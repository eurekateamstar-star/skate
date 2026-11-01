import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithCustomToken, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, getDocs, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, LIFF_ID, WORKER_URL } from "./config.js?v=17";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// LINE App 內建瀏覽器用 long polling 連線，避免 Firestore 卡住
const db = initializeFirestore(app, { experimentalForceLongPolling: true });
const liff = window.liff;

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
function appDialog({ title = "", message = "", buttons = [{ text: "好", value: true, style: "primary" }], input = null }) {
  return new Promise(resolve => {
    const mask = $("#dlg");
    const inp = $("#dlgInput");
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
      resolve(input && v === true ? inp.value : v);
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
  const map = { "permission-denied": "權限不足", "unavailable": "網路連線異常" };
  return map[err.code] || err.message;
}

/* ================= 狀態 ================= */
let me = null;          // 目前登入的員工 {id, name, empNo, role, ...}
let shiftTypes = [];
let shiftMap = {};
let employees = [];     // 員工清單（管理者用）

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

async function boot() {
  loading();
  try {
    await withTimeout(liff.init({ liffId: LIFF_ID }), 15000, "LINE 初始化逾時");
  } catch (e) {
    setMsg("LINE 初始化失敗，請確認 config.js 的 LIFF_ID：" + e.message);
    return showLogin();
  }
  // 已有 Firebase 登入狀態就直接進入
  const user = await new Promise(res => { const un = onAuthStateChanged(auth, u => { un(); res(u); }); });
  if (user) {
    if (await enterApp(user)) return;
    if ($("#authMsg").textContent) return showLogin();   // 顯示失敗原因，按按鈕重試
  }
  if (liff.isLoggedIn()) return lineAuth();
  showLogin();
}

async function callWorker(path, data = {}) {
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
      ? list.map(c => `<button class="cand" data-id="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)}${c.empNo ? `<small>${esc(c.empNo)}</small>` : ""}</button>`).join("")
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

$("#lineLoginBtn").onclick = () => {
  setMsg("");
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
  if (liff.isLoggedIn() && !liff.isInClient()) liff.logout();
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

async function enterAppInner(user) {
  try {
    const { claims } = await user.getIdTokenResult();
    if (!claims.empId) { await signOut(auth); return false; }
    const snap = await getDoc(doc(db, "employees", claims.empId));
    if (!snap.exists()) { await signOut(auth); return false; }
    me = { id: snap.id, ...snap.data() };

    $("#userName").textContent = `${me.name}${me.role === "admin" ? "（管理者）" : ""}`;
    if (me.linePicture) { $("#userPic").src = me.linePicture; $("#userPic").classList.remove("hidden"); }
    $$(".admin-only").forEach(el => el.classList.toggle("hidden", me.role !== "admin"));
    await loadShiftTypes();
    $("#loginView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    showView("clock");
    return true;
  } catch (err) {
    console.error(err);
    setMsg("讀取員工資料失敗：" + errMsg(err) + "（請確認 firestore.rules 已發布）");
    await signOut(auth);   // 例如被解除綁定 → 讀取被拒
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
  report: loadReport
};
const TITLES = {
  clock: "打卡", records: "出勤紀錄", mySchedule: "我的班表", scheduling: "排班作業",
  report: "出勤報表", employees: "員工管理", shifts: "班別設定"
};
const ADMIN_VIEWS = ["scheduling", "report", "employees", "shifts"];
function showView(name) {
  $$(".view").forEach(v => v.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $$("[data-view]").forEach(a => a.classList.toggle("active", a.dataset.view === name));
  $("#moreBtn").classList.toggle("active", ADMIN_VIEWS.includes(name));
  $("#pageTitle").textContent = innerWidth <= 768 ? TITLES[name] : "打卡系統";
  closeSheet();
  scrollTo(0, 0);
  if (name === "scheduling" && !$("#view-scheduling").dataset.keep) schMode = "list";
  loaders[name]?.().catch(err => { console.error(err); toast("載入失敗：" + errMsg(err)); });
}
$$("[data-view]").forEach(a => a.onclick = () => showView(a.dataset.view));

// 手機版管理選單
function openSheet() { $("#sheetMask").classList.remove("hidden"); requestAnimationFrame(() => $("#sheet").classList.add("open")); }
function closeSheet() { $("#sheet").classList.remove("open"); $("#sheetMask").classList.add("hidden"); }
$("#moreBtn").onclick = openSheet;
$("#sheetMask").onclick = closeSheet;

// 手機版表格變卡片：自動把表頭文字填到每格的 data-label
function labelTable(tbl) {
  const heads = [...tbl.querySelectorAll("thead th")].map(th => th.textContent.trim());
  tbl.querySelectorAll("tbody tr").forEach(tr =>
    [...tr.children].forEach((td, i) => td.dataset.label ??= heads[i] || ""));
}
new MutationObserver(muts => {
  const set = new Set();
  muts.forEach(m => { const t = m.target.closest?.("table.tbl"); if (t) set.add(t); });
  set.forEach(labelTable);
}).observe(document.body, { childList: true, subtree: true });

const thisMonth = ym(new Date());
["#recMonth", "#mySchMonth", "#schMonth", "#repMonth"].forEach(s => $(s).value = thisMonth);
$("#recMonth").onchange = () => loadRecords();
$("#mySchMonth").onchange = () => loadMySchedule();
$("#schMonth").onchange = () => loadScheduling();
$("#repMonth").onchange = () => loadReport();
$("#repEmp").onchange = () => renderReport();

/* ================= 班別 ================= */
async function loadShiftTypes() {
  const snap = await getDocs(collection(db, "shiftTypes"));
  shiftTypes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  shiftMap = Object.fromEntries(shiftTypes.map(s => [s.id, s]));
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

async function loadClock() {
  const today = ymd(new Date());
  const sch = await getDoc(doc(db, "schedules", `${me.id}_${today}`));
  const ids = sch.exists() ? sch.data().shiftIds || [] : [];
  $("#todayShift").innerHTML = ids.length
    ? "今日班別：" + ids.map(id => chipHtml(id)).join("")
    : "今日無排班";
  await loadToday();
}

async function loadToday() {
  const today = ymd(new Date());
  const snap = await getDocs(query(collection(db, "attendance"),
    where("empId", "==", me.id), where("date", "==", today)));
  const list = snap.docs.map(toRec).sort((a, b) => a.t - b.t);
  $("#todayList").innerHTML = list.length ? list.map(r => `
    <tr>
      <td><span class="tag ${r.type}">${r.type === "in" ? "上班" : "下班"}</span></td>
      <td>${hms(r.t)}</td>
      <td>${mapLink(r)}</td>
    </tr>`).join("") : `<tr><td colspan="3" class="empty">今天還沒有打卡</td></tr>`;
}

const mapLink = r => r.lat != null
  ? `<a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener">查看地圖</a>`
  : "—";

function getPosition() {
  if (!$("#useGps").checked || !navigator.geolocation) return Promise.resolve(null);
  return new Promise(res => navigator.geolocation.getCurrentPosition(
    p => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }),
    () => res(null),
    { timeout: 8000, enableHighAccuracy: true }
  ));
}

async function punch(type) {
  const btns = [$("#clockIn"), $("#clockOut")];
  btns.forEach(b => b.disabled = true);
  try {
    const now = new Date();
    const pos = await getPosition();
    await addDoc(collection(db, "attendance"), {
      empId: me.id, name: me.name, empNo: me.empNo || "",
      type, date: ymd(now), month: ym(now),
      ts: serverTimestamp(), clientTime: now.toISOString(),
      lat: pos?.lat ?? null, lng: pos?.lng ?? null
    });
    navigator.vibrate?.(30);
    toast(`${type === "in" ? "上班" : "下班"}打卡成功 ${hms(now)}`);
    await loadToday();
  } catch (err) {
    console.error(err);
    toast("打卡失敗：" + errMsg(err));
  } finally {
    btns.forEach(b => b.disabled = false);
  }
}
$("#clockIn").onclick = () => punch("in");
$("#clockOut").onclick = () => punch("out");

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
async function loadRecords() {
  const month = $("#recMonth").value;
  const [attSnap, schSnap] = await Promise.all([
    getDocs(query(collection(db, "attendance"), where("empId", "==", me.id), where("month", "==", month))),
    getDocs(query(collection(db, "schedules"), where("empId", "==", me.id), where("month", "==", month)))
  ]);
  const groups = groupDaily(attSnap.docs.map(toRec));
  const sch = {};
  schSnap.forEach(d => sch[d.data().date] = d.data().shiftIds || []);

  let rows = "", days = 0, total = 0, late = 0;
  for (const d of daysOfMonth(month)) {
    const ds = ymd(d);
    const g = groups[`${me.id}_${ds}`];
    const ids = sch[ds];
    if (!g && !ids) continue;
    const st = dayStatus(g, ids, ds);
    if (g) days++;
    if (g?.hrs) total += g.hrs;
    if (st.some(s => s[1] === "遲到")) late++;
    rows += `<tr>
      <td>${dayLabel(ds)}</td>
      <td>${(ids || []).map(id => chipHtml(id)).join(" ") || "—"}</td>
      <td>${hms(g?.in) || "—"}</td>
      <td>${hms(g?.out) || "—"}</td>
      <td>${g?.hrs ? g.hrs.toFixed(2) : "—"}</td>
      <td>${statusHtml(st)}</td>
    </tr>`;
  }
  $("#recList").innerHTML = rows || `<tr><td colspan="6" class="empty">本月沒有紀錄</td></tr>`;
  $("#recSummary").innerHTML = `
    <div class="stat"><b>${days}</b>出勤天數</div>
    <div class="stat"><b>${total.toFixed(1)}</b>總工時</div>
    <div class="stat"><b>${late}</b>遲到次數</div>`;
}

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

  // 我的月曆
  const sch = {};
  snap.forEach(d => sch[d.data().date] = d.data().shiftIds || []);
  const days = daysOfMonth(month);
  const today = ymd(new Date());
  let html = [...WEEK].map(w => `<div class="hd">${w}</div>`).join("");
  html += "<div></div>".repeat(days[0].getDay());
  for (const d of days) {
    const ds = ymd(d);
    const wk = d.getDay() === 0 || d.getDay() === 6;
    html += `<div class="day ${ds === today ? "today" : ""} ${wk ? "wkend" : ""}">
      <div class="d">${d.getDate()}</div>
      ${(sch[ds] || []).map(id => chipHtml(id)).join("")}
    </div>`;
  }
  $("#myCal").innerHTML = html;

  $("#myCalWrap").classList.toggle("hidden", mySchMode !== "mine");
  $("#teamWrap").classList.toggle("hidden", mySchMode !== "all");
  if (mySchMode === "all" && pub) renderTeam(month, pub);
}

function renderTeam(month, pub) {
  const days = daysOfMonth(month);
  const today = ymd(new Date());
  const wk = d => (d.getDay() === 0 || d.getDay() === 6) ? "wkend" : "";
  const cellIds = (eid, ds) => (pub.grid?.[eid]?.[ds]) || [];
  // 電腦：表格
  let html = `<thead><tr><th class="name">姓名 / 員編</th>${days.map(d =>
    `<th class="${wk(d)}"${ymd(d) === today ? ' style="color:var(--primary)"' : ""}>${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）</th>`).join("")}</tr></thead><tbody>`;
  for (const u of pub.emps || []) {
    html += `<tr class="${u.id === me.id ? "me" : ""}"><td class="name">${esc(u.name)}<div class="emp-no">${esc(u.empNo || "")}</div></td>`;
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
  const snap = await getDocs(collection(db, "employees"));
  employees = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.empNo || "zzz").localeCompare(b.empNo || "zzz") || (a.name || "").localeCompare(b.name || ""));
}
const activeEmployees = () => employees.filter(e => e.active !== false);

async function loadEmployeesView() {
  await loadEmployees();
  $("#empList").innerHTML = employees.map(u => {
    const locked = (u.bindFails || 0) >= 5;
    const lineCell = u.lineUid
      ? `<span class="line-cell">${u.linePicture ? `<img class="avatar" src="${esc(u.linePicture)}" alt="">` : ""}${esc(u.lineName || "已綁定")}</span>`
      : locked ? `<span class="tag bad">已鎖定</span>` : `<span class="tag">未綁定</span>`;
    return `
    <tr data-id="${u.id}">
      <td><input class="e-no" value="${esc(u.empNo)}" size="6"></td>
      <td><input class="e-name" value="${esc(u.name)}" size="8"></td>
      <td><input class="e-email" type="email" value="${esc(u.email)}" size="20"></td>
      <td><select class="e-role">
        <option value="employee" ${u.role !== "admin" ? "selected" : ""}>員工</option>
        <option value="admin" ${u.role === "admin" ? "selected" : ""}>管理者</option>
      </select></td>
      <td>${lineCell}</td>
      <td><select class="e-active">
        <option value="1" ${u.active !== false ? "selected" : ""}>在職</option>
        <option value="0" ${u.active === false ? "selected" : ""}>停用</option>
      </select></td>
      <td>
        <button class="btn small primary e-save">儲存</button>
        ${u.lineUid || locked ? `<button class="btn small e-unbind">解除綁定</button>` : ""}
        ${u.id !== me.id ? `<button class="btn small danger e-del">刪除</button>` : ""}
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">尚無員工</td></tr>`;
}

$("#empForm").onsubmit = async e => {
  e.preventDefault();
  const data = {
    empNo: $("#eNo").value.trim(),
    name: $("#eName").value.trim(),
    email: $("#eEmail").value.trim().toLowerCase(),
    role: $("#eRole").value,
    active: true, lineUid: null, lineName: "", linePicture: "", bindFails: 0,
    createdAt: serverTimestamp()
  };
  if (!data.name || !data.email) return;
  if (employees.some(x => (x.email || "").toLowerCase() === data.email)) return toast("此 Email 已有員工使用");
  try {
    await addDoc(collection(db, "employees"), data);
    e.target.reset();
    toast("已新增員工");
    loadEmployeesView();
  } catch (err) { toast("新增失敗：" + errMsg(err)); }
};

$("#empList").onclick = async e => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const id = tr.dataset.id;
  const emp = employees.find(x => x.id === id);
  try {
    if (e.target.classList.contains("e-save")) {
      const data = {
        empNo: $(".e-no", tr).value.trim(),
        name: $(".e-name", tr).value.trim(),
        email: $(".e-email", tr).value.trim().toLowerCase(),
        role: $(".e-role", tr).value,
        active: $(".e-active", tr).value === "1"
      };
      if (!data.name) return toast("姓名不可空白");
      if (id === me.id && (data.role !== "admin" || !data.active)
        && !(await appConfirm("變更自己的權限", "確定要取消自己的管理者權限或停用自己？之後將無法進入管理功能。", { okText: "確定變更", danger: true }))) return;
      await updateDoc(doc(db, "employees", id), data);
      toast("已儲存");
    } else if (e.target.classList.contains("e-unbind")) {
      if (!(await appConfirm("解除 LINE 綁定", `解除「${emp.name}」的 LINE 綁定？他下次登入需要重新綁定。`, { okText: "解除綁定", danger: true }))) return;
      await updateDoc(doc(db, "employees", id), { lineUid: null, lineName: "", linePicture: "", bindFails: 0 });
      toast("已解除綁定");
      loadEmployeesView();
    } else if (e.target.classList.contains("e-del")) {
      if (!(await appConfirm("刪除員工", `刪除「${emp.name}」？打卡紀錄會保留。`, { okText: "刪除", danger: true }))) return;
      await deleteDoc(doc(db, "employees", id));
      toast("已刪除");
      loadEmployeesView();
    }
  } catch (err) { toast("操作失敗：" + errMsg(err)); }
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
async function renderShiftList() {
  await loadShiftTypes();
  $("#shiftList").innerHTML = shiftTypes.length ? shiftTypes.map(s => `
    <tr data-id="${s.id}">
      <td><input type="checkbox" class="s-chk"></td>
      <td><input class="s-code" value="${esc(s.code || "")}" size="5"></td>
      <td><select class="s-cat">
        <option value="shift" ${s.cat !== "leave" ? "selected" : ""}>班別</option>
        <option value="leave" ${s.cat === "leave" ? "selected" : ""}>休假</option>
      </select></td>
      <td><input class="s-name" value="${esc(s.name)}" size="22"></td>
      <td><input class="s-start" type="time" value="${esc(s.start || "")}"></td>
      <td><input class="s-end" type="time" value="${esc(s.end || "")}"></td>
      <td>${shiftHours(s) || "—"}${s.breakStart && s.breakEnd ? `<div class="emp-no">休息 ${esc(s.breakStart)}~${esc(s.breakEnd)}</div>` : ""}</td>
      <td><input class="s-color" type="color" value="${esc(s.color || "#2e9e3f")}"></td>
      <td>
        <button class="btn small primary s-save">儲存</button>
        <button class="btn small danger s-del">刪除</button>
      </td>
    </tr>`).join("") : `<tr><td colspan="9" class="empty">尚未建立班別</td></tr>`;
  $("#shAll").checked = false;
  $("#shCount").textContent = `共 ${shiftTypes.length} 個班別`;
}
$("#shiftForm").onsubmit = async e => {
  e.preventDefault();
  const data = {
    cat: $("#shCat").value,
    name: $("#shName").value.trim(),
    start: $("#shStart").value,
    end: $("#shEnd").value,
    color: $("#shColor").value,
    order: Date.now()
  };
  if (!data.name) return;
  try {
    await addDoc(collection(db, "shiftTypes"), data);
    e.target.reset(); $("#shColor").value = "#2e9e3f";
    toast("已新增班別");
    renderShiftList();
  } catch (err) { toast("新增失敗：" + errMsg(err)); }
};
$("#shiftList").onclick = async e => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const id = tr.dataset.id;
  try {
    if (e.target.classList.contains("s-save")) {
      const data = {
        code: $(".s-code", tr).value.trim(),
        cat: $(".s-cat", tr).value,
        name: $(".s-name", tr).value.trim(),
        start: $(".s-start", tr).value,
        end: $(".s-end", tr).value,
        color: $(".s-color", tr).value
      };
      if (!data.name) return toast("名稱不可空白");
      if ((data.start && !data.end) || (!data.start && data.end)) return toast("上班與下班時間要一起填，或都留空");
      await updateDoc(doc(db, "shiftTypes", id), data);
      shiftMap[id] = { ...shiftMap[id], ...data };
      toast(`已儲存「${data.name}」`);
      renderShiftList();
    } else if (e.target.classList.contains("s-del")) {
      if (!(await appConfirm("刪除班別", `確定刪除「${shiftMap[id]?.name}」？已排入班表的不會自動移除。`, { okText: "刪除", danger: true }))) return;
      await deleteDoc(doc(db, "shiftTypes", id));
      toast("已刪除");
      renderShiftList();
    }
  } catch (err) { toast("操作失敗：" + errMsg(err)); }
};

// ---- 勾選刪除 / 全部刪除 ----
$("#shAll").onchange = e => $$(".s-chk").forEach(c => c.checked = e.target.checked);

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
  const ids = $$(".s-chk:checked").map(c => c.closest("tr").dataset.id);
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
    getDocs(query(collection(db, "schedules"), where("month", "==", month))),
    getDoc(doc(db, "rosters", month))
  ]);
  schedMap = {};
  snap.forEach(d => schedMap[d.id] = d.data().shiftIds || []);

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
      html += `<td class="cell ${wk(d)}" data-key="${key}">${(schedMap[key] || []).map(id => chipHtml(id, true)).join("")}</td>`;
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
const dayChips = key => (schedMap[key] || []).map(id => chipHtml(id, true)).join("") || `<span class="dr-empty">尚未排班</span>`;

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
        emps: emps.map(u => ({ id: u.id, name: u.name || "", empNo: u.empNo || "" }))
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
async function loadHistory(month) {
  if (history.month === month) return;
  const [y, m] = month.split("-").map(Number);
  const months = [1, 2, 3].map(i => ym(new Date(y, m - 1 - i, 1)));
  const snap = await getDocs(query(collection(db, "schedules"), where("month", "in", months)));
  history = { month, list: snap.docs.map(d => d.data()) };
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
  const mine = {}, all = {}, who = {};
  for (const [e, d, ids] of rows) {
    if (wdOf(d) !== wd) continue;
    for (const id of ids) {
      all[id] = (all[id] || 0) + 1;
      if (e === empId) mine[id] = (mine[id] || 0) + 1;
      (who[id] ??= {})[e] = (who[id][e] || 0) + 1;
    }
  }
  const topWho = id => {
    const best = Object.entries(who[id] || {}).sort((a, b) => b[1] - a[1])[0];
    return best ? { name: empName(best[0]), n: best[1], isMe: best[0] === empId } : null;
  };
  const allowed = new Set(rosterShifts().map(s => s.id));
  const rec = Object.entries(mine).filter(([id, n]) => allowed.has(id) && n >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => ({ id, n, src: "mine" }));
  if (rec.length < 4) {
    Object.entries(all).filter(([id, n]) => allowed.has(id) && n >= 2 && !rec.some(r => r.id === id))
      .sort((a, b) => b[1] - a[1]).slice(0, 4 - rec.length)
      .forEach(([id, n]) => rec.push({ id, n, src: "all", top: topWho(id) }));
  }
  return { wd, rec, topWho };
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
  const { wd, rec, topWho } = analyze(dp.empId, dp.ds);
  const W = `週${WEEK[wd]}`;
  $("#dpCurrent").innerHTML = ids.map(id => chipHtml(id, true)).join("") || `<span class="dr-empty">尚未排班</span>`;

  const recF = rec.filter(r => !ids.includes(r.id) && shiftMap[r.id]);
  $("#dpRecWrap").classList.toggle("hidden", !recF.length);
  $("#dpRecNote").textContent = `依過去 3 個月${W}的排班`;
  $("#dpRec").innerHTML = recF.map(r => {
    const s = shiftMap[r.id];
    const why = r.src === "mine" ? `他${W}排過 ${r.n} 次` : (r.top ? `${W}常由 ${esc(r.top.name)} 負責（${r.top.n} 次）` : `${W}常見班別`);
    return `<button class="rec" data-add="${r.id}">
      <span class="dot" style="background:${esc(s.color)}"></span>
      <span class="rec-main"><span class="rec-name">${esc(s.name)}</span><span class="rec-why">${why}${s.start && s.end ? ` · ${s.start}–${s.end}` : ""}</span></span>
      <span class="rec-add">＋</span></button>`;
  }).join("");

  const f = $("#dpFilter").value.trim().toLowerCase();
  const list = rosterShifts().filter(s => !f || s.name.toLowerCase().includes(f) || (s.code || "").toLowerCase().includes(f));
  $("#dpList").innerHTML = list.map(s => {
    const t = topWho(s.id);
    const sub = [s.start && s.end ? `${s.start}–${s.end}` : (s.cat === "leave" ? "休假" : ""),
                 t ? `${W}常由${t.isMe ? "他本人" : " " + esc(t.name)}` : ""].filter(Boolean).join(" · ");
    return `<label class="check-item"><input type="checkbox" data-sid="${s.id}" ${ids.includes(s.id) ? "checked" : ""}>
      <span class="dot" style="background:${esc(s.color)}"></span>
      <span class="ci-main"><span class="ci-name">${esc(s.name)}</span>${sub ? `<span class="ci-sub">${sub}</span>` : ""}</span></label>`;
  }).join("") || `<p class="empty">找不到班別</p>`;
}
async function setDayShift(id, on) {
  if (!dp) return;
  let ids = [...(schedMap[dp.key] || [])];
  if (on && !ids.includes(id)) ids.push(id);
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
      await setDoc(doc(db, "schedules", key), { empId, date, month: date.slice(0, 7), shiftIds: ids });
    } else {
      await deleteDoc(doc(db, "schedules", key));
    }
    schedMap[key] = ids;
    markEdited();
    document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach(el => {
      if (el.classList.contains("day-row")) el.querySelector(".dr-chips").innerHTML = dayChips(key);
      else el.innerHTML = ids.map(id => chipHtml(id, true)).join("");
    });
    renderEmpCounts();
  } catch (err) { toast("儲存失敗：" + errMsg(err)); }
}

// 依「星期幾」把 src 月份的班表（含設定）複製到 dst 月份
async function copyRoster(src, dst) {
  await Promise.all([loadEmployees(), loadShiftTypes()]);
  const [snap, rSnap] = await Promise.all([
    getDocs(query(collection(db, "schedules"), where("month", "==", src))),
    getDoc(doc(db, "rosters", src))
  ]);
  const srcR = rSnap.exists() ? rSnap.data() : {};
  const tpl = {};
  snap.docs.map(d => d.data()).sort((a, b) => a.date.localeCompare(b.date)).forEach(s => {
    tpl[`${s.empId}_${new Date(s.date + "T00:00:00").getDay()}`] = s.shiftIds;
  });
  const emps = srcR.empIds?.length ? activeEmployees().filter(u => srcR.empIds.includes(u.id)) : activeEmployees();
  let batch = writeBatch(db), n = 0, total = 0;
  for (const u of emps) {
    for (const d of daysOfMonth(dst)) {
      const ids = tpl[`${u.id}_${d.getDay()}`];
      if (!ids?.length) continue;
      const date = ymd(d);
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
  if (!(await appConfirm("複製上月班表", `將 ${prev} 的班表依「星期幾」對應複製到 ${month}？本月已排的同一天會被覆蓋。`, { okText: "複製" }))) return;
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
      title: "複製班表", message: `把 ${month} 的班表（含設定）依「星期幾」複製到：`,
      input: { type: "month", value: ym(new Date(y, m, 1)) },
      buttons: [{ text: "取消", value: false }, { text: "複製", value: true, style: "primary" }]
    });
    if (!dst) return;
    if (dst === month) return toast("請選擇不同的月份");
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

async function loadReport() {
  const month = $("#repMonth").value;
  await loadEmployees();
  const [attSnap, schSnap] = await Promise.all([
    getDocs(query(collection(db, "attendance"), where("month", "==", month))),
    getDocs(query(collection(db, "schedules"), where("month", "==", month)))
  ]);
  const groups = groupDaily(attSnap.docs.map(toRec));
  const sch = {};
  schSnap.forEach(d => sch[d.id] = d.data().shiftIds || []);

  const cur = $("#repEmp").value;
  $("#repEmp").innerHTML = `<option value="">全部員工</option>` +
    employees.map(u => `<option value="${u.id}">${esc(u.empNo)} ${esc(u.name)}</option>`).join("");
  $("#repEmp").value = cur;

  reportRows = [];
  for (const u of employees) {
    for (const d of daysOfMonth(month)) {
      const ds = ymd(d), key = `${u.id}_${ds}`;
      const g = groups[key], ids = sch[key];
      if (!g && !ids) continue;
      reportRows.push({ u, date: ds, g, ids: ids || [], st: dayStatus(g, ids, ds) });
    }
  }
  renderReport();
}

function renderReport() {
  const f = $("#repEmp").value;
  const rows = reportRows.filter(r => !f || r.u.id === f);

  const sum = {};
  rows.forEach(r => {
    const s = sum[r.u.id] ??= { u: r.u, days: 0, hrs: 0, late: 0, early: 0, miss: 0 };
    if (r.g) s.days++;
    s.hrs += r.g?.hrs || 0;
    r.st.forEach(([, t]) => {
      if (t === "遲到") s.late++;
      else if (t === "早退") s.early++;
      else if (["缺勤", "未打上班", "未打下班"].includes(t)) s.miss++;
    });
  });
  $("#repSum").innerHTML = Object.values(sum).map(s => `
    <tr><td>${esc(s.u.empNo)}</td><td>${esc(s.u.name)}</td><td>${s.days}</td>
    <td>${s.hrs.toFixed(2)}</td><td>${s.late}</td><td>${s.early}</td><td>${s.miss}</td></tr>`).join("")
    || `<tr><td colspan="7" class="empty">本月沒有資料</td></tr>`;

  $("#repList").innerHTML = rows.map(r => `
    <tr>
      <td>${dayLabel(r.date)}</td><td>${esc(r.u.empNo)}</td><td>${esc(r.u.name)}</td>
      <td>${r.ids.map(id => chipHtml(id)).join(" ") || "—"}</td>
      <td>${hms(r.g?.in) || "—"}</td><td>${hms(r.g?.out) || "—"}</td>
      <td>${r.g?.hrs ? r.g.hrs.toFixed(2) : "—"}</td>
      <td>${statusHtml(r.st)}</td>
      <td>${r.g?.inRec ? mapLink(r.g.inRec) : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="9" class="empty">本月沒有資料</td></tr>`;
}

$("#csvBtn").onclick = () => {
  const f = $("#repEmp").value;
  const rows = reportRows.filter(r => !f || r.u.id === f);
  const head = ["日期", "員編", "姓名", "班別", "上班", "下班", "工時", "狀態"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(",")].concat(rows.map(r => [
    r.date, r.u.empNo, r.u.name,
    r.ids.map(id => shiftMap[id]?.name).filter(Boolean).join("、"),
    hms(r.g?.in), hms(r.g?.out),
    r.g?.hrs ? r.g.hrs.toFixed(2) : "",
    r.st.map(s => s[1]).join("、")
  ].map(q).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `出勤報表_${$("#repMonth").value}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};


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
