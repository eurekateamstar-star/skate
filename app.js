import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithCustomToken, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, doc, getDoc, setDoc as _setDoc, updateDoc as _updateDoc, deleteDoc as _deleteDoc, addDoc as _addDoc,
  collection, query, where, getDocs, serverTimestamp, writeBatch as _writeBatch, deleteField, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, LIFF_ID, WORKER_URL } from "./config.js?v=95";

/* 整個月的大量查詢（報表、薪資、排班）暫存 3 分鐘，省 Firestore 讀取額度；任何寫入都會清掉暫存 */
const MEMO = new Map();
const MEMO_TTL = 3 * 60e3;
const setDoc = (...a) => { MEMO.clear(); return _setDoc(...a); };
const updateDoc = (...a) => { MEMO.clear(); return _updateDoc(...a); };
const deleteDoc = (...a) => { MEMO.clear(); return _deleteDoc(...a); };
const addDoc = (...a) => { MEMO.clear(); return _addDoc(...a); };
const writeBatch = d => { const b = _writeBatch(d); const c = b.commit.bind(b); b.commit = () => { MEMO.clear(); return c(); }; return b; };
function collDocs(coll) {
  const k = coll + "|*", hit = MEMO.get(k);
  if (hit && Date.now() - hit.at < MEMO_TTL) return hit.p;
  const p = getDocs(collection(db, coll));
  MEMO.set(k, { at: Date.now(), p });
  p.catch(() => MEMO.delete(k));
  return p;
}
function monthDocs(coll, month) {
  const k = coll + "|" + month, hit = MEMO.get(k);
  if (hit && Date.now() - hit.at < MEMO_TTL) return hit.p;
  const p = getDocs(query(collection(db, coll), where("month", "==", month)));
  MEMO.set(k, { at: Date.now(), p });
  p.catch(() => MEMO.delete(k));
  return p;
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// LINE App 內建瀏覽器用 long polling 連線，避免 Firestore 卡住
const IN_LINE = /\bLine\//i.test(navigator.userAgent);
const db = initializeFirestore(app, IN_LINE ? { experimentalForceLongPolling: true } : { experimentalAutoDetectLongPolling: true });
let liff = null;   // LINE SDK：只有需要登入時才載入，已登入者不必等

/* ================= 工具 ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = d => ymd(d).slice(0, 7);
const hms = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : "";
const hm = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
const WEEK = "日一二三四五六";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2500);
}
// App 風格對話框（取代瀏覽器內建 confirm / alert）
function appDialog({ title = "", message = "", buttons = [{ text: "好", value: true, style: "primary" }], input = null, select = null }) {
  return new Promise(resolve => {
    const mask = $("#dlg");
    const inp = $("#dlgInput");
    const sel = $("#dlgSelect");
    sel.classList.toggle("hidden", !select);
    if (select) sel.innerHTML = select.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
    inp.classList.toggle("hidden", !input);
    if (input) { inp.type = input.type || "text"; inp.value = input.value || ""; inp.placeholder = input.placeholder || ""; }
    $("#dlgTitle").textContent = title;
    $("#dlgMsg").textContent = message;
    $("#dlgTitle").classList.toggle("hidden", !title);
    $("#dlgBtns").className = "dlg-btns" + (buttons.length > 2 ? " col" : "");
    $("#dlgBtns").innerHTML = buttons.map((b, i) => `<button data-i="${i}" class="${b.style || ""}">${esc(b.text)}</button>`).join("");
    mask.classList.remove("hidden");
    requestAnimationFrame(() => mask.classList.add("open"));
    $("#dlgBtns").onclick = e => {
      const btn = e.target.closest("button[data-i]");
      if (!btn) return;
      mask.classList.remove("open");
      setTimeout(() => mask.classList.add("hidden"), 180);
      const v = buttons[+btn.dataset.i].value;
      resolve(v === true && select ? sel.value : input && v === true ? inp.value : v);
    };
  });
}
const appConfirm = (title, message, { okText = "確定", danger = false } = {}) =>
  appDialog({ title, message, buttons: [{ text: "取消", value: false }, { text: okText, value: true, style: danger ? "danger" : "primary" }] });
const appAlert = (title, message) => appDialog({ title, message });

function daysOfMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => new Date(y, m - 1, i + 1));
}
function prevMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return ym(new Date(y, m - 2, 1));
}
function dayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
}
function errMsg(err) {
  const map = { "permission-denied": "權限不足", "unavailable": "網路連線異常", "resource-exhausted": "Firebase 今日免費讀取額度已用完（台灣時間下午 4 點後恢復）" };
  return map[err.code] || err.message;
}

// 送出請假／加入班表後，請 Worker 立刻用 LINE 通知管理者（失敗也沒關係，早上 8:00 會再彙整）
function notifyAdmins(coll, id) {
  fetch(WORKER_URL + "/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ coll, id }), keepalive: true }).catch(() => {});
}

// 手機版用新版面、電腦版用原本的表格
const isMob = () => innerWidth <= 768;
let lastMob = isMob();
addEventListener("resize", () => {
  const m = isMob();
  if (m === lastMob) return; lastMob = m;
  const v = $$(".view").find(x => !x.classList.contains("hidden"))?.id;
  if (v === "view-report" && reportRows?.length) renderReport();
  if (v === "view-shifts") renderShiftList();
  if (v === "view-payroll" && pay.tab === "rates") renderRates();
});

// 班別依上班時間排序（沒設時間的放最後）
const byTime = ids => [...(ids || [])].sort((a, b) => (shiftMap[a]?.start || "99:99").localeCompare(shiftMap[b]?.start || "99:99") || (shiftMap[a]?.end || "").localeCompare(shiftMap[b]?.end || ""));


/* ---- 收合／展開（記住狀態）---- */
const FOLD_KEY = "punch_fold_v1";
let folds = {}; try { folds = JSON.parse(localStorage.getItem(FOLD_KEY) || "{}"); } catch {}
function applyFold(id) {
  const el = document.getElementById(id); if (!el) return;
  const closed = !!folds[id]; el.classList.toggle("folded", closed);
  $$(`[data-fold="${id}"]`).forEach(b => { b.classList.toggle("closed", closed); if (b.tagName === "BUTTON" && !b.classList.contains("fold-head")) b.textContent = closed ? "展開" : "收合"; });
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-fold]"); if (!b) return;
  const id = b.dataset.fold; folds[id] = !folds[id];
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(folds)); } catch {}
  applyFold(id);
});
["locBody", "shBody", "palBody"].forEach(id => setTimeout(() => applyFold(id)));

/* ---- 拖曳排序（滑鼠、手指都可以）---- */
let dragJustEnded = false;
function sortable(container, itemSel, handleSel, onEnd) {
  container.addEventListener("pointerdown", e => {
    const h = handleSel ? e.target.closest(handleSel) : e.target.closest(itemSel);
    if (!h || !container.contains(h) || e.button > 0) return;
    const item = h.closest(itemSel); if (!item) return;
    const sx = e.clientX, sy = e.clientY; let dragging = false;
    const move = ev => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true; item.classList.add("dragging"); document.body.classList.add("is-dragging");
      }
      ev.preventDefault();
      item.style.pointerEvents = "none";
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(itemSel);
      item.style.pointerEvents = "";
      if (!over || over === item || over.parentNode !== item.parentNode) return;
      const r = over.getBoundingClientRect();
      const before = ev.clientY < r.top || (ev.clientY < r.bottom && (r.width > r.height * 3 ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2));
      over.parentNode.insertBefore(item, before ? over : over.nextSibling);
    };
    const up = () => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
      if (!dragging) return;
      item.classList.remove("dragging"); document.body.classList.remove("is-dragging");
      dragJustEnded = true; setTimeout(() => dragJustEnded = false, 50);
      onEnd([...item.parentNode.querySelectorAll(itemSel)].map(x => x.dataset.id || x.dataset.pick || x.dataset.sid));
    };
    addEventListener("pointermove", move, { passive: false }); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  });
  container.addEventListener("click", e => { if (dragJustEnded) { e.stopPropagation(); e.preventDefault(); } }, true);
}
// 依新順序寫回 order（只改有變的）
async function saveOrder(coll, list, ids) {
  const all = list.map(x => x.id);
  const pos = ids.map(id => all.indexOf(id)).filter(i => i >= 0).sort((a, b) => a - b);
  pos.forEach((p, i) => all[p] = ids[i]);
  const batch = writeBatch(db); let n = 0;
  all.forEach((id, i) => { const x = list.find(y => y.id === id); const o = (i + 1) * 10; if (x && x.order !== o) { x.order = o; batch.update(doc(db, coll, id), { order: o }); n++; } });
  list.sort((a, b) => all.indexOf(a.id) - all.indexOf(b.id));
  if (n) await batch.commit().then(() => toast("已更新順序")).catch(err => toast("順序儲存失敗：" + errMsg(err)));
}

/* ================= 狀態 ================= */
let me = null;          // 目前登入的員工 {id, name, empNo, role, ...}
let shiftTypes = [];
let shiftMap = {};
let employees = [];     // 員工清單（管理者用）
let staff = [];         // 員工名單（只有 id／姓名，所有人可讀，選代班用）

function shiftHours(s) {
  if (!s.start || !s.end) return "";
  const m = t => { const [h, mm] = t.split(":").map(Number); return h * 60 + mm; };
  let d = m(s.end) - m(s.start);
  if (d < 0) d += 1440;
  if (s.breakStart && s.breakEnd) d -= Math.max(0, m(s.breakEnd) - m(s.breakStart));
  return `${Math.floor(d / 60)} 小時 ${d % 60} 分鐘`;
}
const shiftTip = s => s.start && s.end ? `上班時間：${s.start} - ${s.end}` : (s.cat === "leave" ? "休假" : "未設定時間");
const chipHtml = (id, withX = false) => {
  const s = shiftMap[id];
  if (!s) return "";
  return `<span class="chip" style="background:${esc(s.color)}" data-sid="${id}" title="${esc(shiftTip(s))}">${esc(s.name)}${withX ? '<span class="x">×</span>' : ""}</span>`;
};

/* ================= LINE 登入 / 綁定 ================= */
const STEPS = ["stepLogin", "stepPick", "stepEmail"];
const redirectUri = () => location.origin + location.pathname;

function showLogin(step = "stepLogin") {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  $("#authLoading").classList.add("hidden");
  STEPS.forEach(s => $("#" + s).classList.toggle("hidden", s !== step));
}
function loading() {
  $("#appView").classList.add("hidden");
  $("#loginView").classList.remove("hidden");
  $("#authLoading").classList.remove("hidden");
  STEPS.forEach(s => $("#" + s).classList.add("hidden"));
}
const setMsg = m => $("#authMsg").textContent = m || "";

let liffReady = null, liffErr = null;

// 圖文選單深層連結：?view=records 或 LIFF 的 liff.state=?view=records
// LINE 開啟時網址帶 liff.state，先自己轉成正常網址，避免之後 liff.init 重新整理頁面
(() => {
  const p = new URLSearchParams(location.search), st = p.get("liff.state");
  if (st == null) return;
  const q = new URLSearchParams(st.includes("?") ? st.split("?")[1] : st);
  p.delete("liff.state"); q.forEach((v, k) => p.set(k, v));
  window.history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : "") + location.hash);
})();
const START = (() => {
  const p = new URLSearchParams(location.search);
  let view = p.get("view"), mode = p.get("mode");
  const st = p.get("liff.state");
  if (!view && st) { const q = new URLSearchParams(st.includes("?") ? st.split("?")[1] : st); view = q.get("view"); mode = q.get("mode"); }
  return { view, mode };
})();
function firstView() {
  const v = START.view;
  if (!v || !document.getElementById("view-" + v)) return "clock";
  if (ADMIN_VIEWS.includes(v) && me?.role !== "admin") return "clock";
  if (v === "mySchedule" && START.mode === "all") mySchMode = "all";
  return v;
}
function getLiff() {
  return liffReady ??= new Promise((res, rej) => {
    if (window.liff) return res();
    const sc = document.createElement("script");
    sc.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    sc.onload = res; sc.onerror = () => rej(new Error("LINE SDK 載入失敗"));
    document.head.appendChild(sc);
  }).then(() => { liff = window.liff; return withTimeout(liff.init({ liffId: LIFF_ID }), 15000, "LINE 初始化逾時"); })
    .then(() => true).catch(e => { liffErr = e; return false; });
}

// 資料讀取要等登入狀態確認後才開始
let authOk;
const authReady = new Promise(r => authOk = r);

async function boot() {
  const cache = readCache();
  const authUser = new Promise(res => { const un = onAuthStateChanged(auth, u => { un(); res(u); }); });

  // 秒開：有快取就先顯示畫面，背景再確認登入
  if (cache?.me && cache.uid) {
    me = cache.me;
    shiftTypes = cache.shiftTypes || [];
    shiftMap = Object.fromEntries(shiftTypes.map(s => [s.id, s]));
    locations = cache.locations || [];
    locMap = Object.fromEntries(locations.map(l => [l.id, l]));
    showShell();
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    showView(firstView());
    if (/ Line\//i.test(navigator.userAgent)) setTimeout(() => getLiff(), 600);   // 背景先準備 LINE 功能（分享用）
    const user = await authUser;
    if (user && user.uid === cache.uid) {
      const { claims } = await user.getIdTokenResult().catch(() => ({ claims: {} }));
      if (claims.empId === cache.me.id) {
        authOk();
        verifyMe(user, claims.empId).then(showShell).catch(async err => {
          console.error(err);
          if (err.code === "unbound" || err.code === "permission-denied") {
            clearCache(); await signOut(auth); me = null;
            setMsg("你的帳號已停用或解除綁定，請重新登入");
            showLogin();
          }
        });
        return;
      }
    }
    // 快取對不上 → 回到正常登入流程
    me = null; clearCache();
    $("#appView").classList.add("hidden");
  }

  loading();
  const user = await authUser;
  if (user) {
    if (await enterApp(user)) return;
    if ($("#authMsg").textContent) return showLogin();   // 顯示失敗原因，按按鈕重試
  }
  if (!(await getLiff())) {
    setMsg("LINE 初始化失敗，請確認 config.js 的 LIFF_ID：" + (liffErr?.message || ""));
    return showLogin();
  }
  if (liff.isLoggedIn()) return lineAuth();
  showLogin();
}

async function callWorker(path, data = {}) {
  if (!(await getLiff())) throw new Error("LINE 初始化失敗：" + (liffErr?.message || ""));
  const idToken = liff.getIDToken();
  if (!idToken) {
    if (liff.isInClient()) throw new Error("取不到 LINE 身分，請確認 LIFF 的 Scopes 有勾 openid");
    liff.login({ redirectUri: redirectUri() }); throw new Error("redirect");
  }
  let r;
  try {
    r = await withTimeout(fetch(WORKER_URL.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, ...data })
    }), 15000, "連線 Worker 逾時");
  } catch (e) {
    throw new Error("無法連線到驗證伺服器（Worker）：" + e.message);
  }
  const d = await r.json().catch(() => ({ error: "伺服器回應錯誤（HTTP " + r.status + "）" }));
  if (d.error === "invalid_token") {
    // LINE 登入過期 → 外部瀏覽器重新登入一次；LINE App 內或已重試過就直接顯示錯誤，避免卡住
    let retried = false;
    try { retried = sessionStorage.getItem("lineRetry") === "1"; } catch {}
    if (liff.isInClient() || retried) {
      try { sessionStorage.removeItem("lineRetry"); } catch {}
      throw new Error("LINE 身分驗證失敗。" + tokenInfo(idToken) + (d.detail ? "｜" + d.detail : "｜（Worker 尚未更新為新版，看不到 LINE 的詳細原因）"));
    }
    try { sessionStorage.setItem("lineRetry", "1"); } catch {}
    liff.logout();
    liff.login({ redirectUri: redirectUri() });
    throw new Error("redirect");
  }
  try { sessionStorage.removeItem("lineRetry"); } catch {}
  if (d.error === "server_error") throw new Error("Worker 錯誤：" + (d.message || "") + "（請檢查 Worker 變數設定）");
  return d;
}

// 解析 LINE idToken 內容，方便排錯（只讀取，不驗證）
function tokenInfo(t) {
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))));
    const left = Math.round((p.exp * 1000 - Date.now()) / 60000);
    return `token 的 Channel ID=${p.aud}，${left > 0 ? `剩 ${left} 分鐘到期` : `已過期 ${-left} 分鐘`}`;
  } catch { return "token 無法解析"; }
}

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

// 任何未預期的錯誤都顯示出來，不要卡在「載入中」
function showFatal(e) {
  if (!me) { setMsg("發生錯誤：" + (e?.message || e)); showLogin(); }
}
window.addEventListener("error", e => showFatal(e.error || e.message));
window.addEventListener("unhandledrejection", e => showFatal(e.reason));

let picked = null;

async function lineAuth() {
  loading(); setMsg("");
  try {
    const d = await callWorker("/auth");
    if (d.error === "disabled") throw new Error("你的帳號已被停用，請聯絡管理者");
    if (d.error) throw new Error(d.message || d.error);
    if (d.bound) return finishLogin(d.token);

    $("#lineName").textContent = d.lineName || "";
    const list = d.candidates || [];
    $("#candList").innerHTML = list.length
      ? list.map(c => `<button class="cand" data-id="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)}</button>`).join("")
      : `<p class="empty">目前沒有可綁定的員工，請聯絡管理者先建立你的資料。</p>`;
    showLogin("stepPick");
  } catch (e) {
    if (e.message === "redirect") return;
    setMsg("登入失敗：" + e.message);
    showLogin();
  }
}

async function finishLogin(token) {
  let cred;
  try {
    cred = await signInWithCustomToken(auth, token);
  } catch (e) {
    setMsg("Firebase 登入失敗：" + (e.code || e.message) + "（請確認 Authentication 已啟用、Worker 的服務帳戶變數正確）");
    return showLogin();
  }
  if (!await enterApp(cred.user)) {
    if (!$("#authMsg").textContent) setMsg("找不到員工資料或帳號已停用");
    showLogin();
  }
}

$("#lineLoginBtn").onclick = async () => {
  setMsg("");
  if (!(await getLiff())) return setMsg("LINE 初始化失敗：" + (liffErr?.message || ""));
  if (!liff.isLoggedIn()) liff.login({ redirectUri: redirectUri() });
  else lineAuth();
};

$("#candList").onclick = e => {
  const b = e.target.closest(".cand");
  if (!b) return;
  picked = { id: b.dataset.id, name: b.dataset.name };
  $("#pickName").textContent = picked.name;
  $("#bindEmail").value = "";
  setMsg("");
  showLogin("stepEmail");
  $("#bindEmail").focus();
};
$("#backPick").onclick = () => { setMsg(""); showLogin("stepPick"); };

$("#bindForm").onsubmit = async e => {
  e.preventDefault();
  if (!picked) return;
  $("#bindBtn").disabled = true; setMsg("");
  try {
    const d = await callWorker("/bind", { empId: picked.id, email: $("#bindEmail").value.trim() });
    const msgs = {
      email_mismatch: `Email 不正確，還可以再試 ${d.left} 次`,
      locked: "嘗試太多次已鎖定，請聯絡管理者解除",
      already_bound: "這位員工已經綁定其他 LINE 帳號",
      already_bound_line: "你的 LINE 已經綁定其他員工",
      not_found: "找不到這位員工"
    };
    if (d.error) return setMsg(msgs[d.error] || d.message || d.error);
    toast("綁定成功！");
    await finishLogin(d.token);
  } catch (err) {
    if (err.message !== "redirect") setMsg("綁定失敗：" + err.message);
  } finally {
    $("#bindBtn").disabled = false;
  }
};

$("#logoutBtn").onclick = async () => {
  await signOut(auth);
  clearCache();
  try { if (liffReady && await liffReady && liff.isLoggedIn() && !liff.isInClient()) liff.logout(); } catch {}
  me = null;
  setMsg("");
  showLogin();
};

async function enterApp(user) {
  try {
    return await withTimeout(enterAppInner(user), 20000, "讀取資料庫逾時，請檢查網路後重試");
  } catch (err) {
    console.error(err);
    setMsg("進入系統失敗：" + errMsg(err));
    try { await signOut(auth); } catch {}
    return false;
  }
}

// 本機快取：第二次開啟立即顯示，背景再確認
const CACHE_KEY = "punch_cache_v1";
const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { return null; } };
const writeCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: auth.currentUser?.uid, me, shiftTypes, locations })); } catch {} };
const clearCache = () => { try { localStorage.removeItem(CACHE_KEY); } catch {} };

function showShell() {
  $("#userName").textContent = `${me.name}${me.role === "admin" ? "（管理者）" : ""}`;
  if (me.linePicture) { $("#userPic").src = me.linePicture; $("#userPic").classList.remove("hidden"); }
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", me.role !== "admin"));
}

async function verifyMe(user, empId) {
  const [snap] = await Promise.all([getDoc(doc(db, "employees", empId)), loadShiftTypes()]);
  const d = snap.exists() ? snap.data() : null;
  if (!d || d.lineUid !== user.uid || d.active === false) throw Object.assign(new Error("帳號已停用或已解除綁定"), { code: "unbound" });
  me = { id: snap.id, ...d };
  writeCache();
  return me;
}

async function enterAppInner(user) {
  try {
    const { claims } = await user.getIdTokenResult();
    if (!claims.empId) { await signOut(auth); return false; }
    const cache = readCache();
    if (cache && cache.uid === user.uid && cache.me?.id === claims.empId) {
      // 快速路徑：先用快取畫面，背景確認
      me = cache.me;
      shiftTypes = cache.shiftTypes || [];
      shiftMap = Object.fromEntries(shiftTypes.map(s => [s.id, s]));
      showShell();
      $("#loginView").classList.add("hidden");
      $("#appView").classList.remove("hidden");
      authOk();
      showView(firstView());
      verifyMe(user, claims.empId).then(showShell).catch(async err => {
        console.error(err);
        if (err.code === "unbound" || err.code === "permission-denied") {
          clearCache(); await signOut(auth); me = null;
          setMsg("你的帳號已停用或解除綁定，請重新登入");
          showLogin();
        }
      });
      return true;
    }
    await verifyMe(user, claims.empId);
    showShell();
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    authOk();
    showView(firstView());
    return true;
  } catch (err) {
    console.error(err);
    clearCache();
    setMsg(err.code === "unbound" ? "找不到員工資料或帳號已停用" : "讀取員工資料失敗：" + errMsg(err) + "（請確認 firestore.rules 已發布）");
    await signOut(auth);
    return false;
  }
}

/* ================= 導覽 ================= */
const loaders = {
  clock: loadClock,
  records: loadRecords,
  mySchedule: loadMySchedule,
  employees: loadEmployeesView,
  shifts: renderShiftList,
  scheduling: loadSchedulingView,
  report: loadReport,
  payroll: loadPayroll,
  mypay: loadMyPay,
  leave: loadLeaveView,
  approvals: loadApprovals,
  today: loadTodayView
};
const TITLES = {
  clock: "打卡", records: "出勤紀錄", mySchedule: "我的班表", scheduling: "排班作業",
  report: "出勤報表", employees: "員工管理", shifts: "班別設定", payroll: "薪資計算",
  leave: "請假", approvals: "簽核中心", mypay: "我的薪資", today: "今日上班"
};
const ADMIN_VIEWS = ["today", "approvals", "scheduling", "report", "payroll", "employees", "shifts"];
function showView(name) {
  $$(".view").forEach(v => v.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $$("[data-view]").forEach(a => a.classList.toggle("active", a.dataset.view === name));
  $("#moreBtn").classList.toggle("active", ADMIN_VIEWS.includes(name));
  $("#pageTitle").textContent = innerWidth <= 768 ? TITLES[name] : "打卡系統";
  closeSheet();
  scrollTo(0, 0);
  if (name === "scheduling" && !$("#view-scheduling").dataset.keep) schMode = "list";
  if (name !== "clock") stopGeo();
  if (name === "clock") renderClockCache();
  // 讀取超過 0.3 秒就在上方顯示進度條，不會看起來一片空白
  const seq = ++loadSeq;
  const t = setTimeout(() => { if (seq === loadSeq) document.body.classList.add("is-loading"); }, 300);
  // 超過 5 秒還沒好 → 顯示重新整理提示
  const t5 = setTimeout(() => { if (seq === loadSeq) document.body.classList.add("is-slow"); }, 5000);
  document.body.classList.remove("is-slow");
  authReady.then(() => loaders[name]?.()).catch(err => { console.error(err); toast("載入失敗：" + errMsg(err)); })
    .finally(() => { clearTimeout(t); clearTimeout(t5); if (seq === loadSeq) document.body.classList.remove("is-loading", "is-slow"); });
}
let loadSeq = 0;
$$("[data-view]").forEach(a => a.onclick = () => showView(a.dataset.view));

// 手機版管理選單
function openSheet() { $("#sheetMask").classList.remove("hidden"); requestAnimationFrame(() => $("#sheet").classList.add("open")); }
function closeSheet() { $("#sheet").classList.remove("open"); $("#sheetMask").classList.add("hidden"); }
$("#moreBtn").onclick = openSheet;
$("#sheetMask").onclick = closeSheet;

// 手機版表格變卡片：自動把表頭文字填到每格的 data-label
function labelTable(tbl) {
  const rows = tbl.querySelectorAll("thead tr");
  const heads = rows.length ? [...rows[rows.length - 1].querySelectorAll("th")].map(th => th.textContent.trim()) : [];
  tbl.querySelectorAll("tbody tr").forEach(tr =>
    [...tr.children].forEach((td, i) => td.dataset.label ??= heads[i] || ""));
}
new MutationObserver(muts => {
  const set = new Set();
  muts.forEach(m => { const t = m.target.closest?.("table.tbl"); if (t) set.add(t); });
  set.forEach(labelTable);
}).observe(document.body, { childList: true, subtree: true });

const thisMonth = ym(new Date());
["#recMonth", "#mySchMonth", "#schMonth", "#repMonth", "#payMonth", "#mpMonth"].forEach(s => $(s).value = thisMonth);
$("#mpMonth").value = prevMonth(thisMonth);   // 我的薪資：預設上個月（本月要下個月 1 號才開放）
$("#recMonth").onchange = () => loadRecords();
$("#mySchMonth").onchange = () => loadMySchedule();
$("#schMonth").onchange = () => loadScheduling();
$("#repMonth").onchange = () => loadReport();

/* ================= 班別 ================= */
async function loadShiftTypes() {
  const snap = await collDocs("shiftTypes");
  shiftTypes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  shiftMap = Object.fromEntries(shiftTypes.map(s => [s.id, s]));
  if (me) writeCache();
}
function shiftWindow(ids) {
  const ss = (ids || []).map(id => shiftMap[id]).filter(s => s && s.start && s.end);
  if (!ss.length) return null;
  return { start: ss.map(s => s.start).sort()[0], end: ss.map(s => s.end).sort().at(-1) };
}
const isLeaveDay = ids => (ids || []).length > 0 && ids.every(id => shiftMap[id]?.cat === "leave");

/* ================= 打卡 ================= */
setInterval(tick, 1000); tick();
function tick() {
  const d = new Date();
  $("#nowTime").textContent = hms(d);
  $("#nowDate").textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
}

const mapLink = r => r.lat != null
  ? `<a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener">查看地圖</a>`
  : "—";

// ---- 打卡地點 ----
let locations = [], locMap = {};
async function loadLocations() {
  const snap = await collDocs("locations");
  locations = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 1e12) - (b.order ?? 1e12) || (a.name || "").localeCompare(b.name || ""));
  locMap = Object.fromEntries(locations.map(l => [l.id, l]));
}
function distM(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function parseCoord(str) {
  const m = String(str || "").match(/(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}

// ---- 定位 ----
const geo = { pos: null, acc: null, err: null, watch: null, first: true };
function startGeo() {
  if (!navigator.geolocation) { geo.err = "這個裝置不支援定位"; return onGeo(); }
  if (geo.watch != null) return;
  geo.watch = navigator.geolocation.watchPosition(p => {
    geo.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
    geo.acc = Math.round(p.coords.accuracy);
    geo.err = null;
    if (geo.first) { geo.first = false; mapFitted = false; }
    onGeo();
  }, e => {
    geo.err = e.code === 1 ? "請允許定位權限才能打卡（LINE 右上角 ⋮ → 設定，或手機設定開啟定位）" : "暫時無法取得定位，請到戶外或稍後再試";
    onGeo();
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
}
function stopGeo() {
  if (geo.watch != null) { navigator.geolocation.clearWatch(geo.watch); geo.watch = null; }
}
function onGeo() {
  const line = $("#gpsLine");
  line.className = "gps-line " + (geo.err ? "bad" : geo.pos ? "ok" : "wait");
  $("#gpsText").textContent = geo.err || (geo.pos ? `已定位・精準度約 ${geo.acc} 公尺` : "定位中…");
  if (!$("#view-clock").classList.contains("hidden")) { renderPunchCards(); updateClockMap(); }
}
// 是否在打卡範圍內
function rangeCheck(loc) {
  if (!loc) return { ok: true, cls: "none", text: "此班別未設定打卡地點，不限地點" };
  if (geo.err) return { ok: false, cls: "far", text: geo.err };
  if (!geo.pos) return { ok: false, cls: "wait", text: `${loc.name}・定位中…` };
  const d = Math.round(distM(geo.pos, loc));
  const ok = d <= (loc.radius || 50) + Math.min(geo.acc || 0, 30);
  return { ok, cls: ok ? "ok" : "far", d, text: ok ? `${loc.name}・距離 ${d} 公尺，可以打卡` : `${loc.name}・距離 ${d} 公尺，超出範圍（打卡需填原因）` };
}

// ---- 地圖（Leaflet）----
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return leafletP ??= new Promise((res, rej) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const sc = document.createElement("script");
    sc.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    sc.onload = () => res(window.L); sc.onerror = rej;
    document.head.appendChild(sc);
  });
}
const TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
function newMap(L, el) {
  const m = L.map(el, { zoomControl: false, attributionControl: true });
  L.tileLayer(TILE, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(m);
  return m;
}

// 班別的上班 / 下班打卡地點（沒設定下班地點 = 和上班相同）
const locFor = (s, type) => locMap[(type === "out" && s?.outLocationId) ? s.outLocationId : s?.locationId];

// ---- 今日班別打卡 ----
let clockShifts = [], extraShifts = [], todayRecs = [], clockLeave = {};
let cMap = null, cLayer = null, mapFitted = false;
const punchIds = () => [...new Set([...clockShifts, ...extraShifts])].filter(id => shiftMap[id])
  .sort((a, b) => (shiftMap[a].start || "99").localeCompare(shiftMap[b].start || "99"));

const CLOCK_KEY = "punch_clock_v1";
function saveClockCache() {
  try {
    localStorage.setItem(CLOCK_KEY, JSON.stringify({ date: ymd(new Date()), emp: me.id, shifts: clockShifts, leave: clockLeave,
      recs: todayRecs.map(r => ({ type: r.type, shiftId: r.shiftId, t: +r.t, outOfRange: !!r.outOfRange })) }));
  } catch {}
}
function renderClockCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CLOCK_KEY) || "null");
    if (!c || c.date !== ymd(new Date()) || c.emp !== me?.id) return;
    clockShifts = c.shifts || [];
    clockLeave = c.leave || {};
    todayRecs = (c.recs || []).map(r => ({ ...r, t: new Date(r.t) }));
    renderPunchCards();
  } catch {}
  startGeo();   // 定位也先開始，不必等資料
}
async function loadClock() {
  const today = ymd(new Date());
  const [sch] = await Promise.all([getDoc(doc(db, "schedules", `${me.id}_${today}`)), loadToday(), loadLocations(),
    loadMyReqs(today.slice(0, 7)).catch(() => {}), loadMyShiftReqs().catch(() => {})]);
  clockShifts = sch.exists() ? sch.data().shiftIds || [] : [];
  calcExtra();
  clockLeave = sch.exists() ? sch.data().leave || {} : {};
  saveClockCache();
  writeCache();
  mapFitted = false;
  renderPunchCards();
  startGeo();
  updateClockMap();
}

// ---- 申請其他班別（臨時加班）----
let myShiftReqs = [];
async function loadMyShiftReqs() {
  const snap = await getDocs(query(collection(db, "shiftRequests"), where("empId", "==", me.id), where("date", "==", ymd(new Date()))));
  myShiftReqs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
// 今天額外要顯示的班：申請中／已核准的臨時班 + 有打卡但不在班表上的班
function calcExtra() {
  extraShifts = [...myShiftReqs.filter(q => q.status !== "rejected").map(q => q.shiftId),
    ...todayRecs.map(r => r.shiftId).filter(Boolean)].filter(id => !clockShifts.includes(id));
}
const shiftReqOf = id => myShiftReqs.find(q => q.shiftId === id && q.status !== "rejected");
async function loadToday() {
  const today = ymd(new Date());
  const snap = await getDocs(query(collection(db, "attendance"), where("empId", "==", me.id), where("date", "==", today)));
  todayRecs = snap.docs.map(toRec).sort((a, b) => a.t - b.t);
}

function renderPunchCards() {
  const ids = punchIds();
  if (!ids.length) {
    $("#shiftPunch").innerHTML = `<div class="card empty-card">今天沒有排班<br><small>有上班但沒排到？按下方「申請其他班別打卡」</small></div>`;
    return;
  }
  $("#shiftPunch").innerHTML = ids.map(id => {
    const s = shiftMap[id];
    const time = s.start && s.end ? `上班 ${s.start}・下班 ${s.end}` : "";
    if (clockLeave[id]) {
      return `<div class="card punch-card leave"><div class="pc-head"><span class="dot" style="background:${esc(s.color)}"></span>
        <div class="pc-title"><b>${esc(s.name)}</b><span>${s.start && s.end ? `${s.start}–${s.end}・` : ""}已請假，不需打卡</span></div>
        <span class="pc-pill done">${esc(clockLeave[id])}</span></div></div>`;
    }
    if (s.cat === "leave") {
      return `<div class="card punch-card leave"><div class="pc-head"><span class="dot" style="background:${esc(s.color)}"></span>
        <div class="pc-title"><b>${esc(s.name)}</b><span>休假，不需打卡</span></div></div></div>`;
    }
    const inLoc = locFor(s, "in"), outLoc = locFor(s, "out");
    const two = inLoc?.id !== outLoc?.id;
    const chkIn = rangeCheck(inLoc), chkOut = rangeCheck(outLoc);
    const pendReq = !clockShifts.includes(id) ? myShiftReqs.find(q => q.shiftId === id && q.status === "pending") : null;
    if (pendReq) {
      return `<div class="card punch-card pending"><div class="pc-head"><span class="dot" style="background:${esc(s.color)}"></span>
        <div class="pc-title"><b>${esc(s.name)}</b>${time ? `<span>${time}</span>` : ""}</div><span class="pc-pill wait">審核中</span></div>
        <div class="pc-btns"><button class="btn big" disabled><span>上班</span><small>等管理者審核</small></button><button class="btn big" disabled><span>下班</span><small>等管理者審核</small></button></div>
        <p class="pc-note">加入班表申請已送出，管理者核准後就可以打卡（超過時間會改成補打卡）</p></div>`;
    }
    const recs = todayRecs.filter(r => r.shiftId === id);
    const inR = recs.filter(r => r.type === "in")[0];
    const outR = recs.filter(r => r.type === "out").at(-1);
    const chkOf = { in: chkIn, out: chkOut };
    const today = ymd(new Date());
    const late = { in: !inR && isMakeup(s, "in"), out: !outR && isMakeup(s, "out") };
    // 按鈕狀態：已打卡／補打卡審核中／超過時間・補打卡／範圍外・申請打卡／可打卡
    const btn = (type, r, label) => {
      const chk = chkOf[type];
      const req = myReqs.find(q => q.date === today && q.shiftId === id && q.type === type && q.status === "pending");
      if (r) return `<button class="btn big done" data-punch="${type}" data-sid="${id}">
        <span>✓ 已${label}</span><small>${hm(r.t)} 打卡${r.outOfRange ? "・範圍外" : ""}${r.makeup ? "・補打卡" : ""}</small></button>`;
      if (req) return `<button class="btn big done" disabled><span>${label}</span><small>補打卡 ${req.time}・審核中</small></button>`;
      if (late[type]) return `<button class="btn big apply" data-makeup="${type}" data-sid="${id}"><span>補打卡</span><small>已超過${label}時間</small></button>`;
      if (chk.cls === "wait") return `<button class="btn big ${type}" disabled><span>${label}</span><small>定位中…</small></button>`;
      if (!chk.ok) return `<button class="btn big apply" data-punch="${type}" data-sid="${id}">
        <span>${label}</span><small>不在範圍・申請打卡</small></button>`;
      return `<button class="btn big ${type}" data-punch="${type}" data-sid="${id}"><span>${label}</span></button>`;
    };
    // 地點：精簡一行一個，小圓點表示狀態（綠＝範圍內、紅＝範圍外、灰＝已打卡／不限）
    const fmtD = d => d == null ? "" : d >= 1000 ? `${(d / 1000).toFixed(1)} 公里` : `${d} 公尺`;
    const locLine = (chk, prefix, loc, r) => {
      const label = prefix ? `<b>${prefix}</b>` : "";
      if (r) return `<div class="pl done"><i></i>${label}<span>${esc(loc?.name || "不限地點")}</span><em>✓ ${hm(r.t)}</em></div>`;
      if (!loc) return `<div class="pl none"><i></i>${label}<span>不限地點</span></div>`;
      if (chk.cls === "wait") return `<div class="pl wait"><i></i>${label}<span>${esc(loc.name)}</span><em>定位中…</em></div>`;
      if (geo.err) return `<div class="pl far"><i></i>${label}<span>${esc(loc.name)}</span><em>無法定位</em></div>`;
      return `<div class="pl ${chk.ok ? "ok" : "far"}"><i></i>${label}<span>${esc(loc.name)}</span><em>${fmtD(chk.d)}${chk.ok ? "" : "・範圍外"}</em></div>`;
    };
    const locHtml = `<div class="pc-locs">${two
      ? locLine(chkIn, "上班", inLoc, inR) + locLine(chkOut, "下班", outLoc, outR)
      : (inR && outR ? locLine(chkIn, "", inLoc, outR) : locLine(chkIn, "", inLoc))}</div>`;
    const hint = timeHint(s, inR, outR);
    const sreq = !clockShifts.includes(id) ? shiftReqOf(id) : null;
    const badge = sreq?.status === "pending" && !(inR && outR) ? `<span class="pc-pill soon">加班・審核中</span>`
      : inR && outR ? `<span class="pc-pill done">已完成</span>`
      : hint ? `<span class="pc-pill ${hint.cls}">${hint.text}</span>`
      : inR ? `<span class="pc-pill on">上班中</span>` : "";
    return `<div class="card punch-card">
      <div class="pc-head"><span class="dot" style="background:${esc(s.color)}"></span>
        <div class="pc-title"><b>${esc(s.name)}</b>${time ? `<span>${time}</span>` : ""}</div>${badge}</div>
      ${locHtml}
      <div class="pc-btns">${btn("in", inR, "上班")}${btn("out", outR, "下班")}</div>
    </div>`;
  }).join("");
}

async function updateClockMap() {
  const locs = [...new Map(punchIds().flatMap(id => [locFor(shiftMap[id], "in"), locFor(shiftMap[id], "out")]).filter(Boolean).map(l => [l.id, l])).values()];
  if (!locs.length && !geo.pos) { $("#mapCard").classList.add("hidden"); return; }
  $("#mapCard").classList.remove("hidden");
  let L;
  try { L = await loadLeaflet(); } catch { $("#mapCard").classList.add("hidden"); return; }
  if (!cMap) { cMap = newMap(L, "clockMap"); cLayer = L.layerGroup().addTo(cMap); }
  cLayer.clearLayers();
  const pts = [];
  locs.forEach(l => {
    L.circle([l.lat, l.lng], { radius: l.radius || 50, color: "#0071e3", weight: 2, fillOpacity: .12 }).addTo(cLayer).bindTooltip(l.name, { permanent: true, direction: "top", className: "map-tip" });
    pts.push([l.lat, l.lng]);
  });
  if (geo.pos) {
    if (geo.acc) L.circle([geo.pos.lat, geo.pos.lng], { radius: Math.min(geo.acc, 200), stroke: false, fillColor: "#34c759", fillOpacity: .15 }).addTo(cLayer);
    L.circleMarker([geo.pos.lat, geo.pos.lng], { radius: 7, color: "#fff", weight: 3, fillColor: "#34c759", fillOpacity: 1 }).addTo(cLayer);
    pts.push([geo.pos.lat, geo.pos.lng]);
  }
  setTimeout(() => {
    cMap.invalidateSize();
    if (!mapFitted && pts.length) {
      pts.length === 1 ? cMap.setView(pts[0], 17) : cMap.fitBounds(pts, { padding: [40, 40], maxZoom: 18 });
      mapFitted = true;
    }
  }, 50);
}

// 過去 3 個月＋本月我的排班（過去月份存在本機，不重複讀）
const HIST_KEY = "punch_hist_v1";
async function myHistory() {
  let cache = {};
  try { const c = JSON.parse(localStorage.getItem(HIST_KEY) || "null"); if (c?.uid === me.id) cache = c.months || {}; } catch {}
  const now = new Date(), cur = ym(now);
  const months = [0, 1, 2, 3].map(i => ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  await Promise.all(months.map(async m => {
    if (m !== cur && cache[m]) return;
    const snap = await getDocs(query(collection(db, "schedules"), where("empId", "==", me.id), where("month", "==", m)));
    const days = {};
    snap.forEach(d => { const x = d.data(); days[x.date] = (x.shiftIds || []).filter(id => !x.leave?.[id]); });
    cache[m] = days;
  }));
  try { localStorage.setItem(HIST_KEY, JSON.stringify({ uid: me.id, months: Object.fromEntries(months.map(m => [m, cache[m]])) })); } catch {}
  return months.flatMap(m => Object.entries(cache[m] || {}));
}
let otRank = null;
async function openOtherPunch() {
  $("#otFilter").value = "";
  $("#otList").innerHTML = `<p class="hint" style="margin:0">讀取中…</p>`;
  $("#otherModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#otherModal").classList.add("open"));
  const today = ymd(new Date()), wd = new Date().getDay();
  const hist = await myHistory().catch(() => []);
  const wdN = {}, allN = {};
  hist.forEach(([ds, ids]) => { if (ds === today) return; const same = new Date(ds + "T00:00:00").getDay() === wd; ids.forEach(id => { allN[id] = (allN[id] || 0) + 1; if (same) wdN[id] = (wdN[id] || 0) + 1; }); });
  otRank = { wdN, allN, wd };
  renderOtherList();
}
function renderOtherList() {
  if (!otRank) return;
  const { wdN, allN, wd } = otRank;
  const f = $("#otFilter").value.trim().toLowerCase();
  const have = punchIds();
  const busy = workIds([...clockShifts, ...extraShifts], clockLeave);
  const list = shiftTypes.filter(s => s.cat !== "leave" && !have.includes(s.id) && (!f || s.name.toLowerCase().includes(f) || (s.code || "").toLowerCase().includes(f)))
    .map((s, i) => ({ s, i, sc: (wdN[s.id] || 0) * 1000 + (allN[s.id] || 0) }))
    .sort((a, b) => b.sc - a.sc || a.i - b.i);
  let hot = false, rest = false;
  $("#otList").innerHTML = list.map(({ s, sc }) => {
    const c = clashWith(s.id, busy);
    let head = "";
    if (!f && sc > 0 && !hot) { hot = true; head = `<div class="list-head">你常排的班</div>`; }
    if (!f && sc === 0 && !rest) { rest = true; head = `<div class="list-head">其他班別</div>`; }
    const why = wdN[s.id] ? `你週${WEEK[wd]}排過 ${wdN[s.id]} 次・共 ${allN[s.id]} 次` : allN[s.id] ? `共排過 ${allN[s.id]} 次` : "";
    return `${head}<button class="ot-item ${c ? "clash" : ""}" data-sid="${s.id}" ${c ? "disabled" : ""}>
      <span class="dot" style="background:${esc(s.color)}"></span>
      <span class="ot-main"><b>${esc(s.name)}</b><small>${[s.start && s.end ? `${s.start}–${s.end}` : "", c ? `<em>時段衝突：${esc(shiftMap[c].name)}</em>` : why].filter(Boolean).join("・")}</small></span>
      <span class="ot-add">${c ? "" : "申請"}</span></button>`;
  }).join("") || `<p class="empty">找不到班別</p>`;
}
function closeOther() { $("#otherModal").classList.remove("open"); setTimeout(() => $("#otherModal").classList.add("hidden"), 200); }
$("#otherPunchBtn").onclick = () => openOtherPunch();
// 分享打卡連結（LINE 圖文卡片）
const PUNCH_URL = `https://liff.line.me/${LIFF_ID}?view=clock`;
$("#sharePunchBtn").onclick = async () => {
  const flex = { type: "flex", altText: "今天也要準時打卡｜野馬溜冰打卡系統", contents: {
    type: "bubble",
    styles: { hero: { backgroundColor: "#00000000" } },
    hero: { type: "image", url: "https://wild-horses-skating.pages.dev/share-card.png?v=20", size: "full", aspectRatio: "1200:1114", aspectMode: "fit", action: { type: "uri", label: "我要打卡", uri: PUNCH_URL } } } };
  if (me?.role !== "admin") return;
  const ok = await getLiff();
  if (!ok || !liff.isInClient?.()) return appAlert("請在 LINE 裡打開", "圖文卡片只能在 LINE 裡分享，請從 LINE 官方帳號的選單打開打卡系統再按一次。");
  if (!liff.isApiAvailable?.("shareTargetPicker"))
    return appAlert("還沒開啟分享功能", "請到 LINE Developers → LINE Login Channel → LIFF → 2012318362-VOU7aFr9，把「shareTargetPicker」打開並儲存，再回來按一次。");
  try {
    const r = await liff.shareTargetPicker([flex]);
    if (r) toast("已分享圖文卡片");
  } catch (e) { appAlert("分享失敗", e.message || String(e)); }
};
$("#otFilter").oninput = renderOtherList;
$("#otherModal").onclick = async e => {
  if (e.target.id === "otherModal" || e.target.closest("[data-close]")) return closeOther();
  const b = e.target.closest(".ot-item[data-sid]"); if (!b || b.disabled) return;
  const s = shiftMap[b.dataset.sid];
  if (!(await appConfirm("申請這個班", `${s.name}${s.start && s.end ? `（${s.start}–${s.end}）` : ""}\n管理者核准、加進你今天的班表後就可以打卡。`, { okText: "送出申請" }))) return;
  const today = ymd(new Date());
  try {
    const data = { empId: me.id, name: me.name, empNo: me.empNo || "", date: today, month: today.slice(0, 7), shiftId: s.id, shiftName: s.name,
      status: "pending", notified: false, createdAt: serverTimestamp() };
    const ref = await addDoc(collection(db, "shiftRequests"), data);
    notifyAdmins("shiftRequests", ref.id);
    myShiftReqs.push({ id: ref.id, ...data });
    calcExtra(); renderPunchCards(); updateClockMap();
    closeOther();
    toast("已送出，等管理者核准後就能打卡");
  } catch (err) { appAlert("送出失敗", errMsg(err) + (err.code === "permission-denied" ? "\n請管理者更新 firestore.rules。" : "")); }
};

// ---- 時間提示與補打卡判斷 ----
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const toMin = t => t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null;
const MAKEUP_OUT_GRACE = 60;   // 下班後 60 分鐘內仍可直接打下班卡
// 上班：班別結束後還沒打 → 補打卡；下班：下班時間 + 60 分鐘後還沒打 → 補打卡
function isMakeup(s, type) {
  const end = toMin(s?.end);
  if (end == null) return false;
  return type === "in" ? nowMin() > end : nowMin() > end + MAKEUP_OUT_GRACE;
}
function timeHint(s, inR, outR) {
  const st = toMin(s.start), en = toMin(s.end), n = nowMin();
  if (st == null || en == null) return null;
  if (!inR && n < st && st - n <= 60) return { cls: "soon", text: `${st - n} 分後上班` };
  if (!inR && n >= st && n <= en) return { cls: "late", text: `遲到 ${n - st} 分` };
  if (!inR && n > en) return { cls: "late", text: "需補打卡" };
  if (inR && !outR && n < en && en - n <= 15) return { cls: "soon", text: `${en - n} 分後下班` };
  if (inR && !outR && n >= en && n <= en + MAKEUP_OUT_GRACE) return { cls: "soon", text: "該打下班卡" };
  if (inR && !outR && n > en + MAKEUP_OUT_GRACE) return { cls: "late", text: "忘記打下班" };
  return null;
}
// 每分鐘更新一次提示
setInterval(() => { if (me && !$("#view-clock").classList.contains("hidden")) renderPunchCards(); }, 60000);

// ---- 補打卡申請 ----
let myReqs = [];
async function loadMyReqs(month) {
  const snap = await getDocs(query(collection(db, "punchRequests"), where("empId", "==", me.id), where("month", "==", month)));
  myReqs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
let mk = null;
function openMakeup(sid, type, date = ymd(new Date())) {
  const s = shiftMap[sid];
  mk = { sid, type, date };
  const d = new Date(date + "T00:00:00");
  $("#mkTitle").textContent = `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）${s?.name || ""}`;
  $$("#mkType button").forEach(b => b.classList.toggle("on", b.dataset.v === type));
  $("#mkTime").value = (type === "in" ? s?.start : s?.end) || "";
  $("#mkReason").value = "";
  $("#makeupModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#makeupModal").classList.add("open"));
}
function closeMakeup() { $("#makeupModal").classList.remove("open"); setTimeout(() => $("#makeupModal").classList.add("hidden"), 200); }
$("#mkType").onclick = e => {
  const b = e.target.closest("button[data-v]");
  if (!b || !mk) return;
  mk.type = b.dataset.v;
  $$("#mkType button").forEach(x => x.classList.toggle("on", x === b));
  const s = shiftMap[mk.sid];
  $("#mkTime").value = (mk.type === "in" ? s?.start : s?.end) || $("#mkTime").value;
};
$("#makeupModal").onclick = e => { if (e.target.id === "makeupModal" || e.target.closest("[data-close]")) closeMakeup(); };
$("#mkSubmit").onclick = async () => {
  const time = $("#mkTime").value, reason = $("#mkReason").value.trim();
  if (!time) return toast("請填寫實際的上下班時間");
  if (reason.length < 2) return toast("請填寫補打卡原因");
  const s = shiftMap[mk.sid];
  if (myReqs.some(q => q.date === mk.date && q.shiftId === mk.sid && q.type === mk.type && q.status === "pending"))
    return toast("這筆已經申請過，等待審核中");
  $("#mkSubmit").disabled = true;
  try {
    const ref = await addDoc(collection(db, "punchRequests"), {
      empId: me.id, name: me.name, empNo: me.empNo || "",
      date: mk.date, month: mk.date.slice(0, 7), shiftId: mk.sid, shiftName: s?.name || "",
      type: mk.type, time, reason, status: "pending", notified: false, createdAt: serverTimestamp()
    });
    myReqs.push({ id: ref.id, empId: me.id, date: mk.date, shiftId: mk.sid, type: mk.type, time, reason, status: "pending" });
    closeMakeup();
    toast("已送出補打卡申請，等待管理者審核");
    if (!$("#view-clock").classList.contains("hidden")) renderPunchCards();
    if (!$("#view-records").classList.contains("hidden")) renderRecDay();
  } catch (err) {
    appAlert("送出失敗", errMsg(err) + (err.code === "permission-denied" ? "\n請管理者更新 firestore.rules。" : ""));
  } finally { $("#mkSubmit").disabled = false; }
};

$("#shiftPunch").onclick = e => {
  const m = e.target.closest("[data-makeup]");
  if (m) return openMakeup(m.dataset.sid, m.dataset.makeup);
  const b = e.target.closest("[data-punch]");
  if (b && !b.disabled) punch(b.dataset.punch, b.dataset.sid);
};

async function punch(type, sid) {
  const s = shiftMap[sid];
  const loc = locFor(s, type);
  const chk = rangeCheck(loc);
  let reason = "";
  if (!chk.ok) {
    const where = chk.d != null ? `你目前距離「${loc.name}」約 ${chk.d} 公尺，超出 ${loc.radius || 50} 公尺打卡範圍。` : `${chk.text}`;
    reason = await appDialog({
      title: "不在打卡範圍內", message: `${where}\n仍要打卡請填寫原因，管理者會看到。`,
      input: { type: "text", placeholder: "例：在校門口等學生、臨時改地點" },
      buttons: [{ text: "取消", value: false }, { text: "送出打卡", value: true, style: "primary" }]
    });
    if (reason === false) return;
    reason = String(reason || "").trim();
    if (reason.length < 2) return appAlert("請填寫原因", "範圍外打卡需要填寫原因（至少 2 個字）。");
  }
  const done = todayRecs.some(r => r.shiftId === sid && r.type === type);
  if (done && !(await appConfirm("重複打卡", `「${s.name}」已經打過${type === "in" ? "上班" : "下班"}卡，要再打一次嗎？`, { okText: "再打一次" }))) return;
  if (type === "out" && !todayRecs.some(r => r.shiftId === sid && r.type === "in") &&
      !(await appConfirm("還沒打上班卡", `「${s.name}」還沒有上班卡紀錄，確定要直接打下班卡？`, { okText: "打下班卡" }))) return;
  $$("#shiftPunch [data-punch]").forEach(x => x.disabled = true);
  try {
    const now = new Date();
    await addDoc(collection(db, "attendance"), {
      empId: me.id, name: me.name, empNo: me.empNo || "",
      type, shiftId: sid, shiftName: s?.name || "",
      locationId: loc?.id || null, dist: chk.d ?? null,
      date: ymd(now), month: ym(now),
      ts: serverTimestamp(), clientTime: now.toISOString(),
      lat: geo.pos?.lat ?? null, lng: geo.pos?.lng ?? null, acc: geo.acc ?? null,
      outOfRange: !chk.ok, reason
    });
    navigator.vibrate?.(30);
    toast(`${s?.name || ""} ${type === "in" ? "上班" : "下班"}打卡成功 ${hm(now)}${reason ? "（範圍外）" : ""}`);
    await loadToday();
    saveClockCache();
  } catch (err) {
    console.error(err);
    if (err.code === "permission-denied") {
      appAlert("打卡失敗：權限不足", reason
        ? "系統還不接受「範圍外打卡」。請管理者到 Firebase → Firestore → 規則，貼上最新版 firestore.rules 並按「發布」。"
        : "打卡位置不在範圍內，或 Firebase 規則還沒更新為最新版。請管理者確認規則已發布。");
    } else toast("打卡失敗：" + errMsg(err));
  } finally {
    renderPunchCards();
  }
}


/* ================= 出勤彙整（共用） ================= */
const toRec = d => { const r = d.data(); return { ...r, t: r.ts?.toDate() || new Date(r.clientTime) }; };

function groupDaily(records) {
  const map = {};
  records.forEach(r => {
    const k = `${r.empId}_${r.date}`;
    map[k] ??= { empId: r.empId, date: r.date, ins: [], outs: [] };
    (r.type === "in" ? map[k].ins : map[k].outs).push(r);
  });
  for (const g of Object.values(map)) {
    g.ins.sort((a, b) => a.t - b.t);
    g.outs.sort((a, b) => b.t - a.t);
    g.inRec = g.ins[0]; g.outRec = g.outs[0];
    g.in = g.inRec?.t; g.out = g.outRec?.t;
    g.hrs = g.in && g.out && g.out > g.in ? (g.out - g.in) / 36e5 : null;
  }
  return map;
}

function dayStatus(g, ids, dateStr) {
  const today = ymd(new Date());
  const st = [];
  const hasWork = (ids || []).some(id => shiftMap[id]?.cat !== "leave");
  if (!g) {
    if (hasWork && dateStr < today) st.push(["bad", "缺勤"]);
    else if (isLeaveDay(ids)) st.push(["ok", "休假"]);
    return st;
  }
  if (!g.in) st.push(["bad", "未打上班"]);
  if (!g.out && dateStr < today) st.push(["bad", "未打下班"]);
  const w = shiftWindow(ids);
  if (w && g.in && hm(g.in) > w.start) st.push(["bad", "遲到"]);
  if (w && g.out && hm(g.out) < w.end) st.push(["bad", "早退"]);
  if (!st.length) st.push(["ok", "正常"]);
  return st;
}
const statusHtml = st => st.map(([c, t]) => `<span class="tag ${c}">${t}</span>`).join("");

/* ================= 我的出勤紀錄 ================= */
let rec = { month: null, sch: {}, recs: [], sel: null };

// 某一天、某個班別的上下班狀態
function shiftPunchState(ds, sid, recs) {
  const s = shiftMap[sid];
  const mine = recs.filter(r => r.date === ds && r.shiftId === sid);
  const inR = mine.filter(r => r.type === "in").sort((a, b) => a.t - b.t)[0];
  const outR = mine.filter(r => r.type === "out").sort((a, b) => b.t - a.t)[0];
  const now = new Date(), today = ymd(now), nowHm = hm(now);
  const passed = t => ds < today || (ds === today && t && nowHm > t);
  const one = (r, kind) => {
    const plan = kind === "in" ? s?.start : s?.end;
    if (r) {
      const t = hm(r.t);
      const bad = plan && (kind === "in" ? t > plan : t < plan);
      const label = bad ? (kind === "in" ? "遲到" : "早退") : "正常";
      return { t, cls: bad ? "bad" : r.outOfRange ? "warn" : "ok", label: r.outOfRange ? `${label}・範圍外` : label, r };
    }
    return passed(plan) ? { cls: "bad", label: kind === "in" ? "上班未打卡" : "下班未打卡" } : { cls: "wait", label: "尚未打卡" };
  };
  return { s, in: one(inR, "in"), out: one(outR, "out") };
}

const REC_KEY = "punch_rec_v1";
async function loadRecords() {
  const month = $("#recMonth").value;
  // 先顯示上次的資料（或空白月曆），再背景更新
  try {
    const c = JSON.parse(localStorage.getItem(REC_KEY) || "null");
    if (c?.uid === me.id && c.month === month) {
      rec.month = month; rec.sch = c.sch || {}; rec.leave = c.leave || {};
      rec.recs = (c.recs || []).map(r => ({ ...r, t: new Date(r.t) }));
      renderRecords(month);
    } else if (rec.month !== month) { rec.month = month; rec.recs = []; rec.sch = {}; rec.leave = {}; renderRecords(month, true); }
  } catch {}
  const [attSnap, schSnap] = await Promise.all([
    getDocs(query(collection(db, "attendance"), where("empId", "==", me.id), where("month", "==", month))),
    getDocs(query(collection(db, "schedules"), where("empId", "==", me.id), where("month", "==", month))),
    loadMyReqs(month).catch(() => {})
  ]);
  if (month !== $("#recMonth").value) return;
  rec.month = month;
  rec.recs = attSnap.docs.map(toRec);
  rec.sch = {};
  rec.leave = {};
  schSnap.forEach(d => { rec.sch[d.data().date] = byTime(d.data().shiftIds); rec.leave[d.data().date] = d.data().leave || {}; });
  try {
    localStorage.setItem(REC_KEY, JSON.stringify({ uid: me.id, month, sch: rec.sch, leave: rec.leave,
      recs: rec.recs.map(r => ({ type: r.type, shiftId: r.shiftId || null, shiftName: r.shiftName || "", date: r.date, t: +r.t, outOfRange: !!r.outOfRange, reason: r.reason || "", dist: r.dist ?? null, lat: r.lat ?? null, lng: r.lng ?? null, makeup: !!r.makeup })) }));
  } catch {}
  renderRecords(month);
}
function renderRecords(month, skeleton) {
  if (!rec.sel || rec.sel.slice(0, 7) !== month) {
    const t = ymd(new Date());
    rec.sel = t.slice(0, 7) === month ? t : `${month}-01`;
  }
  // 統計
  let days = 0, late = 0, miss = 0;
  for (const d of daysOfMonth(month)) {
    const ds = ymd(d);
    const work = (rec.sch[ds] || []).filter(id => shiftMap[id] && shiftMap[id].cat !== "leave" && !rec.leave?.[ds]?.[id]);
    if (rec.recs.some(r => r.date === ds)) days++;
    work.forEach(id => {
      const st = shiftPunchState(ds, id, rec.recs);
      [st.in, st.out].forEach(x => { if (x.label === "遲到" || x.label === "早退") late++; if (x.label.includes("未打卡")) miss++; });
    });
  }
  const v = n => skeleton ? "–" : n;
  $("#recSummary").innerHTML = `
    <div class="stat"><b>${v(days)}</b>出勤天數</div>
    <div class="stat"><b>${v(late)}</b>遲到／早退</div>
    <div class="stat"><b class="${miss && !skeleton ? "red" : ""}">${v(miss)}</b>未打卡</div>`;
  renderRecCal();
  if (skeleton) { $("#recDayTitle").textContent = ""; $("#recDetail").innerHTML = `<div class="card empty-card">讀取中…</div>`; }
  else renderRecDay();
}

function dayFlag(ds) {
  const work = (rec.sch[ds] || []).filter(id => shiftMap[id] && shiftMap[id].cat !== "leave" && !rec.leave?.[ds]?.[id]);
  const has = rec.recs.some(r => r.date === ds);
  if (!work.length) return has ? "ok" : (rec.sch[ds]?.length ? "leave" : "");
  let bad = false, wait = false, warn = false;
  work.forEach(id => { const st = shiftPunchState(ds, id, rec.recs); [st.in, st.out].forEach(x => { if (x.cls === "bad") bad = true; if (x.cls === "wait") wait = true; if (x.cls === "warn") warn = true; }); });
  return bad ? "bad" : wait || warn ? "wait" : "ok";
}

function renderRecCal() {
  const days = daysOfMonth(rec.month);
  const today = ymd(new Date());
  let html = [...WEEK].map(w => `<div class="hd">${w}</div>`).join("") + "<div></div>".repeat(days[0].getDay());
  for (const d of days) {
    const ds = ymd(d), f = dayFlag(ds);
    html += `<div class="rday ${ds === today ? "today" : ""} ${ds === rec.sel ? "sel" : ""} ${d.getDay() % 6 === 0 ? "wkend" : ""}" data-ds="${ds}">
      <span class="rnum">${d.getDate()}</span><i class="rdot ${f}"></i></div>`;
  }
  $("#recCal").innerHTML = html;
}

function renderRecDay() {
  const ds = rec.sel;
  const d = new Date(ds + "T00:00:00");
  $("#recDayTitle").textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
  const ids = byTime((rec.sch[ds] || []).filter(id => shiftMap[id]));
  const used = new Set();
  let html = ids.map(id => {
    const st = shiftPunchState(ds, id, rec.recs);
    used.add(id);
    if (rec.leave?.[ds]?.[id]) return `<div class="rd-group"><div class="rd-shift"><span class="dot" style="background:${esc(st.s.color)}"></span>${esc(st.s.name)}<span class="rd-plan"><span class="tag ok">已請假・${esc(rec.leave[ds][id])}</span></span></div></div>`;
    if (st.s.cat === "leave") return `<div class="rd-group"><div class="rd-shift"><span class="dot" style="background:${esc(st.s.color)}"></span>${esc(st.s.name)}<span class="rd-plan">休假</span></div></div>`;
    const reqBtn = (kind, x) => {
      if (x.r || !x.label.includes("未打卡")) return "";
      const q = myReqs.filter(q => q.date === ds && q.shiftId === id && q.type === kind).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))[0];
      if (q?.status === "pending") return `<span class="tag warn">補打卡 ${esc(q.time)} 審核中</span>`;
      return `${q?.status === "rejected" ? `<span class="tag bad">已退回</span>` : ""}<button class="btn small" data-mkreq="${kind}" data-sid="${id}" data-ds="${ds}">申請補打卡</button>`;
    };
    const row = (kind, x) => `<div class="rd-row"><i class="rdot ${x.cls}"></i><span class="rd-kind">${kind === "in" ? "上班" : "下班"}</span>
      <span class="rd-status ${x.cls}">${x.t ? `${x.t}・${x.label}` : x.label}${x.r?.makeup ? "（補打卡）" : ""}</span>
      ${x.r?.lat != null ? `<a class="rd-map" href="https://www.google.com/maps?q=${x.r.lat},${x.r.lng}" target="_blank" rel="noopener">地圖</a>` : ""}${reqBtn(kind, x)}</div>
      ${x.r?.reason ? `<div class="rd-reason">原因：${esc(x.r.reason)}${x.r.dist != null ? `（距離 ${x.r.dist} 公尺）` : ""}</div>` : ""}`;
    return `<div class="rd-group">
      <div class="rd-shift"><span class="dot" style="background:${esc(st.s.color)}"></span>${esc(st.s.name)}${st.s.start && st.s.end ? `<span class="rd-plan">${st.s.start}–${st.s.end}</span>` : ""}</div>
      ${row("in", st.in)}${row("out", st.out)}
    </div>`;
  }).join("");
  // 沒有對應到排班的打卡（舊紀錄或臨時班別）
  const others = rec.recs.filter(r => r.date === ds && (!r.shiftId || !used.has(r.shiftId))).sort((a, b) => a.t - b.t);
  if (others.length) {
    html += `<div class="rd-group"><div class="rd-shift">其他打卡</div>${others.map(r => `<div class="rd-row"><i class="rdot ok"></i>
      <span class="rd-kind">${r.type === "in" ? "上班" : "下班"}</span><span class="rd-status ok">${hm(r.t)}${r.shiftName ? `・${esc(r.shiftName)}` : ""}</span></div>`).join("")}</div>`;
  }
  $("#recDetail").innerHTML = html || `<div class="card empty-card">這天沒有排班，也沒有打卡紀錄</div>`;
}

$("#recDetail").onclick = e => {
  const b = e.target.closest("[data-mkreq]");
  if (b) openMakeup(b.dataset.sid, b.dataset.mkreq, b.dataset.ds);
};
$("#recCal").onclick = e => {
  const c = e.target.closest(".rday[data-ds]");
  if (!c) return;
  rec.sel = c.dataset.ds;
  renderRecCal();
  renderRecDay();
};

/* ================= 我的班表 ================= */
let mySchMode = "mine";
const VIS_LABEL = { self: "僅可查看自己", all: "可查看全部人" };

async function loadMySchedule() {
  const month = $("#mySchMonth").value;
  const [snap, rSnap] = await Promise.all([
    getDocs(query(collection(db, "schedules"), where("empId", "==", me.id), where("month", "==", month))),
    getDoc(doc(db, "rosters", month))
  ]);
  const r = rSnap.exists() ? rSnap.data() : {};
  let pub = null;
  if (r.visibility === "all") {
    const p = await getDoc(doc(db, "rosterPublic", month)).catch(() => null);
    if (p?.exists()) pub = p.data();
  }
  $("#mySchMode").classList.toggle("hidden", !pub);
  if (!pub) mySchMode = "mine";
  $$("#mySchMode button").forEach(b => b.classList.toggle("on", b.dataset.v === mySchMode));
  const [y, m] = month.split("-");
  $("#mySchSub").textContent = (r.name || `${y}/${+m}月班表`) + (pub ? " · 已發布全部人班表" : "");

  // 我的月曆 + 週明細
  mySch = {};
  snap.forEach(d => mySch[d.data().date] = byTime(d.data().shiftIds));
  const days = daysOfMonth(month);
  if (!mySel || mySel.slice(0, 7) !== month) {
    const t = ymd(new Date());
    mySel = t.slice(0, 7) === month ? t : ymd(days[0]);
  }
  renderMyCal(month);
  renderWeek();
  $("#myCalWrap").classList.toggle("hidden", mySchMode !== "mine");
  $("#teamWrap").classList.toggle("hidden", mySchMode !== "all");
  if (mySchMode === "all" && pub) renderTeam(month, pub);
}

let mySch = {}, mySel = null;
const weekStart = ds => { const d = new Date(ds + "T00:00:00"); d.setDate(d.getDate() - d.getDay()); return d; };  // 週日開始，對齊月曆

function renderMyCal(month) {
  const days = daysOfMonth(month);
  const today = ymd(new Date());
  const ws = ymd(weekStart(mySel));
  let html = [...WEEK].map(w => `<div class="hd">${w}</div>`).join("");
  html += "<div></div>".repeat(days[0].getDay());
  for (const d of days) {
    const ds = ymd(d);
    const ids = byTime(mySch[ds]);
    const inWeek = ymd(weekStart(ds)) === ws;
    html += `<div class="day ${ds === today ? "today" : ""} ${d.getDay() % 6 === 0 ? "wkend" : ""} ${inWeek ? "in-week" : ""} ${ds === mySel ? "sel" : ""}" data-ds="${ds}">
      <div class="d">${d.getDate()}</div>
      <div class="bars">${ids.slice(0, 4).map(id => `<i style="background:${esc(shiftMap[id]?.color || "#ccc")}"></i>`).join("")}</div>
      <div class="chips">${ids.map(id => chipHtml(id)).join("")}</div>
    </div>`;
  }
  $("#myCal").innerHTML = html;
}

function renderWeek() {
  const start = weekStart(mySel);
  const today = ymd(new Date());
  const list = [];
  for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); list.push(d); }
  const md = d => `${d.getMonth() + 1}/${d.getDate()}`;
  $("#wkTitle").textContent = `${md(list[0])} – ${md(list[6])}`;
  let n = 0, mins = 0;
  $("#weekList").innerHTML = list.map(d => {
    const ds = ymd(d);
    const ids = byTime(mySch[ds]);
    const other = ds.slice(0, 7) !== $("#mySchMonth").value;
    ids.forEach(id => { const s = shiftMap[id]; if (s?.start && s?.end) { n++; const [a, b] = [s.start, s.end].map(t => +t.slice(0, 2) * 60 + +t.slice(3)); mins += Math.max(0, b - a); } });
    const items = ids.map(id => {
      const s = shiftMap[id];
      if (!s) return "";
      return `<div class="wk-item"><i style="background:${esc(s.color)}"></i><span class="wk-name">${esc(s.name)}</span><span class="wk-time">${s.start && s.end ? `${s.start}–${s.end}` : (s.cat === "leave" ? "休假" : "")}</span></div>`;
    }).join("");
    return `<div class="wk-day ${ds === today ? "today" : ""} ${ds === mySel ? "sel" : ""} ${d.getDay() % 6 === 0 ? "wkend" : ""} ${other ? "other" : ""}" data-ds="${ds}">
      <div class="wk-date"><b>${d.getDate()}</b><span>週${WEEK[d.getDay()]}</span></div>
      <div class="wk-items">${items || `<span class="wk-off">${other ? "其他月份" : "休息"}</span>`}</div>
    </div>`;
  }).join("");
  $("#wkSub").textContent = n ? `本週 ${n} 個班・約 ${Math.round(mins / 6) / 10} 小時` : "本週沒有排班";
}

function selectMyDay(ds) {
  const month = $("#mySchMonth").value;
  mySel = ds;
  if (ds.slice(0, 7) !== month) { $("#mySchMonth").value = ds.slice(0, 7); return loadMySchedule(); }
  renderMyCal(month);
  renderWeek();
}
$("#myCal").onclick = e => { const c = e.target.closest(".day[data-ds]"); if (c) selectMyDay(c.dataset.ds); };
$("#weekList").onclick = e => { const c = e.target.closest(".wk-day[data-ds]"); if (c && !c.classList.contains("other")) selectMyDay(c.dataset.ds); };
const shiftWeek = n => { const d = new Date(mySel + "T00:00:00"); d.setDate(d.getDate() + 7 * n); selectMyDay(ymd(d)); };
$("#wkPrev").onclick = () => shiftWeek(-1);
$("#wkNext").onclick = () => shiftWeek(1);

function renderTeam(month, pub) {
  const days = daysOfMonth(month);
  const today = ymd(new Date());
  const wk = d => (d.getDay() === 0 || d.getDay() === 6) ? "wkend" : "";
  const cellIds = (eid, ds) => byTime(pub.grid?.[eid]?.[ds]);
  // 電腦：表格
  let html = `<thead><tr><th class="name">姓名</th>${days.map(d =>
    `<th class="${wk(d)}"${ymd(d) === today ? ' style="color:var(--primary)"' : ""}>${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）</th>`).join("")}</tr></thead><tbody>`;
  for (const u of pub.emps || []) {
    html += `<tr class="${u.id === me.id ? "me" : ""}"><td class="name">${esc(u.name)}</td>`;
    for (const d of days) html += `<td class="${wk(d)}">${cellIds(u.id, ymd(d)).map(id => chipHtml(id)).join("")}</td>`;
    html += "</tr>";
  }
  $("#teamTable").innerHTML = html + "</tbody>";
  // 手機：每天誰上班
  $("#teamDays").innerHTML = days.map(d => {
    const ds = ymd(d);
    const rows = (pub.emps || []).map(u => ({ u, ids: cellIds(u.id, ds) })).filter(x => x.ids.length);
    return `<div class="team-day ${wk(d)} ${ds === today ? "today" : ""}">
      <div class="td-head"><b>${d.getMonth() + 1}/${d.getDate()}</b><span>週${WEEK[d.getDay()]}</span><span class="td-n">${rows.length ? rows.length + " 人" : "無排班"}</span></div>
      ${rows.map(x => `<div class="td-row ${x.u.id === me.id ? "me" : ""}"><span class="td-name">${esc(x.u.name)}</span><span class="td-chips">${x.ids.map(id => chipHtml(id)).join("")}</span></div>`).join("")}
    </div>`;
  }).join("");
}

$("#mySchMode").onclick = e => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  mySchMode = b.dataset.v;
  loadMySchedule();
};

/* ================= 員工管理（管理者） ================= */
async function loadEmployees() {
  const snap = await collDocs("employees");
  employees = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.empNo || "zzz").localeCompare(b.empNo || "zzz") || (a.name || "").localeCompare(b.name || ""));
}
const activeEmployees = () => employees.filter(e => e.active !== false);

async function loadStaff() {
  if (staff.length) return staff;
  const d = await getDoc(doc(db, "meta", "staff"));
  staff = d.exists() ? (d.data().list || []) : [];
  return staff;
}
// 管理者：把在職員工姓名同步到 meta/staff，讓員工選代班人
async function syncStaff() {
  if (me?.role !== "admin") return;
  if (!employees.length) await loadEmployees();
  const list = activeEmployees().map(e => ({ id: e.id, name: e.name || "" }));
  const d = await getDoc(doc(db, "meta", "staff"));
  if (JSON.stringify(d.exists() ? d.data().list : null) !== JSON.stringify(list)) await setDoc(doc(db, "meta", "staff"), { list, updatedAt: serverTimestamp() });
  staff = list;
}
let empF = "";
async function loadEmployeesView() {
  await loadEmployees();
  syncStaff().catch(() => {});
  renderEmpList();
  renderEmpTable();
}
// 電腦版：原本的表格（直接在表格裡修改）
function renderEmpTable() {
  $("#empListT").innerHTML = employees.map(u => {
    const locked = empLocked(u);
    const lineCell = u.lineUid
      ? `<span class="line-cell">${u.linePicture ? `<img class="avatar" src="${esc(u.linePicture)}" alt="">` : ""}${esc(u.lineName || "已綁定")}</span>`
      : locked ? `<span class="tag bad">已鎖定</span>` : `<span class="tag">未綁定</span>`;
    return `<tr data-id="${u.id}">
      <td><input class="e-no" value="${esc(u.empNo)}" size="6"></td>
      <td><input class="e-name" value="${esc(u.name)}" size="8"></td>
      <td><input class="e-email" type="email" value="${esc(u.email)}" size="20"></td>
      <td><select class="e-role"><option value="employee" ${u.role !== "admin" ? "selected" : ""}>員工</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>管理者</option></select></td>
      <td>${lineCell}</td>
      <td><select class="e-active"><option value="1" ${u.active !== false ? "selected" : ""}>在職</option><option value="0" ${u.active === false ? "selected" : ""}>停用</option></select></td>
      <td><button class="btn small primary e-save">儲存</button>
        ${u.lineUid || locked ? `<button class="btn small e-unbind">解除綁定</button>` : ""}
        ${u.id !== me.id ? `<button class="btn small danger e-del">刪除</button>` : ""}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">尚無員工</td></tr>`;
}
$("#empForm").onsubmit = async e => {
  e.preventDefault();
  const data = { empNo: $("#eNo").value.trim(), name: $("#eName").value.trim(), email: $("#eEmail").value.trim().toLowerCase(), role: $("#eRole").value,
    active: true, lineUid: null, lineName: "", linePicture: "", bindFails: 0, createdAt: serverTimestamp() };
  if (!data.name || !data.email) return;
  if (employees.some(x => (x.email || "").toLowerCase() === data.email)) return toast("此 Email 已有員工使用");
  try { await addDoc(collection(db, "employees"), data); e.target.reset(); toast("已新增員工"); loadEmployeesView(); }
  catch (err) { toast("新增失敗：" + errMsg(err)); }
};
$("#empListT").onclick = async e => {
  const tr = e.target.closest("tr[data-id]"); if (!tr) return;
  const id = tr.dataset.id, emp = employees.find(x => x.id === id);
  try {
    if (e.target.classList.contains("e-save")) {
      const data = { empNo: $(".e-no", tr).value.trim(), name: $(".e-name", tr).value.trim(), email: $(".e-email", tr).value.trim().toLowerCase(),
        role: $(".e-role", tr).value, active: $(".e-active", tr).value === "1" };
      if (!data.name) return toast("姓名不可空白");
      if (id === me.id && (data.role !== "admin" || !data.active)
        && !(await appConfirm("變更自己的權限", "確定要取消自己的管理者權限或停用自己？之後將無法進入管理功能。", { okText: "確定變更", danger: true }))) return;
      await updateDoc(doc(db, "employees", id), data); toast("已儲存"); loadEmployeesView();
    } else if (e.target.classList.contains("e-unbind")) {
      if (!(await appConfirm("解除 LINE 綁定", `解除「${emp.name}」的 LINE 綁定？他下次登入需要重新綁定。`, { okText: "解除綁定", danger: true }))) return;
      await updateDoc(doc(db, "employees", id), { lineUid: null, lineName: "", linePicture: "", bindFails: 0 }); toast("已解除綁定"); loadEmployeesView();
    } else if (e.target.classList.contains("e-del")) {
      if (!(await appConfirm("刪除員工", `刪除「${emp.name}」？打卡紀錄會保留。`, { okText: "刪除", danger: true }))) return;
      await deleteDoc(doc(db, "employees", id)); toast("已刪除"); loadEmployeesView();
    }
  } catch (err) { toast("操作失敗：" + errMsg(err)); }
};
const empBound = u => !!u.lineUid, empLocked = u => !u.lineUid && (u.bindFails || 0) >= 5;
function renderEmpList() {
  const q = $("#empSearch").value.trim().toLowerCase();
  const list = employees.filter(u => (!q || `${u.name} ${u.empNo} ${u.email}`.toLowerCase().includes(q))
    && (empF === "" || (empF === "unbound" && !empBound(u) && u.active !== false) || (empF === "admin" && u.role === "admin") || (empF === "off" && u.active === false)));
  const act = employees.filter(u => u.active !== false);
  $("#empSub").textContent = `在職 ${act.length} 人・已綁定 LINE ${act.filter(empBound).length} 人・未綁定 ${act.filter(u => !empBound(u)).length} 人`;
  const colors = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff", "#ac8e68"];
  $("#empList").innerHTML = list.map(u => {
    const ini = (u.name || "?").slice(-2);
    const col = colors[[...String(u.name || u.id)].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length];
    const tags = [
      u.role === "admin" ? `<span class="tag blue">管理者</span>` : "",
      u.active === false ? `<span class="tag muted">停用</span>` : "",
      empBound(u) ? `<span class="tag ok">LINE 已綁定</span>` : empLocked(u) ? `<span class="tag bad">綁定已鎖定</span>` : `<span class="tag muted">未綁定</span>`
    ].join("");
    return `<button class="emr-row ${u.active === false ? "off" : ""}" data-id="${u.id}">
      ${u.linePicture ? `<img class="emp-av" src="${esc(u.linePicture)}" alt="">` : `<span class="emp-av" style="background:${col}">${esc(ini)}</span>`}
      <span class="emp-main"><b>${esc(u.name || "（未命名）")}</b><small>${esc([u.empNo, u.email].filter(Boolean).join("・"))}</small></span>
      <span class="emp-tags">${tags}</span><span class="chev-r">›</span></button>`;
  }).join("") || `<p class="empty" style="padding:20px">沒有符合的員工</p>`;
}
$("#empSearch").oninput = renderEmpList;
$("#empFilter").onclick = e => { const b = e.target.closest("button[data-v]"); if (!b) return; empF = b.dataset.v; setSeg("#empFilter", empF); renderEmpList(); };

let em = null;
function openEmp(u) {
  em = { u };
  const isNew = !u;
  $("#emTitle").textContent = isNew ? "新增員工" : "員工資料";
  $("#emName").value = u?.name || ""; $("#emNo").value = u?.empNo || ""; $("#emEmail").value = u?.email || "";
  setSeg("#emRole", u?.role === "admin" ? "admin" : "employee");
  setSeg("#emActive", u?.active === false ? "0" : "1");
  $("#emHead").innerHTML = isNew ? "" : `${u.linePicture ? `<img class="emp-av big" src="${esc(u.linePicture)}" alt="">` : ""}<b>${esc(u.name || "")}</b>`;
  $("#emHead").classList.toggle("hidden", isNew);
  $("#emLine").innerHTML = isNew ? `<p class="hint" style="margin:0">新增後，請員工用 LINE 打開系統、點自己的名字並輸入上面的 Email 完成綁定。</p>`
    : empBound(u) ? `<div class="em-line-row"><span>LINE 綁定</span><b>${esc(u.lineName || "已綁定")}</b><button class="btn small" id="emUnbind">解除綁定</button></div><p class="hint" style="margin:6px 0 0">換手機或換 LINE 帳號時解除，員工重新登入再綁定一次。</p>`
    : empLocked(u) ? `<div class="em-line-row"><span>LINE 綁定</span><b class="red">Email 輸錯 5 次已鎖定</b><button class="btn small" id="emUnbind">重設</button></div>`
    : `<div class="em-line-row"><span>LINE 綁定</span><b class="muted">尚未綁定</b></div>`;
  $("#emDel").classList.toggle("hidden", isNew || u.id === me.id);
  $("#empModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#empModal").classList.add("open"));
}
function closeEmp() { $("#empModal").classList.remove("open"); setTimeout(() => $("#empModal").classList.add("hidden"), 200); }
$("#empAddBtn").onclick = () => openEmp(null);
$("#empList").onclick = e => { const r = e.target.closest(".emr-row"); if (r) openEmp(employees.find(x => x.id === r.dataset.id)); };
$("#emRole").onclick = e => { const b = e.target.closest("button[data-v]"); if (b) setSeg("#emRole", b.dataset.v); };
$("#emActive").onclick = e => { const b = e.target.closest("button[data-v]"); if (b) setSeg("#emActive", b.dataset.v); };
$("#empModal").onclick = async e => {
  if (e.target.id === "empModal" || e.target.closest("[data-close]")) return closeEmp();
  const u = em?.u;
  try {
    if (e.target.id === "emUnbind") {
      if (!(await appConfirm("解除 LINE 綁定", `解除「${u.name}」的 LINE 綁定？他下次登入需要重新綁定。`, { okText: "解除綁定", danger: true }))) return;
      await updateDoc(doc(db, "employees", u.id), { lineUid: null, lineName: "", linePicture: "", bindFails: 0 });
      toast("已解除綁定"); closeEmp(); loadEmployeesView();
    } else if (e.target.id === "emDel") {
      if (!(await appConfirm("刪除員工", `刪除「${u.name}」？打卡紀錄會保留。\n（離職建議改成「停用」就好）`, { okText: "刪除", danger: true }))) return;
      await deleteDoc(doc(db, "employees", u.id));
      toast("已刪除"); closeEmp(); loadEmployeesView();
    }
  } catch (err) { toast("操作失敗：" + errMsg(err)); }
};
$("#emSave").onclick = async () => {
  const u = em?.u;
  const data = {
    name: $("#emName").value.trim(), empNo: $("#emNo").value.trim(), email: $("#emEmail").value.trim().toLowerCase(),
    role: $("#emRole button.on")?.dataset.v || "employee", active: $("#emActive button.on")?.dataset.v !== "0"
  };
  if (!data.name) return toast("請輸入姓名");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return toast("請輸入正確的 Email");
  if (employees.some(x => x.id !== u?.id && (x.email || "").toLowerCase() === data.email)) return toast("這個 Email 已經有其他員工使用");
  try {
    if (!u) {
      await addDoc(collection(db, "employees"), { ...data, lineUid: null, lineName: "", linePicture: "", bindFails: 0, createdAt: serverTimestamp() });
      toast("已新增員工");
    } else {
      if (u.id === me.id && (data.role !== "admin" || !data.active)
        && !(await appConfirm("變更自己的權限", "確定要取消自己的管理者權限或停用自己？之後將無法進入管理功能。", { okText: "確定變更", danger: true }))) return;
      await updateDoc(doc(db, "employees", u.id), data);
      toast("已儲存");
    }
    closeEmp(); loadEmployeesView();
  } catch (err) { toast("儲存失敗：" + errMsg(err)); }
};

$("#importBtn").onclick = async () => {
  const lines = $("#importText").value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return toast("請先貼上員工資料");
  $("#importBtn").disabled = true;
  try {
    await loadEmployees();
    const byEmail = Object.fromEntries(employees.map(e => [(e.email || "").toLowerCase(), e]));
    const seen = new Set();
    const bad = [];
    let batch = writeBatch(db), n = 0, add = 0, upd = 0;
    for (const line of lines) {
      const c = line.split(/\t|,/).map(x => x.trim());
      if (["員編", "編號"].includes(c[0])) continue;          // 表頭
      const [empNo = "", rawName = "", rawEmail = "", joinDate = "", role = ""] = c;
      const email = rawEmail.toLowerCase();
      const name = rawName.replace(/\s+/g, "");
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || seen.has(email)) { bad.push(line); continue; }
      seen.add(email);
      const data = { empNo, name, email, joinDate };
      if (role) data.role = /admin|管理/i.test(role) ? "admin" : "employee";
      const ex = byEmail[email];
      if (ex) {
        if (ex.id === me.id) delete data.role;              // 不改自己的權限
        batch.update(doc(db, "employees", ex.id), data); upd++;
      } else {
        batch.set(doc(collection(db, "employees")), {
          role: "employee", ...data, active: true,
          lineUid: null, lineName: "", linePicture: "", bindFails: 0, createdAt: serverTimestamp()
        });
        add++;
      }
      if (++n >= 450) { await batch.commit(); batch = writeBatch(db); n = 0; }
    }
    if (n) await batch.commit();
    toast(`匯入完成：新增 ${add} 位、更新 ${upd} 位${bad.length ? `，略過 ${bad.length} 行` : ""}`);
    $("#importText").value = bad.join("\n");
    if (bad.length) appAlert("部分資料已略過", "以下資料格式錯誤或重複（已保留在輸入框中）：\n" + bad.join("\n"));
    loadEmployeesView();
  } catch (err) {
    toast("匯入失敗：" + errMsg(err));
  } finally {
    $("#importBtn").disabled = false;
  }
};

/* ================= 班別設定（管理者） ================= */
let shF = "", shTab = "shift";
const SH_COLORS = ["#3a3f44", "#7b4fb0", "#2f6fb5", "#0a84ff", "#3d9a3a", "#30d158", "#d9822b", "#ff9f0a", "#b03a5b", "#ff375f", "#64d2ff", "#ac8e68", "#8e8e93"];
async function renderShiftList() {
  await Promise.all([loadShiftTypes(), loadLocations()]);
  $$("#shTab button").forEach(b => b.classList.toggle("on", b.dataset.v === shTab));
  const mob = isMob();
  $("#shPaneShift").classList.toggle("hidden", mob && shTab !== "shift");
  $("#shPaneLoc").classList.toggle("hidden", mob && shTab !== "loc");
  renderLocList(); locCountUpd();
  if (!mob || shTab === "loc") initLocMap();
  drawShiftRows();
  const c2 = $("#shCount2"); if (c2) c2.textContent = `${shiftTypes.length} 個`;
}
sortable($("#shiftList"), "[data-id]", ".drag-h", async ids => {
  await saveOrder("shiftTypes", shiftTypes, ids);
  shiftMap = Object.fromEntries(shiftTypes.map(s => [s.id, s])); writeCache(); drawShiftRows();
});
function drawShiftRowsDesk() {
  const locOpts = sel => `<option value="">不限地點</option>` + locations.map(l => `<option value="${l.id}" ${sel === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  $("#shiftList").innerHTML = `<table class="tbl"><thead><tr><th></th><th>代碼</th><th>類別</th><th>名稱</th><th>上班時間</th><th>下班時間</th><th>時數</th><th>打卡地點</th><th>顏色</th><th></th></tr></thead><tbody>` + (shiftTypes.length ? shiftTypes.map(s => `
    <tr data-id="${s.id}">
      <td class="nowrap"><span class="drag-h" title="拖曳調整順序">⋮⋮</span><input type="checkbox" class="s-chk"></td>
      <td><input class="s-code" value="${esc(s.code || "")}" size="5"></td>
      <td><select class="s-cat"><option value="shift" ${s.cat !== "leave" ? "selected" : ""}>班別</option><option value="leave" ${s.cat === "leave" ? "selected" : ""}>休假</option></select></td>
      <td><input class="s-name" value="${esc(s.name)}" size="22"></td>
      <td><input class="s-start" type="time" value="${esc(s.start || "")}"></td>
      <td><input class="s-end" type="time" value="${esc(s.end || "")}"></td>
      <td>${shiftHours(s) || "—"}${s.breakStart && s.breakEnd ? `<div class="emp-no">休息 ${esc(s.breakStart)}~${esc(s.breakEnd)}</div>` : ""}</td>
      <td><div class="loc-pair"><label><span>上班</span><select class="s-loc">${locOpts(s.locationId || "")}</select></label>
        <label><span>下班</span><select class="s-oloc">${locOpts(s.outLocationId || "").replace("不限地點", "同上班地點")}</select></label></div></td>
      <td><input class="s-color" type="color" value="${esc(s.color || "#2e9e3f")}"></td>
      <td><button class="btn small primary s-save">儲存</button> <button class="btn small danger s-del">刪除</button></td>
    </tr>`).join("") : `<tr><td colspan="10" class="empty">尚未建立班別</td></tr>`) + `</tbody></table>`;
  $("#shCount").textContent = `共 ${shiftTypes.length} 個班別`;
  $("#shAll").checked = false; updShSel();
}
function drawShiftRows() {
  if (!isMob()) return drawShiftRowsDesk();
  const q = $("#shSearch").value.trim().toLowerCase();
  const list = shiftTypes.filter(s => (!q || `${s.name} ${s.code || ""}`.toLowerCase().includes(q))
    && (!shF || (shF === "shift" && s.cat !== "leave") || (shF === "leave" && s.cat === "leave") || (shF === "noloc" && s.cat !== "leave" && !s.locationId)));
  const nShift = shiftTypes.filter(s => s.cat !== "leave").length;
  $("#shSub").textContent = `${nShift} 個上班班別・${shiftTypes.length - nShift} 個休假・${locations.length} 個打卡地點`;
  $("#shCount").textContent = list.length !== shiftTypes.length ? `顯示 ${list.length} / ${shiftTypes.length}` : `共 ${shiftTypes.length} 個`;
  const ln = id => locMap[id]?.name || "";
  $("#shiftList").innerHTML = list.map(s => {
    const leave = s.cat === "leave";
    const loc = leave ? "" : !s.locationId ? `<span class="sh-loc none">不限地點</span>`
      : s.outLocationId && s.outLocationId !== s.locationId ? `<span class="sh-loc">📍 上班 ${esc(ln(s.locationId))} → 下班 ${esc(ln(s.outLocationId))}</span>`
      : `<span class="sh-loc">📍 ${esc(ln(s.locationId))}</span>`;
    const h = shiftHours(s);
    return `<div class="sh-row" data-id="${s.id}">
      <span class="drag-h" title="拖曳調整順序">⋮⋮</span><input type="checkbox" class="s-chk">
      <span class="sh-bar-c" style="background:${esc(s.color || "#8e8e93")}"></span>
      <span class="sh-main"><b>${esc(s.name)}</b>
        <small>${leave ? `<span class="tag muted">休假</span>` : s.start && s.end ? `<span class="sh-time">${esc(s.start)} – ${esc(s.end)}</span>${h ? `<span class="sh-h">${h}</span>` : ""}` : `<span class="sh-loc none">沒設時間</span>`}${s.code ? `<span class="sh-code">${esc(s.code)}</span>` : ""}</small>
        ${loc}</span>
      <span class="chev-r">›</span></div>`;
  }).join("") || `<p class="empty" style="padding:20px">${shiftTypes.length ? "沒有符合的班別" : "尚未建立班別，按「＋ 新增班別」或用下方批次新增"}</p>`;
  $("#shAll").checked = false; updShSel();
}
function updShSel() { const n = $$(".s-chk:checked").length; $("#shDelSel").classList.toggle("hidden", !n); $("#shDelSel").textContent = `刪除勾選（${n}）`; }
$("#shTab").onclick = e => { const b = e.target.closest("button[data-v]"); if (!b) return; shTab = b.dataset.v; renderShiftList(); };
$("#shSearch").oninput = drawShiftRows;
$("#shFilter").onclick = e => { const b = e.target.closest("button[data-v]"); if (!b) return; shF = b.dataset.v; setSeg("#shFilter", shF); drawShiftRows(); };
$("#shiftList").onclick = async e => {
  if (e.target.classList.contains("s-chk")) return updShSel();
  if (e.target.closest(".drag-h")) return;
  const tr = e.target.closest("tr[data-id]");
  if (tr) {   // 電腦版表格：直接編輯
    const id = tr.dataset.id;
    try {
      if (e.target.classList.contains("s-save")) {
        const data = {
          code: $(".s-code", tr).value.trim(), cat: $(".s-cat", tr).value, name: $(".s-name", tr).value.trim(),
          start: $(".s-start", tr).value, end: $(".s-end", tr).value,
          locationId: $(".s-loc", tr).value || "", outLocationId: $(".s-oloc", tr).value || "", color: $(".s-color", tr).value
        };
        if (!data.name) return toast("名稱不可空白");
        if ((data.start && !data.end) || (!data.start && data.end)) return toast("上班與下班時間要一起填，或都留空");
        await updateDoc(doc(db, "shiftTypes", id), data);
        toast(`已儲存「${data.name}」`); renderShiftList();
      } else if (e.target.classList.contains("s-del")) {
        if (!(await appConfirm("刪除班別", `確定刪除「${shiftMap[id]?.name}」？已排入班表的不會自動移除。`, { okText: "刪除", danger: true }))) return;
        await deleteDoc(doc(db, "shiftTypes", id)); toast("已刪除"); renderShiftList();
      }
    } catch (err) { toast("操作失敗：" + errMsg(err)); }
    return;
  }
  const r = e.target.closest(".sh-row"); if (r) openShift(shiftMap[r.dataset.id]);
};
$("#shiftForm").onsubmit = async e => {
  e.preventDefault();
  const data = { cat: $("#shCat").value, name: $("#shName").value.trim(), start: $("#shStart").value, end: $("#shEnd").value, color: $("#shColor").value, order: Date.now() };
  if (!data.name) return;
  try { await addDoc(collection(db, "shiftTypes"), data); e.target.reset(); $("#shColor").value = "#2e9e3f"; toast("已新增班別"); renderShiftList(); }
  catch (err) { toast("新增失敗：" + errMsg(err)); }
};
$("#shAddBtn").onclick = () => openShift(null);

// 班別編輯視窗
let sm = null;
function openShift(sh) {
  sm = { s: sh };
  $("#smTitle").textContent = sh ? "編輯班別" : "新增班別";
  $("#smName").value = sh?.name || ""; $("#smCode").value = sh?.code || "";
  $("#smStart").value = sh?.start || ""; $("#smEnd").value = sh?.end || "";
  setSeg("#smCat", sh?.cat === "leave" ? "leave" : "shift");
  sm.color = sh?.color || "#2f6fb5";
  const cols = SH_COLORS.includes(sm.color) ? SH_COLORS : [sm.color, ...SH_COLORS];
  $("#smColors").innerHTML = cols.map(c => `<button type="button" data-c="${c}" style="background:${c}" class="${c === sm.color ? "on" : ""}"></button>`).join("") + `<label class="sm-more" title="其他顏色"><input type="color" id="smColorPick" value="${esc(sm.color)}">＋</label>`;
  const opts = (sel, none) => `<option value="">${none}</option>` + locations.map(l => `<option value="${l.id}" ${sel === l.id ? "selected" : ""}>${esc(l.name)}（${l.radius || 50} 公尺）</option>`).join("");
  $("#smLoc").innerHTML = opts(sh?.locationId || "", "不限地點");
  $("#smOLoc").innerHTML = opts(sh?.outLocationId || "", "同上班地點");
  smCatUI();
  $("#smDel").classList.toggle("hidden", !sh);
  $("#shModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#shModal").classList.add("open"));
}
function smCatUI() { const leave = $("#smCat button.on")?.dataset.v === "leave"; $(".sm-time").classList.toggle("hidden", leave); $(".sm-loc").classList.toggle("hidden", leave); }
function closeShiftM() { $("#shModal").classList.remove("open"); setTimeout(() => $("#shModal").classList.add("hidden"), 200); }
$("#smCat").onclick = e => { const b = e.target.closest("button[data-v]"); if (b) { setSeg("#smCat", b.dataset.v); smCatUI(); } };
$("#smColors").onclick = e => { const b = e.target.closest("button[data-c]"); if (!b) return; sm.color = b.dataset.c; $$("#smColors button").forEach(x => x.classList.toggle("on", x === b)); };
$("#smColors").oninput = e => { if (e.target.id === "smColorPick") { sm.color = e.target.value; $$("#smColors button").forEach(x => x.classList.remove("on")); } };
$("#shModal").onclick = async e => {
  if (e.target.id === "shModal" || e.target.closest("[data-close]")) return closeShiftM();
  if (e.target.id === "smDel") {
    if (!(await appConfirm("刪除班別", `確定刪除「${sm.s.name}」？已排入班表的不會自動移除。`, { okText: "刪除", danger: true }))) return;
    try { await deleteDoc(doc(db, "shiftTypes", sm.s.id)); toast("已刪除"); closeShiftM(); renderShiftList(); }
    catch (err) { toast("刪除失敗：" + errMsg(err)); }
  }
};
$("#smSave").onclick = async () => {
  const leave = $("#smCat button.on")?.dataset.v === "leave";
  const data = {
    name: $("#smName").value.trim(), code: $("#smCode").value.trim(), cat: leave ? "leave" : "shift",
    start: leave ? "" : $("#smStart").value, end: leave ? "" : $("#smEnd").value, color: sm.color,
    locationId: leave ? "" : $("#smLoc").value, outLocationId: leave ? "" : $("#smOLoc").value
  };
  if (!data.name) return toast("請輸入班別名稱");
  if ((data.start && !data.end) || (!data.start && data.end)) return toast("上班和下班時間要一起填，或都留空");
  try {
    if (sm.s) { await updateDoc(doc(db, "shiftTypes", sm.s.id), data); toast(`已儲存「${data.name}」`); }
    else { await addDoc(collection(db, "shiftTypes"), { ...data, order: Date.now() }); toast("已新增班別"); }
    closeShiftM(); renderShiftList();
  } catch (err) { toast("儲存失敗：" + errMsg(err)); }
};

// ---- 打卡地點（管理者）----
let lMap = null, lLayer = null, lPick = null;
const boxOf = (lat, radius) => {
  // 給安全規則用的經緯度範圍（多留 30 公尺給 GPS 誤差）
  const m = (radius || 50) + 30;
  return { dLat: m / 111320, dLng: m / (111320 * Math.cos(lat * Math.PI / 180)) };
};

function renderLocList() {
  if (!isMob()) {
    const usedN = id => shiftTypes.filter(s => s.locationId === id || s.outLocationId === id).length;
    $("#locList").innerHTML = `<table class="tbl"><thead><tr><th style="width:28px"></th><th>地點</th><th>座標</th><th>範圍（公尺）</th><th></th></tr></thead><tbody>` + (locations.map(l => `
      <tr data-id="${l.id}">
        <td><span class="drag-h" title="拖曳調整順序">⋮⋮</span></td>
        <td><input class="l-name" value="${esc(l.name)}" size="14"></td>
        <td><a href="https://www.google.com/maps?q=${l.lat},${l.lng}" target="_blank" rel="noopener">${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}</a><div class="emp-no">${usedN(l.id)} 個班別使用</div></td>
        <td><input class="l-radius" type="number" min="10" max="1000" value="${l.radius || 50}" style="width:80px"></td>
        <td><button class="btn small primary l-save">儲存</button> <button class="btn small danger l-del">刪除</button></td>
      </tr>`).join("") || `<tr><td colspan="5" class="empty">尚未建立打卡地點</td></tr>`) + `</tbody></table>`;
    return;
  }
  const used = id => shiftTypes.filter(x => x.locationId === id || x.outLocationId === id);
  $("#locList").innerHTML = locations.map(l => {
    const u = used(l.id);
    return `<div class="sh-row lc-row" data-id="${l.id}">
      <span class="drag-h" title="拖曳調整順序">⋮⋮</span><span class="lc-pin">📍</span>
      <span class="sh-main"><b>${esc(l.name)}</b><small><span class="sh-time">範圍 ${l.radius || 50} 公尺</span><span class="${u.length ? "" : "sh-loc none"}">${u.length ? `${u.length} 個班別使用` : "還沒有班別使用"}</span></small></span>
      <span class="chev-r">›</span></div>`;
  }).join("") || `<p class="empty" style="padding:20px">尚未建立打卡地點</p>`;
}
const locCountUpd = () => { const el = $("#locCount"); if (el) el.textContent = `${locations.length} 個`; };
sortable($("#locList"), "[data-id]", ".drag-h", async ids => { await saveOrder("locations", locations, ids); renderLocList(); locCountUpd(); });
let lc = null;
$("#locList").onclick = async e => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) {   // 電腦版表格
    const l = locMap[tr.dataset.id];
    try {
      if (e.target.classList.contains("l-save")) {
        const radius = Math.max(10, Math.min(1000, +$(".l-radius", tr).value || 50));
        await updateDoc(doc(db, "locations", l.id), { name: $(".l-name", tr).value.trim() || l.name, radius, ...boxOf(l.lat, radius) });
        toast("已儲存"); renderShiftList();
      } else if (e.target.classList.contains("l-del")) { lc = l; $("#lcDel").click(); }
    } catch (err) { toast("操作失敗：" + errMsg(err)); }
    return;
  }
  if (e.target.closest(".drag-h")) return;
  const r = e.target.closest(".lc-row"); if (!r) return;
  const l = locMap[r.dataset.id]; lc = l;
  $("#lcName").value = l.name; $("#lcRadius").value = l.radius || 50; $("#lcRadiusV").textContent = `${l.radius || 50} 公尺`;
  $("#lcMapLink").href = `https://www.google.com/maps?q=${l.lat},${l.lng}`; $("#lcMapLink").textContent = `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}（在 Google 地圖打開）`;
  const u = shiftTypes.filter(x => x.locationId === l.id || x.outLocationId === l.id);
  $("#lcUsed").innerHTML = u.map(x => `<span class="chip" style="--c:${esc(x.color || "#8e8e93")}">${esc(x.name)}</span>`).join("") || `<span class="hint" style="margin:0">還沒有班別使用，到「班別」分頁點班別指定</span>`;
  $("#lcModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#lcModal").classList.add("open"));
};
$("#lcRadius").oninput = () => $("#lcRadiusV").textContent = `${$("#lcRadius").value} 公尺`;
function closeLc() { $("#lcModal").classList.remove("open"); setTimeout(() => $("#lcModal").classList.add("hidden"), 200); }
$("#lcModal").onclick = async e => {
  if (e.target.id === "lcModal" || e.target.closest("[data-close]")) return closeLc();
  if (e.target.id !== "lcDel") return;
  const l = lc;
  const users = shiftTypes.filter(x => x.locationId === l.id || x.outLocationId === l.id);
  if (!(await appConfirm("刪除打卡地點", `刪除「${l.name}」？${users.length ? `目前有 ${users.length} 個班別使用，刪除後這些班別將不限地點。` : ""}`, { okText: "刪除", danger: true }))) return;
  try {
    const b = writeBatch(db);
    users.forEach(x => b.update(doc(db, "shiftTypes", x.id), { ...(x.locationId === l.id ? { locationId: "" } : {}), ...(x.outLocationId === l.id ? { outLocationId: "" } : {}) }));
    b.delete(doc(db, "locations", l.id));
    await b.commit();
    toast("已刪除"); closeLc(); renderShiftList();
  } catch (err) { toast("刪除失敗：" + errMsg(err)); }
};
$("#lcSave").onclick = async () => {
  const l = lc, radius = Math.max(10, Math.min(1000, +$("#lcRadius").value || 50));
  try {
    await updateDoc(doc(db, "locations", l.id), { name: $("#lcName").value.trim() || l.name, radius, ...boxOf(l.lat, radius) });
    toast("已儲存"); closeLc(); renderShiftList();
  } catch (err) { toast("儲存失敗：" + errMsg(err)); }
};

async function initLocMap() {
  let L;
  try { L = await loadLeaflet(); } catch { return; }
  if (!lMap) {
    lMap = newMap(L, "locMap");
    L.control.zoom({ position: "bottomright" }).addTo(lMap);
    lLayer = L.layerGroup().addTo(lMap);
    lMap.on("click", e => setPick(e.latlng.lat, e.latlng.lng, true));
    lMap.setView([25.04, 121.53], 12);
  }
  lLayer.clearLayers();
  const pts = locations.map(l => {
    L.circle([l.lat, l.lng], { radius: l.radius || 50, color: "#0071e3", weight: 2, fillOpacity: .12 }).addTo(lLayer)
      .bindTooltip(l.name, { permanent: true, direction: "top", className: "map-tip" });
    return [l.lat, l.lng];
  });
  setTimeout(() => {
    lMap.invalidateSize();
    if (pts.length && !lPick) pts.length === 1 ? lMap.setView(pts[0], 16) : lMap.fitBounds(pts, { padding: [30, 30], maxZoom: 17 });
  }, 60);
}

async function setPick(lat, lng, fromMap) {
  const L = await loadLeaflet();
  $("#locCoord").value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const r = +$("#locRadius").value || 50;
  if (lPick) lLayer.removeLayer(lPick);
  lPick = L.circle([lat, lng], { radius: r, color: "#ff9500", weight: 2, fillOpacity: .18, dashArray: "4 4" }).addTo(lLayer);
  if (!fromMap) lMap.setView([lat, lng], 17);
}
// 地址搜尋（OpenStreetMap Nominatim，免費）
async function searchPlace() {
  const q = $("#locSearch").value.trim();
  if (!q) return;
  const c = parseCoord(q);
  if (c) { $("#locResults").innerHTML = ""; return setPick(c.lat, c.lng); }
  $("#locResults").innerHTML = `<div class="loc-res muted">搜尋中…</div>`;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=tw&accept-language=zh-TW&q=${encodeURIComponent(q)}`);
    const list = await r.json();
    $("#locResults").innerHTML = list.length ? list.map(x => `
      <button type="button" class="loc-res" data-lat="${x.lat}" data-lng="${x.lon}" data-name="${esc((x.name || x.display_name.split(",")[0]).trim())}">
        <b>${esc(x.name || x.display_name.split(",")[0])}</b><span>${esc(x.display_name)}</span></button>`).join("")
      : `<div class="loc-res muted">找不到「${esc(q)}」，可以換個關鍵字，或直接在地圖上點選</div>`;
  } catch {
    $("#locResults").innerHTML = `<div class="loc-res muted">搜尋失敗，請直接在地圖上點選位置</div>`;
  }
}
$("#locSearchBtn").onclick = searchPlace;
$("#locSearch").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); searchPlace(); } };
$("#locResults").onclick = e => {
  const b = e.target.closest(".loc-res[data-lat]");
  if (!b) return;
  setPick(+b.dataset.lat, +b.dataset.lng);
  if (!$("#locName").value.trim()) $("#locName").value = b.dataset.name;
  $("#locResults").innerHTML = "";
};

$("#locCoord").onchange = () => { const c = parseCoord($("#locCoord").value); if (c) setPick(c.lat, c.lng); else toast("看不懂這個座標，請點地圖選位置"); };
$("#locRadius").oninput = () => { if (lPick) lPick.setRadius(+$("#locRadius").value || 50); };
$("#locHere").onclick = () => {
  if (!navigator.geolocation) return toast("這個裝置不支援定位");
  toast("定位中…");
  navigator.geolocation.getCurrentPosition(p => setPick(p.coords.latitude, p.coords.longitude),
    () => toast("無法取得目前位置，請改點地圖"), { enableHighAccuracy: true, timeout: 15000 });
};
$("#locForm").onsubmit = async e => {
  e.preventDefault();
  const c = parseCoord($("#locCoord").value);
  if (!c) return toast("請先在地圖上點選位置");
  const radius = Math.max(10, Math.min(1000, +$("#locRadius").value || 50));
  const name = $("#locName").value.trim();
  if (!name) return;
  try {
    await addDoc(collection(db, "locations"), { name, lat: c.lat, lng: c.lng, radius, ...boxOf(c.lat, radius), createdAt: serverTimestamp() });
    toast(`已新增「${name}」，記得到「班別」分頁指定打卡地點`);
    e.target.reset(); $("#locRadius").value = 50;
    if (lPick) { lLayer.removeLayer(lPick); lPick = null; }
    renderShiftList();
  } catch (err) { toast("新增失敗：" + errMsg(err) + "（請確認 firestore.rules 已更新）"); }
};
// ---- 勾選刪除 / 全部刪除 ----
$("#shAll").onchange = e => { $$(".s-chk").forEach(c => c.checked = e.target.checked); updShSel(); };

async function deleteShifts(ids) {
  let batch = writeBatch(db), n = 0;
  for (const id of ids) {
    batch.delete(doc(db, "shiftTypes", id));
    if (++n >= 450) { await batch.commit(); batch = writeBatch(db); n = 0; }
  }
  if (n) await batch.commit();
  toast(`已刪除 ${ids.length} 個班別`);
  renderShiftList();
}
$("#shDelSel").onclick = async () => {
  const ids = $$(".s-chk:checked").map(c => c.closest("[data-id]").dataset.id);
  if (!ids.length) return toast("請先勾選要刪除的班別");
  if (!(await appConfirm("刪除班別", `確定刪除勾選的 ${ids.length} 個班別？`, { okText: "刪除", danger: true }))) return;
  try { await deleteShifts(ids); } catch (err) { toast("刪除失敗：" + errMsg(err)); }
};
$("#shDelAll").onclick = async () => {
  await loadShiftTypes();
  if (!shiftTypes.length) return toast("目前沒有班別");
  if (!(await appConfirm("刪除全部班別", `確定刪除全部 ${shiftTypes.length} 個班別？此動作無法復原，已排入班表的班別會從班表上消失。`, { okText: "全部刪除", danger: true }))) return;
  try { await deleteShifts(shiftTypes.map(s => s.id)); } catch (err) { toast("刪除失敗：" + errMsg(err)); }
};

// ---- 批次新增班別 ----
const COLOR_RULES = [
  [/接送|交通車/, "#3d9a3a"],
  [/溜冰場/, "#3a3f44"],
  [/學校課堂/, "#2f6fb5"],
  [/加課|加強/, "#d9822b"],
  [/晨訓/, "#7b4fb0"],
  [/校隊/, "#b03a5b"]
];
const FALLBACK_COLORS = ["#0f8b8d", "#8d6e63", "#5c6bc0", "#c0392b", "#16a085", "#6d4c41"];
const LEAVE_COLOR = "#9aa0a6";

function parseTimes(name) {
  const m = name.match(/(\d{1,2}):?(\d{2})\s*[-~～－]\s*(\d{1,2}):?(\d{2})/);
  if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59) return ["", ""];
  return [`${pad(+m[1])}:${m[2]}`, `${pad(+m[3])}:${m[4]}`];
}

async function addShiftsBulk(items) {
  await loadShiftTypes();
  const byName = Object.fromEntries(shiftTypes.map(s => [s.name, s]));
  const seen = new Set();
  let batch = writeBatch(db), n = 0, add = 0, upd = 0, fb = 0;
  const base = Date.now();
  for (const [i, it] of items.entries()) {
    if (!it.name || seen.has(it.name)) continue;
    seen.add(it.name);
    const fields = { cat: it.cat || "shift", order: base + i };
    if (it.code) fields.code = it.code;
    if (it.start && it.end) { fields.start = it.start; fields.end = it.end; }
    fields.breakStart = it.breakStart || "";
    fields.breakEnd = it.breakEnd || "";
    const ex = byName[it.name];
    if (ex) {
      batch.update(doc(db, "shiftTypes", ex.id), fields); upd++;
    } else {
      let color = it.cat === "leave" ? LEAVE_COLOR
        : (COLOR_RULES.find(([re]) => re.test(it.name)) || [, FALLBACK_COLORS[fb++ % FALLBACK_COLORS.length]])[1];
      batch.set(doc(collection(db, "shiftTypes")), { start: "", end: "", code: "", ...fields, name: it.name, color });
      add++;
    }
    if (++n >= 450) { await batch.commit(); batch = writeBatch(db); n = 0; }
  }
  if (n) await batch.commit();
  toast(`新增 ${add} 個、更新 ${upd} 個班別`);
  renderShiftList();
}

$("#shiftBulkBtn").onclick = async () => {
  const isTime = p => /^\d{1,2}:\d{2}$/.test(p);
  const norm = t => t.padStart(5, "0");
  const items = $("#shiftBulk").value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\t|,/).map(x => x.trim()).filter(Boolean);
    const cat = parts.some(p => /^(休假|leave)$/i.test(p)) ? "leave" : "shift";
    const texts = parts.filter(p => !isTime(p) && !/^(休假|leave)$/i.test(p));
    const times = parts.filter(isTime).map(norm);
    const [code, name] = texts.length >= 2 ? [texts[0], texts[1]] : ["", texts[0]];
    let [start, end] = times.length >= 2 ? times : (cat === "leave" ? ["", ""] : parseTimes(name || ""));
    return { code, name, cat, start, end, breakStart: times[2] || "", breakEnd: times[3] || "" };
  });
  if (!items.length) return toast("請先輸入班別名稱");
  $("#shiftBulkBtn").disabled = true;
  try { await addShiftsBulk(items); $("#shiftBulk").value = ""; }
  catch (err) { toast("新增失敗：" + errMsg(err)); }
  finally { $("#shiftBulkBtn").disabled = false; }
};

$("#leaveDefaultBtn").onclick = async () => {
  try {
    await addShiftsBulk(["國定假日", "休息日", "例假日", "空班"].map(name => ({ name, cat: "leave" })));
  } catch (err) { toast("新增失敗：" + errMsg(err)); }
};

/* ================= 排班作業（管理者） ================= */
let selShift = null;
let schedMap = {}; // `${empId}_${date}` -> shiftIds
let schedLeave = {}; // `${empId}_${date}` -> { shiftId: 假別 }
const cellChips = key => byTime(schedMap[key]).map(id => schedLeave[key]?.[id]
  ? chipHtml(id, true).replace('class="chip"', `class="chip lv" title="已請假：${esc(schedLeave[key][id])}"`) : chipHtml(id, true)).join("");
let roster = {};   // 當月班表設定

const tsMs = t => t?.toMillis ? t.toMillis() : (t instanceof Date ? t.getTime() : 0);
const rosterShifts = () => roster.shiftIds?.length ? shiftTypes.filter(s => roster.shiftIds.includes(s.id)) : shiftTypes;
const rosterEmps = () => roster.empIds?.length ? activeEmployees().filter(u => roster.empIds.includes(u.id)) : activeEmployees();

function renderSchSub() {
  const month = $("#schMonth").value;
  const [y, m] = month.split("-");
  const last = new Date(+y, +m, 0).getDate();
  const pub = tsMs(roster.publishedAt);
  const state = !pub ? `<span class="badge gray">尚未發布</span>`
    : tsMs(roster.editedAt) > pub ? `<span class="badge orange">有未發布的變更</span>`
    : `<span class="badge green">已發布</span>`;
  $("#schTitle").textContent = roster.name;
  $("#schSub").innerHTML = `${month}-01 ~ ${month}-${last} · ${VIS_LABEL[roster.visibility] || VIS_LABEL.self} · ${rosterEmps().length} 位人員 · ${rosterShifts().length} 個班別 ${state}`;
}

async function loadScheduling() {
  const month = $("#schMonth").value;
  await Promise.all([loadEmployees(), loadShiftTypes()]);
  const [snap, rSnap] = await Promise.all([
    monthDocs("schedules", month),
    getDoc(doc(db, "rosters", month))
  ]);
  schedMap = {};
  schedLeave = {};
  snap.forEach(d => { schedMap[d.id] = d.data().shiftIds || []; schedLeave[d.id] = d.data().leave || {}; });

  const [y, m] = month.split("-");
  roster = { name: `${y}/${+m}月班表`, shiftIds: [], empIds: [], visibility: "self", ...(rSnap.exists() ? rSnap.data() : {}) };
  if (selShift && !rosterShifts().some(s => s.id === selShift)) selShift = null;
  renderSchSub();

  // 下拉選單（手機、電腦共用）
  const opt = s => `<option value="${s.id}">${esc(s.name)}${s.start && s.end ? `（${s.start}-${s.end}）` : ""}</option>`;
  const shifts = rosterShifts().filter(s => (s.cat || "shift") === "shift");
  const leaves = rosterShifts().filter(s => s.cat === "leave");
  $("#schPick").innerHTML = `<option value="">快速排班：關閉（點日期選擇班別）</option>` +
    (shifts.length ? `<optgroup label="班別">${shifts.map(opt).join("")}</optgroup>` : "") +
    (leaves.length ? `<optgroup label="休假">${leaves.map(opt).join("")}</optgroup>` : "");

  await loadHistory(month).catch(err => console.warn("歷史排班載入失敗", err));
  renderPalette();
  syncPick();
  renderSchedTable(month);
  renderSchedMobile(month);
}

function renderPalette() {
  const f = ($("#schFilter").value || "").trim().toLowerCase();
  const pal = cat => rosterShifts()
    .filter(s => (s.cat || "shift") === cat && (!f || s.name.toLowerCase().includes(f) || (s.code || "").toLowerCase().includes(f)))
    .map(s => `<span class="chip ${selShift === s.id ? "sel" : ""}" style="background:${esc(s.color)}" data-pick="${s.id}" title="${esc(shiftTip(s))}">${esc(s.name)}</span>`)
    .join("") || `<span class="hint" style="margin:0">${f ? "找不到符合的班別" : "（請先到「班別設定」新增）"}</span>`;
  $("#palShift").innerHTML = pal("shift");
  $("#palLeave").innerHTML = pal("leave");
}
$("#schFilter").oninput = renderPalette;
["#palShift", "#palLeave"].forEach(sel => sortable($(sel), "[data-pick]", null, async ids => {
  await saveOrder("shiftTypes", shiftTypes, ids);
  shiftMap = Object.fromEntries(shiftTypes.map(s => [s.id, s])); writeCache();
  renderPalette(); syncPick();
}));

function syncPick() {
  $("#schPick").value = selShift || "";
  $$("[data-pick]").forEach(c => c.classList.toggle("sel", c.dataset.pick === selShift));
  $("#schPickChip").innerHTML = selShift ? chipHtml(selShift) : "";
}
$("#schPick").onchange = e => { selShift = e.target.value || null; syncPick(); };
$("#view-scheduling").addEventListener("click", e => {
  const pick = e.target.closest("[data-pick]");
  if (!pick) return;
  selShift = selShift === pick.dataset.pick ? null : pick.dataset.pick;
  syncPick();
});

// ---- 電腦版：表格 ----
function renderSchedTable(month) {
  const days = daysOfMonth(month);
  const list = rosterEmps();
  const today = ymd(new Date());
  const wk = d => (d.getDay() === 0 || d.getDay() === 6) ? "wkend" : "";
  let html = `<thead><tr><th class="name">姓名 / 員編</th>${days.map(d =>
    `<th class="${wk(d)}"${ymd(d) === today ? ' style="color:var(--primary)"' : ""}>${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）</th>`).join("")}</tr></thead><tbody>`;
  for (const u of list) {
    html += `<tr><td class="name">${esc(u.name)}<div class="emp-no">${esc(u.empNo || "")}</div></td>`;
    for (const d of days) {
      const key = `${u.id}_${ymd(d)}`;
      html += `<td class="cell ${wk(d)}" data-key="${key}">${cellChips(key)}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody>";
  $("#schedTable").innerHTML = list.length ? html : `<tbody><tr><td class="empty">尚無員工</td></tr></tbody>`;
}

$("#schedTable").onclick = e => onCellClick(e, e.target.closest("td.cell"));

// ---- 手機版：選一位員工，列出整月每天 ----
function renderSchedMobile(month) {
  const list = rosterEmps();
  const sel = $("#schEmp");
  const cur = sel.value;
  sel.innerHTML = list.map(u => {
    const n = Object.keys(schedMap).filter(k => k.startsWith(u.id + "_") && schedMap[k].length).length;
    return `<option value="${u.id}">${esc(u.empNo)} ${esc(u.name)}（${n} 天）</option>`;
  }).join("");
  if (cur && list.some(u => u.id === cur)) sel.value = cur;
  renderDayList(month);
}
function renderEmpCounts() {
  $$("#schEmp option").forEach(o => {
    const u = employees.find(x => x.id === o.value);
    if (!u) return;
    const n = Object.keys(schedMap).filter(k => k.startsWith(u.id + "_") && schedMap[k].length).length;
    o.textContent = `${u.empNo || ""} ${u.name}（${n} 天）`;
  });
}
function renderDayList(month = $("#schMonth").value) {
  const empId = $("#schEmp").value;
  if (!empId) { $("#schDays").innerHTML = `<p class="empty">尚無員工</p>`; return; }
  const today = ymd(new Date());
  $("#schDays").innerHTML = daysOfMonth(month).map(d => {
    const ds = ymd(d), key = `${empId}_${ds}`;
    const wk = d.getDay() === 0 || d.getDay() === 6;
    return `<div class="day-row ${wk ? "wkend" : ""} ${ds === today ? "today" : ""}" data-key="${key}">
      <div class="dr-date"><b>${d.getDate()}</b><span>週${WEEK[d.getDay()]}</span></div>
      <div class="dr-chips">${dayChips(key)}</div>
      <span class="dr-add">＋</span>
    </div>`;
  }).join("");
}
const dayChips = key => cellChips(key) || `<span class="dr-empty">尚未排班</span>`;

$("#schEmp").onchange = () => renderDayList();
function stepEmp(d) {
  const sel = $("#schEmp");
  const i = sel.selectedIndex + d;
  if (i < 0 || i >= sel.options.length) return;
  sel.selectedIndex = i;
  renderDayList();
}
$("#schPrev").onclick = () => stepEmp(-1);
$("#schNext").onclick = () => stepEmp(1);
$("#schDays").onclick = e => onCellClick(e, e.target.closest(".day-row"));

// ---- 班表設定視窗 ----
let rDraft = null;
function openRoster() {
  rDraft = {
    name: roster.name,
    visibility: roster.visibility || "self",
    shiftIds: new Set(roster.shiftIds?.length ? roster.shiftIds : shiftTypes.map(s => s.id)),
    empIds: new Set(roster.empIds?.length ? roster.empIds : activeEmployees().map(u => u.id))
  };
  $("#rName").value = rDraft.name;
  $("#rShiftFilter").value = ""; $("#rEmpFilter").value = "";
  renderRosterForm();
  $("#rosterModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#rosterModal").classList.add("open"));
}
function closeRoster() {
  $("#rosterModal").classList.remove("open");
  setTimeout(() => $("#rosterModal").classList.add("hidden"), 200);
}
function renderRosterForm() {
  $$("#rVis button").forEach(b => b.classList.toggle("on", b.dataset.v === rDraft.visibility));
  const fs = $("#rShiftFilter").value.trim().toLowerCase();
  $("#rShifts").innerHTML = shiftTypes.filter(s => !fs || s.name.toLowerCase().includes(fs) || (s.code || "").toLowerCase().includes(fs)).map(s => `
    <label class="check-item"><input type="checkbox" data-sid="${s.id}" ${rDraft.shiftIds.has(s.id) ? "checked" : ""}>
      <span class="dot" style="background:${esc(s.color)}"></span><span class="ci-name">${esc(s.name)}</span>
      <span class="ci-sub">${s.start && s.end ? `${s.start}–${s.end}` : (s.cat === "leave" ? "休假" : "")}</span></label>`).join("")
    || `<p class="empty">找不到班別</p>`;
  const fe = $("#rEmpFilter").value.trim().toLowerCase();
  $("#rEmps").innerHTML = activeEmployees().filter(u => !fe || (u.name || "").toLowerCase().includes(fe) || (u.empNo || "").toLowerCase().includes(fe)).map(u => `
    <label class="check-item"><input type="checkbox" data-eid="${u.id}" ${rDraft.empIds.has(u.id) ? "checked" : ""}>
      <span class="ci-name">${esc(u.name)}</span><span class="ci-sub">${esc(u.empNo || "")}</span></label>`).join("")
    || `<p class="empty">找不到人員</p>`;
  $("#rShiftCount").textContent = `${rDraft.shiftIds.size} / ${shiftTypes.length}`;
  $("#rEmpCount").textContent = `${rDraft.empIds.size} / ${activeEmployees().length}`;
}
$("#rosterEditBtn").onclick = openRoster;
$("#rosterModal").onclick = e => { if (e.target.id === "rosterModal" || e.target.closest("[data-close]")) closeRoster(); };
$("#rVis").onclick = e => { const b = e.target.closest("button[data-v]"); if (b) { rDraft.visibility = b.dataset.v; renderRosterForm(); } };
$("#rShiftFilter").oninput = renderRosterForm;
$("#rEmpFilter").oninput = renderRosterForm;
$("#rShifts").onchange = e => { const id = e.target.dataset.sid; e.target.checked ? rDraft.shiftIds.add(id) : rDraft.shiftIds.delete(id); renderRosterForm(); };
$("#rEmps").onchange = e => { const id = e.target.dataset.eid; e.target.checked ? rDraft.empIds.add(id) : rDraft.empIds.delete(id); renderRosterForm(); };
$("#rShiftAll").onclick = () => { shiftTypes.forEach(s => rDraft.shiftIds.add(s.id)); renderRosterForm(); };
$("#rShiftNone").onclick = () => { rDraft.shiftIds.clear(); renderRosterForm(); };
$("#rEmpAll").onclick = () => { activeEmployees().forEach(u => rDraft.empIds.add(u.id)); renderRosterForm(); };
$("#rEmpNone").onclick = () => { rDraft.empIds.clear(); renderRosterForm(); };

$("#rosterSave").onclick = async () => {
  if (!rDraft.shiftIds.size) return toast("請至少選擇一個班別");
  if (!rDraft.empIds.size) return toast("請至少選擇一位排班人員");
  const month = $("#schMonth").value;
  // 全選時存空陣列 = 全部（之後新增的班別 / 員工也會自動包含）
  const allS = rDraft.shiftIds.size === shiftTypes.length;
  const allE = activeEmployees().every(u => rDraft.empIds.has(u.id));
  const data = {
    name: $("#rName").value.trim() || roster.name,
    visibility: rDraft.visibility,
    shiftIds: allS ? [] : [...rDraft.shiftIds],
    empIds: allE ? [] : [...rDraft.empIds],
    editedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, "rosters", month), data, { merge: true });
    toast("班表設定已儲存");
    closeRoster();
    loadScheduling();
  } catch (err) { toast("儲存失敗：" + errMsg(err)); }
};

// ---- ✨ AI 快速排班：貼上訊息 → AI 解析 → 預覽 → 套用 ----
let ai = null;   // { emps, shifts, acts:[{op, empId, sid, dates[], why, err, on, off:Set}], notes, base:{key:{ids,leave}} }
const aiOpen = () => { $("#aiModal").classList.remove("hidden"); requestAnimationFrame(() => $("#aiModal").classList.add("open")); };
const aiClose = () => { $("#aiModal").classList.remove("open"); setTimeout(() => $("#aiModal").classList.add("hidden"), 200); };
const aiStep = n => { $("#aiStep1").classList.toggle("hidden", n !== 1); $("#aiStep2").classList.toggle("hidden", n !== 2); $("#aiApply").disabled = n !== 2; };
$("#aiSchBtn").onclick = () => { aiStep(ai?.acts ? 2 : 1); aiOpen(); if (!ai?.acts) setTimeout(() => $("#aiText").focus(), 250); };
$("#aiBack").onclick = () => aiStep(1);
$("#aiModal").addEventListener("click", e => {
  if (e.target.id === "aiModal" || e.target.closest("[data-close]")) return aiClose();
  const d = e.target.closest("[data-ad]");
  if (d && !d.classList.contains("skip") && !d.classList.contains("clash")) {
    const a = ai.acts[+d.dataset.ai];
    a.off.has(d.dataset.ad) ? a.off.delete(d.dataset.ad) : a.off.add(d.dataset.ad);
    aiRender();
  }
});
$("#aiList").addEventListener("change", e => {
  const c = e.target.closest("[data-aion]");
  if (c) { ai.acts[+c.dataset.aion].on = c.checked; return aiRender(); }
  const em = e.target.closest("[data-aiemp]"), sh = e.target.closest("[data-aish]");
  if (!em && !sh) return;
  const a = ai.acts[+(em || sh).dataset[em ? "aiemp" : "aish"]];
  if (em) a.empId = em.value || null; else { a.sid = sh.value || null; a.warn = ""; }
  // 手動改過就重新檢查，沒問題自動勾選
  a.err = !a.empId ? "請選擇員工" : a.op !== "clear" && !a.sid ? "請選擇班別" : !a.dates.length ? "沒有日期" : "";
  a.on = !a.err && !a.warn;
  aiRender();
});

const aiNorm = s => String(s || "").replace(/\s|教練|老師|coach/gi, "").toLowerCase();
function aiEmp(v, emps) {
  const m = /^E(\d+)$/i.exec(String(v || "").trim());
  if (m) return emps[+m[1] - 1] || null;
  const n = aiNorm(v);
  if (!n) return null;
  return emps.find(e => aiNorm(e.name) === n) || emps.find(e => aiNorm(e.name).includes(n) || n.includes(aiNorm(e.name))) || null;
}
function aiShift(v, time, shifts) {
  const m = /^S(\d+)$/i.exec(String(v || "").trim());
  if (m && shifts[+m[1] - 1]) return shifts[+m[1] - 1];
  if (v && !m) { const n = aiNorm(v); const hit = shifts.find(s => aiNorm(s.name) === n) || shifts.find(s => aiNorm(s.name).includes(n)); if (hit) return hit; }
  const t = /(\d{1,2}):?(\d{2})\s*[-~～]\s*(\d{1,2}):?(\d{2})/.exec(String(time || ""));
  if (t) {
    const st = `${pad(+t[1])}:${t[2]}`, en = `${pad(+t[3])}:${t[4]}`;
    const hits = shifts.filter(s => s.start === st && s.end === en);
    if (hits[0]) hits[0]._multi = hits.length > 1;
    return hits[0] || null;
  }
  return null;
}
function aiDates(a, month) {
  const isD = x => /^\d{4}-\d{2}-\d{2}$/.test(x || "");
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`, last = `${month}-${pad(new Date(y, m, 0).getDate())}`;
  const out = new Set((a.dates || []).filter(isD));
  const wd = (a.weekdays || []).map(Number).filter(n => n >= 0 && n <= 6);
  if (wd.length || isD(a.from) || isD(a.to)) {
    if (wd.length || !out.size) {
      const from = isD(a.from) ? a.from : first, to = isD(a.to) ? a.to : (isD(a.from) && !wd.length ? a.from : last);
      const d = new Date(from + "T00:00:00"), end = new Date(to + "T00:00:00");
      for (let i = 0; d <= end && i < 120; i++, d.setDate(d.getDate() + 1))
        if (!wd.length || wd.includes(d.getDay())) out.add(ymd(d));
    }
  }
  return [...out].sort();
}

$("#aiGo").onclick = async () => {
  const text = $("#aiText").value.trim();
  if (!text) return toast("請先貼上排班訊息");
  const btn = $("#aiGo"), old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> AI 分析中…（約 20–60 秒）`;
  try {
    await Promise.all([loadEmployees(), loadShiftTypes()]);
    const month = $("#schMonth").value;
    // 暑訓只在 7、8 月、寒訓只在 1、2 月，其他月份不給 AI 選，避免選錯
    const mm = +month.slice(5);
    const emps = activeEmployees(), shifts = shiftTypes.filter(s =>
      !(/暑訓/.test(s.name) && ![7, 8].includes(mm)) && !(/寒訓/.test(s.name) && ![1, 2].includes(mm)));
    const token = await auth.currentUser.getIdToken();
    const r = await withTimeout(fetch(WORKER_URL.replace(/\/$/, "") + "/ai-schedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, text, ctx: { today: ymd(new Date()), month,
        employees: emps.map(e => ({ name: e.name })), shifts: shifts.map(s => ({ name: s.name, start: s.start || "", end: s.end || "", cat: s.cat || "shift" })) } })
    }), 120000, "AI 分析逾時，請把訊息分成幾段再試");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || ({ unauthorized: "登入逾時，請重新整理", forbidden: "只有管理者可以使用", no_ai: "Worker 還沒開通 AI 功能" }[d.error]) || d.error || r.status);
    let outside = 0;
    const acts = (d.actions || []).map(a => {
      const op = ["add", "remove", "clear"].includes(a.op) ? a.op : "add";
      const emp = aiEmp(a.emp, emps), sh = op === "clear" ? null : aiShift(a.shift, a.time, shifts);
      const all = aiDates(a, month), dates = all.filter(x => x.startsWith(month));
      if (all.length > dates.length) outside++;
      const err = !emp ? `找不到員工「${a.emp || "?"}」` : op !== "clear" && !sh ? `找不到班別${a.time ? `（${a.time}）` : a.shift ? `「${a.shift}」` : ""}，請先到班別設定新增` : !dates.length ? "沒有日期" : "";
      const warn = sh?._multi ? `同時段（${sh.start}-${sh.end}）有好幾個班別，先選了「${sh.name}」，請確認後再勾選` : "";
      if (sh) delete sh._multi;
      return { op, empId: emp?.id, sid: sh?.id, dates, why: String(a.reason || "").slice(0, 60), err, warn, on: !err && !warn, off: new Set() };
    });
    // 讀取這些日期目前的排班
    const months = [...new Set(acts.flatMap(a => a.dates.map(x => x.slice(0, 7))))];
    const base = {};
    (await Promise.all(months.map(m => monthDocs("schedules", m)))).forEach(snap => snap.forEach(x => {
      base[x.id] = { ids: x.data().shiftIds || [], leave: x.data().leave || {} };
    }));
    const notes = (d.notes || []).map(String);
    if (outside) notes.push(`有些日期不在 ${month}，已略過；要排其他月份請先打開那個月的班表再用 AI 排班`);
    ai = { acts, notes, base, emps, shifts };
    aiRender();
    aiStep(2);
    if (!acts.length) toast("AI 沒有找到排班動作，可以把訊息寫清楚一點再試");
  } catch (err) {
    console.error(err);
    toast("AI 分析失敗：" + errMsg(err));
  } finally { btn.disabled = false; btn.innerHTML = old; }
};

// 依序模擬每個動作，算出每一天的結果
function aiSim() {
  const st = {}, res = [];
  const get = k => st[k] || (st[k] = { ids: [...(ai.base[k]?.ids || [])], leave: ai.base[k]?.leave || {} });
  ai.acts.forEach((a, i) => {
    const r = {};
    res[i] = r;
    if (!a.on || a.err) return;
    for (const ds of a.dates) {
      if (a.off.has(ds)) { r[ds] = { s: "off" }; continue; }
      const c = get(`${a.empId}_${ds}`);
      if (a.op === "add") {
        if (c.ids.includes(a.sid)) { r[ds] = { s: "skip", t: "已經有這個班" }; continue; }
        const x = clashWith(a.sid, workIds(c.ids, c.leave));
        if (x) { r[ds] = { s: "clash", t: `時段衝突：已排「${shiftMap[x]?.name}」` }; continue; }
        c.ids.push(a.sid); r[ds] = { s: "ok" };
      } else if (a.op === "remove") {
        if (!c.ids.includes(a.sid)) { r[ds] = { s: "skip", t: "當天沒有這個班" }; continue; }
        c.ids = c.ids.filter(x => x !== a.sid); r[ds] = { s: "ok" };
      } else {
        if (!c.ids.length) { r[ds] = { s: "skip", t: "當天沒有班" }; continue; }
        r[ds] = { s: "ok", t: "清掉：" + c.ids.map(x => shiftMap[x]?.name).filter(Boolean).join("、") }; c.ids = [];
      }
    }
  });
  const changes = Object.entries(st).filter(([k, v]) => {
    const o = ai.base[k]?.ids || [];
    return o.length !== v.ids.length || o.some(x => !v.ids.includes(x));
  });
  return { res, changes };
}

function aiRender() {
  const { res, changes } = aiSim();
  const OP = { add: "新增", remove: "取消", clear: "清空" };
  $("#aiNotes").innerHTML = ai.notes.map(n => `<div class="ai-note">💡 ${esc(n)}</div>`).join("");
  $("#aiList").innerHTML = ai.acts.length ? `<div class="ai-legend">AI 判斷錯可以直接點人名或課堂修改・點日期可以排除那一天・灰色＝不用變・紅色＝時段衝突不會排入</div>` + ai.acts.map((a, i) => {
    const r = res[i] || {};
    const pills = a.dates.map(ds => {
      const x = r[ds] || {}, d = new Date(ds + "T00:00:00");
      const cls = !a.on || a.err ? "skip" : x.s === "off" ? "off" : x.s === "skip" ? "skip" : x.s === "clash" ? "clash" : "";
      return `<button class="ai-d ${cls}" data-ai="${i}" data-ad="${ds}" title="${esc(x.t || "")}">${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）</button>`;
    }).join("");
    const md = ds => ds.slice(5).replace("-", "/").replace(/^0/, "").replace("/0", "/");
    const clashes = Object.values(r).filter(x => x.s === "clash").map(x => x.t);
    const cleared = Object.entries(r).filter(([, x]) => a.op === "clear" && x.s === "ok" && x.t).map(([ds, x]) => `${md(ds)} ${x.t}`);
    return `<div class="ai-card ${a.on ? "" : "off"} ${a.err ? "bad" : ""}">
      <div class="ai-head"><input type="checkbox" data-aion="${i}" ${a.on ? "checked" : ""} ${a.err ? "disabled" : ""}>
        <span class="ai-op ${a.op}">${OP[a.op]}</span>
        <select class="ai-sel ai-sel-emp" data-aiemp="${i}" title="點一下可以改人">${a.empId ? "" : `<option value="">選擇員工…</option>`}${ai.emps.map(e => `<option value="${e.id}" ${e.id === a.empId ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select>
        ${a.op === "clear" ? `<span class="hint" style="margin:0">當天所有班</span>`
          : `<select class="ai-sel ai-sel-sh" data-aish="${i}" title="點一下可以改課堂" style="background-color:${esc(shiftMap[a.sid]?.color || "#8e8e93")}">${a.sid ? "" : `<option value="">選擇班別…</option>`}${ai.shifts.map(sh => `<option value="${sh.id}" ${sh.id === a.sid ? "selected" : ""}>${esc(sh.name)}${sh.start && sh.end ? `（${sh.start}-${sh.end}）` : ""}</option>`).join("")}</select>`}</div>
      ${a.why ? `<div class="ai-why">${esc(a.why)}</div>` : ""}
      ${a.err ? `<div class="ai-err">⚠️ ${esc(a.err)}</div>` : ""}
      ${a.warn ? `<div class="ai-err">⚠️ ${esc(a.warn)}</div>` : ""}
      ${[...new Set(clashes)].slice(0, 3).map(t => `<div class="ai-err">${esc(t)}</div>`).join("")}
      ${cleared.slice(0, 6).map(t => `<div class="ai-why">${esc(t)}</div>`).join("")}
      <div class="ai-dates">${pills}</div></div>`;
  }).join("") : `<p class="empty">沒有可以套用的排班</p>`;
  const people = new Set(changes.map(([k]) => k.slice(0, k.lastIndexOf("_"))));
  $("#aiSum").textContent = changes.length ? `將變更 ${people.size} 人・${changes.length} 天` : "目前沒有要變更的內容";
  $("#aiApply").disabled = !changes.length;
}

$("#aiApply").onclick = async () => {
  const { changes } = aiSim();
  if (!changes.length) return;
  const btn = $("#aiApply"); btn.disabled = true;
  try {
    for (let i = 0; i < changes.length; i += 400) {
      const batch = writeBatch(db);
      for (const [key, v] of changes.slice(i, i + 400)) {
        const j = key.lastIndexOf("_"), empId = key.slice(0, j), date = key.slice(j + 1);
        if (v.ids.length || Object.keys(v.leave || {}).length)
          batch.set(doc(db, "schedules", key), { empId, date, month: date.slice(0, 7), shiftIds: v.ids }, { merge: true });
        else batch.delete(doc(db, "schedules", key));
      }
      await batch.commit();
    }
    const months = [...new Set(changes.map(([k]) => k.slice(k.lastIndexOf("_") + 1, k.lastIndexOf("_") + 8)))];
    await Promise.all(months.map(m => setDoc(doc(db, "rosters", m), { editedAt: serverTimestamp() }, { merge: true }).catch(() => {})));
    toast(`已套用 ${changes.length} 天的排班，記得按「發布」`);
    ai = null; $("#aiText").value = "";
    aiClose();
    await loadScheduling();
  } catch (err) { toast("套用失敗：" + errMsg(err)); btn.disabled = false; }
};

// ---- 發布 ----
async function markEdited() {
  roster.editedAt = new Date();
  renderSchSub();
  try { await setDoc(doc(db, "rosters", $("#schMonth").value), { editedAt: serverTimestamp() }, { merge: true }); } catch {}
}
$("#publishBtn").onclick = async () => {
  const month = $("#schMonth").value;
  const emps = rosterEmps();
  const msg = roster.visibility === "all"
    ? `發布後 ${emps.length} 位人員都可以在「我的班表」看到全部人的班表。`
    : `目前權限為「僅可查看自己」，員工只會看到自己的班。`;
  if (!(await appConfirm(`發布「${roster.name}」`, msg, { okText: "發布" }))) return;
  $("#publishBtn").disabled = true;
  try {
    if (roster.visibility === "all") {
      const grid = {};
      emps.forEach(u => {
        const g = {};
        Object.entries(schedMap).forEach(([k, ids]) => { if (k.startsWith(u.id + "_") && ids.length) g[k.slice(u.id.length + 1)] = ids; });
        grid[u.id] = g;
      });
      await setDoc(doc(db, "rosterPublic", month), {
        name: roster.name, month, grid, publishedAt: serverTimestamp(),
        emps: emps.map(u => ({ id: u.id, name: u.name || "" }))
      });
    } else {
      await deleteDoc(doc(db, "rosterPublic", month)).catch(() => {});
    }
    await setDoc(doc(db, "rosters", month), {
      name: roster.name, visibility: roster.visibility || "self",
      shiftIds: roster.shiftIds || [], empIds: roster.empIds || [], publishedAt: serverTimestamp()
    }, { merge: true });
    roster.publishedAt = new Date(Date.now() + 1000);
    renderSchSub();
    toast("班表已發布");
  } catch (err) { toast("發布失敗：" + errMsg(err) + "（請確認 firestore.rules 已更新）"); }
  finally { $("#publishBtn").disabled = false; }
};

// ---- 共用：點格子加入 / 點 × 移除 ----
async function onCellClick(e, cell) {
  if (!cell) return;
  const key = cell.dataset.key;
  let ids = [...(schedMap[key] || [])];
  if (e.target.classList.contains("x")) {
    const sid = e.target.closest(".chip").dataset.sid;
    ids = ids.filter(i => i !== sid);
  } else {
    if (!selShift) return openDay(cell);          // 沒選快速排班 → 跳出選單
    if (ids.includes(selShift)) return toast("這天已經有這個班別");
    ids.push(selShift);
  }
  await saveCell(key, ids, cell);
}

// ---- 歷史排班（推薦用）----
let history = { month: null, list: [] };
// 過去月份的班表存在本機（不常變動），只有沒存過的月份才去讀，省大量讀取
const SHIST_KEY = "punch_sched_hist_v1";
async function loadHistory(month) {
  if (history.month === month) return;
  const [y, m] = month.split("-").map(Number);
  const months = [1, 2, 3, 4, 5, 6].map(i => ym(new Date(y, m - 1 - i, 1)));
  let store = {};
  try { store = JSON.parse(localStorage.getItem(SHIST_KEY) || "{}"); } catch {}
  const cur = ym(new Date());
  // 上個月以後的仍可能被修改，6 小時後重讀；更早的月份讀過就不再讀
  const need = months.filter(mm => !store[mm] || (mm >= prevMonth(cur) && Date.now() - (store[mm].at || 0) > 6 * 3600e3));
  if (need.length) {
    const snap = await getDocs(query(collection(db, "schedules"), where("month", "in", need)));
    need.forEach(mm => store[mm] = { at: Date.now(), rows: [] });
    snap.docs.forEach(d => { const x = d.data(); store[x.month]?.rows.push([x.empId, x.date, x.shiftIds || []]); });
    Object.keys(store).forEach(k => { if (k < months.at(-1)) delete store[k]; });
    try { localStorage.setItem(SHIST_KEY, JSON.stringify(store)); } catch {}
  }
  history = { month, list: months.flatMap(mm => (store[mm]?.rows || []).map(([empId, date, shiftIds]) => ({ empId, date, shiftIds }))) };
}
const wdOf = ds => new Date(ds + "T00:00:00").getDay();
const empName = id => employees.find(u => u.id === id)?.name || "";

// 依「同一個星期幾」統計：這個人常排什麼、每個班別常由誰負責
function analyze(empId, ds) {
  const wd = wdOf(ds);
  const rows = history.list.map(x => [x.empId, x.date, x.shiftIds || []]);
  for (const [k, ids] of Object.entries(schedMap)) {
    const i = k.lastIndexOf("_");
    if (k.slice(i + 1) !== ds) rows.push([k.slice(0, i), k.slice(i + 1), ids]);
  }
  const mine = {}, all = {}, who = {}, mineAll = {}, whoAll = {};
  for (const [e, d, ids] of rows) {
    const same = wdOf(d) === wd;
    for (const id of ids) {
      if (e === empId) mineAll[id] = (mineAll[id] || 0) + 1;
      (whoAll[id] ??= {})[e] = (whoAll[id][e] || 0) + 1;
      if (!same) continue;
      all[id] = (all[id] || 0) + 1;
      if (e === empId) mine[id] = (mine[id] || 0) + 1;
      (who[id] ??= {})[e] = (who[id][e] || 0) + 1;
    }
  }
  const topWho = id => {
    const best = Object.entries(who[id] || whoAll[id] || {}).sort((a, b) => b[1] - a[1])[0];
    return best ? { name: empName(best[0]), n: best[1], isMe: best[0] === empId } : null;
  };
  const allowed = new Set(rosterShifts().map(s => s.id));
  // 推薦只看本人：先「這個星期幾」最常排的，再依「全部日子」次數往下排
  const rec = [];
  Object.entries(mine).filter(([id]) => allowed.has(id))
    .sort((a, b) => b[1] - a[1] || (mineAll[b[0]] || 0) - (mineAll[a[0]] || 0))
    .forEach(([id, n]) => rec.push({ id, n, src: "wd", total: mineAll[id] || n }));
  Object.entries(mineAll).filter(([id]) => allowed.has(id) && !mine[id])
    .sort((a, b) => b[1] - a[1])
    .forEach(([id, n]) => rec.push({ id, n, src: "all" }));
  // 本人完全沒有紀錄時，才參考其他人這個星期幾常排的
  if (!rec.length) {
    Object.entries(all).filter(([id, n]) => allowed.has(id) && n >= 2)
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .forEach(([id, n]) => rec.push({ id, n, src: "others", top: topWho(id) }));
  }
  // 智能排序分數：本人同星期幾 > 本人全部 > 全部人同星期幾
  const score = id => (mine[id] || 0) * 1000 + (mineAll[id] || 0) * 20 + (all[id] || 0);
  return { wd, rec, topWho, score, mine, mineAll };
}

// ---- 點日期：班別選單 ----
let dp = null;
function openDay(cell) {
  const key = cell.dataset.key, i = key.lastIndexOf("_");
  dp = { key, empId: key.slice(0, i), ds: key.slice(i + 1), cell };
  const d = new Date(dp.ds + "T00:00:00");
  $("#dpTitle").textContent = `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）${empName(dp.empId)}`;
  $("#dpFilter").value = "";
  renderDay();
  $("#dayModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#dayModal").classList.add("open"));
}
function closeDay() {
  $("#dayModal").classList.remove("open");
  setTimeout(() => $("#dayModal").classList.add("hidden"), 200);
  dp = null;
}
function renderDay() {
  if (!dp) return;
  const ids = schedMap[dp.key] || [];
  const { wd, rec, topWho, score, mine, mineAll } = analyze(dp.empId, dp.ds);
  const W = `週${WEEK[wd]}`;
  $("#dpCurrent").innerHTML = byTime(ids).map(id => chipHtml(id, true)).join("") || `<span class="dr-empty">尚未排班</span>`;

  const workNow = workIds(ids, schedLeave[dp.key]);
  const recF = rec.filter(r => !ids.includes(r.id) && shiftMap[r.id] && !clashWith(r.id, workNow)).slice(0, 8);
  $("#dpRecWrap").classList.toggle("hidden", !recF.length);
  $("#dpRecNote").textContent = recF[0]?.src === "others" ? `他還沒有紀錄，參考其他人${W}的排班` : `依他過去 6 個月的排班`;
  $("#dpRec").innerHTML = recF.map(r => {
    const s = shiftMap[r.id];
    const why = r.src === "wd" ? `他${W}排過 ${r.n} 次・共 ${r.total} 次`
      : r.src === "all" ? `他共排過 ${r.n} 次（${W}沒排過）`
      : (r.top ? `${W}常由 ${esc(r.top.name)} 負責（${r.top.n} 次）` : `${W}常見班別`);
    return `<button class="rec ${r.src === "wd" ? "top" : ""}" data-add="${r.id}">
      <span class="dot" style="background:${esc(s.color)}"></span>
      <span class="rec-main"><span class="rec-name">${esc(s.name)}</span><span class="rec-why">${why}${s.start && s.end ? ` · ${s.start}–${s.end}` : ""}</span></span>
      <span class="rec-add">＋</span></button>`;
  }).join("");

  const f = $("#dpFilter").value.trim().toLowerCase();
  const list = rosterShifts()
    .filter(s => !f || s.name.toLowerCase().includes(f) || (s.code || "").toLowerCase().includes(f))
    .map((s, i) => ({ s, i, sc: score(s.id) }))
    .sort((a, b) => (ids.includes(b.s.id) - ids.includes(a.s.id)) || (b.sc - a.sc) || (a.i - b.i));
  let shownHot = false, shownRest = false;
  $("#dpList").innerHTML = list.map(({ s, sc }) => {
    const t = topWho(s.id);
    const freq = [mine[s.id] ? `他${W} ${mine[s.id]} 次` : "", mineAll[s.id] ? `共 ${mineAll[s.id]} 次` : ""].filter(Boolean).join("・");
    const sub = [freq, s.start && s.end ? `${s.start}–${s.end}` : (s.cat === "leave" ? "休假" : ""),
                 t && !t.isMe ? `常由 ${esc(t.name)}` : ""].filter(Boolean).join(" · ");
    let head = "";
    if (!f && sc > 0 && !shownHot) { shownHot = true; head = `<div class="list-head">常排班別</div>`; }
    if (!f && sc === 0 && shownHot && !shownRest) { shownRest = true; head = `<div class="list-head">其他班別</div>`; }
    const clash = !ids.includes(s.id) && clashWith(s.id, workNow);
    return `${head}<label class="check-item ${mineAll[s.id] ? "hot" : ""} ${clash ? "clash" : ""}"><input type="checkbox" data-sid="${s.id}" ${ids.includes(s.id) ? "checked" : ""} ${clash ? "disabled" : ""}>
      <span class="dot" style="background:${esc(s.color)}"></span>
      <span class="ci-main"><span class="ci-name">${esc(s.name)}</span>${clash ? `<span class="ci-sub clash-why">時段衝突：已排「${esc(shiftMap[clash].name)}」</span>` : sub ? `<span class="ci-sub">${sub}</span>` : ""}</span></label>`;
  }).join("") || `<p class="empty">找不到班別</p>`;
}
async function setDayShift(id, on) {
  if (!dp) return;
  let ids = [...(schedMap[dp.key] || [])];
  if (on && !ids.includes(id)) {
    const c = clashWith(id, workIds(ids, schedLeave[dp.key]));
    if (c) { toast(`時段衝突：已排「${shiftMap[c].name}」`); renderDay(); return; }
    ids.push(id);
  }
  if (!on) ids = ids.filter(x => x !== id);
  // 畫面若已重繪，找回對應格子
  await saveCell(dp.key, ids, dp.cell);
  renderDay();
}
$("#dayModal").onclick = e => {
  if (e.target.id === "dayModal" || e.target.closest("[data-close]")) return closeDay();
  const add = e.target.closest("[data-add]");
  if (add) return setDayShift(add.dataset.add, true);
  if (e.target.classList.contains("x") && e.target.closest("#dpCurrent")) return setDayShift(e.target.closest(".chip").dataset.sid, false);
};
$("#dpList").onchange = e => { if (e.target.dataset.sid) setDayShift(e.target.dataset.sid, e.target.checked); };
$("#dpFilter").oninput = renderDay;

async function saveCell(key, ids, cell) {
  const i = key.lastIndexOf("_");
  const empId = key.slice(0, i), date = key.slice(i + 1);
  try {
    if (ids.length) {
      await setDoc(doc(db, "schedules", key), { empId, date, month: date.slice(0, 7), shiftIds: ids }, { merge: true });
    } else {
      await deleteDoc(doc(db, "schedules", key));
    }
    schedMap[key] = ids;
    markEdited();
    document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach(el => {
      if (el.classList.contains("day-row")) el.querySelector(".dr-chips").innerHTML = dayChips(key);
      else el.innerHTML = cellChips(key);
    });
    renderEmpCounts();
  } catch (err) { toast("儲存失敗：" + errMsg(err)); }
}

// 一週一週對應：來源月份「完整的週」（週一～週日，月內至少 4 天）依序套到目標月份的每一週，不夠就循環
function weekBlocks(month) {
  const days = daysOfMonth(month);
  const blocks = [];
  for (const d of days) {
    const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const k = ymd(mon);
    if (!blocks.length || blocks.at(-1).monday !== k) blocks.push({ monday: k, days: [] });
    blocks.at(-1).days.push(ymd(d));
  }
  return blocks;
}
function weekMapping(src, dst) {
  let sw = weekBlocks(src).filter(b => b.days.length >= 4);
  if (!sw.length) sw = weekBlocks(src);
  const map = {}, lines = [];
  weekBlocks(dst).forEach((tw, i) => {
    const sb = sw[i % sw.length];
    const srcByWd = {};
    // 這一週以外，也備好其他週同星期幾的日期，當這週缺那天時遞補
    sw.forEach(b => b.days.forEach(ds => { const w = wdOf(ds); srcByWd[w] ??= []; srcByWd[w].push({ ds, own: b === sb }); }));
    tw.days.forEach(ds => {
      const w = wdOf(ds);
      const cand = srcByWd[w] || [];
      // 這週有那天就用；沒有就取離這週最近的同星期幾
      const base = new Date(sb.monday + "T00:00:00").getTime();
      const pick = cand.find(c => c.own) ||
        [...cand].sort((a, b) => Math.abs(new Date(a.ds + "T00:00:00") - base) - Math.abs(new Date(b.ds + "T00:00:00") - base))[0];
      if (pick) map[ds] = pick.ds;
    });
    const md = ds => `${+ds.slice(5, 7)}/${+ds.slice(8)}`;
    const used = tw.days.map(ds => map[ds]).filter(Boolean).sort();
    const rng = (a, b) => a === b ? md(a) : `${md(a)}–${md(b)}`;
    if (used.length) lines.push(`${rng(tw.days[0], tw.days.at(-1))}　←　${rng(used[0], used.at(-1))}`);
  });
  return { map, lines };
}

// 把 src 月份的班表（含設定）一週一週複製到 dst 月份
async function copyRoster(src, dst) {
  await Promise.all([loadEmployees(), loadShiftTypes()]);
  const [snap, rSnap] = await Promise.all([
    getDocs(query(collection(db, "schedules"), where("month", "==", src))),
    getDoc(doc(db, "rosters", src))
  ]);
  const srcR = rSnap.exists() ? rSnap.data() : {};
  const srcMap = {};
  snap.docs.forEach(d => { const x = d.data(); srcMap[`${x.empId}_${x.date}`] = x.shiftIds || []; });
  const { map } = weekMapping(src, dst);
  const emps = srcR.empIds?.length ? activeEmployees().filter(u => srcR.empIds.includes(u.id)) : activeEmployees();
  let batch = writeBatch(db), n = 0, total = 0;
  for (const u of emps) {
    for (const d of daysOfMonth(dst)) {
      const date = ymd(d);
      const ids = map[date] && srcMap[`${u.id}_${map[date]}`];
      if (!ids?.length) continue;
      batch.set(doc(db, "schedules", `${u.id}_${date}`), { empId: u.id, date, month: dst, shiftIds: ids });
      total++;
      if (++n >= 450) { await batch.commit(); batch = writeBatch(db); n = 0; }
    }
  }
  if (n) await batch.commit();
  const [y, m] = dst.split("-");
  await setDoc(doc(db, "rosters", dst), {
    name: `${y}/${m}月班表`, visibility: srcR.visibility || "self",
    shiftIds: srcR.shiftIds || [], empIds: srcR.empIds || [], editedAt: serverTimestamp()
  }, { merge: true });
  history.month = null;
  return total;
}

$("#copyPrevBtn").onclick = async () => {
  const month = $("#schMonth").value;
  const prev = prevMonth(month);
  if (!(await appConfirm("複製上月班表", `將 ${prev} 一週一週複製到 ${month}：\n\n${weekMapping(prev, month).lines.join("\n")}\n\n本月已排的同一天會被覆蓋。`, { okText: "複製" }))) return;
  try {
    const total = await copyRoster(prev, month);
    toast(total ? `已複製 ${total} 筆` : "上月沒有排班可複製");
    loadScheduling();
  } catch (err) { toast("複製失敗：" + errMsg(err)); }
};

/* ---------- 班表列表 ---------- */
let schMode = "list";
function loadSchedulingView() {
  $("#schListView").classList.toggle("hidden", schMode !== "list");
  $("#schEditor").classList.toggle("hidden", schMode !== "edit");
  return schMode === "list" ? loadRosterList() : loadScheduling();
}
function openRosterEditor(month) {
  schMode = "edit";
  $("#schMonth").value = month;
  scrollTo(0, 0);
  return loadSchedulingView();
}
$("#schBack").onclick = () => { schMode = "list"; scrollTo(0, 0); loadSchedulingView(); };

const rosterState = r => {
  const pub = tsMs(r.publishedAt);
  return !pub ? `<span class="badge gray">尚未發布</span>`
    : tsMs(r.editedAt) > pub ? `<span class="badge orange">有未發布的變更</span>`
    : `<span class="badge green">已發布</span>`;
};

async function loadRosterList() {
  const snap = await getDocs(collection(db, "rosters"));
  const list = snap.docs.map(d => ({ month: d.id, ...d.data() }))
    .filter(r => /^\d{4}-\d{2}$/.test(r.month))
    .sort((a, b) => b.month.localeCompare(a.month));
  $("#rosterList").innerHTML = list.map(r => {
    const [y, m] = r.month.split("-");
    const last = new Date(+y, +m, 0).getDate();
    return `<tr data-m="${r.month}">
      <td><a class="roster-name" data-act="edit">${esc(r.name || `${y}/${m}月班表`)}</a></td>
      <td>${r.month}-01 ~ ${r.month}-${last}</td>
      <td>${VIS_LABEL[r.visibility] || VIS_LABEL.self}</td>
      <td>${rosterState(r)}</td>
      <td class="row-acts">
        <button class="btn small primary" data-act="edit">編輯</button>
        <button class="btn small" data-act="copy">複製</button>
        <button class="btn small danger" data-act="del">刪除</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">還沒有任何班表，按右上角「＋ 新增班表」開始，或「匯入 Excel」匯入舊班表。</td></tr>`;
}

$("#rosterList").onclick = async e => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const month = btn.closest("tr").dataset.m;
  const act = btn.dataset.act;
  if (act === "edit") return openRosterEditor(month);
  if (act === "copy") {
    const [y, m] = month.split("-").map(Number);
    const dst = await appDialog({
      title: "複製班表", message: `把 ${month} 的班表（含設定）一週一週複製到：`,
      input: { type: "month", value: ym(new Date(y, m, 1)) },
      buttons: [{ text: "取消", value: false }, { text: "複製", value: true, style: "primary" }]
    });
    if (!dst) return;
    if (dst === month) return toast("請選擇不同的月份");
    if (!(await appConfirm("確認週對應", `${month} → ${dst}，一週一週對應如下：\n\n${weekMapping(month, dst).lines.join("\n")}\n\n${dst} 已排的同一天會被覆蓋。`, { okText: "開始複製" }))) return;
    toast("複製中…");
    try {
      const total = await copyRoster(month, dst);
      toast(`已複製 ${total} 筆到 ${dst}`);
      loadRosterList();
    } catch (err) { toast("複製失敗：" + errMsg(err)); }
  }
  if (act === "del") {
    if (!(await appConfirm("刪除班表", `確定刪除 ${month} 的班表？這個月所有的排班資料都會一起刪除，無法復原。`, { okText: "刪除", danger: true }))) return;
    try {
      const snap = await getDocs(query(collection(db, "schedules"), where("month", "==", month)));
      let batch = writeBatch(db), n = 0;
      for (const d of snap.docs) { batch.delete(d.ref); if (++n >= 450) { await batch.commit(); batch = writeBatch(db); n = 0; } }
      batch.delete(doc(db, "rosters", month));
      batch.delete(doc(db, "rosterPublic", month));
      await batch.commit();
      history.month = null;
      toast(`已刪除 ${month} 的班表`);
      loadRosterList();
    } catch (err) { toast("刪除失敗：" + errMsg(err)); }
  }
};

$("#newRosterBtn").onclick = async () => {
  const d = new Date();
  const month = await appDialog({
    title: "新增班表", message: "選擇要排班的月份",
    input: { type: "month", value: ym(new Date(d.getFullYear(), d.getMonth() + 1, 1)) },
    buttons: [{ text: "取消", value: false }, { text: "建立", value: true, style: "primary" }]
  });
  if (!month) return;
  const ex = await getDoc(doc(db, "rosters", month));
  if (!ex.exists()) {
    const [y, m] = month.split("-");
    await setDoc(doc(db, "rosters", month), { name: `${y}/${m}月班表`, visibility: "self", shiftIds: [], empIds: [], editedAt: serverTimestamp() });
  }
  openRosterEditor(month);
};

/* ================= 出勤報表（管理者） ================= */
let reportRows = [];
const minOf = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
/* ---- 時段衝突檢查 ---- */
function shiftsOverlap(a, b) {
  const A = shiftMap[a], B = shiftMap[b];
  if (!A || !B || A.cat === "leave" || B.cat === "leave" || !A.start || !A.end || !B.start || !B.end) return false;
  let a1 = minOf(A.start), a2 = minOf(A.end), b1 = minOf(B.start), b2 = minOf(B.end);
  if (a2 <= a1) a2 += 1440; if (b2 <= b1) b2 += 1440;
  return a1 < b2 && b1 < a2;
}
// sid 跟 ids 裡哪一個班衝突（同一班也算）
const clashWith = (sid, ids) => ids.find(x => x === sid || shiftsOverlap(sid, x));
// 某人當天「實際要上」的班（扣掉已請假的）
const workIds = (ids, leave) => (ids || []).filter(x => !leave?.[x] && shiftMap[x] && shiftMap[x].cat !== "leave");
// 檢查代班安排：subs {shiftId: empId}，day {empId: {ids, leave}}，ignore {shiftId: empId}（這筆請假之前排進去的）
function subProblems(subs, day, ignore = {}) {
  const out = [], plan = {};
  for (const [sid, eid] of Object.entries(subs)) {
    if (!eid) continue;
    const d = day[eid] || {};
    const has = workIds(d.ids, d.leave).filter(x => !(ignore[x] === eid && x === sid));
    const c = clashWith(sid, has) || clashWith(sid, plan[eid] || []);
    if (c) out.push(`${empNameOf(eid)} 在 ${shiftMap[sid]?.name || ""} 的時段已經有班（${shiftMap[c]?.name || ""}）`);
    (plan[eid] ??= []).push(sid);
  }
  return out;
}
const empNameOf = id => employees.find(e => e.id === id)?.name || staff.find(e => e.id === id)?.name || "";

// 單筆打卡的細項
function punchDetail(r, kind, plan, ds) {
  const today = ymd(new Date()), nowHm = hm(new Date());
  if (!r) {
    const passed = ds < today || (ds === today && plan && nowHm > plan);
    return { time: "", place: "", reason: "", abn: passed && plan !== undefined ? "未打卡" : "", miss: passed };
  }
  const t = hm(r.t);
  const loc = locMap[r.locationId];
  const place = loc ? `GPS（${loc.name}）` : r.placeName ? `GPS（${r.placeName}）` : (r.lat != null ? "GPS" : "—");
  let abn = "", late = 0, early = 0;
  if (plan) {
    const diff = minOf(t) - minOf(plan);
    if (kind === "in" && diff > 0) { abn = `遲到 ${diff} 分鐘`; late = diff; }
    if (kind === "out" && diff < 0) { abn = `早退 ${-diff} 分鐘`; early = -diff; }
  }
  const reason = r.outOfRange ? (r.reason || "範圍外") + (r.dist != null && !r.imported ? `（距離 ${r.dist} 公尺）` : "") : "";
  return { r, time: t, place, reason: [reason, r.note].filter(Boolean).join("；"), abn, late, early, far: !!r.outOfRange };
}

/* ================= 請假（員工） ================= */
const LV_ST = { pending: ["warn", "審核中"], approved: ["ok", "已核准"], rejected: ["bad", "已退回"], revoked: ["", "已撤銷"] };
// 代班文字：管理者指定的優先，否則顯示員工填的
function subText(q) {
  const names = Object.entries(q.subNames || {}).filter(([sid, n]) => n && (q.shiftIds || []).includes(sid));
  if (names.length) return names.map(([sid, n]) => (q.shiftIds.length > 1 ? `${shiftMap[sid]?.name || ""} → ` : "") + n).join("、");
  return q.subNeed ? (q.subName || "有代班") : "不需代班";
}
let lv = { month: null, date: null, sch: undefined, monthSch: {}, mine: [] };

const LV_KEY = "punch_lv_v1";
function lvSaveCache() {
  try { localStorage.setItem(LV_KEY, JSON.stringify({ uid: me.id, month: lv.month, monthSch: lv.monthSch, mine: lv.mine.map(({ createdAt, updatedAt, reviewedAt, editedAt, ...x }) => x) })); } catch {}
}
async function loadLeaveView() {
  if (!lv.month) {
    const t = ymd(new Date()); lv.month = t.slice(0, 7); lv.date = t;
    // 先用上次的資料秒開
    try {
      const c = JSON.parse(localStorage.getItem(LV_KEY) || "null");
      if (c?.uid === me.id && c.month === lv.month) { lv.monthSch = c.monthSch || {}; lv.mine = c.mine || []; lv.cached = true; }
    } catch {}
  }
  const [y, m] = lv.month.split("-").map(Number);
  $("#lvMonthTitle").textContent = `${y}年${m}月`;
  renderLvCal(); renderMyLeaves();
  if (lv.cached || lv.loaded?.[lv.month]) selectLvDay(lv.date);
  else loadLvOneDay(lv.date);              // 先只讀選到的那一天
  // 整個月與請假紀錄在背景更新
  loadLvMonth().catch(() => {});
  loadMyLeaves().catch(() => {});
}
// 只讀一天（月份還沒載入時用，比較快）
async function loadLvOneDay(ds) {
  $("#lvShifts").innerHTML = `<p class="hint" style="margin:0">讀取中…</p>`;
  const d = await getDoc(doc(db, "schedules", `${me.id}_${ds}`)).catch(() => null);
  if (ds !== lv.date) return;
  if (d?.exists()) lv.monthSch[ds] = d.data();
  selectLvDay(ds);
}
async function loadMyLeaves() {
  const snap = await getDocs(query(collection(db, "leaveRequests"), where("empId", "==", me.id)));
  lv.mine = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  renderMyLeaves();
  renderLvCal();
  renderLvShifts();
  lvSaveCache();
}
async function loadLvMonth() {
  const [y, m] = lv.month.split("-").map(Number);
  $("#lvMonthTitle").textContent = `${y}年${m}月`;
  renderLvCal();
  const month = lv.month;
  const snap = await getDocs(query(collection(db, "schedules"), where("empId", "==", me.id), where("month", "==", month)));
  if (month !== lv.month) return;
  const fresh = {};
  snap.forEach(d => { fresh[d.data().date] = d.data(); });
  const changed = JSON.stringify(fresh[lv.date] || null) !== JSON.stringify(lv.monthSch[lv.date] || null);
  lv.monthSch = fresh;
  (lv.loaded ??= {})[month] = true;
  renderLvCal();
  // 正在勾選時不要整個重畫，除非那天的班有變
  if (changed || lv.sch === undefined || !$$("#lvShifts input:checked").length) selectLvDay(lv.date);
  lvSaveCache();
}
const lvWorkIds = sch => (sch?.shiftIds || []).filter(id => shiftMap[id] && shiftMap[id].cat !== "leave")
  .sort((a, b) => (shiftMap[a].start || "99").localeCompare(shiftMap[b].start || "99"));
function renderLvCal() {
  if (!lv.month) return;
  const days = daysOfMonth(lv.month), today = ymd(new Date());
  let html = [...WEEK].map(w => `<div class="hd">${w}</div>`).join("") + "<div></div>".repeat(days[0].getDay());
  for (const d of days) {
    const ds = ymd(d), sch = lv.monthSch[ds], ids = lvWorkIds(sch);
    const pend = lv.mine.some(q => q.date === ds && q.status === "pending");
    const off = ids.length && ids.some(id => sch?.leave?.[id]);
    const f = pend ? "wait" : off ? "leave" : ids.length ? "sh" : "";
    html += `<div class="rday ${ds === today ? "today" : ""} ${ds === lv.date ? "sel" : ""} ${d.getDay() % 6 === 0 ? "wkend" : ""} ${ids.length ? "" : "none"}" data-ds="${ds}">
      <span class="rnum">${d.getDate()}</span><i class="rdot ${f}"></i></div>`;
  }
  $("#lvCal").innerHTML = html;
}
function selectLvDay(ds) {
  if (!ds || ds.slice(0, 7) !== lv.month) ds = `${lv.month}-01`;
  lv.date = ds;
  lv.sch = lv.monthSch[ds] || null;
  const d = new Date(ds + "T00:00:00");
  $("#lvDayTitle").textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
  $$("#lvCal .rday").forEach(x => x.classList.toggle("sel", x.dataset.ds === ds));
  renderLvShifts();
}
const lvSubOn = () => $("#lvSub button.on")?.dataset.v === "yes";
function renderLvShifts() {
  if (!lv.date || lv.sch === undefined) return;
  const ids = lvWorkIds(lv.sch);
  if (!ids.length) { $("#lvShifts").innerHTML = `<p class="empty" style="padding:14px">這天沒有排班</p>`; $("#lvSubmit").disabled = true; return; }
  const taken = id => lv.sch?.leave?.[id] ? "已請假" : lv.mine.some(q => q.id !== lv.editId && q.date === lv.date && q.status === "pending" && (q.shiftIds || []).includes(id)) ? "審核中" : "";
  const eq = lv.editId ? lv.mine.find(q => q.id === lv.editId) : null;
  const pre = eq?.date === lv.date ? eq.shiftIds || [] : [];
  const preSubs = eq?.date === lv.date ? eq.subs || {} : {};
  $("#lvShifts").innerHTML = ids.map((id, i) => {
    const s = shiftMap[id], t = taken(id), on = !t && pre.includes(id);
    return `<div class="lv-row ${on ? "on" : ""}" data-sid="${id}"><label class="lv-shift ${t ? "taken" : ""}"><input type="checkbox" value="${id}" ${t ? "disabled" : ""} ${on ? "checked" : ""}>
      <span class="lv-no" style="background:${esc(s.color || "#8e8e93")}">${i + 1}</span>
      <span class="lv-name">${esc(s.name)}<small>${s.start && s.end ? `${s.start}–${s.end}` : ""}</small></span>${t ? `<span class="tag ${t === "已請假" ? "ok" : "warn"}">${t}</span>` : ""}</label>
      ${t ? "" : `<select class="lv-subsel" data-pre="${esc(preSubs[id] || "")}"><option value="">此班不需代班</option></select>`}</div>`;
  }).join("") + (ids.length > 1 ? `<button class="btn link lv-all" id="lvAll">全部勾選</button>` : "");
  $("#lvSubmit").disabled = ids.every(id => taken(id));
  $("#lvShifts").classList.toggle("subon", lvSubOn());
  if (lvSubOn()) loadLvSubDay();
}
// 讀取當天所有人的班，用來判斷誰能代班
async function loadLvSubDay(force) {
  const date = lv.date;
  lv.days ??= {};
  await loadStaff();
  if (!staff.length) { $("#lvSubHint").textContent = "員工名單還沒建立，請管理員開啟一次系統後再試"; }
  if (force || !lv.days[date]) {
    const others = staff.filter(e => e.id !== me.id);
    const docs = await Promise.all(others.map(e => getDoc(doc(db, "schedules", `${e.id}_${date}`)).catch(() => null)));
    const day = {};
    docs.forEach((d, i) => { if (d?.exists()) day[others[i].id] = { ids: d.data().shiftIds || [], leave: d.data().leave || {} }; });
    lv.days[date] = day;
  }
  if (date === lv.date) refreshLvSubs();
}
function refreshLvSubs() {
  const day = lv.days?.[lv.date] || {};
  const rows = $$("#lvShifts .lv-row");
  const chosen = rows.filter(r => r.classList.contains("on")).map(r => ({ sid: r.dataset.sid, eid: r.querySelector("select")?.value || r.querySelector("select")?.dataset.pre }));
  rows.forEach(r => {
    const sel = r.querySelector("select"); if (!sel) return;
    const sid = r.dataset.sid, cur = sel.value || sel.dataset.pre || "";
    sel.innerHTML = `<option value="">此班不需代班</option>` + staff.filter(e => e.id !== me.id).map(e => {
      const d = day[e.id] || {};
      const c = clashWith(sid, workIds(d.ids, d.leave))
        || chosen.find(x => x.sid !== sid && x.eid === e.id && shiftsOverlap(sid, x.sid))?.sid;
      return `<option value="${e.id}" ${c ? "disabled" : ""}>${esc(e.name)}${c ? `（這時段有班：${esc(shiftMap[c]?.name || "")}）` : ""}</option>`;
    }).join("");
    sel.value = cur && !sel.querySelector(`option[value="${CSS.escape(cur)}"]`)?.disabled ? cur : "";
    sel.dataset.pre = "";
  });
}
function renderMyLeaves() {
  $("#lvList").innerHTML = lv.mine.slice(0, 30).map(q => {
    const [cls, txt] = LV_ST[q.status] || ["", q.status];
    return `<div class="card lv-item" data-id="${q.id}">
      <div class="lv-top"><b>${dayLabel(q.date)}</b><span class="tag">${esc(q.leaveType)}</span><span class="tag ${cls}">${txt}</span>
        ${q.status === "pending" ? `<button class="btn small danger" data-lvcancel>取消</button>` : ""}</div>
      <div class="lv-shs">${(q.shiftNames || []).map(n => `<span>${esc(n)}</span>`).join("")}</div>
      <div class="lv-reason">代班：${esc(subText(q))}</div>
      ${q.reason ? `<div class="lv-reason">原因：${esc(q.reason)}</div>` : ""}
      ${q.status === "rejected" && q.rejectNote ? `<div class="lv-reason bad">退回原因：${esc(q.rejectNote)}</div>` : ""}
      ${q.status === "pending" ? `<div class="lv-acts"><button class="btn small" data-lvedit>修改</button></div>` : ""}
    </div>`;
  }).join("") || `<div class="card empty-card">還沒有請假紀錄</div>`;
}
const lvMove = n => { const [y, m] = lv.month.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); lv.month = ymd(d).slice(0, 7); lv.date = lv.month === ymd(new Date()).slice(0, 7) ? ymd(new Date()) : `${lv.month}-01`; lv.sch = undefined; lv.monthSch = {}; renderLvCal(); loadLvOneDay(lv.date); loadLvMonth().catch(() => {}); };
$("#lvPrev").onclick = () => lvMove(-1);
$("#lvNext").onclick = () => lvMove(1);
$("#lvCal").onclick = e => {
  const c = e.target.closest(".rday"); if (!c) return;
  if (!lv.loaded?.[lv.month] && !lv.monthSch[c.dataset.ds]) { lv.date = c.dataset.ds; $$("#lvCal .rday").forEach(x => x.classList.toggle("sel", x.dataset.ds === lv.date)); loadLvOneDay(lv.date); }
  else selectLvDay(c.dataset.ds);
};
$("#lvType").onclick = e => { const b = e.target.closest("button[data-v]"); if (b) $$("#lvType button").forEach(x => x.classList.toggle("on", x === b)); };
$("#lvShifts").onclick = e => { if (e.target.id === "lvAll") { e.preventDefault(); $$("#lvShifts input:not(:disabled)").forEach(i => { i.checked = true; i.closest(".lv-row").classList.add("on"); }); refreshLvSubs(); } };
$("#lvShifts").onchange = e => {
  if (e.target.type === "checkbox") e.target.closest(".lv-row").classList.toggle("on", e.target.checked);
  refreshLvSubs();
};
$("#lvSubmit").onclick = async () => {
  const ids = $$("#lvShifts input:checked").map(i => i.value);
  if (!ids.length) return toast("請勾選要請假的班別");
  const reason = $("#lvReason").value.trim();
  const type = $("#lvType button.on")?.dataset.v || "事假";
  const subNeed = lvSubOn();
  const subs = {};
  if (subNeed) $$("#lvShifts .lv-row.on").forEach(r => { const v = r.querySelector("select")?.value; if (v) subs[r.dataset.sid] = v; });
  if (subNeed && !Object.keys(subs).length) return toast("請在勾選的班別下方選代班人");
  if (subNeed) {
    await loadLvSubDay(true);   // 送出前用最新班表再檢查一次
    const bad = subProblems(subs, lv.days[lv.date] || {});
    if (bad.length) return appAlert("代班時段衝突", bad.join("\n"));
  }
  const subNames = Object.fromEntries(Object.entries(subs).map(([sid, eid]) => [sid, empNameOf(eid)]));
  const subName = [...new Set(Object.values(subNames))].join("、");
  const editing = lv.editId;
  if (!(await appConfirm(editing ? "更新請假" : "送出請假", `${dayLabel(lv.date)}・${type}\n${ids.map(id => shiftMap[id]?.name).join("\n")}\n代班：${subNeed ? subName : "不需代班"}`, { okText: editing ? "更新" : "送出" }))) return;
  $("#lvSubmit").disabled = true;
  try {
    const data = { date: lv.date, month: lv.date.slice(0, 7), shiftIds: ids, shiftNames: ids.map(id => shiftMap[id]?.name || ""),
      leaveType: type, reason, subNeed, subName, subs, subNames };
    if (editing) await updateDoc(doc(db, "leaveRequests", editing), { ...data, status: "pending", empId: me.id, updatedAt: serverTimestamp() });
    else {
      const ref = await addDoc(collection(db, "leaveRequests"), { empId: me.id, name: me.name, empNo: me.empNo || "", ...data, status: "pending", notified: false, createdAt: serverTimestamp() });
      notifyAdmins("leaveRequests", ref.id);
    }
    resetLvForm();
    toast(editing ? "已更新請假申請" : "已送出請假申請，等待管理者審核");
    loadMyLeaves();
  } catch (err) { appAlert("送出失敗", errMsg(err) + (err.code === "permission-denied" ? "\n請管理者更新 firestore.rules。" : "")); }
  finally { $("#lvSubmit").disabled = false; }
};
function setSeg(sel, v) { $$(sel + " button").forEach(x => x.classList.toggle("on", x.dataset.v === v)); }
function resetLvForm() {
  lv.editId = null;
  $("#lvReason").value = "";
  setSeg("#lvSub", "no"); $("#lvSubHint").classList.add("hidden"); $("#lvShifts").classList.remove("subon");
  $("#lvSubmit").textContent = "送出請假申請"; $("#lvCancelEdit").classList.add("hidden");
}
$("#lvSub").onclick = e => {
  const b = e.target.closest("button[data-v]"); if (!b) return;
  setSeg("#lvSub", b.dataset.v);
  const on = b.dataset.v === "yes";
  $("#lvSubHint").classList.toggle("hidden", !on); $("#lvShifts").classList.toggle("subon", on);
  if (on) { if (!$$("#lvShifts .lv-row.on").length) toast("先勾選要請假的班別，再選代班人"); loadLvSubDay(); }
};
$("#lvCancelEdit").onclick = () => { resetLvForm(); renderLvShifts(); };
$("#lvList").onclick = async e => {
  if (e.target.closest("[data-lvedit]")) {
    const q = lv.mine.find(x => x.id === e.target.closest(".lv-item").dataset.id);
    if (!q) return;
    lv.editId = q.id;
    setSeg("#lvType", q.leaveType); $("#lvReason").value = q.reason || "";
    setSeg("#lvSub", q.subNeed && Object.keys(q.subs || {}).length ? "yes" : "no"); $("#lvSubHint").classList.toggle("hidden", !lvSubOn());
    $("#lvSubmit").textContent = "更新請假申請"; $("#lvCancelEdit").classList.remove("hidden");
    const m = q.date.slice(0, 7);
    lv.date = q.date;
    if (m !== lv.month) { lv.month = m; await loadLvMonth(); } else selectLvDay(q.date);
    $("#view-leave .card").scrollIntoView({ behavior: "smooth" });
    toast("修改後按「更新請假申請」");
    return;
  }
  if (!e.target.closest("[data-lvcancel]")) return;
  const id = e.target.closest(".lv-item").dataset.id;
  if (!(await appConfirm("取消請假", "確定要取消這筆請假申請？", { okText: "取消申請", danger: true }))) return;
  try { await deleteDoc(doc(db, "leaveRequests", id)); toast("已取消"); loadMyLeaves(); }
  catch (err) { toast("取消失敗：" + errMsg(err)); }
};


/* ================= 今日上班（管理者） ================= */
let td = { date: null };
async function loadTodayView() {
  td.date ??= ymd(new Date());
  const d = new Date(td.date + "T00:00:00"), isToday = td.date === ymd(new Date());
  $("#tdTitle").textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}${isToday ? "（今天）" : ""}`;
  $("#tdToday").classList.toggle("hidden", isToday);
  $("#tdList").innerHTML = `<div class="card empty-card">讀取中…</div>`;
  const date = td.date;
  const [schSnap, attSnap] = await Promise.all([
    getDocs(query(collection(db, "schedules"), where("date", "==", date))),
    getDocs(query(collection(db, "attendance"), where("date", "==", date))),
    employees.length ? null : loadEmployees(), Object.keys(shiftMap).length ? null : loadShiftTypes()
  ]);
  if (date !== td.date) return;
  const recs = attSnap.docs.map(toRec);
  const empBy = Object.fromEntries(employees.map(u => [u.id, u]));
  const groups = {};   // shiftId -> [{u, leave, inR, outR}]
  schSnap.forEach(x => {
    const v = x.data(), u = empBy[v.empId];
    if (!u || u.active === false) return;
    (v.shiftIds || []).forEach(sid => {
      const s = shiftMap[sid]; if (!s || s.cat === "leave") return;
      const mine = recs.filter(r => r.empId === v.empId && r.shiftId === sid);
      (groups[sid] ??= []).push({ u, leave: v.leave?.[sid], inR: mine.filter(r => r.type === "in").sort((a, b) => a.t - b.t)[0], outR: mine.filter(r => r.type === "out").sort((a, b) => b.t - a.t)[0] });
    });
  });
  const now = isToday ? nowMin() : (td.date < ymd(new Date()) ? 99999 : -1);
  const people = new Set(), cnt = { work: 0, done: 0, late: 0, miss: 0, leave: 0 };
  const status = (p, s) => {
    const st = toMin(s.start), en = toMin(s.end);
    if (p.leave) { cnt.leave++; return [`<span class="tag">請假・${esc(p.leave)}</span>`, "leave"]; }
    if (p.inR && p.outR) { cnt.done++; return [`<span class="tag ok">已下班 ${hm(p.outR.t)}</span>`, "done"]; }
    if (p.inR) { const late = st != null && minOf(hm(p.inR.t)) > st; if (late) cnt.late++; cnt.work++; return [`<span class="tag ${late ? "warn" : "blue"}">上班中 ${hm(p.inR.t)}${late ? "・遲到" : ""}</span>`, "on"]; }
    if (st != null && now > st) { cnt.miss++; return [`<span class="tag bad">${now > (en ?? st) ? "未打卡" : `未到・已過 ${now - st} 分`}</span>`, "miss"]; }
    return [`<span class="tag muted">${st != null && now >= 0 ? `${st - now > 0 ? `${st - now} 分後上班` : "還沒到"}` : "還沒上班"}</span>`, "wait"];
  };
  const ids = byTime(Object.keys(groups));
  const colors = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff", "#ac8e68"];
  const av = u => u.linePicture ? `<img class="emp-av sm" src="${esc(u.linePicture)}" alt="">`
    : `<span class="emp-av sm" style="background:${colors[[...String(u.name || u.id)].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length]}">${esc((u.name || "?").slice(-2))}</span>`;
  $("#tdList").innerHTML = ids.map(sid => {
    const s = shiftMap[sid], list = groups[sid].sort((a, b) => (a.u.empNo || "").localeCompare(b.u.empNo || ""));
    const nowShift = isToday && toMin(s.start) != null && now >= toMin(s.start) && now <= toMin(s.end);
    return `<div class="card td-shift ${nowShift ? "now" : ""}">
      <div class="td-sh-head"><span class="sh-bar-c" style="background:${esc(s.color || "#8e8e93")}"></span>
        <span><b>${esc(s.name)}</b><small>${s.start && s.end ? `${s.start}–${s.end}` : ""}${nowShift ? `<em>進行中</em>` : ""}</small></span><span class="td-n">${list.length} 人</span></div>
      ${list.map(p => { people.add(p.u.id); const [tag, cls] = status(p, s); return `<div class="td-person ${cls}">${av(p.u)}<b>${esc(p.u.name)}</b>${tag}</div>`; }).join("")}
    </div>`;
  }).join("") || `<div class="card empty-card">這天沒有人排班</div>`;
  $("#tdSub").textContent = `${people.size} 人上班・${ids.length} 個班別`;
  $("#tdStats").innerHTML = `<div class="stat"><b>${people.size}</b>上班人數</div><div class="stat"><b>${cnt.work}</b>上班中</div>
    <div class="stat"><b class="${cnt.miss ? "red" : ""}">${cnt.miss}</b>未打卡</div><div class="stat"><b>${cnt.leave}</b>請假</div>`;
}
const tdMove = n => { const d = new Date(td.date + "T00:00:00"); d.setDate(d.getDate() + n); td.date = ymd(d); loadTodayView(); };
$("#tdPrev").onclick = () => tdMove(-1);
$("#tdNext").onclick = () => tdMove(1);
$("#tdToday").onclick = () => { td.date = ymd(new Date()); loadTodayView(); };

/* ================= 簽核中心（管理者） ================= */
let ap = { tab: "leave", leave: [], punch: [], shift: [], done: [] };
async function fetchPending() {
  const [l, p, sh] = await Promise.all([
    getDocs(query(collection(db, "leaveRequests"), where("status", "==", "pending"))),
    getDocs(query(collection(db, "punchRequests"), where("status", "==", "pending"))),
    getDocs(query(collection(db, "shiftRequests"), where("status", "==", "pending"))).catch(() => null)
  ]);
  ap.shift = (sh?.docs || []).map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.date.localeCompare(b.date));
  ap.leave = l.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.date.localeCompare(b.date));
  ap.punch = p.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.date.localeCompare(b.date));
  setApBadge();
  return ap.leave.length + ap.punch.length + ap.shift.length;
}
async function fetchApproved() {
  const snap = await getDocs(query(collection(db, "leaveRequests"), where("status", "==", "approved")));
  ap.done = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 150);
}
function setApBadge() {
  const n = ap.leave.length + ap.punch.length + ap.shift.length;
  ["#apBadge", "#apBadge2", "#apBadge3"].forEach(sel => { const el = $(sel); if (el) { el.textContent = n; el.classList.toggle("hidden", !n); } });
  $("#apN1").textContent = ap.leave.length || "";
  $("#apN2").textContent = ap.punch.length || "";
  $("#apN3").textContent = ap.shift.length || "";
}
async function loadApprovals() {
  await Promise.all([fetchPending(), ap.tab === "done" ? fetchApproved() : null, employees.length ? null : loadEmployees()]);
  renderApprovals();
}
function leaveCard(q, done) {
  return `<div class="card ap-item" data-id="${q.id}">
      <div class="ap-head"><b>${esc(q.name)}</b><span class="emp-no">${esc(q.empNo || "")}</span><span class="tag">${esc(q.leaveType)}</span>${done ? `<span class="tag ok">已核准</span>` : ""}</div>
      <div class="ap-date">${dayLabel(q.date)}・請 ${(q.shiftIds || []).length} 個班</div>
      <div class="lv-shs">${(q.shiftIds || []).map((sid, i) => `<span>${esc(q.shiftNames?.[i] || shiftMap[sid]?.name || "")}${q.subNames?.[sid] ? ` → <b>${esc(q.subNames[sid])}</b> 代班` : ""}</span>`).join("")}</div>
      ${Object.keys(q.subNames || {}).length ? "" : `<div class="lv-reason">代班：${q.subNeed ? `${esc(q.subName || "有")}（員工填寫，尚未指定）` : "不需代班"}</div>`}
      ${q.reason ? `<div class="lv-reason">原因：${esc(q.reason)}</div>` : ""}
      ${q.editedBy ? `<div class="lv-reason muted">由 ${esc(q.editedBy)} 修改</div>` : ""}
      <div class="ap-acts">${done
        ? `<button class="btn" data-ap="edit">修改／代班</button>`
        : `<button class="btn danger" data-ap="reject">退回</button><button class="btn" data-ap="edit">修改／代班</button><button class="btn primary" data-ap="ok">核准</button>`}</div>
    </div>`;
}
function renderApprovals() {
  $$("#apTab button").forEach(b => b.classList.toggle("on", b.dataset.v === ap.tab));
  const list = ap[ap.tab];
  const empty = { leave: "目前沒有待審核的請假申請 🎉", punch: "目前沒有待審核的補打卡申請 🎉", shift: "目前沒有待審核的加班申請 🎉", done: "還沒有已核准的請假" }[ap.tab];
  $("#apList").innerHTML = list.map(q => ap.tab === "shift" ? `
    <div class="card ap-item" data-id="${q.id}">
      <div class="ap-head"><b>${esc(q.name)}</b><span class="emp-no">${esc(q.empNo || "")}</span><span class="tag warn">加班（班表沒排到）</span></div>
      <div class="ap-date">${dayLabel(q.date)}・${esc(q.shiftName)}${shiftMap[q.shiftId]?.start ? `（${shiftMap[q.shiftId].start}–${shiftMap[q.shiftId].end}）` : ""}</div>
      <div class="ap-acts"><button class="btn danger" data-ap="reject">退回</button><button class="btn primary" data-ap="ok">核准並加入班表</button></div>
    </div>` : ap.tab !== "punch" ? leaveCard(q, ap.tab === "done") : `
    <div class="card ap-item" data-id="${q.id}">
      <div class="ap-head"><b>${esc(q.name)}</b><span class="emp-no">${esc(q.empNo || "")}</span><span class="tag warn">補打卡</span></div>
      <div class="ap-date">${dayLabel(q.date)}・${esc(q.shiftName)}</div>
      <div class="ap-what">${q.type === "in" ? "上班" : "下班"} <b>${esc(q.time)}</b></div>
      <div class="lv-reason">原因：${esc(q.reason)}</div>
      <div class="ap-acts"><button class="btn danger" data-ap="reject">退回</button><button class="btn primary" data-ap="ok">核准</button></div>
    </div>`).join("") || `<div class="card empty-card">${empty}</div>`;
}
$("#apTab").onclick = async e => {
  const b = e.target.closest("button[data-v]"); if (!b) return;
  ap.tab = b.dataset.v; renderApprovals();
  if (ap.tab === "done") { $("#apList").innerHTML = `<div class="card empty-card">讀取中…</div>`; await fetchApproved(); renderApprovals(); }
};

/* 套用請假：寫入請假人班表的 leave、把班排給代班人；mode = approve | save | revoke */
async function applyLeave(q, { ids, type, reason, subs }, mode) {
  const wasApplied = q.status === "approved";
  if (mode === "save" && wasApplied && !ids.length) mode = "revoke";
  const applying = mode === "approve" || (mode === "save" && wasApplied);
  const month = q.date.slice(0, 7);
  // 防呆：代班人那個時段不能已經有班
  const useSubs = Object.fromEntries(ids.filter(sid => subs[sid]).map(sid => [sid, subs[sid]]));
  if (Object.keys(useSubs).length) {
    const day = await loadDayAll(q.date);
    const bad = subProblems(useSubs, day, wasApplied ? (q.subAdded || {}) : {});
    if (bad.length) throw Object.assign(new Error(bad.join("\n")), { clash: true });
  }
  const batch = writeBatch(db);
  const leaveObj = {};
  if (wasApplied) (q.shiftIds || []).forEach(id => { if (!applying || !ids.includes(id)) leaveObj[id] = deleteField(); });
  if (applying) ids.forEach(id => leaveObj[id] = type);
  if (Object.keys(leaveObj).length)
    batch.set(doc(db, "schedules", `${q.empId}_${q.date}`), { empId: q.empId, date: q.date, month, leave: leaveObj }, { merge: true });
  // 代班
  const oldAdded = wasApplied ? (q.subAdded || {}) : {};
  const newAdded = {};
  if (applying) {
    for (const sid of ids) {
      const eid = subs[sid];
      if (!eid) continue;
      if (oldAdded[sid] === eid) { newAdded[sid] = eid; continue; }
      const r = await getDoc(doc(db, "schedules", `${eid}_${q.date}`));
      if (!(r.exists() && (r.data().shiftIds || []).includes(sid))) {
        batch.set(doc(db, "schedules", `${eid}_${q.date}`), { empId: eid, date: q.date, month, shiftIds: arrayUnion(sid) }, { merge: true });
        newAdded[sid] = eid;
      }
    }
  }
  for (const [sid, eid] of Object.entries(oldAdded))
    if (newAdded[sid] !== eid) batch.set(doc(db, "schedules", `${eid}_${q.date}`), { shiftIds: arrayRemove(sid) }, { merge: true });
  const empName = id => employees.find(e => e.id === id)?.name || "";
  const keepSubs = Object.fromEntries(ids.filter(sid => subs[sid]).map(sid => [sid, subs[sid]]));
  const upd = {
    shiftIds: ids, shiftNames: ids.map(id => shiftMap[id]?.name || ""), leaveType: type, reason,
    subs: keepSubs, subNames: Object.fromEntries(Object.entries(keepSubs).map(([sid, id]) => [sid, empName(id)])),
    subAdded: newAdded
  };
  if (mode === "approve") Object.assign(upd, { status: "approved", reviewedBy: me.name, reviewedAt: serverTimestamp(), notifyEmp: "todo", seenByEmp: false, notifyKind: "approved" });
  if (mode === "revoke") Object.assign(upd, { status: "revoked", subs: {}, subNames: {}, subAdded: {}, editedBy: me.name, editedAt: serverTimestamp(), notifyEmp: "todo", seenByEmp: false, notifyKind: "revoked" });
  if (mode === "save" && wasApplied) Object.assign(upd, { editedBy: me.name, editedAt: serverTimestamp(), notifyEmp: "todo", seenByEmp: false, notifyKind: "edited" });
  batch.update(doc(db, "leaveRequests", q.id), upd);
  await batch.commit();
}

// 管理者：讀某天所有人的班 {empId: {ids, leave}}
async function loadDayAll(date) {
  const snap = await getDocs(query(collection(db, "schedules"), where("date", "==", date)));
  const day = {};
  snap.forEach(d => { const x = d.data(); day[x.empId] = { ids: x.shiftIds || [], leave: x.leave || {} }; });
  return day;
}
// 請假審核／修改視窗
let lm = null;
async function openLeaveModal(q) {
  lm = { q, ids: [] };
  $("#lmTitle").textContent = q.status === "approved" ? "修改請假" : "審核請假";
  $("#lmWho").textContent = `${q.name}　${dayLabel(q.date)}`;
  setSeg("#lmType", q.leaveType); $("#lmReason").value = q.reason || "";
  $("#lmSubHint").textContent = `員工申請時：${subText(q)}`;
  $("#lmShifts").innerHTML = `<p class="hint" style="margin:0">讀取中…</p>`;
  $("#lmActs").innerHTML = q.status === "approved"
    ? `<button class="btn danger" data-lm="revoke">撤銷這筆請假</button>`
    : `<button class="btn danger" data-lm="reject">退回</button><button class="btn primary" data-lm="approve">核准</button>`;
  $("#lvModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#lvModal").classList.add("open"));
  const [day] = await Promise.all([loadDayAll(q.date), employees.length ? null : loadEmployees()]);
  lm.day = day;
  const have = day[q.empId]?.ids || [];
  const ids = [...new Set([...have, ...(q.shiftIds || [])])].filter(id => shiftMap[id] && shiftMap[id].cat !== "leave")
    .sort((a, b) => (shiftMap[a].start || "99").localeCompare(shiftMap[b].start || "99"));
  lm.ids = ids;
  // 員工填的名字對得到員工 → 預設帶入
  const guess = q.subNeed && q.subName ? activeEmployees().filter(e => e.id !== q.empId && q.subName.includes(e.name)) : [];
  const opts = activeEmployees().filter(e => e.id !== q.empId);
  const ign = q.status === "approved" ? (q.subAdded || {}) : {};
  const busy = (sid, eid) => { const d = day[eid] || {}; return clashWith(sid, workIds(d.ids, d.leave).filter(x => !(ign[x] === eid && x === sid))); };
  $("#lmShifts").innerHTML = ids.map((id, i) => {
    const s = shiftMap[id], on = (q.shiftIds || []).includes(id);
    let cur = q.subs?.[id] || (guess.length === 1 ? guess[0].id : "");
    if (cur && busy(id, cur)) cur = "";
    return `<div class="lm-row ${on ? "on" : ""}" data-sid="${id}">
      <label class="lm-chk"><input type="checkbox" ${on ? "checked" : ""}><span class="lv-no" style="background:${esc(s.color || "#8e8e93")}">${i + 1}</span>
        <span class="lv-name">${esc(s.name)}<small>${s.start && s.end ? `${s.start}–${s.end}` : ""}</small></span></label>
      <select class="lm-sub" ${on ? "" : "disabled"}><option value="">不需代班</option>${opts.map(e => { const c = busy(id, e.id); return `<option value="${e.id}" ${e.id === cur ? "selected" : ""} ${c ? "disabled" : ""}>代班：${esc(e.name)}${c ? `（這時段有班：${esc(shiftMap[c]?.name || "")}）` : ""}</option>`; }).join("")}</select>
    </div>`;
  }).join("") || `<p class="empty" style="padding:14px">這天沒有排班</p>`;
}
function closeLeaveModal() { $("#lvModal").classList.remove("open"); setTimeout(() => $("#lvModal").classList.add("hidden"), 200); }
function lmData() {
  const ids = [], subs = {};
  $$("#lmShifts .lm-row").forEach(r => {
    if (!r.querySelector("input").checked) return;
    ids.push(r.dataset.sid);
    const v = r.querySelector("select").value; if (v) subs[r.dataset.sid] = v;
  });
  return { ids, subs, type: $("#lmType button.on")?.dataset.v || lm.q.leaveType, reason: $("#lmReason").value.trim() };
}
$("#lmShifts").onchange = e => {
  const r = e.target.closest(".lm-row"); if (!r || e.target.type !== "checkbox") return;
  r.classList.toggle("on", e.target.checked); r.querySelector("select").disabled = !e.target.checked;
};
$("#lmType").onclick = e => { const b = e.target.closest("button[data-v]"); if (b) setSeg("#lmType", b.dataset.v); };
async function lmRun(mode, btn) {
  const q = lm.q, d = lmData();
  if (mode !== "revoke" && mode !== "reject" && !d.ids.length) return toast("請至少勾選一個班別");
  try {
    if (mode === "reject") {
      const note = await appDialog({ title: "退回申請", message: `${q.name}・${dayLabel(q.date)} ${q.leaveType}`, input: { type: "text", placeholder: "退回原因（選填，員工會看到）" },
        buttons: [{ text: "取消", value: false }, { text: "退回", value: true, style: "danger" }] });
      if (note === false) return;
      await updateDoc(doc(db, "leaveRequests", q.id), { status: "rejected", rejectNote: note || "", reviewedBy: me.name, reviewedAt: serverTimestamp(), notifyEmp: "todo", seenByEmp: false, notifyKind: "rejected" });
      toast("已退回");
    } else {
      if (mode === "revoke" && !(await appConfirm("撤銷請假", `${q.name}・${dayLabel(q.date)}\n撤銷後恢復原本的班，代班人的班也會移除。`, { okText: "撤銷", danger: true }))) return;
      if (btn) btn.disabled = true;
      await applyLeave(q, d, mode);
      toast({ approve: "已核准", save: "已儲存", revoke: "已撤銷請假" }[mode]);
    }
    closeLeaveModal();
    await loadApprovals();
  } catch (err) { err.clash ? appAlert("代班時段衝突", err.message) : appAlert("操作失敗", errMsg(err) + "\n請確認 firestore.rules 已更新。"); }
  finally { if (btn) btn.disabled = false; }
}
$("#lmSave").onclick = e => lmRun("save", e.currentTarget);
$("#lmActs").onclick = e => { const b = e.target.closest("[data-lm]"); if (b) lmRun(b.dataset.lm, b); };
$("#lvModal").onclick = e => { if (e.target.id === "lvModal" || e.target.closest("[data-close]")) closeLeaveModal(); };

$("#apList").onclick = async e => {
  const b = e.target.closest("[data-ap]");
  if (!b) return;
  const q = ap[ap.tab].find(x => x.id === b.closest(".ap-item").dataset.id);
  if (!q) return;
  if (ap.tab === "leave" || ap.tab === "done") {
    if (b.dataset.ap === "edit") return openLeaveModal(q);
    lm = { q };
    if (b.dataset.ap === "reject") return lmRun("reject");
    // 快速核准：帶入已指定的代班
    let subs = q.subs || {};
    if (!Object.keys(subs).length && q.subNeed && q.subName) {   // 員工填的名字剛好對到一位員工 → 直接排給他
      if (!employees.length) await loadEmployees();
      const g = activeEmployees().filter(x => x.id !== q.empId && q.subName.includes(x.name));
      if (g.length === 1) {
        const day = await loadDayAll(q.date);
        subs = Object.fromEntries((q.shiftIds || []).filter(sid => !subProblems({ [sid]: g[0].id }, day).length).map(sid => [sid, g[0].id]));
      }
    }
    try { b.disabled = true; await applyLeave(q, { ids: q.shiftIds || [], type: q.leaveType, reason: q.reason || "", subs }, "approve"); toast(`已核准：${q.name}・${dayLabel(q.date)} ${q.leaveType}`); await loadApprovals(); }
    catch (err) { b.disabled = false; err.clash ? appAlert("代班時段衝突", err.message + "\n請按「修改／代班」換一位代班人。") : appAlert("操作失敗", errMsg(err) + "\n請確認 firestore.rules 已更新。"); }
    return;
  }
  if (ap.tab === "shift") {
    try {
      if (b.dataset.ap === "ok") {
        const day = await loadDayAll(q.date);
        const d = day[q.empId] || {};
        const c = clashWith(q.shiftId, workIds(d.ids, d.leave).filter(x => x !== q.shiftId));
        if (c && !(await appConfirm("時段衝突", `${q.name} 那天已經有「${shiftMap[c]?.name}」，時間重疊。仍要加入嗎？`, { okText: "仍要加入" }))) return;
        b.disabled = true;
        const batch = writeBatch(db);
        batch.set(doc(db, "schedules", `${q.empId}_${q.date}`), { empId: q.empId, date: q.date, month: q.date.slice(0, 7), shiftIds: arrayUnion(q.shiftId) }, { merge: true });
        batch.update(doc(db, "shiftRequests", q.id), { status: "approved", reviewedBy: me.name, reviewedAt: serverTimestamp(), notifyEmp: "todo", seenByEmp: false });
        await batch.commit();
        toast(`已核准並加入班表：${q.name} ${q.shiftName}`);
      } else {
        const note = await appDialog({ title: "退回加班申請", message: `${q.name}・${dayLabel(q.date)} ${q.shiftName}\n退回後這堂不會算薪資（已打的卡仍保留紀錄）`, input: { type: "text", placeholder: "退回原因（選填，員工會看到）" },
          buttons: [{ text: "取消", value: false }, { text: "退回", value: true, style: "danger" }] });
        if (note === false) return;
        await updateDoc(doc(db, "shiftRequests", q.id), { status: "rejected", rejectNote: note || "", reviewedBy: me.name, reviewedAt: serverTimestamp(), notifyEmp: "todo", seenByEmp: false });
        toast("已退回");
      }
      await loadApprovals();
    } catch (err) { b.disabled = false; appAlert("操作失敗", errMsg(err) + "\n請確認 firestore.rules 已更新。"); }
    return;
  }
  const title = `${q.name}・${dayLabel(q.date)} ${q.type === "in" ? "上班" : "下班"} ${q.time}`;
  try {
    if (b.dataset.ap === "ok") {
      b.disabled = true;
      const batch = writeBatch(db);
      const t = new Date(`${q.date}T${q.time}:00`);
      batch.set(doc(db, "attendance", `mk_${q.id}`), {
        empId: q.empId, name: q.name, empNo: q.empNo || "", type: q.type,
        shiftId: q.shiftId || null, shiftName: q.shiftName || "", locationId: null, dist: null,
        date: q.date, month: q.date.slice(0, 7), ts: t, clientTime: t.toISOString(),
        lat: null, lng: null, acc: null, outOfRange: false, reason: "", note: `補打卡（${q.reason}）`,
        makeup: true, imported: true, requestId: q.id, approvedBy: me.name, approvedAt: serverTimestamp()
      });
      batch.update(doc(db, "punchRequests", q.id), { status: "approved", reviewedBy: me.name, reviewedAt: serverTimestamp(), notifyEmp: "todo", seenByEmp: false });
      await batch.commit();
      toast(`已核准：${title}`);
    } else {
      const note = await appDialog({ title: "退回申請", message: title, input: { type: "text", placeholder: "退回原因（選填，員工會看到）" },
        buttons: [{ text: "取消", value: false }, { text: "退回", value: true, style: "danger" }] });
      if (note === false) return;
      await updateDoc(doc(db, "punchRequests", q.id), { status: "rejected", rejectNote: note || "", reviewedBy: me.name, reviewedAt: serverTimestamp(), notifyEmp: "todo", seenByEmp: false });
      toast("已退回");
    }
    await loadApprovals();
  } catch (err) { b.disabled = false; appAlert("操作失敗", errMsg(err) + "\n請確認 firestore.rules 已更新。"); }
};
// 管理者登入後：有待審核就跳出提示
let apPrompted = false;
async function checkPendingOnStart() {
  if (me?.role !== "admin" || apPrompted) return;
  apPrompted = true;
  syncStaff().catch(() => {});
  const n = await fetchPending().catch(() => 0);
  if (!n) return;
  const parts = [ap.leave.length ? `請假 ${ap.leave.length} 筆` : "", ap.punch.length ? `補打卡 ${ap.punch.length} 筆` : "", ap.shift.length ? `加班 ${ap.shift.length} 筆` : ""].filter(Boolean).join("、");
  const go = await appDialog({ title: "有申請待審核", message: parts, buttons: [{ text: "稍後", value: false }, { text: "前往審核", value: true, style: "primary" }] });
  if (go) { ap.tab = ap.leave.length ? "leave" : ap.punch.length ? "punch" : "shift"; showView("approvals"); }
}
// 員工：申請審核完成後，打開系統跳出結果（按「知道了」後不再出現）
async function showMyResults() {
  if (!me?.id) return;
  const since = ymd(new Date(Date.now() - 30 * 864e5));
  const [l, p, shq] = await Promise.all([
    getDocs(query(collection(db, "leaveRequests"), where("empId", "==", me.id))),
    getDocs(query(collection(db, "punchRequests"), where("empId", "==", me.id))),
    getDocs(query(collection(db, "shiftRequests"), where("empId", "==", me.id))).catch(() => null)
  ]);
  const pick = (snap, coll) => snap.docs.map(d => ({ id: d.id, coll, ...d.data() }))
    .filter(q => q.status !== "pending" && q.seenByEmp === false && q.date >= since);
  const sl = await getDocs(query(collection(db, "payslips"), where("empId", "==", me.id))).catch(() => null);
  const slips = (sl?.docs || []).map(d => ({ id: d.id, coll: "payslips", date: d.data().month + "-01", ...d.data() })).filter(q => q.seenByEmp === false);
  const list = [...pick(l, "leaveRequests"), ...pick(p, "punchRequests"), ...(shq ? pick(shq, "shiftRequests") : []), ...slips].sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) return;
  const line = q => {
    if (q.coll === "payslips") { const [y, m] = q.month.split("-"); return `💰 ${y}年${+m}月薪資已結算\n${money(q.total)}（到「我的薪資」看明細）`; }
    if (q.coll === "shiftRequests") return `${q.status === "approved" ? "✅ 加班已核准，已加入班表" : "❌ 加班申請被退回"}\n${dayLabel(q.date)} ${q.shiftName}` + (q.status === "rejected" && q.rejectNote ? `\n退回原因：${q.rejectNote}` : "");
    if (q.coll === "punchRequests") return `${q.status === "approved" ? "✅ 補打卡已核准" : "❌ 補打卡被退回"}\n${dayLabel(q.date)} ${q.shiftName || ""}・${q.type === "in" ? "上班" : "下班"} ${q.time}` + (q.status === "rejected" && q.rejectNote ? `\n退回原因：${q.rejectNote}` : "");
    const head = q.status === "revoked" ? "↩️ 請假已撤銷" : q.status === "rejected" ? "❌ 請假被退回" : q.notifyKind === "edited" ? "✏️ 請假已被修改" : "✅ 請假審核通過";
    return `${head}\n${dayLabel(q.date)} ${q.leaveType}・${(q.shiftNames || []).join("、")}`
      + (q.status === "approved" ? `\n代班：${subText(q)}` : "")
      + (q.status === "rejected" && q.rejectNote ? `\n退回原因：${q.rejectNote}` : "")
      + (q.status === "revoked" ? "\n請照原班表上班" : "");
  };
  const allOk = list.every(q => q.status === "approved" || q.coll === "payslips");
  await appDialog({ title: list.length > 1 ? `你有 ${list.length} 筆申請有結果` : allOk ? "審核通過" : "申請結果", message: list.map(line).join("\n\n"),
    buttons: [{ text: "知道了", value: true, style: "primary" }] });
  await Promise.all(list.map(q => updateDoc(doc(db, q.coll, q.id), { seenByEmp: true }).catch(() => {})));
  if (list.some(q => q.coll === "leaveRequests") && !$("#view-leave").classList.contains("hidden")) loadLeaveView().catch(() => {});
}
authReady.then(() => setTimeout(async () => {
  await showMyResults().catch(() => {});
  checkPendingOnStart();
}, 800));

async function loadReport() {
  const month = $("#repMonth").value;
  await Promise.all([loadEmployees(), loadShiftTypes(), loadLocations()]);
  const [attSnap, schSnap] = await Promise.all([
    monthDocs("attendance", month),
    monthDocs("schedules", month)
  ]);
  const recs = attSnap.docs.map(toRec);
  const sch = {};
  const lvMap = {};
  schSnap.forEach(d => { sch[d.id] = d.data().shiftIds || []; lvMap[d.id] = d.data().leave || {}; });

  const cur = $("#repEmp").value;
  $("#repEmp").innerHTML = `<option value="">全部員工</option>` +
    employees.map(u => `<option value="${u.id}">${esc(u.empNo)} ${esc(u.name)}</option>`).join("");
  $("#repEmp").value = cur;

  const today = ymd(new Date());
  const byKey = {};
  recs.forEach(r => (byKey[`${r.empId}_${r.date}`] ??= []).push(r));
  reportRows = [];
  for (const u of employees) {
    for (const d of daysOfMonth(month)) {
      const ds = ymd(d), key = `${u.id}_${ds}`;
      const dayRecs = byKey[key] || [];
      const ids = (sch[key] || []).filter(id => shiftMap[id] && shiftMap[id].cat !== "leave");
      if (ds > today && !dayRecs.length) continue;           // 未來日期不列
      const used = new Set();
      const addRow = (sid, list) => {
        const s = shiftMap[sid];
        const ins = list.filter(r => r.type === "in").sort((a, b) => a.t - b.t);
        const outs = list.filter(r => r.type === "out").sort((a, b) => b.t - a.t);
        const inD = punchDetail(ins[0], "in", s?.start, ds);
        const outD = punchDetail(outs[0], "out", s?.end, ds);
        const hrs = inD.r && outD.r && outD.r.t > inD.r.t ? (outD.r.t - inD.r.t) / 36e5 : null;
        reportRows.push({ u, date: ds, s, sid, inD, outD, hrs });
      };
      ids.forEach(id => {
        used.add(id);
        const lt = lvMap[key]?.[id];
        if (lt && !dayRecs.some(r => r.shiftId === id)) {
          const L = { time: "", place: "", reason: "", abn: "", leave: lt };
          reportRows.push({ u, date: ds, s: shiftMap[id], sid: id, inD: L, outD: L, hrs: null, leave: lt });
        } else addRow(id, dayRecs.filter(r => r.shiftId === id));
      });
      // 沒有對應排班的打卡（臨時班別或舊紀錄）
      const extra = {};
      dayRecs.filter(r => !used.has(r.shiftId)).forEach(r => (extra[r.shiftId || ""] ??= []).push(r));
      Object.entries(extra).forEach(([sid, list]) => addRow(sid || null, list));
    }
  }
  reportRows.sort((a, b) => b.date.localeCompare(a.date) || (a.u.empNo || "").localeCompare(b.u.empNo || "") || (a.s?.start || "").localeCompare(b.s?.start || ""));
  renderReport();
}

const isAbn = r => !!(r.inD.abn || r.outD.abn || r.inD.far || r.outD.far);
function filteredReport() {
  const f = $("#repEmp").value, st = $("#repStatus").value, q = $("#repSearch").value.trim().toLowerCase();
  return reportRows.filter(r => (!f || r.u.id === f)
    && (!q || `${r.u.name} ${r.u.empNo} ${r.s?.name || ""}`.toLowerCase().includes(q))
    && (!st || (st === "abn" && isAbn(r)) || (st === "late" && r.inD.late) || (st === "early" && r.outD.early)
        || (st === "miss" && (r.inD.abn === "未打卡" || r.outD.abn === "未打卡")) || (st === "far" && (r.inD.far || r.outD.far))));
}

function renderReport() {
  const rows = filteredReport();
  // 月統計（依員工篩選，不受狀態篩選影響）
  const f = $("#repEmp").value;
  const sum = {};
  reportRows.filter(r => !f || r.u.id === f).forEach(r => {
    const s = sum[r.u.id] ??= { u: r.u, days: new Set(), hrs: 0, late: 0, early: 0, miss: 0, far: 0 };
    if (r.inD.r || r.outD.r) s.days.add(r.date);
    s.hrs += r.hrs || 0;
    if (r.inD.late) s.late++;
    if (r.outD.early) s.early++;
    if (r.inD.abn === "未打卡") s.miss++;
    if (r.outD.abn === "未打卡") s.miss++;
    if (r.inD.far) s.far++;
    if (r.outD.far) s.far++;
  });
  if (!isMob()) return renderReportDesk(rows, sum);
  const colors = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff", "#ac8e68"];
  const av = u => u.linePicture ? `<img class="emp-av sm" src="${esc(u.linePicture)}" alt="">`
    : `<span class="emp-av sm" style="background:${colors[[...String(u.name || u.id)].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length]}">${esc((u.name || "?").slice(-2))}</span>`;
  const people = Object.values(sum).sort((a, b) => (a.u.empNo || "").localeCompare(b.u.empNo || ""));
  $("#repSum").innerHTML = people.map(x => {
    const bad = [x.late ? `<span class="tag bad">遲到 ${x.late}</span>` : "", x.early ? `<span class="tag bad">早退 ${x.early}</span>` : "",
      x.miss ? `<span class="tag bad">未打卡 ${x.miss}</span>` : "", x.far ? `<span class="tag warn">地點異常 ${x.far}</span>` : ""].join("");
    return `<button class="card rp-card ${f === x.u.id ? "on" : ""}" data-eid="${x.u.id}">
      <div class="rp-top">${av(x.u)}<span><b>${esc(x.u.name)}</b><small>${esc(x.u.empNo || "")}</small></span></div>
      <div class="rp-nums"><span><b>${x.days.size}</b>出勤天</span><span><b>${x.hrs.toFixed(1)}</b>小時</span></div>
      <div class="rp-tags">${bad || `<span class="tag ok">全部正常</span>`}</div></button>`;
  }).join("") || `<div class="card empty-card">本月沒有資料</div>`;

  $("#repCount").textContent = `共 ${rows.length} 筆${f ? `・只看 ${esc(employees.find(u => u.id === f)?.name || "")}` : ""}`;
  const st = (x, k) => {
    if (x.r) return `<span class="rp-t">${x.time}</span>${x.abn ? `<span class="tag bad">${x.abn.replace(/ 分鐘/, "分")}</span>` : `<span class="tag ok">正常</span>`}${x.far ? `<span class="tag warn">範圍外</span>` : ""}`;
    return x.abn ? `<span class="rp-t none">--:--</span><span class="tag bad">${x.abn}</span>` : `<span class="rp-t none">--:--</span><span class="tag muted">未到</span>`;
  };
  const extra = x => [x.reason ? `原因：${esc(x.reason)}` : "", x.r?.lat != null ? `<a href="https://www.google.com/maps?q=${x.r.lat},${x.r.lng}" target="_blank" rel="noopener">地圖</a>` : ""].filter(Boolean).join("・");
  let html = "", lastDate = "";
  rows.slice(0, 1500).forEach(r => {
    if (r.date !== lastDate) { if (lastDate) html += `</div>`; lastDate = r.date; html += `<div class="rp-day-h">${dayLabel(r.date)}</div><div class="card rp-day">`; }
    const sname = r.s ? r.s.name : (r.inD.r?.shiftName || r.outD.r?.shiftName || "未指定班別");
    const time = r.s?.start && r.s?.end ? `${r.s.start}–${r.s.end}` : "";
    html += `<div class="rp-row ${isAbn(r) ? "abn" : ""}">
      <div class="rp-who">${av(r.u)}<span><b>${esc(r.u.name)}</b><small><i class="dot" style="background:${esc(r.s?.color || "#9aa0a6")}"></i>${esc(sname)}${time ? `　${time}` : ""}</small></span>${r.hrs ? `<em class="rp-hrs">${r.hrs.toFixed(2)} 時</em>` : ""}</div>
      ${r.leave ? `<div class="rp-io"><span class="tag ok">請假・${esc(r.leave)}</span></div>` : `
      <div class="rp-io"><div><label>上班</label>${st(r.inD, "上班")}${extra(r.inD) ? `<small>${extra(r.inD)}</small>` : ""}</div>
        <div><label>下班</label>${st(r.outD, "下班")}${extra(r.outD) ? `<small>${extra(r.outD)}</small>` : ""}</div></div>`}
    </div>`;
  });
  if (lastDate) html += `</div>`;
  $("#repList").innerHTML = html || `<div class="card empty-card">沒有符合的紀錄</div>`;
}
// 電腦版：原本的表格
function renderReportDesk(rows, sum) {
  const num = (n, cls) => n ? `<span class="tag ${cls}">${n}</span>` : "0";
  $("#repSumT").innerHTML = Object.values(sum).sort((a, b) => (a.u.empNo || "").localeCompare(b.u.empNo || "")).map(s => `
    <tr><td>${esc(s.u.empNo)}</td><td>${esc(s.u.name)}</td><td>${s.days.size}</td><td>${s.hrs.toFixed(2)}</td>
    <td>${num(s.late, "bad")}</td><td>${num(s.early, "bad")}</td><td>${num(s.miss, "bad")}</td><td>${num(s.far, "warn")}</td></tr>`).join("")
    || `<tr><td colspan="8" class="empty">本月沒有資料</td></tr>`;
  $("#repCountT").textContent = `共 ${rows.length} 筆`;
  const cell = (x, cls, k) => `
    <td class="${cls} t" data-label="${k}時間">${x.time || "—"}</td>
    <td class="${cls}" data-label="${k}打卡地點">${x.place || "—"}</td>
    <td class="${cls}" data-label="${k}查看地點">${x.r?.lat != null ? `<a href="https://www.google.com/maps?q=${x.r.lat},${x.r.lng}" target="_blank" rel="noopener">查看地點</a>` : "—"}</td>
    <td class="${cls} wrap" data-label="${k}地點異常原因">${x.reason ? `<span class="tag warn">異常</span> ${esc(x.reason)}` : "—"}</td>
    <td class="${cls}" data-label="${k}出勤異常">${x.abn ? `<span class="tag bad">${x.abn}</span>` : (x.r ? `<span class="tag ok">正常</span>` : "—")}</td>`;
  $("#repListT").innerHTML = rows.slice(0, 1500).map(r => `
    <tr class="${isAbn(r) ? "abn" : ""}">
      <td>${esc(r.u.empNo)}</td><td>${esc(r.u.name)}</td><td>${dayLabel(r.date)}</td>
      <td>${r.s ? chipHtml(r.sid) : `<span class="tag">${esc(r.inD.r?.shiftName || r.outD.r?.shiftName || "未指定班別")}</span>`}</td>
      ${r.leave ? `<td colspan="10" data-label="出勤"><span class="tag ok">請假・${esc(r.leave)}</span></td>` : cell(r.inD, "g-in", "上班") + cell(r.outD, "g-out", "下班")}
      <td>${r.hrs ? r.hrs.toFixed(2) : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="15" class="empty">沒有符合的紀錄</td></tr>`;
}
$("#repSum").onclick = e => {
  const c = e.target.closest(".rp-card"); if (!c) return;
  $("#repEmp").value = $("#repEmp").value === c.dataset.eid ? "" : c.dataset.eid;
  renderReport();
  $("#repList").scrollIntoView({ behavior: "smooth", block: "start" });
};
$("#repEmp").onchange = renderReport;
$("#repStatus").onchange = renderReport;
$("#repSearch").oninput = renderReport;

$("#csvBtn").onclick = () => {
  const rows = filteredReport();
  const head = ["員編", "姓名", "打卡日期", "班別", "班別時間",
    "上班時間", "上班打卡地點", "上班座標", "上班地點異常原因", "上班出勤異常",
    "下班時間", "下班打卡地點", "下班座標", "下班地點異常原因", "下班出勤異常", "工時"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const part = x => [x.time, x.place, x.r?.lat != null ? `${x.r.lat},${x.r.lng}` : "", x.reason, x.abn || (x.r ? "正常" : "")];
  const lines = [head.map(q).join(",")].concat(rows.map(r => [
    r.u.empNo, r.u.name, r.date, r.s?.name || r.inD.r?.shiftName || r.outD.r?.shiftName || "",
    r.s?.start && r.s?.end ? `${r.s.start}-${r.s.end}` : "",
    ...part(r.inD), ...part(r.outD), r.hrs ? r.hrs.toFixed(2) : ""
  ].map(q).join(",")));
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `打卡紀錄_${$("#repMonth").value}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/* ================= 薪資計算（管理者） ================= */
const ST = { ok: "正常", forgot: "忘記打卡", missing: "未打卡", leave: "請假", absent: "未上班" };
let pay = { month: null, rates: {}, cfg: {}, items: [], open: new Set(), tab: "month" };
const normName = s => String(s || "").replace(/\s+/g, "").toLowerCase();

async function loadPayRates() {
  const d = await getDoc(doc(db, "payRates", "all"));
  pay.rates = d.exists() ? d.data().rates || {} : {};
}
const rateOf = (empId, sid) => +(pay.rates[empId]?.[sid] || 0);

async function loadPayroll() {
  const month = $("#payMonth").value;
  await Promise.all([loadEmployees(), loadShiftTypes(), loadPayRates()]);
  $("#payMonthView").classList.toggle("hidden", pay.tab !== "month");
  $("#payRatesView").classList.toggle("hidden", pay.tab !== "rates");
  $$("#payTab button").forEach(b => b.classList.toggle("on", b.dataset.v === pay.tab));
  $("#payMonth").classList.toggle("hidden", pay.tab !== "month");
  if (pay.tab === "rates") return renderRates();

  const [attSnap, schSnap, cfgSnap, confSnap, slipSnap] = await Promise.all([
    monthDocs("attendance", month),
    monthDocs("schedules", month),
    getDoc(doc(db, "payroll", month)),
    getDocs(query(collection(db, "payConfirm"), where("month", "==", month))).catch(() => null),
    getDocs(query(collection(db, "payslips"), where("month", "==", month))).catch(() => null)
  ]);
  pay.conf = {}; confSnap?.forEach(d => pay.conf[d.data().empId] = d.data());
  pay.slips = {}; slipSnap?.forEach(d => pay.slips[d.data().empId] = d.data());
  pay.month = month;
  pay.cfg = { empIds: null, overrides: {}, adjust: {}, payForgot: true, payMissing: false, ...(cfgSnap.exists() ? cfgSnap.data() : {}) };
  $("#payForgot").checked = pay.cfg.payForgot !== false;
  $("#payMissing").checked = !!pay.cfg.payMissing;

  // 每一個「人 × 日期 × 班別」是一堂
  const recs = attSnap.docs.map(toRec);
  const byKey = {};
  recs.forEach(r => (byKey[`${r.empId}_${r.date}_${r.shiftId || "x:" + (r.shiftName || "")}`] ??= []).push(r));
  const today = ymd(new Date());
  const items = [], seen = new Set();
  schSnap.forEach(d => {
    const x = d.data();
    (x.shiftIds || []).forEach(sid => {
      const k = `${x.empId}_${x.date}_${sid}`;
      seen.add(k);
      items.push({ key: k, empId: x.empId, date: x.date, sid, recs: byKey[k] || [], leave: x.leave?.[sid] });
    });
  });
  // 沒排班但有打卡的班（臨時班別）
  Object.entries(byKey).forEach(([k, list]) => {
    if (seen.has(k)) return;
    const r = list[0];
    items.push({ key: k, empId: r.empId, date: r.date, sid: r.shiftId || null, sname: r.shiftName, recs: list, extra: true });
  });
  pay.items = items.map(it => {
    const s = shiftMap[it.sid];
    const hasIn = it.recs.some(r => r.type === "in"), hasOut = it.recs.some(r => r.type === "out");
    let auto = it.leave || s?.cat === "leave" || /假/.test(s?.name || it.sname || "") ? "leave"
      : hasIn && hasOut ? "ok" : hasIn || hasOut ? "forgot"
      : it.date < today ? "missing" : "future";
    const st = pay.cfg.overrides[it.key] || auto;
    return { ...it, s, name: s?.name || it.sname || "未指定班別", auto, st, hasIn, hasOut };
  }).filter(it => it.st !== "future").sort((a, b) => a.date.localeCompare(b.date) || (a.s?.start || "").localeCompare(b.s?.start || ""));

  renderPayEmps();
  renderPayroll();
}

const paid = st => st === "ok" || (st === "forgot" && pay.cfg.payForgot !== false) || (st === "missing" && pay.cfg.payMissing);
const selectedEmps = () => {
  const act = activeEmployees();
  const ids = pay.cfg.empIds;
  return ids ? act.filter(u => ids.includes(u.id)) : act.filter(u => pay.items.some(it => it.empId === u.id));
};

function renderPayEmps() {
  const sel = new Set(selectedEmps().map(u => u.id));
  $("#payEmps").innerHTML = activeEmployees().map(u => {
    const n = pay.items.filter(it => it.empId === u.id).length;
    return `<button class="emp-chip ${sel.has(u.id) ? "on" : ""}" data-eid="${u.id}">${esc(u.name)}<small>${n ? n + " 堂" : "無排班"}</small></button>`;
  }).join("");
}

function calcEmp(u) {
  const list = pay.items.filter(it => it.empId === u.id);
  const by = {};
  list.forEach(it => {
    const k = it.sid || "x:" + it.name;
    const g = by[k] ??= { sid: it.sid, name: it.name, color: it.s?.color || "#9aa0a6", rate: it.sid ? rateOf(u.id, it.sid) : 0, n: { ok: 0, forgot: 0, missing: 0, leave: 0, absent: 0 }, paidN: 0 };
    g.n[it.st] = (g.n[it.st] || 0) + 1;
    if (paid(it.st)) g.paidN++;
  });
  const groups = Object.values(by).map(g => ({ ...g, sub: g.paidN * g.rate }))
    .sort((a, b) => (shiftMap[a.sid]?.order || 9e15) - (shiftMap[b.sid]?.order || 9e15));
  const cnt = st => list.filter(it => it.st === st).length;
  const adj = pay.cfg.adjust[u.id] || {};
  const base = groups.reduce((a, g) => a + g.sub, 0);
  const total = base + (+adj.bonus || 0) - (+adj.deduct || 0);
  return { u, list, groups, base, adj, total, ok: cnt("ok"), forgot: cnt("forgot"), missing: cnt("missing"), leave: cnt("leave") + cnt("absent"), paidN: groups.reduce((a, g) => a + g.paidN, 0), noRate: groups.filter(g => g.paidN && !g.rate).length };
}

const money = n => "$" + Math.round(n).toLocaleString("en-US");

function renderPayroll() {
  const stF = $("#payStatus").value;
  const rows = selectedEmps().map(calcEmp).filter(c => !stF || c.list.some(it => it.st === stF || (stF === "leave" && it.st === "absent")));
  const sum = rows.reduce((a, c) => a + c.total, 0);
  const [y, m] = pay.month.split("-");
  $("#payTotal").innerHTML = `<div><span>${y}年${+m}月 應發總額</span><b>${money(sum)}</b></div>
    <div><span>人數</span><b>${rows.length}</b></div>
    <div><span>計薪堂數</span><b>${rows.reduce((a, c) => a + c.paidN, 0)}</b></div>
    <div><span>忘記打卡</span><b class="${rows.some(c => c.forgot) ? "orange" : ""}">${rows.reduce((a, c) => a + c.forgot, 0)}</b></div>
    <div><span>未打卡</span><b class="${rows.some(c => c.missing) ? "red" : ""}">${rows.reduce((a, c) => a + c.missing, 0)}</b></div>`;

  $("#payList").innerHTML = rows.map(c => {
    const open = pay.open.has(c.u.id);
    const tags = [c.forgot ? `<span class="tag warn">忘記打卡 ${c.forgot}</span>` : "", c.missing ? `<span class="tag bad">未打卡 ${c.missing}</span>` : "",
      c.leave ? `<span class="tag">請假/未上班 ${c.leave}</span>` : "", c.noRate ? `<span class="tag bad">${c.noRate} 個班別沒設單價</span>` : ""].join("") + payStateTags(c);
    let detail = "";
    if (open) {
      const inst = c.list.filter(it => !stF || it.st === stF || (stF === "leave" && it.st === "absent"));
      detail = `<div class="pay-detail">
        <table class="pay-tbl"><thead><tr><th>班別</th><th>正常</th><th>忘記打卡</th><th>未打卡</th><th>請假</th><th>計薪次數</th><th>單價</th><th>小計</th></tr></thead><tbody>
        ${c.groups.map(g => `<tr><td><span class="dot" style="background:${esc(g.color)}"></span>${esc(g.name)}</td>
          <td>${g.n.ok || ""}</td><td class="o">${g.n.forgot || ""}</td><td class="r">${g.n.missing || ""}</td><td>${(g.n.leave || 0) + (g.n.absent || 0) || ""}</td>
          <td><b>${g.paidN}</b></td><td class="${g.paidN && !g.rate ? "r" : ""}">${g.rate ? money(g.rate) : "未設定"}</td><td><b>${money(g.sub)}</b></td></tr>`).join("")}
        </tbody></table>
        <div class="pay-adj">
          <label>加給<input type="number" data-adj="bonus" value="${c.adj.bonus || ""}" placeholder="0"></label>
          <label>扣款<input type="number" data-adj="deduct" value="${c.adj.deduct || ""}" placeholder="0"></label>
          <label class="grow">備註<input data-adj="note" value="${esc(c.adj.note || "")}" placeholder="例：交通補貼、獎金"></label>
        </div>
        ${pay.conf[c.u.id]?.status === "issue" ? `<div class="pay-issue"><b>員工回報有問題</b>${Object.values(pay.conf[c.u.id].issues || {}).sort((a, b) => a.date.localeCompare(b.date)).map(i => `<div>・${dayLabel(i.date)} ${esc(i.name)}：${esc(i.note)}</div>`).join("")}${pay.conf[c.u.id].note ? `<div>・${esc(pay.conf[c.u.id].note)}</div>` : ""}</div>` : ""}
        ${pay.slips[c.u.id] ? `<div class="pay-pubrow">已發布 ${money(pay.slips[c.u.id].total)}・${fmtTs(pay.slips[c.u.id].publishedAt)}<button class="btn small danger" data-unpub>取消發布</button></div>` : ""}
        <div class="inst-head">每堂明細 <span>（可手動改狀態，例如補請假）</span></div>
        <div class="inst-list">${inst.map(it => `<div class="inst">
          <span class="inst-date">${dayLabel(it.date)}</span>
          <span class="dot" style="background:${esc(it.s?.color || "#9aa0a6")}"></span><span class="inst-name">${esc(it.name)}</span>
          <span class="inst-punch">${it.hasIn ? "上✓" : "上✗"} ${it.hasOut ? "下✓" : "下✗"}</span>
          ${(() => { const is = pay.conf[c.u.id]?.issues?.[`${it.date}_${it.sid || it.name}`]; return is ? `<span class="inst-issue" title="${esc(is.note)}">❗ ${esc(is.note)}</span>` : ""; })()}
          <select data-ov="${esc(it.key)}" class="st-${it.st}">${Object.entries(ST).map(([k, v]) => `<option value="${k}" ${it.st === k ? "selected" : ""}>${v}${it.auto === k ? "（系統）" : ""}</option>`).join("")}</select>
        </div>`).join("") || `<p class="empty">沒有符合的紀錄</p>`}</div>
      </div>`;
    }
    return `<div class="card pay-card ${open ? "open" : ""}" data-eid="${c.u.id}">
      <div class="pay-head" data-toggle>
        <div class="ph-name"><b>${esc(c.u.name)}</b><span>${esc(c.u.empNo || "")}・計薪 ${c.paidN} 堂</span></div>
        <div class="ph-tags">${tags}</div>
        <div class="ph-total">${money(c.total)}${c.adj.bonus || c.adj.deduct ? `<small>課堂 ${money(c.base)}</small>` : ""}</div>
        <span class="chev"></span>
      </div>${detail}
    </div>`;
  }).join("") || `<div class="card empty-card">沒有符合的人員</div>`;
}

let payCfgTimer = null;
function savePayCfg(patch) {
  Object.assign(pay.cfg, patch);
  clearTimeout(payCfgTimer);
  payCfgTimer = setTimeout(() => setDoc(doc(db, "payroll", pay.month), pay.cfg, { merge: true })
    .catch(err => toast("儲存失敗：" + errMsg(err) + "（請確認 firestore.rules 已更新）")), 500);
}

$("#payTab").onclick = e => { const b = e.target.closest("button[data-v]"); if (b) { pay.tab = b.dataset.v; loadPayroll(); } };
$("#payMonth").onchange = () => { pay.open.clear(); loadPayroll(); };
$("#payStatus").onchange = renderPayroll;
$("#payForgot").onchange = e => { savePayCfg({ payForgot: e.target.checked }); renderPayroll(); };
$("#payMissing").onchange = e => { savePayCfg({ payMissing: e.target.checked }); renderPayroll(); };
$("#payEmps").onclick = e => {
  const b = e.target.closest(".emp-chip");
  if (!b) return;
  const set = new Set(selectedEmps().map(u => u.id));
  set.has(b.dataset.eid) ? set.delete(b.dataset.eid) : set.add(b.dataset.eid);
  savePayCfg({ empIds: [...set] });
  renderPayEmps(); renderPayroll();
};
$("#payEmpAll").onclick = () => { savePayCfg({ empIds: activeEmployees().map(u => u.id) }); renderPayEmps(); renderPayroll(); };
$("#payEmpNone").onclick = () => { savePayCfg({ empIds: [] }); renderPayEmps(); renderPayroll(); };
$("#payList").onclick = e => {
  if (!e.target.closest("[data-toggle]")) return;
  const id = e.target.closest(".pay-card").dataset.eid;
  pay.open.has(id) ? pay.open.delete(id) : pay.open.add(id);
  renderPayroll();
};
$("#payList").onchange = e => {
  const card = e.target.closest(".pay-card");
  if (e.target.dataset.ov) {
    const it = pay.items.find(x => x.key === e.target.dataset.ov);
    const ov = { ...pay.cfg.overrides };
    if (e.target.value === it.auto) delete ov[it.key]; else ov[it.key] = e.target.value;
    it.st = e.target.value;
    savePayCfg({ overrides: ov });
    renderPayroll();
  } else if (e.target.dataset.adj) {
    const id = card.dataset.eid;
    const adjust = { ...pay.cfg.adjust, [id]: { ...(pay.cfg.adjust[id] || {}), [e.target.dataset.adj]: e.target.type === "number" ? (+e.target.value || 0) : e.target.value } };
    savePayCfg({ adjust });
    renderPayroll();
  }
};

const fmtTs = t => { const d = t?.toDate ? t.toDate() : t ? new Date(t) : null; return d ? `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}` : ""; };
function payStateTags(c) {
  const cf = pay.conf?.[c.u.id], sl = pay.slips?.[c.u.id];
  const conf = cf?.status === "ok" ? `<span class="tag ok">員工已確認</span>` : cf?.status === "issue" ? `<span class="tag bad">員工回報 ${Object.keys(cf.issues || {}).length || 1} 堂有問題</span>` : `<span class="tag muted">員工未確認</span>`;
  const pub = !sl ? "" : Math.round(sl.total) === Math.round(c.total) ? `<span class="tag ok">已發布</span>` : `<span class="tag warn">已改動，需重新發布</span>`;
  return conf + pub;
}
function slipOf(c) {
  return {
    empId: c.u.id, name: c.u.name || "", empNo: c.u.empNo || "", month: pay.month,
    total: c.total, base: c.base, bonus: +c.adj.bonus || 0, deduct: +c.adj.deduct || 0, note: c.adj.note || "",
    groups: c.groups.filter(g => g.paidN || g.n.ok || g.n.forgot || g.n.missing).map(g => ({ name: g.name, paidN: g.paidN, rate: g.rate, sub: g.sub })),
    items: c.list.map(it => ({ key: `${it.date}_${it.sid || it.name}`, date: it.date, name: it.name, st: it.st, paid: paid(it.st) })),
    publishedAt: serverTimestamp(), publishedBy: me.name, notifyEmp: "todo", seenByEmp: false
  };
}
$("#payPublish").onclick = async () => {
  const rows = selectedEmps().map(calcEmp);
  if (!rows.length) return toast("沒有計薪人員");
  const [y, m] = pay.month.split("-");
  const noConf = rows.filter(c => pay.conf?.[c.u.id]?.status !== "ok").length;
  const issue = rows.filter(c => pay.conf?.[c.u.id]?.status === "issue").map(c => c.u.name);
  const msg = `${y}年${+m}月・${rows.length} 人・合計 ${money(rows.reduce((a, c) => a + c.total, 0))}`
    + (issue.length ? `\n\n⚠️ 有疑問未處理：${issue.join("、")}` : "")
    + (noConf ? `\n${noConf} 人還沒確認打卡明細` : "")
    + `\n\n發布後員工會在「我的薪資」看到，並收到 LINE 通知。已發布的會用最新金額覆蓋。`;
  if (!(await appConfirm("發布薪資", msg, { okText: "發布" }))) return;
  try {
    const batch = writeBatch(db);
    rows.forEach(c => batch.set(doc(db, "payslips", `${pay.month}_${c.u.id}`), slipOf(c)));
    await batch.commit();
    toast(`已發布 ${rows.length} 人的薪資`);
    loadPayroll();
  } catch (err) { appAlert("發布失敗", errMsg(err) + "\n請確認 firestore.rules 已更新。"); }
};
$("#payList").addEventListener("click", async e => {
  if (!e.target.closest("[data-unpub]")) return;
  const id = e.target.closest(".pay-card").dataset.eid;
  if (!(await appConfirm("取消發布", "員工將看不到這個月的薪資（顯示未結算）。", { okText: "取消發布", danger: true }))) return;
  try { await deleteDoc(doc(db, "payslips", `${pay.month}_${id}`)); toast("已取消發布"); loadPayroll(); }
  catch (err) { toast("失敗：" + errMsg(err)); }
});

/* ================= 我的薪資（員工） ================= */
const MP_ST = { ok: ["ok", "正常"], forgot: ["warn", "忘記打卡"], missing: ["bad", "未打卡"], leave: ["", "請假"], absent: ["", "未上班"], future: ["muted", "未到"] };
let mp = { month: null };
async function loadMyPay() {
  const month = $("#mpMonth").value;
  mp.month = month;
  // 本月（還沒結束）的打卡明細要到下個月 1 號才開放核對
  if (month >= ym(new Date())) {
    const [y, m] = month.split("-").map(Number);
    const open = new Date(y, m, 1);
    $("#mpPay").innerHTML = `<div class="mp-head"><span>${y}年${m}月 薪資</span><span class="tag muted">未結算</span></div>
      <div class="mp-total none">未結算薪資</div>
      <p class="hint" style="margin:6px 0 0">${m} 月還沒結束，打卡明細將於 <b>${open.getMonth() + 1}/${open.getDate()}</b> 開放核對。</p>`;
    $("#mpConfirm").innerHTML = `<button class="btn mp-okbtn" id="mpPrevBtn">查看上個月的薪資與明細</button>`;
    $("#mpListTitle").textContent = ""; $("#mpList").innerHTML = "";
    $("#mpList").classList.add("hidden");
    return;
  }
  $("#mpList").classList.remove("hidden");
  $("#mpPay").innerHTML = `<p class="hint" style="margin:0">讀取中…</p>`;
  const [att, sch, slip, conf] = await Promise.all([
    getDocs(query(collection(db, "attendance"), where("empId", "==", me.id), where("month", "==", month))),
    getDocs(query(collection(db, "schedules"), where("empId", "==", me.id), where("month", "==", month))),
    getDoc(doc(db, "payslips", `${month}_${me.id}`)).catch(() => null),
    getDoc(doc(db, "payConfirm", `${month}_${me.id}`)).catch(() => null)
  ]);
  if (month !== mp.month) return;
  const recs = att.docs.map(toRec);
  const byKey = {};
  recs.forEach(r => (byKey[`${r.date}_${r.shiftId || r.shiftName || ""}`] ??= []).push(r));
  const today = ymd(new Date()), items = [], seen = new Set();
  sch.forEach(d => {
    const x = d.data();
    (x.shiftIds || []).forEach(sid => {
      const k = `${x.date}_${sid}`; seen.add(k);
      items.push({ key: k, date: x.date, sid, s: shiftMap[sid], recs: byKey[k] || [], leave: x.leave?.[sid] });
    });
  });
  Object.entries(byKey).forEach(([k, list]) => { if (!seen.has(k)) items.push({ key: k, date: list[0].date, sid: list[0].shiftId, s: shiftMap[list[0].shiftId], sname: list[0].shiftName, recs: list }); });
  mp.slip = slip?.exists() ? slip.data() : null;
  mp.conf = conf?.exists() ? conf.data() : null;
  const slipSt = Object.fromEntries((mp.slip?.items || []).map(i => [i.key, i.st]));
  mp.items = items.map(it => {
    const ins = it.recs.filter(r => r.type === "in").sort((a, b) => a.t - b.t), outs = it.recs.filter(r => r.type === "out").sort((a, b) => b.t - a.t);
    const auto = it.leave || it.s?.cat === "leave" ? "leave" : ins.length && outs.length ? "ok" : ins.length || outs.length ? "forgot" : it.date < today ? "missing" : "future";
    return { ...it, name: it.s?.name || it.sname || "未指定班別", inT: ins[0] ? hm(ins[0].t) : "", outT: outs[0] ? hm(outs[0].t) : "", st: slipSt[it.key] || auto };
  }).sort((a, b) => a.date.localeCompare(b.date) || (a.s?.start || "").localeCompare(b.s?.start || ""));
  renderMyPay();
}
function renderMyPay() {
  const [y, m] = mp.month.split("-");
  const sl = mp.slip;
  $("#mpPay").innerHTML = sl ? `
    <div class="mp-head"><span>${y}年${+m}月 薪資</span><span class="tag ok">已結算</span></div>
    <div class="mp-total">${money(sl.total)}</div>
    <table class="mp-tbl"><thead><tr><th>班別</th><th>堂數</th><th>單價</th><th>小計</th></tr></thead><tbody>
      ${(sl.groups || []).map(g => `<tr><td>${esc(g.name)}</td><td>${g.paidN}</td><td>${g.rate ? money(g.rate) : "—"}</td><td>${money(g.sub)}</td></tr>`).join("")}
      ${sl.bonus ? `<tr class="adj"><td colspan="3">加給${sl.note ? `（${esc(sl.note)}）` : ""}</td><td>+${money(sl.bonus)}</td></tr>` : ""}
      ${sl.deduct ? `<tr class="adj"><td colspan="3">扣款${!sl.bonus && sl.note ? `（${esc(sl.note)}）` : ""}</td><td>−${money(sl.deduct)}</td></tr>` : ""}
    </tbody></table>
    <div class="mp-foot">發布時間 ${fmtTs(sl.publishedAt)}</div>
    <button class="btn mp-slipbtn" id="mpSlipBtn">下載薪資條</button>` : `
    <div class="mp-head"><span>${y}年${+m}月 薪資</span><span class="tag muted">未結算</span></div>
    <div class="mp-total none">未結算薪資</div>
    <p class="hint" style="margin:6px 0 0">請先核對下方打卡明細並按「確認無誤」，管理者結算發布後會顯示金額。</p>`;
  const cf = mp.conf;
  const n = st => mp.items.filter(i => i.st === st).length;
  $("#mpConfirm").innerHTML = `
    <div class="mp-stats"><span><b>${mp.items.filter(i => i.st !== "future").length}</b>堂</span><span><b>${n("ok")}</b>正常</span>
      <span class="${n("forgot") ? "o" : ""}"><b>${n("forgot")}</b>忘記打卡</span><span class="${n("missing") ? "r" : ""}"><b>${n("missing")}</b>未打卡</span><span><b>${n("leave")}</b>請假</span></div>
    ${cf?.status === "ok" ? `<div class="mp-cf ok">✅ 你已在 ${fmtTs(cf.at)} 確認打卡明細無誤</div>`
      : cf?.status === "issue" ? `<div class="mp-cf bad">❗ 已回報 ${Object.keys(cf.issues || {}).length || 1} 堂有問題，等管理者確認${cf.note ? `<br>${esc(cf.note)}` : ""}</div><button class="btn mp-okbtn" data-mp="ok">問題已解決，確認無誤</button>`
      : `<button class="btn primary mp-okbtn" data-mp="ok">確認無誤</button>`}
    <p class="hint mp-tip">有問題？直接點下方<b>有問題的那一堂</b>回報</p>`;
  $("#mpListTitle").textContent = `打卡明細（${mp.items.length} 堂）`;
  const iss = mp.conf?.issues || {};
  $("#mpList").innerHTML = mp.items.map(it => {
    const [cls, txt] = MP_ST[it.st] || ["", it.st];
    const is = iss[it.key];
    return `<div class="mp-row ${it.st === "future" ? "fut" : ""} ${is ? "issue" : ""}" data-key="${esc(it.key)}">
      <span class="mp-date">${dayLabel(it.date)}</span>
      <span class="mp-name"><i class="dot" style="background:${esc(it.s?.color || "#9aa0a6")}"></i>${esc(it.name)}</span>
      <span class="mp-t">${it.st === "leave" ? "—" : `${it.inT || "--:--"} → ${it.outT || "--:--"}`}</span>
      <span class="tag ${is ? "bad" : cls}">${is ? "已回報" : txt}</span>
      ${is ? `<div class="mp-issue">❗ ${esc(is.note)}</div>` : ""}</div>`;
  }).join("") || `<p class="empty" style="padding:16px">這個月沒有排班或打卡紀錄</p>`;
}
$("#mpMonth").onchange = () => loadMyPay();
$("#mpPay").onclick = async e => {
  if (e.target.id !== "mpSlipBtn" || !mp.slip) return;
  const sl = mp.slip, n = st => mp.items.filter(i => i.st === st).length;
  const cv = await drawPayslip({ ...sl, name: sl.name || me.name, empNo: sl.empNo || me.empNo, stats: { ok: n("ok"), forgot: n("forgot"), missing: n("missing"), leave: n("leave") }, date: sl.publishedAt?.toDate?.() || new Date() });
  showSlip(cv, `薪資條_${sl.month}_${sl.name || me.name}.png`);
};

/* ================= 薪資條圖片 ================= */
let slipLogo = null;
const loadSlipLogo = () => slipLogo ??= new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = "logo-wide.png?v=1"; });
let slipFontReady = null;
function loadSlipFont() {
  return slipFontReady ??= new Promise(res => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@900&text=" + encodeURIComponent("野馬溜冰隊印");
    l.onload = () => document.fonts.load('900 80px "Noto Serif TC"', "野馬溜冰隊印").then(res, res);
    l.onerror = res;
    document.head.appendChild(l);
    setTimeout(res, 4000);
  });
}
// 官印：野馬溜冰隊印（由右至左、由上而下）
function drawSeal(ctx, cx, cy, size) {
  const red = "#c8102e";
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(-0.07);
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = red; ctx.fillStyle = red;
  const h = size / 2, r = size * 0.06;
  ctx.lineWidth = size * 0.065;
  ctx.beginPath(); ctx.roundRect(-h, -h, size, size, r); ctx.stroke();
  ctx.lineWidth = size * 0.015;
  ctx.beginPath(); ctx.roundRect(-h + size * 0.075, -h + size * 0.075, size * 0.85, size * 0.85, r * 0.6); ctx.stroke();
  const cols = [["野", "馬"], ["溜", "冰"], ["隊", "印"]];
  const fs = size * 0.31;
  ctx.font = `900 ${fs}px "Noto Serif TC","Songti TC","PMingLiU",serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const cw = size * 0.85 / 3;
  cols.forEach((col, i) => {
    const x = h - size * 0.075 - cw * (i + 0.5);
    col.forEach((ch, j) => {
      const y = -h + size * 0.075 + size * 0.85 * (j === 0 ? 0.27 : 0.73);
      ctx.save(); ctx.translate(x, y); ctx.scale(0.86, 1.18); ctx.fillText(ch, 0, 0); ctx.restore();
    });
  });
  // 蓋印的斑駁感
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 1;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 260; i++) {
    const x = (rnd() - 0.5) * size, y = (rnd() - 0.5) * size, rr = rnd() * size * 0.012 + 0.6;
    ctx.globalAlpha = rnd() * 0.7;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fill();
  }
  ctx.restore();
}
async function drawPayslip(d) {
  await loadSlipFont();
  const W = 1080, P = 72, F = '-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif';
  const groups = (d.groups || []).filter(g => g.paidN || g.sub);
  const adjRows = (d.bonus ? 1 : 0) + (d.deduct ? 1 : 0);
  const H = 1010 + groups.length * 64 + adjRows * 64 + (d.note ? 60 : 0);
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  c.fillStyle = "#ffffff"; c.fillRect(0, 0, W, H);
  // 頁首
  c.fillStyle = "#c8102e"; c.fillRect(0, 0, W, 14);
  const [y, m] = String(d.month).split("-");
  c.fillStyle = "#1d1d1f"; c.font = `700 52px ${F}`; c.textBaseline = "alphabetic";
  c.fillText("野馬溜冰隊　薪資條", P, 120);
  c.fillStyle = "#86868b"; c.font = `500 30px ${F}`;
  c.fillText(`${y} 年 ${+m} 月`, P, 170);
  // 員工
  c.fillStyle = "#f5f5f7"; c.beginPath(); c.roundRect(P, 210, W - P * 2, 110, 20); c.fill();
  c.fillStyle = "#1d1d1f"; c.font = `700 40px ${F}`; c.fillText(d.name || "", P + 32, 278);
  // 表格
  let yy = 390;
  const col = [P, W - P - 430, W - P - 230, W - P];
  c.fillStyle = "#86868b"; c.font = `600 26px ${F}`;
  c.fillText("班別", col[0], yy);
  c.textAlign = "right"; c.fillText("堂數", col[1] + 60, yy); c.fillText("單價", col[2] + 40, yy); c.fillText("小計", col[3], yy); c.textAlign = "left";
  yy += 22; c.fillStyle = "#d2d2d7"; c.fillRect(P, yy, W - P * 2, 2); yy += 50;
  const row = (name, n, rate, sub, color = "#1d1d1f") => {
    c.fillStyle = color; c.font = `500 30px ${F}`;
    let nm = name; while (c.measureText(nm).width > col[1] - col[0] - 40 && nm.length > 1) nm = nm.slice(0, -1);
    c.fillText(nm === name ? nm : nm + "…", col[0], yy);
    c.textAlign = "right";
    c.fillText(n, col[1] + 60, yy); c.fillText(rate, col[2] + 40, yy);
    c.font = `600 30px ${F}`; c.fillText(sub, col[3], yy); c.textAlign = "left";
    yy += 20; c.fillStyle = "#f0f0f2"; c.fillRect(P, yy, W - P * 2, 2); yy += 44;
  };
  groups.forEach(g => row(g.name, String(g.paidN), g.rate ? money(g.rate) : "—", money(g.sub)));
  if (d.bonus) row("加給", "", "", "+" + money(d.bonus), "#1d7a3a");
  if (d.deduct) row("扣款", "", "", "−" + money(d.deduct), "#b42318");
  if (d.note) { c.fillStyle = "#86868b"; c.font = `500 26px ${F}`; c.fillText(`備註：${d.note}`, P, yy); yy += 60; }
  // 合計
  yy += 10;
  c.fillStyle = "#1d1d1f"; c.font = `600 32px ${F}`; c.fillText("實發金額", P, yy + 10);
  c.fillStyle = "#c8102e"; c.font = `800 64px ${F}`; c.textAlign = "right"; c.fillText(money(d.total || 0), W - P, yy + 18); c.textAlign = "left";
  yy += 80;
  // 出勤摘要
  const st = d.stats;
  if (st) {
    const items = [["正常", st.ok], ["忘記打卡", st.forgot], ["未打卡", st.missing], ["請假", st.leave]];
    const bw = (W - P * 2 - 36) / 4;
    items.forEach(([t, v], i) => {
      const x = P + i * (bw + 12);
      c.fillStyle = "#f5f5f7"; c.beginPath(); c.roundRect(x, yy, bw, 100, 16); c.fill();
      c.textAlign = "center"; c.fillStyle = "#1d1d1f"; c.font = `700 36px ${F}`; c.fillText(String(v ?? 0), x + bw / 2, yy + 50);
      c.fillStyle = "#86868b"; c.font = `500 22px ${F}`; c.fillText(t, x + bw / 2, yy + 82); c.textAlign = "left";
    });
    yy += 130;
  }
  // 頁尾＋官印
  const dt = d.date instanceof Date ? d.date : new Date();
  c.fillStyle = "#86868b"; c.font = `500 24px ${F}`;
  c.fillText(`發放單位：野馬溜冰隊`, P, H - 110);
  c.fillText(`製表日期：${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`, P, H - 70);
  const logo = await loadSlipLogo();
  if (logo) { const lw = 400, lh = lw * logo.height / logo.width; c.drawImage(logo, W - P - lw, H - 60 - lh, lw, lh); }
  else drawSeal(c, W - P - 100, H - 140, 180);
  return cv;
}
let slipCur = null;
function showSlip(cv, filename) {
  slipCur = { url: cv.toDataURL("image/png"), filename };
  $("#slipImg").src = slipCur.url;
  $("#slipModal").classList.remove("hidden");
  requestAnimationFrame(() => $("#slipModal").classList.add("open"));
}
function downloadUrl(url, filename) { const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); }
$("#slipDl").onclick = () => slipCur && downloadUrl(slipCur.url, slipCur.filename);
$("#slipModal").onclick = e => { if (e.target.id === "slipModal" || e.target.closest("[data-close]")) { $("#slipModal").classList.remove("open"); setTimeout(() => $("#slipModal").classList.add("hidden"), 200); } };

// 管理者：一鍵下載所有人的薪資條（ZIP）
let jszipReady = null;
const loadJSZip = () => jszipReady ??= new Promise((res, rej) => {
  if (window.JSZip) return res();
  const sc = document.createElement("script");
  sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  sc.onload = res; sc.onerror = () => { jszipReady = null; rej(new Error("壓縮工具載入失敗")); };
  document.head.appendChild(sc);
});
$("#paySlipsBtn").onclick = async () => {
  const rows = selectedEmps().map(calcEmp).filter(c => c.paidN || c.total);
  if (!rows.length) return toast("沒有可下載的薪資");
  const unpub = rows.filter(c => !pay.slips?.[c.u.id]).length;
  if (unpub && !(await appConfirm("下載薪資條", `${unpub} 人還沒發布，會用目前畫面上的金額產生。`, { okText: "繼續下載" }))) return;
  const btn = $("#paySlipsBtn"); btn.disabled = true;
  try {
    await loadJSZip();
    const zip = new JSZip();
    for (let i = 0; i < rows.length; i++) {
      const cnt = rows[i];
      btn.textContent = `產生中 ${i + 1}/${rows.length}`;
      const cv = await drawPayslip({ name: cnt.u.name, empNo: cnt.u.empNo, month: pay.month, groups: cnt.groups, bonus: +cnt.adj.bonus || 0, deduct: +cnt.adj.deduct || 0, note: cnt.adj.note || "",
        total: cnt.total, stats: { ok: cnt.ok, forgot: cnt.forgot, missing: cnt.missing, leave: cnt.leave }, date: new Date() });
      const blob = await new Promise(r => cv.toBlob(r, "image/png"));
      zip.file(`${cnt.u.empNo || ""}_${cnt.u.name}_${pay.month}.png`.replace(/[\\/:*?"<>|]/g, ""), blob);
    }
    const out = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(out);
    downloadUrl(url, `薪資條_${pay.month}.zip`);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`已下載 ${rows.length} 張薪資條`);
  } catch (err) { appAlert("下載失敗", errMsg(err)); }
  finally { btn.disabled = false; btn.textContent = "下載薪資條"; }
};
async function saveMpConf(status, issues) {
  await setDoc(doc(db, "payConfirm", `${mp.month}_${me.id}`), { empId: me.id, name: me.name, month: mp.month, status, issues, note: "", at: serverTimestamp() });
}
$("#mpList").onclick = async e => {
  const row = e.target.closest(".mp-row"); if (!row) return;
  const it = mp.items.find(x => x.key === row.dataset.key); if (!it) return;
  const issues = { ...(mp.conf?.issues || {}) };
  const cur = issues[it.key];
  const res = await appDialog({ title: "這堂有問題", message: `${dayLabel(it.date)}　${it.name}\n打卡：${it.inT || "--:--"} → ${it.outT || "--:--"}（${MP_ST[it.st]?.[1] || ""}）`,
    input: { type: "text", placeholder: "例：有上班但忘了打下班卡、實際 16:00–17:30", value: cur?.note || "" },
    buttons: cur ? [{ text: "更新說明", value: true, style: "primary" }, { text: "取消回報", value: "del", style: "danger" }, { text: "關閉", value: false }]
      : [{ text: "取消", value: false }, { text: "回報", value: true, style: "primary" }] });
  if (res === false) return;
  if (res === "del") delete issues[it.key];
  else { if (!String(res).trim()) return toast("請寫一下哪裡有問題"); issues[it.key] = { date: it.date, name: it.name, sid: it.sid || "", note: String(res).trim() }; }
  try {
    await saveMpConf(Object.keys(issues).length ? "issue" : "none", issues);
    toast(res === "del" ? "已取消回報" : "已回報，管理者會幫你確認");
    loadMyPay();
  } catch (err) { appAlert("送出失敗", errMsg(err) + (err.code === "permission-denied" ? "\n請管理者更新 firestore.rules。" : "")); }
};
$("#mpConfirm").onclick = async e => {
  if (e.target.id === "mpPrevBtn") { $("#mpMonth").value = prevMonth(mp.month); return loadMyPay(); }
  const b = e.target.closest("[data-mp]"); if (!b) return;
  const n = Object.keys(mp.conf?.issues || {}).length;
  if (n && !(await appConfirm("確認無誤", `你有 ${n} 堂回報過問題，確認無誤會把這些回報清掉。`, { okText: "確認無誤" }))) return;
  try { await saveMpConf("ok", {}); toast("已確認無誤"); loadMyPay(); }
  catch (err) { appAlert("送出失敗", errMsg(err) + (err.code === "permission-denied" ? "\n請管理者更新 firestore.rules。" : "")); }
};

$("#payCsv").onclick = () => {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["員編", "姓名", "班別", "正常", "忘記打卡", "未打卡", "請假/未上班", "計薪次數", "單價", "小計"].map(q).join(",")];
  selectedEmps().map(calcEmp).forEach(c => {
    c.groups.forEach(g => lines.push([c.u.empNo, c.u.name, g.name, g.n.ok, g.n.forgot, g.n.missing, (g.n.leave || 0) + (g.n.absent || 0), g.paidN, g.rate, g.sub].map(q).join(",")));
    if (c.adj.bonus) lines.push([c.u.empNo, c.u.name, "加給", "", "", "", "", "", "", c.adj.bonus].map(q).join(","));
    if (c.adj.deduct) lines.push([c.u.empNo, c.u.name, "扣款", "", "", "", "", "", "", -c.adj.deduct].map(q).join(","));
    lines.push([c.u.empNo, c.u.name, "合計" + (c.adj.note ? `（${c.adj.note}）` : ""), c.ok, c.forgot, c.missing, c.leave, c.paidN, "", c.total].map(q).join(","));
  });
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `薪資_${pay.month}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---- 薪資標準（單價表）----
let rateUI = { mode: "emp", sel: null, dirty: false };
const rateShifts = () => shiftTypes.filter(s => s.cat !== "leave");
function setRate(eid, sid, v) {
  v = +v || 0;
  if (v > 0) (pay.rates[eid] ??= {})[sid] = v; else if (pay.rates[eid]) delete pay.rates[eid][sid];
  rateUI.dirty = true; $("#rateSave").textContent = "儲存變更"; $("#rateSave").classList.add("pulse");
}
function renderRates() { if (!isMob()) return renderRatesDesk(); renderRatePick(); renderRateList(); }
// 電腦版：原本的「班別 × 人員」表格
function renderRatesDesk() {
  const cntS = id => Object.values(pay.rates).filter(r => +r?.[id] > 0).length;
  const cntE = id => Object.values(pay.rates[id] || {}).filter(v => +v > 0).length;
  const emps = activeEmployees().map((u, i) => ({ u, i, n: cntE(u.id) })).sort((a, b) => (b.n > 0) - (a.n > 0) || a.i - b.i).map(x => x.u);
  const shifts = rateShifts().map((s, i) => ({ s, i, n: cntS(s.id) })).sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.s);
  $("#rateTbl").innerHTML = `<thead><tr><th class="rc">班別</th>${emps.map(u => `<th>${esc(u.name)}<small>${esc(u.empNo || "")}</small></th>`).join("")}</tr></thead>
    <tbody>${shifts.map(s => `<tr><th class="rc"><span class="dot" style="background:${esc(s.color)}"></span>${esc(s.name)}</th>${emps.map(u =>
      `<td><input type="number" min="0" step="50" data-e="${u.id}" data-s="${s.id}" value="${pay.rates[u.id]?.[s.id] || ""}"></td>`).join("")}</tr>`).join("")}</tbody>`;
}
function renderRatePick() {
  const emp = rateUI.mode === "emp";
  setSeg("#rateMode", rateUI.mode);
  const q = $("#rateSearch").value.trim().toLowerCase();
  const cntE = id => Object.values(pay.rates[id] || {}).filter(v => +v > 0).length;
  const cntS = id => Object.values(pay.rates).filter(r => +r?.[id] > 0).length;
  const items = emp
    ? activeEmployees().map(u => ({ id: u.id, name: u.name, sub: u.empNo || "", n: cntE(u.id) }))
    : rateShifts().map(s => ({ id: s.id, name: s.name, color: s.color, n: cntS(s.id) }));
  if (!items.some(x => x.id === rateUI.sel)) rateUI.sel = (items.find(x => x.n) || items[0])?.id || null;
  $("#ratePick").innerHTML = items.filter(x => !q || x.name.toLowerCase().includes(q)).map(x =>
    `<button class="emp-chip ${x.id === rateUI.sel ? "on" : ""}" data-id="${x.id}">${x.color ? `<i class="dot" style="background:${esc(x.color)}"></i>` : ""}${esc(x.name)}<small>${x.n ? (emp ? `${x.n} 個班` : `${x.n} 人`) : "未設定"}</small></button>`).join("")
    || `<p class="hint" style="margin:0">找不到</p>`;
}
function renderRateList() {
  const emp = rateUI.mode === "emp", sel = rateUI.sel;
  if (!sel) { $("#rateTools").innerHTML = ""; $("#rateList").innerHTML = `<p class="empty">請先建立${emp ? "員工" : "班別"}</p>`; return; }
  if (emp) {
    const u = employees.find(x => x.id === sel);
    const others = activeEmployees().filter(x => x.id !== sel && Object.keys(pay.rates[x.id] || {}).length);
    $("#rateTools").innerHTML = `<div class="rt-title"><b>${esc(u?.name || "")}</b> 的每堂單價</div>
      <div class="rt-acts"><select id="rateCopyFrom"><option value="">從別人複製單價…</option>${others.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></div>`;
    const list = rateShifts().map((s, i) => ({ s, i, v: pay.rates[sel]?.[s.id] || "" })).sort((a, b) => (!!b.v - !!a.v) || a.i - b.i);
    $("#rateList").innerHTML = list.map(({ s, v }) => `<label class="rate-row ${v ? "" : "empty"}">
      <i class="dot" style="background:${esc(s.color)}"></i><span class="rr-name">${esc(s.name)}<small>${s.start && s.end ? `${s.start}–${s.end}` : ""}</small></span>
      <span class="rr-in">$<input type="number" inputmode="numeric" min="0" step="50" data-e="${sel}" data-s="${s.id}" value="${v}" placeholder="0"></span></label>`).join("");
  } else {
    const s = shiftMap[sel];
    $("#rateTools").innerHTML = `<div class="rt-title"><i class="dot" style="background:${esc(s?.color)}"></i><b>${esc(s?.name || "")}</b> 每個人的單價</div>
      <div class="rt-acts"><input type="number" inputmode="numeric" id="rateFillV" placeholder="金額"><button class="btn small" id="rateFillAll">全部人填這個價錢</button></div>`;
    const list = activeEmployees().map((u, i) => ({ u, i, v: pay.rates[u.id]?.[sel] || "" })).sort((a, b) => (!!b.v - !!a.v) || a.i - b.i);
    $("#rateList").innerHTML = list.map(({ u, v }) => `<label class="rate-row ${v ? "" : "empty"}">
      <span class="rr-name">${esc(u.name)}<small>${esc(u.empNo || "")}</small></span>
      <span class="rr-in">$<input type="number" inputmode="numeric" min="0" step="50" data-e="${u.id}" data-s="${sel}" value="${v}" placeholder="0"></span></label>`).join("");
  }
}
$("#rateTbl").oninput = e => { const i = e.target.closest("input[data-e]"); if (i) setRate(i.dataset.e, i.dataset.s, i.value); };
$("#rateMode").onclick = e => { const b = e.target.closest("button[data-v]"); if (!b) return; rateUI.mode = b.dataset.v; rateUI.sel = null; renderRates(); };
$("#rateSearch").oninput = renderRates;
$("#ratePick").onclick = e => { const b = e.target.closest(".emp-chip[data-id]"); if (!b) return; rateUI.sel = b.dataset.id; renderRates(); };
$("#rateList").oninput = e => { const i = e.target.closest("input[data-e]"); if (!i) return; setRate(i.dataset.e, i.dataset.s, i.value); i.closest(".rate-row").classList.toggle("empty", !(+i.value > 0)); };
$("#rateList").onchange = () => renderRatePick();
$("#rateTools").onchange = e => {
  if (e.target.id !== "rateCopyFrom" || !e.target.value) return;
  const src = pay.rates[e.target.value] || {};
  Object.entries(src).forEach(([sid, v]) => setRate(rateUI.sel, sid, v));
  toast(`已複製 ${Object.keys(src).length} 個單價，記得按儲存`);
  renderRates();
};
$("#rateTools").onclick = e => {
  if (e.target.id !== "rateFillAll") return;
  const v = +$("#rateFillV").value;
  if (!(v > 0)) return toast("請先輸入金額");
  activeEmployees().forEach(u => setRate(u.id, rateUI.sel, v));
  toast(`已全部填入 $${v}，記得按儲存`);
  renderRates();
};
$("#rateSave").onclick = async () => {
  const rates = {};
  Object.entries(pay.rates).forEach(([e, m]) => Object.entries(m || {}).forEach(([sid, v]) => { if (+v > 0) (rates[e] ??= {})[sid] = +v; }));
  try {
    await setDoc(doc(db, "payRates", "all"), { rates, updatedAt: serverTimestamp() });
    pay.rates = rates;
    rateUI.dirty = false; $("#rateSave").textContent = "儲存"; $("#rateSave").classList.remove("pulse");
    toast("薪資標準已儲存");
  } catch (err) { appAlert("儲存失敗", errMsg(err) + "\n請確認 firestore.rules 已更新為最新版。"); }
};
$("#rateImportBtn").onclick = () => $("#rateXlsx").click();
$("#rateXlsx").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const XLSX = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
    const wb = XLSX.read(await file.arrayBuffer());
    const name = wb.SheetNames.find(n => n.includes("薪資標準"));
    if (!name) return appAlert("找不到工作表", "檔案中需要有「薪資標準」工作表（第一列是人名，其中一欄是班別名稱）。");
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
    // 找出人名列與班別欄
    const empBy = {}; employees.forEach(u => empBy[normName(u.name)] = u);
    let hr = rows.findIndex(r => r.filter(v => empBy[normName(v)]).length >= 3);
    if (hr < 0) return appAlert("找不到人名", "第一列需要是員工姓名。");
    const head = rows[hr];
    const cols = head.map((v, i) => ({ i, u: empBy[normName(v)] })).filter(x => x.u && x.i > 2);
    const shiftBy = {}; shiftTypes.forEach(s => shiftBy[normName(s.name)] = s);
    const loose = n => normName(n).replace(/[\d:：\-~]/g, "");
    const findShift = n => {
      if (shiftBy[normName(n)]) return shiftBy[normName(n)];
      const c = shiftTypes.filter(s => loose(s.name) === loose(n));
      return c.length === 1 ? c[0] : null;
    };
    const firstCol = Math.min(...cols.map(c => c.i));
    let n = 0; const miss = [];
    const rates = JSON.parse(JSON.stringify(pay.rates));
    rows.slice(hr + 1).forEach(r => {
      const label = [...r.slice(0, firstCol)].reverse().find(v => String(v).trim());
      if (!label) return;
      const s = findShift(label);
      if (!s) { if (cols.some(c => +r[c.i] > 0)) miss.push(String(label).trim()); return; }
      cols.forEach(c => { const v = +r[c.i]; if (v > 0) { (rates[c.u.id] ??= {})[s.id] = v; n++; } });
    });
    pay.rates = rates;
    rateUI.dirty = true; $("#rateSave").textContent = "儲存變更"; $("#rateSave").classList.add("pulse");
    renderRates();
    appAlert("已讀入單價", `讀入 ${n} 個單價（${cols.length} 位員工）。` + (miss.length ? `\n對不到的班別：${miss.join("、")}` : "") + "\n確認無誤後請按「儲存」。");
  } catch (err) { appAlert("匯入失敗", err.message || String(err)); }
};

/* ================= 匯入舊系統打卡紀錄 Excel（管理者） ================= */
// 支援「Log 紀錄」工作表（每列一次打卡），沒有的話用「打卡紀錄」工作表（每列含上下班）
function parsePunchWorkbook(XLSX, wb) {
  const pad = n => String(n).padStart(2, "0");
  const clean = v => { const t = String(v ?? "").trim(); return t === "--" ? "" : t; };
  const toDate = v => {
    if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    const m = clean(v).match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  };
  const toTime = v => { const m = clean(v).match(/^(\d{1,2}):(\d{2})/); return m ? `${pad(m[1])}:${m[2]}` : null; };
  const coord = v => {   // "GPS (121.57，25.08)" → 經度在前
    const m = clean(v).match(/(-?\d{1,3}\.\d+)\s*[，,]\s*(-?\d{1,3}\.\d+)/);
    if (!m) return null;
    let a = +m[1], b = +m[2];
    return Math.abs(a) > 90 ? { lat: b, lng: a } : { lat: a, lng: b };
  };
  const place = v => clean(v).replace(/^GPS\s*\/\s*/i, "").replace(/^GPS$/i, "");
  const sheets = wb.SheetNames.map(n => ({ n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" }) }))
    .filter(x => x.rows[0]?.includes("上班打卡時間") && x.rows[0]?.includes("下班打卡時間"));
  const pick = sheets.find(x => /log/i.test(x.n)) || sheets.find(x => !x.rows[0].includes("表定上班時間")) || sheets[0];
  if (!pick) return [];
  const H = pick.rows[0], col = name => H.indexOf(name);
  const C = {
    no: col("員工編號"), name: col("姓名"), date: col("打卡日期"), shift: col("班別"),
    inT: col("上班打卡時間"), outT: col("下班打卡時間"), note: col("紀錄備註"),
    early: col("提早上班原因"), late: col("延後下班原因"),
    inM: col("上班打卡方式"), inP: col("上班打卡地點"), inR: col("上班地點異常，不在範圍內的原因"),
    outM: col("下班打卡方式"), outP: col("下班打卡地點"), outR: col("下班地點異常，不在範圍內的原因")
  };
  const out = [];
  for (const r of pick.rows.slice(1)) {
    const date = toDate(r[C.date]);
    if (!date || !clean(r[C.name])) continue;
    const base = { empNo: clean(r[C.no]), name: clean(r[C.name]), date, shiftName: clean(r[C.shift]), note: clean(r[C.note]) };
    const add = (type, t, m, p, rs, extra) => {
      if (!t) return;
      out.push({ ...base, type, time: t, place: place(r[m]), pos: coord(r[p]), reason: clean(r[rs]), extra: clean(r[extra]) });
    };
    add("in", toTime(r[C.inT]), C.inM, C.inP, C.inR, C.early);
    add("out", toTime(r[C.outT]), C.outM, C.outP, C.outR, C.late);
  }
  return out;
}

$("#punchImportBtn").onclick = () => $("#punchXlsx").click();
$("#punchXlsx").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  toast("讀取檔案中…");
  try {
    const XLSX = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: false, raw: false });
    await importPunches(parsePunchWorkbook(XLSX, wb));
  } catch (err) {
    console.error(err);
    appAlert("匯入失敗", err.message || String(err));
  }
};

async function importPunches(list) {
  if (!list.length) return appAlert("找不到打卡紀錄", "需要有「員工編號、姓名、打卡日期、班別、上班打卡時間、下班打卡時間」欄位。");
  await Promise.all([loadEmployees(), loadShiftTypes(), loadLocations()]);
  const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
  const byNo = {}, byName = {};
  employees.forEach(u => { if (u.empNo) byNo[norm(u.empNo)] = u; byName[norm(u.name)] = u; });
  const findEmp = x => byNo[norm(x.empNo)] || byName[norm(x.name)];
  const shiftBy = {}; shiftTypes.forEach(s => shiftBy[norm(s.name)] = s);
  const locBy = {}; locations.forEach(l => locBy[norm(l.name)] = l);

  const missEmp = [...new Set(list.filter(x => !findEmp(x)).map(x => `${x.name}(${x.empNo})`))];
  const missShift = [...new Set(list.filter(x => x.shiftName && !shiftBy[norm(x.shiftName)]).map(x => x.shiftName))];
  const ok = list.filter(findEmp);
  const dates = list.map(x => x.date).sort();
  const far = ok.filter(x => x.reason).length;
  const msg = [
    `期間：${dates[0]} ~ ${dates.at(-1)}`,
    `打卡筆數：${ok.length} 筆（上班 ${ok.filter(x => x.type === "in").length}、下班 ${ok.filter(x => x.type === "out").length}）`,
    `員工：${new Set(ok.map(x => findEmp(x).id)).size} 位對應成功` + (missEmp.length ? `\n略過（系統中沒有）：${missEmp.join("、")}` : ""),
    missShift.length ? `班別對不到（仍會匯入，只記名稱）：${missShift.join("、")}` : "班別全部對應成功",
    far ? `含地點異常原因 ${far} 筆` : "",
    "",
    "同一筆紀錄重複匯入會覆蓋，不會重複。"
  ].filter(x => x !== "").join("\n");
  if (!(await appConfirm("匯入打卡紀錄", msg, { okText: "匯入" }))) return;

  toast("匯入中…");
  const hash = str => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
  let batch = writeBatch(db), n = 0, done = 0;
  try {
    for (const x of ok) {
      const u = findEmp(x);
      const s = shiftBy[norm(x.shiftName)];
      const loc = locBy[norm(x.place)];
      const t = new Date(`${x.date}T${x.time}:00`);
      let dist = null;
      if (loc && x.pos) dist = Math.round(distM(x.pos, loc));
      const id = `imp_${u.id}_${x.date}_${x.type}_${x.time.replace(":", "")}_${hash(x.shiftName)}`;
      const note = [x.extra, x.note].filter(v => v && v.trim()).join("；");
      batch.set(doc(db, "attendance", id), {
        empId: u.id, name: u.name, empNo: u.empNo || "",
        type: x.type, shiftId: s?.id || null, shiftName: x.shiftName,
        locationId: loc?.id || null, placeName: x.place || "", dist,
        date: x.date, month: x.date.slice(0, 7),
        ts: t, clientTime: t.toISOString(),
        lat: x.pos?.lat ?? null, lng: x.pos?.lng ?? null, acc: null,
        outOfRange: !!x.reason, reason: x.reason || "", note,
        imported: true, importedAt: serverTimestamp()
      });
      done++;
      if (++n >= 400) { await batch.commit(); batch = writeBatch(db); n = 0; toast(`匯入中… ${done} / ${ok.length}`); }
    }
    if (n) await batch.commit();
  } catch (err) {
    console.error(err);
    return appAlert("匯入失敗", err.code === "permission-denied"
      ? `已匯入 ${done - n} 筆後被拒絕。請先到 Firebase → Firestore → 規則，貼上最新版 firestore.rules 並發布（管理者匯入需要新規則）。`
      : (err.message || String(err)));
  }
  await appAlert("匯入完成", `已匯入 ${done} 筆打卡紀錄。`);
  $("#repMonth").value = dates[0].slice(0, 7);
  loadReport();
}

/* ================= 匯入舊班表 Excel（管理者） ================= */
// 解析舊系統匯出的班表 Excel（每週一區塊：日期列 + 員工列）
function parseRosterWorkbook(XLSX, wb) {
  const pad = n => String(n).padStart(2, "0");
  const toDate = v => {
    if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    const m = String(v || "").trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  };
  const out = { titles: {}, entries: [], shiftDefs: {} };
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    if (!rows.some(r => String(r[0]).trim() === "姓名/員編")) continue;   // 不是班表工作表
    let title = String(rows[0]?.[0] || "").trim();
    let colDate = {};
    for (const r of rows) {
      const first = String(r[0] || "").trim();
      const dates = r.map(toDate);
      if (!first && dates.some(Boolean)) {                              // 日期列
        colDate = {};
        dates.forEach((d, i) => { if (d && i > 0) colDate[i] = d; });
        continue;
      }
      const em = first.match(/^(.+?)\s*[（(]([^()（）]+)[)）]\s*$/);       // 姓名(員編)
      if (!em || first === "姓名/員編") continue;
      for (const [i, date] of Object.entries(colDate)) {
        const cell = String(r[i] || "").trim();
        if (!cell) { out.entries.push({ name: em[1].trim(), empNo: em[2].trim(), date, items: [] }); continue; }
        const items = cell.split(/,\s*|\n/).map(s => s.trim()).filter(Boolean).map(part => {
          const m = part.match(/^(.*?)\s+(\d{1,2}:\d{2})\s*[-~–]\s*(\d{1,2}:\d{2})$/);
          const it = m ? { name: m[1].trim(), start: m[2].padStart(5, "0"), end: m[3].padStart(5, "0") } : { name: part, start: "", end: "" };
          out.shiftDefs[it.name] ??= { start: it.start, end: it.end };
          return it;
        });
        out.entries.push({ name: em[1].trim(), empNo: em[2].trim(), date, items });
      }
      if (title) out.titles[Object.values(colDate)[0]?.slice(0, 7)] ??= title.replace(/\s+/g, "");
    }
  }
  return out;
}

$("#importXlsxBtn").onclick = () => $("#xlsxInput").click();
$("#xlsxInput").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  toast("讀取檔案中…");
  try {
    const XLSX = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    await importRoster(parseRosterWorkbook(XLSX, wb));
  } catch (err) {
    console.error(err);
    appAlert("匯入失敗", err.message || String(err));
  }
};

async function importRoster(r) {
  if (!r.entries.length) return appAlert("找不到班表", "這個檔案裡沒有可辨識的班表（需要有「姓名/員編」欄位與日期列）。");
  await Promise.all([loadEmployees(), loadShiftTypes()]);
  const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
  const byNo = {}, byName = {};
  employees.forEach(u => { if (u.empNo) byNo[norm(u.empNo)] = u; byName[norm(u.name)] = u; });
  const findEmp = e => byNo[norm(e.empNo)] || byName[norm(e.name)];
  const missing = [...new Map(r.entries.filter(e => !findEmp(e)).map(e => [norm(e.empNo) + norm(e.name), { name: e.name, empNo: e.empNo }])).values()];
  const shiftBy = {};
  shiftTypes.forEach(s => shiftBy[norm(s.name)] = s);
  const newShifts = Object.keys(r.shiftDefs).filter(n => !shiftBy[norm(n)]);
  const dates = r.entries.map(e => e.date).sort();
  const filled = r.entries.filter(e => e.items.length);
  const matched = new Set(r.entries.filter(findEmp).map(e => findEmp(e).id)).size;

  const msg = [
    `期間：${dates[0]} ~ ${dates.at(-1)}`,
    `員工：${matched} 位對應成功` + (missing.length ? `，${missing.length} 位系統中沒有（${missing.map(m => m.name).join("、")}）` : ""),
    `排班：${filled.length} 天次、${filled.reduce((a, e) => a + e.items.length, 0)} 個班別`,
    newShifts.length ? `將新增班別：${newShifts.join("、")}` : "班別全部對應成功",
    "",
    "檔案中這些日期已有的排班會被覆蓋。"
  ].join("\n");
  const choice = await appDialog({
    title: "匯入班表",
    message: msg,
    buttons: missing.length
      ? [{ text: "建立員工並匯入", value: "create", style: "primary" }, { text: "略過沒有的員工", value: "skip" }, { text: "取消", value: false }]
      : [{ text: "取消", value: false }, { text: "匯入", value: "go", style: "primary" }]
  });
  if (!choice) return;

  toast("匯入中…");
  // 1. 建立缺少的員工（沒有 Email，之後在員工管理補上即可綁定）
  if (choice === "create") {
    const b = writeBatch(db);
    for (const m of missing) {
      const ref = doc(collection(db, "employees"));
      const u = { name: m.name, empNo: m.empNo, email: "", role: "employee", active: true, lineUid: null, lineName: "", linePicture: "", bindFails: 0, createdAt: serverTimestamp() };
      b.set(ref, u);
      byNo[norm(m.empNo)] = { id: ref.id, ...u };
    }
    await b.commit();
  }
  // 2. 建立缺少的班別（含「假」的歸為休假）
  if (newShifts.length) {
    const b = writeBatch(db);
    let fb = 0;
    newShifts.forEach((name, i) => {
      const leave = /假|休/.test(name);
      const def = r.shiftDefs[name];
      const ref = doc(collection(db, "shiftTypes"));
      const sdoc = {
        cat: leave ? "leave" : "shift", name, code: "",
        start: leave ? "" : def.start, end: leave ? "" : def.end, breakStart: "", breakEnd: "",
        color: leave ? LEAVE_COLOR : (COLOR_RULES.find(([re]) => re.test(name)) || [, FALLBACK_COLORS[fb++ % FALLBACK_COLORS.length]])[1],
        order: Date.now() + i
      };
      b.set(ref, sdoc);
      shiftBy[norm(name)] = { id: ref.id, ...sdoc };
    });
    await b.commit();
  }
  // 3. 寫入排班
  let batch = writeBatch(db), n = 0, done = 0;
  for (const e of r.entries) {
    const u = findEmp(e);
    if (!u) continue;
    const key = `${u.id}_${e.date}`;
    const ids = [...new Set(e.items.map(it => shiftBy[norm(it.name)]?.id).filter(Boolean))];
    if (ids.length) batch.set(doc(db, "schedules", key), { empId: u.id, date: e.date, month: e.date.slice(0, 7), shiftIds: ids });
    else batch.delete(doc(db, "schedules", key));
    done++;
    if (++n >= 450) { await batch.commit(); batch = writeBatch(db); n = 0; toast(`匯入中… ${done} / ${r.entries.length}`); }
  }
  if (n) await batch.commit();
  // 4. 班表名稱
  for (const [month, title] of Object.entries(r.titles)) {
    if (month && month !== "undefined") await setDoc(doc(db, "rosters", month), { name: title }, { merge: true });
  }
  history.month = null;   // 讓推薦重新讀取歷史
  await loadShiftTypes();
  await appAlert("匯入完成", `已匯入 ${done} 筆排班資料。` + (choice === "create" && missing.length ? `\n新建立的 ${missing.length} 位員工請到「員工管理」補上 Email，才能用 LINE 綁定。` : ""));
  openRosterEditor(dates[0].slice(0, 7));
}

/* ================= 啟動 ================= */
boot();
