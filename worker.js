/**
 * 打卡系統 — LINE 登入驗證 Worker（Cloudflare Workers）
 *
 * POST /auth  { idToken }                 → 已綁定：回傳 Firebase 登入 token；未綁定：回傳可綁定員工名單
 * POST /bind  { idToken, empId, email }   → Email 正確即綁定，回傳 Firebase 登入 token
 *
 * 需要的環境變數（Worker → 設定 → 變數和密碼）：
 *   LINE_CHANNEL_ID        LINE Login Channel ID
 *   FIREBASE_PROJECT_ID    Firebase 專案 ID
 *   FIREBASE_CLIENT_EMAIL  服務帳戶 JSON 裡的 client_email
 *   FIREBASE_PRIVATE_KEY   服務帳戶 JSON 裡的 private_key（請設成「密碼 / Secret」）
 *   ALLOWED_ORIGIN         你的網站網址，例如 https://你的帳號.github.io （不填則允許所有來源）
 *
 * LINE 圖文選單（選用）：
 *   LINE_MESSAGING_TOKEN   LINE 官方帳號 Messaging API 的 Channel access token（請設成「密碼 / Secret」）
 *   SETUP_KEY              自訂一組密碼，執行 /setup-richmenu?key=這組密碼 時使用
 *   LIFF_ID                （選填）預設 2012318362-VOU7aFr9
 *   SITE_URL               （選填）預設 https://eurekateamstar-star.github.io/skate
 */

export default {
  async fetch(req, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method === "GET" && new URL(req.url).pathname === "/setup-richmenu") {
      const key = new URL(req.url).searchParams.get("key");
      if (!env.SETUP_KEY || key !== env.SETUP_KEY) return json({ error: "請在網址加上正確的 ?key=（Worker 變數 SETUP_KEY）" }, 403);
      if (!env.LINE_MESSAGING_TOKEN) return json({ error: "尚未設定 Worker 變數 LINE_MESSAGING_TOKEN" }, 400);
      try { return json(await setupRichMenu(env)); }
      catch (e) { return json({ error: String(e?.message || e) }, 500); }
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const path = new URL(req.url).pathname;
    try {
      const body = await req.json().catch(() => ({}));
      const line = await verifyLine(body.idToken, env);
      if (!line?.sub) return json({
        error: "invalid_token",
        detail: `LINE 回應：${line?.error || "未知"}；Worker 設定的 LINE_CHANNEL_ID=${env.LINE_CHANNEL_ID || "(未設定)"}`
      }, 401);

      const uid = "line:" + line.sub;
      const fs = new Firestore(env);

      if (path === "/auth") {
        const emp = await fs.findByLineUid(uid);
        if (emp && emp.active !== false) {
          if (env.LINE_MESSAGING_TOKEN && ctx?.waitUntil) ctx.waitUntil(linkMenuFor(env, line.sub, emp.role === "admin").catch(() => {}));
          return json({ bound: true, name: emp.name, token: await customToken(env, uid, { empId: emp.id }) });
        }
        if (emp) return json({ error: "disabled" }, 403);
        const candidates = (await fs.listEmployees())
          .filter(e => e.active !== false && !e.lineUid)
          .map(e => ({ id: e.id, name: e.name || "", empNo: e.empNo || "" }))
          .sort((a, b) => (a.empNo || "zzz").localeCompare(b.empNo || "zzz") || a.name.localeCompare(b.name));
        return json({ bound: false, lineName: line.name || "", candidates });
      }

      if (path === "/bind") {
        if (await fs.findByLineUid(uid)) return json({ error: "already_bound_line" }, 409);
        const emp = await fs.get(body.empId);
        if (!emp || emp.active === false) return json({ error: "not_found" }, 404);
        if (emp.lineUid) return json({ error: "already_bound" }, 409);
        const fails = Number(emp.bindFails || 0);
        if (fails >= 5) return json({ error: "locked" }, 423);

        const norm = s => String(s || "").trim().toLowerCase();
        if (!norm(body.email) || norm(body.email) !== norm(emp.email)) {
          await fs.patch(emp.id, { bindFails: fails + 1 });
          return json({ error: "email_mismatch", left: Math.max(0, 4 - fails) }, 403);
        }

        // 用 updateTime 當前置條件，避免兩個人同時綁定同一位員工
        await fs.patch(emp.id, {
          lineUid: uid, lineName: line.name || "", linePicture: line.picture || "",
          bindFails: 0, boundAt: new Date()
        }, emp._updateTime);
        if (env.LINE_MESSAGING_TOKEN && ctx?.waitUntil) ctx.waitUntil(linkMenuFor(env, line.sub, emp.role === "admin").catch(() => {}));
        return json({ bound: true, name: emp.name, token: await customToken(env, uid, { empId: emp.id }) });
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "server_error", message: String(e?.message || e) }, 500);
    }
  }
};

/* ---------- LINE ---------- */
async function verifyLine(idToken, env) {
  if (!idToken) return { error: "沒有收到 idToken" };
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: String(env.LINE_CHANNEL_ID || "").trim() })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error_description || d.error || ("HTTP " + r.status) };
  return d;
}

/* ---------- JWT（RS256） ---------- */
let keyPromise = null;
function getKey(env) {
  if (!keyPromise) {
    keyPromise = (async () => {
      const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
      const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
      const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    })().catch(e => { keyPromise = null; throw e; });
  }
  return keyPromise;
}
const b64url = bytes => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const enc = s => new TextEncoder().encode(s);
async function signJwt(env, payload) {
  const h = b64url(enc(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const p = b64url(enc(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await getKey(env), enc(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

// Firebase 自訂登入 token（前端用 signInWithCustomToken 登入）
async function customToken(env, uid, claims) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(env, {
    iss: env.FIREBASE_CLIENT_EMAIL, sub: env.FIREBASE_CLIENT_EMAIL,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now, exp: now + 3600, uid, claims
  });
}

// Google OAuth access token（Worker 以管理員身分讀寫 Firestore）
let cachedToken = null;
async function accessToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(env, {
    iss: env.FIREBASE_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Google token 取得失敗：" + JSON.stringify(d));
  cachedToken = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return cachedToken.token;
}

/* ---------- Firestore REST ---------- */
class Firestore {
  constructor(env) {
    this.env = env;
    this.base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  }
  async req(url, opt = {}) {
    const r = await fetch(url, {
      ...opt,
      headers: { Authorization: `Bearer ${await accessToken(this.env)}`, "Content-Type": "application/json" }
    });
    if (r.status === 404) return null;
    const d = await r.json();
    if (!r.ok) throw new Error(`Firestore ${r.status}: ${d.error?.message || JSON.stringify(d)}`);
    return d;
  }
  async get(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id || "")) return null;
    const d = await this.req(`${this.base}/employees/${id}`);
    return d ? decode(d) : null;
  }
  async listEmployees() {
    const out = [];
    let pageToken = "";
    do {
      const d = await this.req(`${this.base}/employees?pageSize=300${pageToken ? "&pageToken=" + pageToken : ""}`);
      (d?.documents || []).forEach(doc => out.push(decode(doc)));
      pageToken = d?.nextPageToken || "";
    } while (pageToken);
    return out;
  }
  async findByLineUid(uid) {
    const res = await this.req(`${this.base}:runQuery`, {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "employees" }],
          where: { fieldFilter: { field: { fieldPath: "lineUid" }, op: "EQUAL", value: { stringValue: uid } } },
          limit: 1
        }
      })
    });
    const hit = (res || []).find(x => x.document);
    return hit ? decode(hit.document) : null;
  }
  async patch(id, fields, updateTime) {
    const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join("&");
    const pre = updateTime ? `&currentDocument.updateTime=${encodeURIComponent(updateTime)}` : "";
    return this.req(`${this.base}/employees/${id}?${mask}${pre}`, {
      method: "PATCH",
      body: JSON.stringify({ fields: encodeFields(fields) })
    });
  }
}

function decode(doc) {
  const o = { id: doc.name.split("/").pop(), _updateTime: doc.updateTime };
  for (const [k, v] of Object.entries(doc.fields || {})) {
    if ("stringValue" in v) o[k] = v.stringValue;
    else if ("integerValue" in v) o[k] = Number(v.integerValue);
    else if ("doubleValue" in v) o[k] = v.doubleValue;
    else if ("booleanValue" in v) o[k] = v.booleanValue;
    else if ("timestampValue" in v) o[k] = v.timestampValue;
    else if ("nullValue" in v) o[k] = null;
  }
  return o;
}
function encodeFields(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) f[k] = { nullValue: null };
    else if (v instanceof Date) f[k] = { timestampValue: v.toISOString() };
    else if (typeof v === "boolean") f[k] = { booleanValue: v };
    else if (typeof v === "number") f[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else f[k] = { stringValue: String(v) };
  }
  return f;
}

/* ---------- LINE 圖文選單 ---------- */
const MENU_SIZE = { width: 2500, height: 1686 };
async function lineApi(env, path, opt = {}, base = "https://api.line.me") {
  const r = await fetch(base + path, {
    ...opt,
    headers: { Authorization: `Bearer ${env.LINE_MESSAGING_TOKEN}`, ...(opt.body && !(opt.body instanceof ArrayBuffer) ? { "Content-Type": "application/json" } : {}), ...(opt.headers || {}) }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`LINE ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function setupRichMenu(env) {
  const LIFF = "https://liff.line.me/" + (env.LIFF_ID || "2012318362-VOU7aFr9");
  const SITE = (env.SITE_URL || "https://eurekateamstar-star.github.io/skate").replace(/\/$/, "");
  const go = (view, extra = "") => ({ type: "uri", uri: `${LIFF}?view=${view}${extra}` });
  const box = (x, y, w, h, action) => ({ bounds: { x, y, width: w, height: h }, action });
  const staffTiles = [
    box(0, 250, 1250, 1436, go("clock")),
    box(1250, 250, 1250, 718, go("records")),
    box(1250, 968, 1250, 718, go("mySchedule"))
  ];
  const tabs = [
    box(0, 0, 1250, 250, { type: "richmenuswitch", richMenuAliasId: "punch-admin-staff", data: "tab=staff" }),
    box(1250, 0, 1250, 250, { type: "richmenuswitch", richMenuAliasId: "punch-admin", data: "tab=admin" })
  ];
  const adminTiles = [["scheduling"], ["report"], ["payroll"], ["employees"], ["shifts"], ["mySchedule", "&mode=all"]]
    .map(([v, ex], i) => box(Math.round((i % 3) * 2500 / 3), 250 + Math.floor(i / 3) * 718, Math.round(2500 / 3), 718, go(v, ex)));
  const menus = [
    { key: "staff", name: "打卡系統-員工", img: "menu-staff.png", areas: staffTiles },
    { key: "adminStaff", name: "打卡系統-管理者(打卡)", img: "menu-admin-staff.png", areas: [...tabs, ...staffTiles] },
    { key: "admin", name: "打卡系統-管理者(管理)", img: "menu-admin.png", areas: [...tabs, ...adminTiles] }
  ];

  // 刪掉舊的（同名選單與別名）
  for (const a of ["punch-admin-staff", "punch-admin"]) await lineApi(env, `/v2/bot/richmenu/alias/${a}`, { method: "DELETE" }).catch(() => {});
  const old = await lineApi(env, "/v2/bot/richmenu/list");
  for (const m of old.richmenus || []) if (String(m.name).startsWith("打卡系統-")) await lineApi(env, `/v2/bot/richmenu/${m.richMenuId}`, { method: "DELETE" }).catch(() => {});

  const ids = {};
  for (const m of menus) {
    const { richMenuId } = await lineApi(env, "/v2/bot/richmenu", {
      method: "POST",
      body: JSON.stringify({ size: MENU_SIZE, selected: true, name: m.name, chatBarText: "打卡選單", areas: m.areas })
    });
    const img = await fetch(`${SITE}/richmenu/${m.img}?t=${Date.now()}`);
    if (!img.ok) throw new Error(`讀不到圖片 ${SITE}/richmenu/${m.img}（${img.status}）`);
    await lineApi(env, `/v2/bot/richmenu/${richMenuId}/content`, { method: "POST", headers: { "Content-Type": "image/png" }, body: await img.arrayBuffer() }, "https://api-data.line.me");
    ids[m.key] = richMenuId;
  }
  await lineApi(env, "/v2/bot/richmenu/alias", { method: "POST", body: JSON.stringify({ richMenuAliasId: "punch-admin-staff", richMenuId: ids.adminStaff }) });
  await lineApi(env, "/v2/bot/richmenu/alias", { method: "POST", body: JSON.stringify({ richMenuAliasId: "punch-admin", richMenuId: ids.admin }) });
  await lineApi(env, `/v2/bot/user/all/richmenu/${ids.staff}`, { method: "POST" });

  // 已綁定 LINE 的管理者改用管理者選單
  const fs = new Firestore(env);
  const admins = (await fs.listEmployees()).filter(e => e.role === "admin" && e.active !== false && String(e.lineUid || "").startsWith("line:"))
    .map(e => e.lineUid.slice(5));
  if (admins.length) await lineApi(env, "/v2/bot/richmenu/bulk/link", { method: "POST", body: JSON.stringify({ richMenuId: ids.adminStaff, userIds: admins }) }).catch(e => { ids.linkError = String(e.message); });
  return { ok: true, message: "圖文選單設定完成！請到 LINE 官方帳號聊天室查看（可能需要關掉聊天室重開）", richMenus: ids, adminsLinked: admins.length };
}

// 依身分切換使用者的圖文選單（管理者 → 管理者選單；一般員工 → 預設選單）
async function linkMenuFor(env, userId, isAdmin) {
  if (isAdmin) {
    const a = await lineApi(env, "/v2/bot/richmenu/alias/punch-admin-staff");
    await lineApi(env, `/v2/bot/user/${userId}/richmenu/${a.richMenuId}`, { method: "POST" });
  } else {
    await lineApi(env, `/v2/bot/user/${userId}/richmenu`, { method: "DELETE" }).catch(() => {});
  }
}
