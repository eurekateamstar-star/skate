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
    // LINE 官方帳號 Webhook：員工傳「請假／換班／加班」→ AI 填好 → 員工按確認 → 進簽核中心
    if (path === "/webhook" && req.method === "POST") {
      const raw = await req.text();
      if (env.LINE_CHANNEL_SECRET) {
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))));
        if (sig !== req.headers.get("x-line-signature")) return new Response("bad signature", { status: 403 });
      }
      let body = {}; try { body = JSON.parse(raw); } catch {}
      ctx.waitUntil(handleLineEvents(env, body.events || []).catch(e => console.error("webhook", e)));
      return new Response("OK");
    }
    // 管理者：設定／查看 LINE Webhook 網址
    if (path === "/admin-webhook") {
      try {
        const b = await req.json().catch(() => ({}));
        const uid = await verifyFirebaseToken(b.token, env);
        const emp = uid && await new Firestore(env).findByLineUid(uid);
        if (!emp || emp.role !== "admin") return json({ error: "forbidden" }, 403);
        const endpoint = new URL(req.url).origin + "/webhook";
        if (b.set) await lineApi(env, "/v2/bot/channel/webhook/endpoint", { method: "PUT", body: JSON.stringify({ endpoint }) });
        const info = await lineApi(env, "/v2/bot/channel/webhook/endpoint");
        let test = null;
        if (b.test) test = await lineApi(env, "/v2/bot/channel/webhook/test", { method: "POST", body: JSON.stringify({ endpoint }) }).catch(e => ({ error: String(e.message || e) }));
        return json({ ok: true, info, test, secret: !!env.LINE_CHANNEL_SECRET });
      } catch (e) { return json({ error: String(e?.message || e) }, 500); }
    }
    // 管理者（從網站登入）重新套用 LINE 圖文選單，不用 SETUP_KEY
    if (path === "/admin-richmenu") {
      try {
        const body = await req.json().catch(() => ({}));
        const uid = await verifyFirebaseToken(body.token, env);
        const emp = uid && await new Firestore(env).findByLineUid(uid);
        if (!emp || emp.role !== "admin") return json({ error: "forbidden" }, 403);
        return json(await setupRichMenu(env));
      } catch (e) { return json({ error: String(e?.message || e) }, 500); }
    }
    // 管理者測試：把「早安報告」傳一則給自己（preview=1 只回傳內容不發送）
    if (path === "/test-daily-report") {
      try {
        const body = await req.json().catch(() => ({}));
        const uid = await verifyFirebaseToken(body.token, env);
        const fs = new Firestore(env);
        const emp = uid && await fs.findByLineUid(uid);
        if (!emp || emp.role !== "admin") return json({ error: "forbidden" }, 403);
        const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
        const msg = await buildDailyReport(fs, body.date || today, "https://liff.line.me/" + (env.LIFF_ID || "2012318362-VOU7aFr9"));
        if (!msg) return json({ ok: true, empty: true });
        if (body.preview) return json({ ok: true, msg });
        msg.altText = "（測試）" + msg.altText;
        await push(env, uid.slice(5), msg);
        return json({ ok: true, to: emp.name });
      } catch (e) { return json({ error: String(e?.message || e) }, 500); }
    }
    // 管理者測試：把「月底排班提醒」傳一則給自己看樣式
    if (path === "/test-roster-remind") {
      try {
        const body = await req.json().catch(() => ({}));
        const uid = await verifyFirebaseToken(body.token, env);
        const emp = uid && await new Firestore(env).findByLineUid(uid);
        if (!emp || emp.role !== "admin") return json({ error: "forbidden" }, 403);
        const tp = new Date(Date.now() + 8 * 3600e3), y = tp.getUTCFullYear(), m = tp.getUTCMonth() + 1;
        const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
        const msg = rosterCard(nm, true, 6, "https://liff.line.me/" + (env.LIFF_ID || "2012318362-VOU7aFr9"));
        msg.altText = "（測試）" + msg.altText;
        // 指定 toName 就發給那位員工（例如排班負責人），否則發給自己
        let target = emp;
        if (body.toName) {
          target = (await new Firestore(env).where("employees", "name", String(body.toName))).find(e => e.active !== false && String(e.lineUid || "").startsWith("line:"));
          if (!target) return json({ error: "找不到這位員工或還沒綁定 LINE" }, 404);
        }
        await push(env, target.lineUid.slice(5), msg);
        return json({ ok: true, to: target.name });
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
        return json(await aiSchedule(env, text, body.ctx || {}, body.model));
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
  async whereRange(coll, field, from, to) {
    const f = (op, v) => ({ fieldFilter: { field: { fieldPath: field }, op, value: { stringValue: v } } });
    const res = await this.req(`${this.base}:runQuery`, {
      method: "POST",
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll }],
        where: { compositeFilter: { op: "AND", filters: [f("GREATER_THAN_OR_EQUAL", from), f("LESS_THAN_OR_EQUAL", to)] } } } })
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
  async add(coll, fields) {
    const d = await this.req(`${this.base}/${coll}`, { method: "POST", body: JSON.stringify({ fields: encodeFields(fields) }) });
    return d?.name?.split("/").pop();
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
    else if (Array.isArray(v)) f[k] = { arrayValue: { values: v.map(x => encodeFields({ x }).x) } };
    else if (typeof v === "object") f[k] = { mapValue: { fields: encodeFields(v) } };
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
  const adminTiles = [["approvals"], ["scheduling"], ["today"], ["payroll"], ["employees"], ["shifts"]]
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

/* ---------- 今日工作會報（每天 8:00）---------- */
async function buildDailyReport(fs, today, LIFF) {
  const W = "日一二三四五六";
  const D = ds => new Date(ds + "T00:00:00Z");
  const add = (ds, n) => { const d = D(ds); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const md = ds => `${+ds.slice(5, 7)}/${+ds.slice(8)}`;
  const mdw = ds => `${md(ds)}(${W[D(ds).getUTCDay()]})`;
  const yest = add(today, -1);
  const wkFrom = today, wkTo = add(today, 6);   // 未來 7 日（含今天）

  const [shifts, emps, schY, schT, schW, attY, p, sh, l] = await Promise.all([
    fs.list("shiftTypes"), fs.list("employees"),
    fs.where("schedules", "date", yest), fs.where("schedules", "date", today), fs.whereRange("schedules", "date", wkFrom, wkTo),
    fs.where("attendance", "date", yest),
    fs.where("punchRequests", "status", "pending"), fs.where("shiftRequests", "status", "pending"), fs.where("leaveRequests", "status", "pending")
  ]);
  const S = Object.fromEntries(shifts.map(x => [x.id, x]));
  const E = Object.fromEntries(emps.filter(e => e.active !== false && !e.dev).map(e => [e.id, e]));
  // 班別名稱縮短：學校課堂(麗小)→麗小、迎風溜冰場→迎風、拿掉名稱裡的「(1830-1900)三五」
  const short = n => {
    n = String(n || "").replace(/\(\d{3,4}-\d{3,4}\)[一二三四五六日]*/g, "").trim();
    const m = /^學校課堂\((.+)\)$/.exec(n);
    return m ? m[1] : n.replace("溜冰場", "");
  };
  // decode() 會在 map 裡多放 id／_updateTime，請假清單要排除
  const LV = x => Object.fromEntries(Object.entries(x.leave || {}).filter(([k, v]) => k !== "id" && k !== "_updateTime" && v));
  const work = x => (x.shiftIds || []).map(id => S[id]).filter(s => s && s.cat !== "leave" && s.start && s.end && !LV(x)[s.id]);

  // 昨天沒打卡（依人分組）
  const missMap = {};
  for (const x of schY) {
    if (!E[x.empId]) continue;
    for (const s of work(x)) {
      const has = t => attY.some(a => a.empId === x.empId && a.shiftId === s.id && a.type === t);
      const req = t => p.some(q => q.empId === x.empId && q.date === yest && q.shiftId === s.id && q.type === t);
      const lack = ["in", "out"].filter(t => !has(t));
      if (!lack.length) continue;
      const st = lack.length === 2 ? "沒打卡" : lack[0] === "in" ? "缺上班卡" : "缺下班卡";
      (missMap[x.empId] ??= { name: E[x.empId].name, items: [] }).items.push({
        label: `${short(s.name)} ${s.start}`, st: st + (lack.every(req) ? "（已申請補卡）" : ""),
        color: lack.every(req) ? "#8e8e93" : lack.length === 2 ? "#d70015" : "#c76a00", t: s.start });
    }
  }
  const missed = Object.values(missMap).map(m => (m.items.sort((a, b) => a.t.localeCompare(b.t)), m))
    .sort((a, b) => b.items.length - a.items.length || a.items[0].t.localeCompare(b.items[0].t));
  const missCnt = missed.reduce((n, m) => n + m.items.length, 0);

  // 今天上班（一人一列，多個班往下排）、今天請假
  const working = [], offToday = [];
  for (const x of schT) {
    if (!E[x.empId]) continue;
    const ws = work(x).sort((a, b) => a.start.localeCompare(b.start));
    if (ws.length) working.push({ name: E[x.empId].name, t: ws[0].start, items: ws.map(s => [short(s.name), s.start]) });
    const lv = Object.entries(LV(x)).filter(([sid]) => S[sid]);
    if (lv.length) offToday.push({ name: E[x.empId].name, pill: [...new Set(lv.map(([, t]) => t))].join("、"), sub: lv.map(([sid]) => short(S[sid].name)).join("、") });
  }
  working.sort((a, b) => a.t.localeCompare(b.t) || a.name.localeCompare(b.name));

  // 未來 7 日請假（每人每天一張）
  const offWeek = schW.filter(x => E[x.empId] && Object.keys(LV(x)).length)
    .map(x => { const lv = Object.entries(LV(x)); return { name: E[x.empId].name, date: x.date, pill: mdw(x.date),
      sub: lv.map(([sid]) => short(S[sid]?.name)).filter(Boolean).join("、") || "整天", right: [...new Set(lv.map(([, t]) => t))].join("、") }; })
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  const pend = [p.length ? `補打卡 ${p.length}` : "", sh.length ? `加班 ${sh.length}` : "", l.length ? `請假 ${l.length}` : ""].filter(Boolean).join("・");
  if (!missed.length && !working.length && !offToday.length && !offWeek.length && !pend) return null;

  // ---- 版面：D 深色標頭＋數字，內容 C 依人分組，上班精簡一人一列 ----
  const GRAY = "#6e6e73", MAXC = 8, MAXR = 15;
  const txt = (text, o = {}) => ({ type: "text", text: String(text), size: "sm", color: "#1d1d1f", wrap: true, ...o });
  const pill = (text, color, bg) => ({ type: "box", layout: "vertical", flex: 0, backgroundColor: bg, cornerRadius: "8px", paddingStart: "8px", paddingEnd: "8px", paddingTop: "1px", paddingBottom: "1px",
    contents: [txt(text, { size: "xxs", weight: "bold", color, wrap: false })] });
  const cardBox = (name, pl, lines) => ({ type: "box", layout: "vertical", backgroundColor: "#f6f6f8", cornerRadius: "12px", paddingAll: "10px", margin: "sm", spacing: "xs", contents: [
    { type: "box", layout: "horizontal", alignItems: "center", contents: [txt(name, { weight: "bold", flex: 1 }), pl] },
    ...lines.map(([l, r, rc]) => ({ type: "box", layout: "horizontal", spacing: "sm", contents: [txt(l || "－", { size: "xs", color: GRAY, flex: 1 }), ...(r ? [txt(r, { size: "xs", color: rc || GRAY, flex: 0, align: "end", wrap: false })] : [])] }))
  ] });
  const head = (t, color) => [{ type: "separator", margin: "lg", color: "#ececf0" }, txt(t, { weight: "bold", color, margin: "lg" })];
  const empty = t => txt(t, { size: "xs", color: "#aeaeb2", margin: "sm" });
  const more = (n, unit) => n > 0 ? [txt(`…另外 ${n} ${unit}`, { size: "xs", color: "#aeaeb2", margin: "sm" })] : [];

  const body = [];
  body.push(txt(`⚠️ 昨天沒打卡（${missed.length} 人・${missCnt} 個班）`, { weight: "bold", color: "#d70015" }));
  if (missed.length) missed.slice(0, MAXC).forEach(m => body.push(cardBox(m.name, pill(`${m.items.length} 個班`, "#d70015", "#ffecec"), m.items.map(i => [i.label, i.st, i.color]))));
  else body.push(empty("全部都有打卡 👍"));
  body.push(...more(missed.length - MAXC, "人"));

  body.push(...head(`👥 今天上班（${working.length} 人）`, "#0068e0"));
  if (working.length) working.slice(0, MAXR).forEach((w, i) => body.push({ type: "box", layout: "horizontal", spacing: "md", paddingTop: "6px", paddingBottom: "6px", contents: [
    txt(w.name, { weight: "bold", flex: 0, wrap: false }),
    { type: "box", layout: "vertical", flex: 1, contents: w.items.map(([n, t]) => ({ type: "text", size: "xs", align: "end", wrap: true, contents: [
      { type: "span", text: n + " ", color: "#555555" }, { type: "span", text: t, color: "#0068e0", weight: "bold" }] })) }
  ] }, ...(i < Math.min(working.length, MAXR) - 1 ? [{ type: "separator", color: "#f2f2f5" }] : [])));
  else body.push(empty("今天沒有排班"));
  body.push(...more(working.length - MAXR, "人"));

  body.push(...head(`🌴 今天請假（${offToday.length}）`, "#e07800"));
  if (offToday.length) offToday.slice(0, MAXC).forEach(o => body.push(cardBox(o.name, pill(o.pill, "#c76a00", "#fff1dc"), [[o.sub, ""]])));
  else body.push(empty("沒有人請假"));
  body.push(...more(offToday.length - MAXC, "人"));

  body.push(...head(`📅 未來 7 日請假 ${md(wkFrom)}–${md(wkTo)}`, "#7a5af8"));
  if (offWeek.length) offWeek.slice(0, MAXC).forEach(o => body.push(cardBox(o.name, pill(o.pill, "#7a5af8", "#f0ecff"), [[o.sub, o.right]])));
  else body.push(empty("未來 7 天沒有人請假"));
  body.push(...more(offWeek.length - MAXC, "筆"));

  if (pend) body.push({ type: "separator", margin: "lg", color: "#ececf0" }, { type: "text", margin: "lg", size: "sm", wrap: true, contents: [
    { type: "span", text: "📝 待審核：" }, { type: "span", text: pend, weight: "bold", color: "#d70015" }] });

  // 樣式 8・紅黑撞色：紅色標題列＋黑色數字列
  const kpi = (n, label, color) => ({ type: "box", layout: "vertical", flex: 1, backgroundColor: "#2a2a2e", cornerRadius: "10px", paddingAll: "7px", contents: [
    txt(n, { size: "xl", weight: "bold", color, wrap: false, align: "center" }), txt(label, { size: "xxs", color: "#bdbdc2", wrap: false, align: "center" })] });
  return {
    type: "flex",
    altText: `📋 ${md(today)} 今日工作彙報：昨天沒打卡 ${missCnt}・今天上班 ${working.length}・請假 ${offToday.length}${pend ? `・待審核 ${pend}` : ""}`,
    contents: {
      type: "bubble", size: "mega",
      header: { type: "box", layout: "vertical", paddingAll: "0px", contents: [
        { type: "box", layout: "vertical", backgroundColor: "#d70015", paddingAll: "18px", paddingBottom: "14px", contents: [
          txt(`${mdw(today).replace("(", "（").replace(")", "）")}野馬溜冰隊`, { size: "xs", color: "#ffffffcc" }),
          txt("📋 今日工作彙報", { size: "xl", weight: "bold", color: "#ffffff", margin: "xs" })
        ] },
        { type: "box", layout: "horizontal", spacing: "sm", backgroundColor: "#1d1d1f", paddingAll: "12px", paddingStart: "18px", paddingEnd: "18px", contents: [
          kpi(missCnt, "昨日缺卡", "#ff5b6b"), kpi(working.length, "今日上班", "#ffffff"), kpi(offToday.length, "今日請假", "#ffb020"), kpi(offWeek.length, "七日請假", "#b9a6ff")] }
      ] },
      body: { type: "box", layout: "vertical", paddingAll: "18px", contents: body },
      footer: { type: "box", layout: "vertical", paddingTop: "0px", contents: [
        { type: "button", style: "primary", color: "#1d1d1f", height: "sm",
          action: { type: "uri", label: pend ? "前往簽核中心" : "查看今日上班", uri: `${LIFF}?view=${pend ? "approvals" : "today"}` } }
      ] }
    }
  };
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
  dailyDigest: true,        // 每天早上 8:00 早安報告：昨天沒打卡、今天上班／請假、本週請假、待審核 → 一則給管理者
  shiftReminders: false,    // 上下班前後提醒員工（很耗訊息量，預設關閉）
  employeeResults: false,   // 審核結果、薪資發布、代班 → 通知員工（員工打開系統會跳出，預設不發 LINE）
  rosterReminder: true      // 月底下個月班表還沒發布 → 提醒排班的人（25 號、28 號、月底最後一天各一次，發布了就不發）
};
const ROSTER_REMIND_TO = "郭佩珊";        // 負責排班的人（員工姓名）；找不到或沒綁 LINE 就改發給所有管理者
const ROSTER_REMIND_DAYS = [25, 28, "last"];
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

  // 3. 每天早上 8:00 早安報告：昨天沒打卡、今天上班、今天請假、本週請假、待審核（全部都沒有就不發）
  if (NOTIFY.dailyDigest && (manual || daily || inWin(DIGEST_AT, 0))) {
    const mark = (await fs.getPath(`reminders/${today}`)) || {};
    if (!mark.digestSent || manual) {
      const msg = await buildDailyReport(fs, today, LIFF);
      if (msg) result.digest = await toAdmins(msg);
      if (!manual) await fs.patchPath(`reminders/${today}`, { digestSent: true });
    }
  }

  // 3b. 月底提醒排下個月班表（下個月班表還沒發布才發）
  if (NOTIFY.rosterReminder && (manual || daily)) {
    const [y, m, d] = today.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const isDay = ROSTER_REMIND_DAYS.some(x => x === "last" ? d === last : d === x);
    const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    if (isDay || manual) {
      const r = await fs.getPath(`rosters/${nm}`);
      if (!r?.publishedAt) {
        const mark = (await fs.getPath(`reminders/${today}`)) || {};
        if (!mark.rosterSent || manual) {
          const msg = rosterCard(nm, !r, last - d, LIFF);
          const who = (await fs.where("employees", "name", ROSTER_REMIND_TO)).find(e => e.active !== false && String(e.lineUid || "").startsWith("line:"));
          if (who) { await push(env, who.lineUid.slice(5), msg).catch(() => {}); result.roster = ROSTER_REMIND_TO; }
          else result.roster = `管理者 ${await toAdmins(msg)} 位`;
          if (!manual) await fs.patchPath(`reminders/${today}`, { rosterSent: true });
        }
      } else result.roster = `${nm} 已發布`;
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

function rosterCard(nm, none, left, LIFF) {
  const n = +nm.slice(5);
  return card(`📅 記得排 ${n} 月班表`, `${nm.slice(0, 4)}/${n}月班表${none ? "還沒建立" : "已經建立但還沒發布"}`,
    `${ROSTER_REMIND_TO}，${left ? `再 ${left} 天就到 ${n} 月了` : `明天就是 ${n} 月了`}，記得排好班表並按「發布」，員工才看得到喔！`,
    "前往排班", `${LIFF}?view=scheduling`, "#d70015");
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


/* ---------- LINE 訊息 → AI 填申請 ---------- */
const LV_TYPES = ["事假", "病假", "特休", "公假", "其他"];
const ASK_RE = /請假|休假|事假|病假|喪假|婚假|特休|公假|換班|調班|代班|代課|加班|加課|支援|補班|不能去|不能來|沒辦法去|沒辦法來|無法到|上不了|請幫我排|幫我排|我要加|幫我加|多加|加一|加個|要上|我要上|交通車|接送車|接送|夜訓|晨訓|加強班/;
// 用 replyToken 回覆（免費）；token 過期才改用 push（算訊息額度）
async function reply(env, ev, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  try { return await lineApi(env, "/v2/bot/message/reply", { method: "POST", body: JSON.stringify({ replyToken: ev.replyToken, messages: msgs }) }); }
  catch (e) {
    console.error("reply", e);
    if (ev.source?.userId) return lineApi(env, "/v2/bot/message/push", { method: "POST", body: JSON.stringify({ to: ev.source.userId, messages: msgs }) }).catch(() => {});
  }
}
async function draftSig(env, id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.FIREBASE_PRIVATE_KEY || env.LINE_MESSAGING_TOKEN)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const b = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("draft:" + id)));
  return [...b.slice(0, 8)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function handleLineEvents(env, events) {
  for (const ev of events) {
    const userId = ev.source?.userId;
    if (!userId || ev.source?.type !== "user") continue;   // 只處理一對一聊天
    if (ev.type === "message" && ev.message?.type === "text") await handleAskText(env, ev, userId);
    else if (ev.type === "postback") await handleDraftPostback(env, ev, userId);
  }
}
async function handleAskText(env, ev, userId) {
  const text = String(ev.message.text || "").trim().slice(0, 600);
  if (!ASK_RE.test(text) || !env.AI) return;               // 不像請假／加班的訊息 → 不處理，留給管理者手動回覆
  const fs = new Firestore(env);
  const emp = await fs.findByLineUid("line:" + userId);
  const LIFF = "https://liff.line.me/" + (env.LIFF_ID || "2012318362-VOU7aFr9");
  if (!emp || emp.active === false) return reply(env, ev, { type: "text", text: "請先從下方選單打開打卡系統完成綁定，就可以直接傳訊息請假或申請加班喔！" });
  // 顯示「輸入中…」動畫，讓員工知道正在處理（免費）
  lineApi(env, "/v2/bot/chat/loading/start", { method: "POST", body: JSON.stringify({ chatId: userId, loadingSeconds: 20 }) }).catch(() => {});
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const add = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const W = "日一二三四五六", wd = ds => W[new Date(ds + "T00:00:00Z").getUTCDay()];
  const [shifts, emps, sch] = await Promise.all([fs.list("shiftTypes"), fs.list("employees"), fs.whereRange("schedules", "date", today, add(today, 45))]);
  const mm = +today.slice(5, 7);   // 暑訓只在 7、8 月、寒訓只在 1、2 月，其他月份不給 AI 選
  const S = shifts.filter(x => x.cat !== "leave" && !(/暑訓/.test(x.name) && ![7, 8].includes(mm)) && !(/寒訓/.test(x.name) && ![1, 2].includes(mm)));
  const staff = emps.filter(e => e.active !== false && !e.dev && e.id !== emp.id);
  const LV = x => Object.fromEntries(Object.entries(x.leave || {}).filter(([k, v]) => k !== "id" && k !== "_updateTime" && v));
  const mine = sch.filter(x => x.empId === emp.id).sort((a, b) => a.date.localeCompare(b.date));
  const sIdx = Object.fromEntries(S.map((x, i) => [x.id, "S" + (i + 1)]));
  const mineTxt = mine.map(x => `${x.date}(${wd(x.date)}): ` + (x.shiftIds || []).filter(id => sIdx[id] && !LV(x)[id]).map(id => sIdx[id]).join(" ")).filter(l => !l.endsWith(": ")).join("\n") || "（未來 45 天沒有排班）";
  const sys = `你是溜冰隊打卡系統的助理。員工 ${emp.name} 用 LINE 傳了訊息，判斷他是要「請假」還是「加班（申請加入一個沒排到的班）」，轉成 JSON。只輸出 JSON。

今天：${today}（${wd(today)}）
班別清單（代號=名稱｜時間）：
${S.map((x, i) => `S${i + 1}=${x.name}${x.start && x.end ? `｜${x.start}-${x.end}` : ""}`).join("\n")}

${emp.name} 未來的排班（日期: 班別代號）：
${mineTxt}

其他員工（代號=姓名）：
${staff.map((e, i) => `E${i + 1}=${e.name}`).join("\n")}

輸出格式：
{"intent":"leave 或 shift 或 none","items":[{"date":"YYYY-MM-DD","shifts":["S代號"],"leaveType":"事假|病假|特休|公假|其他","sub":"E代號或null"}],"reason":"原因（訊息裡有寫才填，繁體中文）"}

規則：
- 請假、休假、不能去、換班、找人代班 → intent=leave。換班／代班就把代班的人填在 sub。
- 加班、加課、支援、幫我排某個班、「我要加一個夜訓」「今天的 1830 交通車」→ intent=shift，shifts 填要加的班別代號。
- 員工常用的說法：「交通車」「接送」＝班別名稱裡的「接送車」或「交通車」；「1830」「18:30」「六點半」＝上班時間 18:30。
  例如「1830 的交通車」→ 找名稱有接送車／交通車、而且上班時間是 18:30 的班（像 接送車去程(1830-1900)）；「2040 回程」→ 上班時間 20:40 的回程車。
  「夜訓」「晨訓」「下午」「加強班」就找名稱有這幾個字的班；同名有好幾個時，選那個日期的星期幾適用的（名稱後面的「三五」「六日」代表星期三五、六日）。
- 日期：「明天」「下週三」「11/19」都換成 YYYY-MM-DD（今天是 ${today}）。只寫星期幾就選今天之後最近的那天。日期區間要展開成每天一筆。
- 請假的 shifts：有指定班別（例如 夜訓、下午）就填那個；沒指定就填他那天排的全部班。只能選他那天有排的班。
- leaveType 沒說就用「事假」，生病用「病假」。
- 只是聊天、問問題、看不出要請假或加班 → intent=none、items=[]。
- 範例：「明天我要加一個夜訓」→ intent=shift，date=明天，shifts=[迎風溜冰場(夜訓) 的代號]。「今天的1830的交通車」→ intent=shift，date=今天，shifts=[接送車去程(1830-1900) 的代號]。`;
  let data = null;
  for (const model of AI_MODELS) {
    try {
      const r = await env.AI.run(model, { messages: [{ role: "system", content: sys }, { role: "user", content: text }], max_tokens: 1200, temperature: 0.1,
        ...(model.includes("llama") ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
      let out = typeof r === "string" ? r : r?.response ?? r?.choices?.[0]?.message?.content ?? "";
      if (typeof out !== "string") out = JSON.stringify(out);
      const m = out.replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
      if (m) { data = JSON.parse(m[0]); break; }
    } catch (e) { console.error("ai-line", model, e); }
  }
  if (!data || !["leave", "shift"].includes(data.intent)) return;   // 判斷不出來就不回，留給管理者
  const code = c => { const m = /^S(\d+)$/i.exec(String(c || "").trim()); return m ? S[+m[1] - 1] : S.find(x => x.name === c); };
  const ecode = c => { const m = /^E(\d+)$/i.exec(String(c || "").trim()); return m ? staff[+m[1] - 1] : staff.find(e => e.name === c); };
  const isD = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && d >= today && d <= add(today, 120);
  const items = [];
  for (const it of (data.items || []).slice(0, 14)) {
    if (!isD(it.date)) continue;
    const day = mine.find(x => x.date === it.date), lv = day ? LV(day) : {};
    const dayIds = (day?.shiftIds || []).filter(id => !lv[id]);
    if (data.intent === "leave") {
      let ids = (it.shifts || []).map(code).filter(Boolean).map(x => x.id).filter(id => dayIds.includes(id));
      if (!ids.length) ids = dayIds.filter(id => S.some(x => x.id === id));
      if (!ids.length) continue;
      const sub = it.sub ? ecode(it.sub) : null;
      items.push({ date: it.date, shiftIds: ids, leaveType: LV_TYPES.includes(it.leaveType) ? it.leaveType : "事假", subId: sub?.id || "", subName: sub?.name || "" });
    } else {
      for (const sh of (it.shifts || []).map(code).filter(Boolean)) if (!dayIds.includes(sh.id)) items.push({ date: it.date, shiftId: sh.id });
    }
  }
  if (!items.length) return reply(env, ev, { type: "text", text: data.intent === "leave"
    ? "收到！不過那天你好像沒有排班，或我看不出是哪一天。請直接到打卡系統的「請假」填寫，或寫清楚日期再傳一次（例如：11/19 夜訓請假）。"
    : "收到！不過我看不出要加哪一天、哪個班。請寫清楚再傳一次（例如：11/20 迎風夜訓幫我加班）。" });
  const kind = data.intent, reason = String(data.reason || "").slice(0, 100);
  const id = await fs.add("lineDrafts", { empId: emp.id, name: emp.name, kind, items: JSON.stringify(items), reason, text, status: "draft", createdAt: new Date() });
  const sig = await draftSig(env, id);
  const SN = Object.fromEntries(shifts.map(x => [x.id, x]));
  const md = ds => `${+ds.slice(5, 7)}/${+ds.slice(8)}（${wd(ds)}）`;
  const rows = items.map(x => ({ type: "box", layout: "vertical", backgroundColor: "#f6f6f8", cornerRadius: "10px", paddingAll: "10px", margin: "sm", contents: kind === "leave" ? [
    { type: "text", text: `${md(x.date)}・${x.leaveType}`, weight: "bold", size: "sm", color: "#1d1d1f" },
    ...x.shiftIds.map(id => ({ type: "text", text: `${SN[id]?.name || ""}${SN[id]?.start ? ` ${SN[id].start}–${SN[id].end}` : ""}`, size: "xs", color: "#6e6e73", wrap: true })),
    { type: "text", text: x.subName ? `代班：${x.subName}` : "代班：不需代班（或由管理員安排）", size: "xs", color: x.subName ? "#0068e0" : "#8e8e93", wrap: true }
  ] : [
    { type: "text", text: md(x.date), weight: "bold", size: "sm", color: "#1d1d1f" },
    { type: "text", text: `${SN[x.shiftId]?.name || ""}${SN[x.shiftId]?.start ? ` ${SN[x.shiftId].start}–${SN[x.shiftId].end}` : ""}`, size: "xs", color: "#6e6e73", wrap: true }
  ] }));
  await reply(env, ev, { type: "flex", altText: kind === "leave" ? "幫你填好請假申請，請確認" : "幫你填好加班申請，請確認",
    contents: { type: "bubble", size: "mega",
      header: { type: "box", layout: "vertical", backgroundColor: kind === "leave" ? "#d70015" : "#ff9500", paddingAll: "16px", contents: [
        { type: "text", text: kind === "leave" ? "📝 幫你填好請假申請" : "➕ 幫你填好加班申請", weight: "bold", color: "#ffffff", size: "lg" },
        { type: "text", text: "確認內容正確再按「確認送出」", color: "#ffffffcc", size: "xs", margin: "xs" }] },
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: [...rows,
        ...(reason ? [{ type: "text", text: `原因：${reason}`, size: "xs", color: "#6e6e73", margin: "md", wrap: true }] : [])] },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "button", style: "primary", color: "#1d1d1f", height: "sm", action: { type: "postback", label: "確認送出", data: `c|${id}|${sig}`, displayText: "確認送出" } },
        { type: "box", layout: "horizontal", spacing: "sm", contents: [
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "取消", data: `x|${id}|${sig}`, displayText: "取消" } },
          { type: "button", style: "secondary", height: "sm", action: { type: "uri", label: "自己修改", uri: `${LIFF}?view=${kind === "leave" ? "leave" : "clock"}` } }] }
      ] } } });
}
async function handleDraftPostback(env, ev, userId) {
  const [act, id, sig] = String(ev.postback?.data || "").split("|");
  if (!["c", "x"].includes(act) || !id || sig !== await draftSig(env, id)) return;
  const fs = new Firestore(env);
  const d = await fs.getPath(`lineDrafts/${id}`);
  const emp = await fs.findByLineUid("line:" + userId);
  if (!d || !emp || d.empId !== emp.id) return;
  if (d.status !== "draft") return reply(env, ev, { type: "text", text: d.status === "sent" ? "這筆已經送出過了，等管理員審核中。" : "這筆已經取消了。" });
  if (Date.now() - Date.parse(d.createdAt) > 24 * 3600e3) { await fs.patchPath(`lineDrafts/${id}`, { status: "expired" }); return reply(env, ev, { type: "text", text: "這筆已經超過 24 小時，請重新傳一次訊息。" }); }
  if (act === "x") { await fs.patchPath(`lineDrafts/${id}`, { status: "cancelled" }); return reply(env, ev, { type: "text", text: "已取消，沒有送出。" }); }
  const items = JSON.parse(d.items || "[]");
  const SN = Object.fromEntries((await fs.list("shiftTypes")).map(x => [x.id, x]));
  const base = { empId: emp.id, name: emp.name, empNo: emp.empNo || "", status: "pending", notified: false, createdAt: new Date(), source: "line", lineDraftId: id };
  const made = [];
  for (const x of items) {
    if (d.kind === "leave") {
      const subs = x.subId ? Object.fromEntries(x.shiftIds.map(s => [s, x.subId])) : {};
      const subNames = x.subId ? Object.fromEntries(x.shiftIds.map(s => [s, x.subName])) : {};
      made.push(["leaveRequests", await fs.add("leaveRequests", { ...base, date: x.date, month: x.date.slice(0, 7), shiftIds: x.shiftIds,
        shiftNames: x.shiftIds.map(s => SN[s]?.name || ""), leaveType: x.leaveType, reason: d.reason || "", subNeed: !!x.subId, subName: x.subName || "", subs, subNames })]);
    } else {
      made.push(["shiftRequests", await fs.add("shiftRequests", { ...base, date: x.date, month: x.date.slice(0, 7), shiftId: x.shiftId, shiftName: SN[x.shiftId]?.name || "", reason: d.reason || "" })]);
    }
  }
  await fs.patchPath(`lineDrafts/${id}`, { status: "sent", sentAt: new Date() });
  await reply(env, ev, { type: "text", text: `✅ 已送出 ${made.length} 筆${d.kind === "leave" ? "請假" : "加班"}申請，等管理員審核。\n審核結果會在打卡系統通知你。` });
  for (const [coll, rid] of made) await notifyNew(env, coll, rid).catch(() => {});
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
// 免費方案可用、中文好的模型（依序嘗試）
const AI_MODELS = ["@cf/qwen/qwen3.8-27b", "@cf/zai-org/glm-4.7-flash", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
async function aiSchedule(env, text, ctx, prefer) {
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
{"actions":[{"op":"add 或 remove 或 clear","emp":"E代號","shift":"S代號或null","time":"HH:MM-HH:MM 或 null","dates":["YYYY-MM-DD"],"weekdays":[0到6],"from":"YYYY-MM-DD","to":"YYYY-MM-DD","reason":"10字內繁體中文說明"}],"notes":["看不懂或需要管理者確認的地方（繁體中文）"]}

規則：
- op：add=排入這個班；remove=取消這個人的這個班；clear=這些日期把這個人所有班都清掉。
- 只取消某一個班（例如「之後週六晨訓不排他」「取消週六晨訓」）→ 只輸出一個 remove，不要再加 clear。
- 「都不排班」「請假」「離職」這種整天都不上 → clear。
- emp 用員工代號。訊息裡的稱呼可能是暱稱（阿翔=名字有「翔」、少了姓氏或加了「教練」），請找最像的員工；只有姓氏相同不算，找不到就不要輸出這個動作，寫進 notes。
- 訊息開頭的稱呼（例如「佩珊，請幫我…」）是在跟排班的人說話，不是要排班的人。
- shift 用班別代號。可依地點名稱、晨訓/夜訓、時間（0900-1030 = 09:00-10:30）比對；找不到班別就 shift 填 null 並把時間填在 time。
- 學校名稱常用縮寫：例如 麗山國小=麗小、新湖國小=新湖、麗山國中=麗中，對應「學校課堂(縮寫)」這類班別。「暑訓」只用在 7、8 月，「寒訓」只用在 1、2 月，其他月份不要選。
- 日期：有明確日期就放 dates（例如 10/13 → 年份選離目前班表月份最近的那年）。日期區間（10/13-10/21）或「之後都」「每週」這種，用 weekdays（0=日,1=一,…,6=六）加 from/to。
- 只處理目前班表月份（${ctx.month}）：from 不可早於這個月第一天，to 不可晚於這個月最後一天。「X起」「之後都」就是整個月。
- 同一個人、同一個 op、同一個班的多個星期幾，合併成一個動作（weekdays 放多個）。
- 「預計」「再確認」的排班也照樣輸出，但在 reason 註明「待確認」。
- 請假且有人代課：請假的人在那些日期用 clear（或指定班別就用 remove），代課的人用 add。
- 費用、薪資等跟排班無關的資訊放進 notes。
- 所有文字都用繁體中文。`;
  let lastErr;
  const order = AI_MODELS.includes(prefer) ? [prefer, ...AI_MODELS.filter(m => m !== prefer)] : AI_MODELS;
  for (const model of order) {
    try {
      const r = await env.AI.run(model, {
        messages: [{ role: "system", content: sys }, { role: "user", content: text }],
        max_tokens: 3000, temperature: 0.1,
        ...(model.includes("llama") ? {} : { chat_template_kwargs: { enable_thinking: false } })
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
