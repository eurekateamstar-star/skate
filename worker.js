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
 *   ALLOWED_ORIGIN         你的網站網址，例如 https://wild-horses-skating.pages.dev （不填則允許所有來源）
 *
 * LINE 圖文選單（選用）：
 *   LINE_MESSAGING_TOKEN   LINE 官方帳號 Messaging API 的 Channel access token（請設成「密碼 / Secret」）
 *   SETUP_KEY              自訂一組密碼，執行 /setup-richmenu?key=這組密碼 時使用
 *   LIFF_ID                （選填）預設 2012318362-VOU7aFr9
 *   SITE_URL               （選填）預設 https://wild-horses-skating.pages.dev
 */

export default {
  // 排程（Cron Trigger，每天台灣時間 08:00）：還沒審核的申請彙整一則給管理者
  async scheduled(event, env, ctx) {
    if (env.LINE_MESSAGING_TOKEN) ctx.waitUntil(runReminders(env, false, true).catch(e => console.error("reminder", e)));
  },
  async fetch(req, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": (() => {
        const o = req.headers.get("Origin") || "";
        const ok = [env.ALLOWED_ORIGIN, "https://wild-horses-skating.pages.dev"].filter(Boolean);
        return !env.ALLOWED_ORIGIN ? "*" : ok.includes(o) || o.endsWith(".wild-horses-skating.pages.dev") ? o : env.ALLOWED_ORIGIN;
      })(),
      "Vary": "Origin",
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
    // 手動測試提醒：/run-reminders?key=SETUP_KEY
    if (req.method === "GET" && new URL(req.url).pathname === "/run-reminders") {
      if (!env.SETUP_KEY || new URL(req.url).searchParams.get("key") !== env.SETUP_KEY) return json({ error: "key 錯誤" }, 403);
      try { return json(await runReminders(env, true)); }
      catch (e) { return json({ error: String(e?.message || e) }, 500); }
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const path = new URL(req.url).pathname;
    // 員工送出請假／加入班表 → 立刻通知管理者（只會通知一次）
    if (path === "/notify") {
      try {
        const body = await req.json().catch(() => ({}));
        if (!["leaveRequests", "shiftRequests"].includes(body.coll) || !/^[A-Za-z0-9]{10,40}$/.test(body.id || "")) return json({ error: "bad_request" }, 400);
        if (!env.LINE_MESSAGING_TOKEN) return json({ ok: false, reason: "no_token" });
        return json(await notifyNew(env, body.coll, body.id));
      } catch (e) { return json({ error: String(e?.message || e) }, 500); }
    }
    // AI 快速排班：管理者貼上文字 → 回傳結構化的排班動作（只回傳預覽，不寫入資料庫）
    if (path === "/ai-schedule") {
      try {
        const body = await req.json().catch(() => ({}));
        const uid = await verifyFirebaseToken(body.token, env);
        if (!uid) return json({ error: "unauthorized" }, 401);
        const emp = await new Firestore(env).findByLineUid(uid);
        if (!emp || emp.role !== "admin" || emp.active === false) return json({ error: "forbidden" }, 403);
        if (!env.AI) return json({ error: "no_ai", message: "Worker 尚未綁定 Workers AI（變數名稱 AI）" }, 400);
        const text = String(body.text || "").slice(0, 4000).trim();
        if (!text) return json({ error: "empty" }, 400);
        return json(await aiSchedule(env, text, body.ctx || {}));
      } catch (e) { console.error(e); return json({ error: "server_error", message: String(e?.message || e) }, 500); }
    }
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
          .sort((a, b) => (a.empNo || "zzz").localeCompare(b.empNo || "zzz") || (a.name || "").localeCompare(b.name || ""))
          .map(e => ({ id: e.id, name: e.name || "" }));   // 員編只給後台看
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
  async where(coll, field, value) {
    const res = await this.req(`${this.base}:runQuery`, {
      method: "POST",
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } } } })
    });
    return (res || []).filter(x => x.document).map(x => decode(x.document));
  }
  async whereAnd(coll, eq) {
    const val = v => typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v) };
    const filters = Object.entries(eq).map(([k, v]) => ({ fieldFilter: { field: { fieldPath: k }, op: "EQUAL", value: val(v) } }));
    const res = await this.req(`${this.base}:runQuery`, {
      method: "POST",
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }],
        where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } } } })
    });
    return (res || []).filter(x => x.document).map(x => decode(x.document));
  }
  async list(coll) {
    const out = [];
    let pageToken = "";
    do {
      const d = await this.req(`${this.base}/${coll}?pageSize=300${pageToken ? "&pageToken=" + pageToken : ""}`);
      (d?.documents || []).forEach(doc => out.push(decode(doc)));
      pageToken = d?.nextPageToken || "";
    } while (pageToken);
    return out;
  }
  async getPath(path) {
    const d = await this.req(`${this.base}/${path}`);
    return d ? decode(d) : null;
  }
  async patchPath(path, fields) {
    const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent("`" + k + "`")}`).join("&");
    return this.req(`${this.base}/${path}?${mask}`, { method: "PATCH", body: JSON.stringify({ fields: encodeFields(fields) }) });
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
    else if ("arrayValue" in v) o[k] = (v.arrayValue.values || []).map(x => x.stringValue ?? x.integerValue ?? x.doubleValue ?? null);
    else if ("mapValue" in v) o[k] = decode({ name: "x/x", fields: v.mapValue.fields || {} });
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
  const SITE = (env.SITE_URL || "https://wild-horses-skating.pages.dev").replace(/\/$/, "");
  const go = (view, extra = "") => ({ type: "uri", uri: `${LIFF}?view=${view}${extra}` });
  const box = (x, y, w, h, action) => ({ bounds: { x, y, width: w, height: h }, action });
  const third = Math.round(1436 / 3);
  const staffTiles = [
    box(0, 250, 1250, 1436, go("clock")),
    box(1250, 250, 1250, third, go("records")),
    box(1250, 250 + third, 1250, third, go("mySchedule")),
    box(1250, 250 + third * 2, 1250, 1436 - third * 2, go("leave"))
  ];
  const tabs = [
    box(0, 0, 1250, 250, { type: "richmenuswitch", richMenuAliasId: "punch-admin-staff", data: "tab=staff" }),
    box(1250, 0, 1250, 250, { type: "richmenuswitch", richMenuAliasId: "punch-admin", data: "tab=admin" })
  ];
  const adminTiles = [["approvals"], ["scheduling"], ["report"], ["payroll"], ["employees"], ["shifts"]]
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
  let admins = [];
  try {
    admins = (await fs.listEmployees()).filter(e => e.role === "admin" && e.active !== false && String(e.lineUid || "").startsWith("line:"))
      .map(e => e.lineUid.slice(5));
  } catch (e) {
    return { ok: true, message: "圖文選單已更新，但讀不到員工資料，管理者選單還沒套用（稍後再開一次這個網址，或管理者重新登入一次系統即可）", richMenus: ids, adminError: String(e.message) };
  }
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

/* ---------- 上下班提醒（LINE 推播） ---------- */
const REMIND_BEFORE = 10;   // 上班前幾分鐘提醒
const REMIND_AFTER = 10;    // 下班後幾分鐘仍未打卡就提醒

// 每天的提醒計畫存在 reminders/{日期}._plan，每次排程只讀這 1 筆（節省 Firestore 讀取額度）
async function loadPlan(fs, today, force) {
  const doc = (await fs.getPath(`reminders/${today}`)) || {};
  let plan = null;
  try { plan = JSON.parse(doc._plan || "null"); } catch {}
  if (force || !plan || Date.now() - plan.at > 60 * 60e3) {
    const [shifts, emps, schedules] = await Promise.all([fs.list("shiftTypes"), fs.list("employees"), fs.where("schedules", "date", today)]);
    const shiftBy = Object.fromEntries(shifts.map(s => [s.id, s]));
    const items = [];
    for (const x of schedules) for (const sid of x.shiftIds || []) {
      const s = shiftBy[sid];
      if (!s || s.cat === "leave" || x.leave?.[sid] || !s.start || !s.end) continue;
      items.push({ e: x.empId, s: sid, n: s.name, st: s.start, en: s.end });
    }
    plan = {
      at: Date.now(), items,
      emps: Object.fromEntries(emps.filter(e => e.active !== false).map(e => [e.id, { name: e.name || "", line: String(e.lineUid || "").startsWith("line:") ? e.lineUid.slice(5) : "", admin: e.role === "admin" }]))
    };
    await fs.patchPath(`reminders/${today}`, { _plan: JSON.stringify(plan) });
  }
  return { doc, plan };
}

async function notifyNew(env, coll, id) {
  const fs = new Firestore(env);
  const q = await fs.getPath(`${coll}/${id}`);
  if (!q || q.status !== "pending" || q.notified === true) return { ok: true, skipped: true };
  await fs.patchPath(`${coll}/${id}`, { notified: true });          // 先標記，避免重複發送
  const LIFF = "https://liff.line.me/" + (env.LIFF_ID || "2012318362-VOU7aFr9");
  const msg = coll === "leaveRequests"
    ? card("📝 新的請假申請", `${q.name}　${String(q.date).slice(5)} ${q.leaveType}`, `${(q.shiftNames || []).join("、")}${q.reason ? `\n原因：${q.reason}` : ""}${q.subName ? `\n代班：${q.subName}` : ""}`, "前往審核", `${LIFF}?view=approvals`)
    : card("➕ 申請加入班表", `${q.name}　${String(q.date).slice(5)}`, `${q.shiftName}\n班表沒排到，核准加入班表後才能打卡`, "前往審核", `${LIFF}?view=approvals`, "#ff9500");
  const admins = (await fs.where("employees", "role", "admin")).filter(e => e.active !== false && String(e.lineUid || "").startsWith("line:"));
  for (const a of admins) await push(env, a.lineUid.slice(5), msg).catch(() => {});
  return { ok: true, sent: admins.length };
}

// LINE 免費方案每月訊息有限，預設只通知管理者
const NOTIFY = {
  leaveToAdmin: false,      // 改由員工送出時直接呼叫 /notify 即時通知（不用排程搜尋）
  dailyDigest: true,        // 每天早上 8:00：還沒審核的補打卡（及仍未處理的請假／加班）→ 一則彙整給管理者（都處理完就不發）
  shiftReminders: false,    // 上下班前後提醒員工（很耗訊息量，預設關閉）
  employeeResults: false    // 審核結果、薪資發布、代班 → 通知員工（員工打開系統會跳出，預設不發 LINE）
};
const DIGEST_AT = 8 * 60;   // 08:00

async function runReminders(env, manual = false, daily = false) {
  const tp = new Date(Date.now() + 8 * 3600e3);          // 台灣時間
  const today = tp.toISOString().slice(0, 10);
  const now = tp.getUTCHours() * 60 + tp.getUTCMinutes();
  const fs = new Firestore(env);
  const LIFF = "https://liff.line.me/" + (env.LIFF_ID || "2012318362-VOU7aFr9");
  const result = { date: today, time: `${String(Math.floor(now / 60)).padStart(2, "0")}:${String(now % 60).padStart(2, "0")}`, sent: [] };
  const toMin = t => t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null;
  const inWin = (t, a) => t != null && now >= t + a && now < t + a + 5;   // 每 5 分鐘一個時間窗
  let adminsCache = null;
  const getAdmins = async () => adminsCache ??= (await fs.where("employees", "role", "admin"))
    .filter(e => e.active !== false && String(e.lineUid || "").startsWith("line:")).map(e => e.lineUid.slice(5));
  const toAdmins = async msg => { const ids = await getAdmins(); for (const id of ids) await push(env, id, msg).catch(() => {}); return ids.length; };

  // 1. 上下班提醒（預設關閉）
  let cands = [];
  if (NOTIFY.shiftReminders) {
    const { doc: sentDoc, plan } = await loadPlan(fs, today, manual);
    const empBy = Object.fromEntries(Object.entries(plan.emps).map(([id, e]) => [id, { id, name: e.name, lineUid: e.line ? "line:" + e.line : "" }]));
    cands = [];
    for (const it of plan.items) {
      const s = { name: it.n, start: it.st, end: it.en };
      if (inWin(toMin(it.st), -REMIND_BEFORE)) cands.push({ empId: it.e, sid: it.s, s, type: "in" });
      if (inWin(toMin(it.en), REMIND_AFTER)) cands.push({ empId: it.e, sid: it.s, s, type: "out" });
    }
    if (cands.length) {
      const mark = {};
      const schCache = {}, attCache = {};
      for (const c of cands) {
        const key = `${c.empId}_${c.sid}_${c.type}`;
        if (sentDoc[key]) continue;
        const e = empBy[c.empId];
        if (!e || !e.lineUid) continue;
        // 再確認一次：班還在、沒請假、還沒打卡
        const sch = schCache[c.empId] ??= await fs.getPath(`schedules/${c.empId}_${today}`);
        if (!sch || !(sch.shiftIds || []).includes(c.sid) || sch.leave?.[c.sid]) continue;
        const att = attCache[c.empId] ??= await fs.whereAnd("attendance", { empId: c.empId, date: today });
        if (att.some(a => a.shiftId === c.sid && a.type === c.type)) continue;
        const msg = c.type === "in"
          ? card(`⏰ ${REMIND_BEFORE} 分鐘後上班`, c.s.name, `上班 ${c.s.start}・下班 ${c.s.end}\n到了記得打上班卡喔！`, "前往打卡", `${LIFF}?view=clock`)
          : card("⚠️ 還沒打下班卡", c.s.name, `下班時間 ${c.s.end} 已過\n請立即打下班卡；超過 1 小時要改用「補打卡」`, "立即打卡", `${LIFF}?view=clock`, "#ff9500");
        try {
          await push(env, e.lineUid.slice(5), msg);
          mark[key] = true;
          result.sent.push(`${e.name} ${c.type === "in" ? "上班" : "下班"} ${c.s.name}`);
        } catch (err) { result.sent.push(`失敗 ${e.name}: ${err.message}`); }
      }
      if (Object.keys(mark).length) await fs.patchPath(`reminders/${today}`, mark);
    }

  }

  // 2. 新的請假、加入班表（加班）申請 → 立即通知管理者（合成一則）
  if (NOTIFY.leaveToAdmin) {
    const [pendL, pendS] = await Promise.all([fs.whereAnd("leaveRequests", { notified: false }), fs.whereAnd("shiftRequests", { notified: false })]);
    const newL = pendL.filter(q => q.status === "pending"), newS = pendS.filter(q => q.status === "pending");
    if (newL.length || newS.length) {
      const lines = [
        ...newL.map(q => `🗓 ${q.name}　${q.date.slice(5)} ${q.leaveType}（${(q.shiftNames || []).length} 個班）`),
        ...newS.map(q => `➕ ${q.name}　${q.date.slice(5)} 申請加入班表：${q.shiftName}`)
      ];
      const title = [newL.length ? `${newL.length} 筆請假` : "", newS.length ? `${newS.length} 筆加入班表` : ""].filter(Boolean).join("、");
      result.notifiedAdmins = await toAdmins(card(`📝 ${title}待審核`, "簽核中心", lines.slice(0, 8).join("\n") + (lines.length > 8 ? "\n…" : ""), "前往審核", `${LIFF}?view=approvals`));
    }
    for (const q of pendL) await fs.patchPath(`leaveRequests/${q.id}`, { notified: true }).catch(() => {});
    for (const q of pendS) await fs.patchPath(`shiftRequests/${q.id}`, { notified: true }).catch(() => {});
  }

  // 3. 每天早上 8:00 彙整還沒審核的申請（已經處理完就不發）
  if (NOTIFY.dailyDigest && (manual || daily || inWin(DIGEST_AT, 0))) {
    const mark = (await fs.getPath(`reminders/${today}`)) || {};
    if (!mark.digestSent || manual) {
      const [p, sh, l] = await Promise.all([fs.where("punchRequests", "status", "pending"), fs.where("shiftRequests", "status", "pending"), fs.where("leaveRequests", "status", "pending")]);
      if (p.length || sh.length || l.length) {
        const lines = [
          ...p.map(q => `⏱ ${q.name}　${q.date.slice(5)} 補${q.type === "in" ? "上班" : "下班"}卡 ${q.time}`),
          ...sh.map(q => `➕ ${q.name}　${q.date.slice(5)} 加班 ${q.shiftName}`),
          ...l.map(q => `🗓 ${q.name}　${q.date.slice(5)} ${q.leaveType}`)
        ];
        const title = [p.length ? `補打卡 ${p.length}` : "", sh.length ? `加班 ${sh.length}` : "", l.length ? `請假 ${l.length}` : ""].filter(Boolean).join("・");
        result.digest = await toAdmins(card(`🌅 今日待審核：${title}`, "簽核中心", lines.slice(0, 10).join("\n") + (lines.length > 10 ? `\n…共 ${lines.length} 筆` : ""), "前往審核", `${LIFF}?view=approvals`));
      }
      if (!manual) await fs.patchPath(`reminders/${today}`, { digestSent: true });
    }
  }

  // 4. 審核結果 → 通知員工（預設關閉）
  if (NOTIFY.employeeResults) {
    const emps = await fs.list("employees");
    const empBy = Object.fromEntries(emps.map(e => [e.id, e]));
    const [doneP, doneL, doneS, doneSh] = await Promise.all([fs.where("punchRequests", "notifyEmp", "todo"), fs.where("leaveRequests", "notifyEmp", "todo"), fs.where("payslips", "notifyEmp", "todo"), fs.where("shiftRequests", "notifyEmp", "todo")]);
    // 加班申請結果 → 通知員工
    for (const q of doneSh) {
      const e = empBy[q.empId];
      if (e?.lineUid) {
        const ok = q.status === "approved";
        await push(env, e.lineUid.slice(5), card(ok ? "✅ 加班已核准" : "❌ 加班被退回", q.shiftName || "加班申請",
          `${q.date.slice(5)} ${q.shiftName || ""}${ok ? "\n已加入你的班表" : q.rejectNote ? `\n退回原因：${q.rejectNote}` : ""}`, "查看", `${LIFF}?view=clock`, ok ? "#34c759" : "#ff3b30")).catch(() => {});
      }
      await fs.patchPath(`shiftRequests/${q.id}`, { notifyEmp: "done" }).catch(() => {});
    }
    // 薪資發布 → 通知員工
    for (const q of doneS) {
      const e = empBy[q.empId];
      if (e?.lineUid) {
        const [y, m] = String(q.month || "").split("-");
        await push(env, e.lineUid.slice(5), card(`💰 ${y}年${+m}月薪資已結算`, "我的薪資", `應發金額 $${Math.round(q.total || 0).toLocaleString("en-US")}\n點下方查看每個班別的明細`, "查看薪資", `${LIFF}?view=mypay`, "#34c759")).catch(() => {});
      }
      await fs.patchPath(`payslips/${q.id}`, { notifyEmp: "done" }).catch(() => {});
    }
    for (const [coll, list] of [["punchRequests", doneP], ["leaveRequests", doneL]]) {
      for (const q of list) {
        const e = empBy[q.empId];
        if (e && String(e.lineUid || "").startsWith("line:")) {
          const ok = q.status === "approved";
          const kind = q.status === "revoked" ? "revoked" : ok && q.notifyKind === "edited" ? "edited" : ok ? "approved" : "rejected";
          const subs = Object.entries(q.subNames || {}).filter(([, n]) => n);
          const subLine = coll === "leaveRequests" && ok ? `\n代班：${subs.length ? [...new Set(subs.map(([, n]) => n))].join("、") : "不需代班"}` : "";
          const what = coll === "leaveRequests" ? `${q.date.slice(5)} ${q.leaveType}\n${(q.shiftNames || []).join("、")}${subLine}` : `${q.date.slice(5)} ${q.shiftName}\n補${q.type === "in" ? "上班" : "下班"}卡 ${q.time}`;
          const head = { approved: "✅ 已核准", edited: "✏️ 已修改", revoked: "↩️ 已撤銷", rejected: "❌ 已退回" }[kind];
          const msg = card(head, coll === "leaveRequests" ? "請假申請" : "補打卡申請",
            what + (kind === "rejected" && q.rejectNote ? `\n退回原因：${q.rejectNote}` : "") + (kind === "revoked" ? "\n請假已取消，請照原班表上班" : ""),
            "查看", `${LIFF}?view=${coll === "leaveRequests" ? "leave" : "records"}`, kind === "rejected" ? "#ff3b30" : kind === "revoked" ? "#8e8e93" : "#34c759");
          await push(env, e.lineUid.slice(5), msg).catch(() => {});
          // 代班人也通知
          if (coll === "leaveRequests" && (kind === "approved" || kind === "edited")) {
            for (const [sid, eid] of Object.entries(q.subAdded || {})) {
              const s = empBy[eid];
              if (!s || !String(s.lineUid || "").startsWith("line:")) continue;
              const idx = (q.shiftIds || []).indexOf(sid);
              await push(env, s.lineUid.slice(5), card("🔁 代班通知", "排班異動", `${q.date.slice(5)} ${q.shiftNames?.[idx] || ""}\n代 ${q.name} 的班`, "查看班表", `${LIFF}?view=mySchedule`, "#ff9500")).catch(() => {});
            }
          }
        }
        await fs.patchPath(`${coll}/${q.id}`, { notifyEmp: "done" }).catch(() => {});
      }
    }
  }
  if (manual) result.candidates = cands.length;
  return result;
}

function card(title, shift, detail, label, uri, color = "#0071e3") {
  return {
    type: "flex", altText: `${title}：${shift}`,
    contents: {
      type: "bubble", size: "kilo",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "text", text: title, weight: "bold", size: "md", color },
        { type: "text", text: shift, weight: "bold", size: "lg", wrap: true, margin: "md" },
        { type: "text", text: detail, size: "sm", color: "#86868b", wrap: true }
      ] },
      footer: { type: "box", layout: "vertical", contents: [
        { type: "button", style: "primary", color, height: "sm", action: { type: "uri", label, uri } }
      ] }
    }
  };
}
async function push(env, to, message) {
  return lineApi(env, "/v2/bot/message/push", { method: "POST", body: JSON.stringify({ to, messages: [message] }) });
}


/* ---------- Firebase ID Token 驗證 ---------- */
let fbKeys = null;
async function verifyFirebaseToken(token, env) {
  try {
    const [h, p, sig] = String(token || "").split(".");
    if (!sig) return null;
    const dec = x => JSON.parse(new TextDecoder().decode(b64u(x)));
    const head = dec(h), pay = dec(p), now = Date.now() / 1000;
    const proj = env.FIREBASE_PROJECT_ID;
    if (head.alg !== "RS256" || pay.aud !== proj || pay.iss !== "https://securetoken.google.com/" + proj || pay.exp < now || !pay.sub) return null;
    if (!fbKeys || fbKeys.exp < Date.now()) {
      const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
      fbKeys = { keys: (await r.json()).keys || [], exp: Date.now() + 3600_000 };
    }
    const jwk = fbKeys.keys.find(k => k.kid === head.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(sig), new TextEncoder().encode(h + "." + p));
    return ok ? pay.sub : null;
  } catch { return null; }
}
function b64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

/* ---------- AI 排班解析（Workers AI） ---------- */
const AI_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen3-30b-a3b-fp8"];
async function aiSchedule(env, text, ctx) {
  const emps = (ctx.employees || []).slice(0, 200).map((e, i) => `E${i + 1}=${String(e.name || "").slice(0, 30)}`).join("\n");
  const shifts = (ctx.shifts || []).slice(0, 300).map((s, i) =>
    `S${i + 1}=${String(s.name || "").slice(0, 40)}${s.start && s.end ? `｜${s.start}-${s.end}` : ""}${s.cat === "leave" ? "｜休假類" : ""}`).join("\n");
  const sys = `你是溜冰教練排班助理。把管理者貼上的中文訊息，轉成排班動作 JSON。只輸出 JSON，不要任何說明文字。

今天：${ctx.today}（台灣）
目前編輯的班表月份：${ctx.month}

員工清單（代號=姓名）：
${emps}

班別清單（代號=名稱｜時間）：
${shifts}

輸出格式：
{"actions":[{"op":"add 或 remove 或 clear","emp":"E代號","shift":"S代號或null","time":"HH:MM-HH:MM 或 null","dates":["YYYY-MM-DD"],"weekdays":[0到6],"from":"YYYY-MM-DD","to":"YYYY-MM-DD","reason":"10字內中文說明"}],"notes":["看不懂或需要管理者確認的地方"]}

規則：
- op：add=排入這個班；remove=取消這個人的這個班；clear=這些日期把這個人所有班都清掉（例如請假、不排班、離職）。
- emp 用員工代號。訊息裡的稱呼可能是暱稱、少了姓氏或加了「教練」，請找最像的員工；完全找不到就不要輸出這個動作，寫進 notes。
- shift 用班別代號。可依地點名稱（例如 迎風、麗山國小）、晨訓/夜訓、時間（0900-1030 = 09:00-10:30）比對；找不到班別就 shift 填 null 並把時間填在 time。
- 日期：有明確日期就放 dates（例如 10/13 → 年份選離目前班表月份最近的那年）。日期區間（10/13-10/21）或「之後都」「每週」這種，用 weekdays（0=日,1=一,…,6=六）加 from/to。
- 「X起」沒寫結束 → to 用目前班表月份的最後一天；沒寫開始 → from 用目前班表月份的第一天（若今天比較晚就用今天）。
- 「預計」「再確認」的排班也照樣輸出，但在 reason 註明「待確認」。
- 請假且有人代課：請假的人在那些日期用 clear（或指定班別就用 remove），代課的人用 add。
- 費用、薪資等跟排班無關的資訊放進 notes。`;
  let lastErr;
  for (const model of AI_MODELS) {
    try {
      const r = await env.AI.run(model, {
        messages: [{ role: "system", content: sys }, { role: "user", content: text }],
        max_tokens: 3000, temperature: 0.1
      });
      let out = typeof r === "string" ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? "";
      if (typeof out !== "string") out = JSON.stringify(out);
      out = out.replace(/<think>[\s\S]*?<\/think>/g, "");
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("AI 沒有回傳 JSON");
      const data = JSON.parse(m[0]);
      return { model, actions: Array.isArray(data.actions) ? data.actions : [], notes: Array.isArray(data.notes) ? data.notes : [] };
    } catch (e) { lastErr = e; console.error("ai", model, e); }
  }
  throw lastErr || new Error("AI 分析失敗");
}
