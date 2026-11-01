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
 */

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const path = new URL(req.url).pathname;
    try {
      const body = await req.json().catch(() => ({}));
      const line = await verifyLine(body.idToken, env);
      if (!line?.sub) return json({ error: "invalid_token" }, 401);

      const uid = "line:" + line.sub;
      const fs = new Firestore(env);

      if (path === "/auth") {
        const emp = await fs.findByLineUid(uid);
        if (emp && emp.active !== false) {
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
  if (!idToken) return null;
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: env.LINE_CHANNEL_ID })
  });
  return r.ok ? r.json() : null;
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
