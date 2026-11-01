import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithCustomToken, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, getDocs, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, LIFF_ID, WORKER_URL } from "./config.js?v=8";

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

const chipHtml = (id, withX = false) => {
  const s = shiftMap[id];
  if (!s) return "";
  return `<span class="chip" style="background:${esc(s.color)}" data-sid="${id}">${esc(s.name)}${withX ? '<span class="x">×</span>' : ""}</span>`;
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
    $(".admin-only").classList.toggle("hidden", me.role !== "admin");
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
  scheduling: loadScheduling,
  report: loadReport
};
function showView(name) {
  $$(".view").forEach(v => v.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $$(".sidebar a").forEach(a => a.classList.toggle("active", a.dataset.view === name));
  $("#sidebar").classList.remove("open");
  loaders[name]?.().catch(err => { console.error(err); toast("載入失敗：" + errMsg(err)); });
}
$$(".sidebar a").forEach(a => a.onclick = () => showView(a.dataset.view));
$("#menuBtn").onclick = () => $("#sidebar").classList.toggle("open");

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
async function loadMySchedule() {
  const month = $("#mySchMonth").value;
  const snap = await getDocs(query(collection(db, "schedules"),
    where("empId", "==", me.id), where("month", "==", month)));
  const sch = {};
  snap.forEach(d => sch[d.data().date] = d.data().shiftIds || []);
  const days = daysOfMonth(month);
  const today = ymd(new Date());
  let html = [...WEEK].map(w => `<div class="hd">${w}</div>`).join("");
  html += "<div></div>".repeat(days[0].getDay());
  for (const d of days) {
    const ds = ymd(d);
    html += `<div class="day ${ds === today ? "today" : ""}">
      <div class="d">${d.getDate()}</div>
      ${(sch[ds] || []).map(id => chipHtml(id)).join("")}
    </div>`;
  }
  $("#myCal").innerHTML = html;
}

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
        && !confirm("確定要取消自己的管理者權限或停用自己？")) return;
      await updateDoc(doc(db, "employees", id), data);
      toast("已儲存");
    } else if (e.target.classList.contains("e-unbind")) {
      if (!confirm(`解除「${emp.name}」的 LINE 綁定？他下次登入需要重新綁定。`)) return;
      await updateDoc(doc(db, "employees", id), { lineUid: null, lineName: "", linePicture: "", bindFails: 0 });
      toast("已解除綁定");
      loadEmployeesView();
    } else if (e.target.classList.contains("e-del")) {
      if (!confirm(`刪除員工「${emp.name}」？打卡紀錄會保留。`)) return;
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
    if (bad.length) alert("以下資料格式錯誤或重複，已略過（保留在輸入框中）：\n" + bad.join("\n"));
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
    <tr>
      <td>${s.cat === "leave" ? "休假" : "班別"}</td>
      <td><span class="swatch" style="background:${esc(s.color)}"></span>${esc(s.name)}</td>
      <td>${s.start && s.end ? `${s.start} ~ ${s.end}` : "—"}</td>
      <td><button class="btn small danger" data-del="${s.id}">刪除</button></td>
    </tr>`).join("") : `<tr><td colspan="4" class="empty">尚未建立班別</td></tr>`;
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
  const id = e.target.dataset.del;
  if (!id || !confirm(`確定刪除「${shiftMap[id]?.name}」？已排入班表的不會自動移除。`)) return;
  await deleteDoc(doc(db, "shiftTypes", id));
  toast("已刪除");
  renderShiftList();
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
  const exist = new Set(shiftTypes.map(s => s.name));
  let batch = writeBatch(db), n = 0, add = 0, skip = 0, fb = 0;
  const base = Date.now();
  items.forEach((it, i) => {
    if (!it.name || exist.has(it.name)) { skip++; return; }
    exist.add(it.name);
    let color = it.color;
    if (!color) {
      if (it.cat === "leave") color = LEAVE_COLOR;
      else color = (COLOR_RULES.find(([re]) => re.test(it.name)) || [, FALLBACK_COLORS[fb++ % FALLBACK_COLORS.length]])[1];
    }
    batch.set(doc(collection(db, "shiftTypes")), {
      cat: it.cat || "shift", name: it.name, start: it.start || "", end: it.end || "", color, order: base + i
    });
    add++; n++;
  });
  if (n) await batch.commit();
  toast(`已新增 ${add} 個班別${skip ? `，略過重複 ${skip} 個` : ""}`);
  renderShiftList();
}

$("#shiftBulkBtn").onclick = async () => {
  const items = $("#shiftBulk").value.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\t|,/).map(x => x.trim());
    const name = parts[0];
    const cat = parts.some(p => /^(休假|leave)$/i.test(p)) ? "leave" : "shift";
    const times = parts.slice(1).filter(p => /^\d{1,2}:\d{2}$/.test(p));
    const [start, end] = times.length === 2 ? times.map(t => t.padStart(5, "0")) : (cat === "leave" ? ["", ""] : parseTimes(name));
    return { name, cat, start, end };
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

async function loadScheduling() {
  const month = $("#schMonth").value;
  await Promise.all([loadEmployees(), loadShiftTypes()]);
  const snap = await getDocs(query(collection(db, "schedules"), where("month", "==", month)));
  schedMap = {};
  snap.forEach(d => schedMap[d.id] = d.data().shiftIds || []);

  const [y, m] = month.split("-");
  $("#schTitle").textContent = `${y}/${+m}月班表`;

  const pal = cat => shiftTypes.filter(s => (s.cat || "shift") === cat).map(s =>
    `<span class="chip ${selShift === s.id ? "sel" : ""}" style="background:${esc(s.color)}" data-pick="${s.id}">${esc(s.name)}</span>`
  ).join("") || `<span class="hint" style="margin:0">（請先到「班別設定」新增）</span>`;
  $("#palShift").innerHTML = pal("shift");
  $("#palLeave").innerHTML = pal("leave");

  renderSchedTable(month);
}

function renderSchedTable(month) {
  const days = daysOfMonth(month);
  const list = activeEmployees();
  const wk = d => (d.getDay() === 0 || d.getDay() === 6) ? "wkend" : "";
  let html = `<thead><tr><th class="name">姓名/員編</th>${days.map(d =>
    `<th class="${wk(d)}">${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})</th>`).join("")}</tr></thead><tbody>`;
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

$("#view-scheduling").addEventListener("click", e => {
  const pick = e.target.closest("[data-pick]");
  if (!pick) return;
  selShift = selShift === pick.dataset.pick ? null : pick.dataset.pick;
  $$("[data-pick]").forEach(c => c.classList.toggle("sel", c.dataset.pick === selShift));
});

$("#schedTable").onclick = async e => {
  const cell = e.target.closest("td.cell");
  if (!cell) return;
  const key = cell.dataset.key;
  let ids = [...(schedMap[key] || [])];
  if (e.target.classList.contains("x")) {
    const sid = e.target.closest(".chip").dataset.sid;
    ids = ids.filter(i => i !== sid);
  } else {
    if (!selShift) return toast("請先點選上方的班別");
    if (ids.includes(selShift)) return;
    ids.push(selShift);
  }
  await saveCell(key, ids, cell);
};

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
    if (cell) cell.innerHTML = ids.map(id => chipHtml(id, true)).join("");
  } catch (err) { toast("儲存失敗：" + errMsg(err)); }
}

$("#copyPrevBtn").onclick = async () => {
  const month = $("#schMonth").value;
  const prev = prevMonth(month);
  if (!confirm(`將 ${prev} 的班表依「星期幾」對應複製到 ${month}？（會覆蓋本月已有的同一天）`)) return;
  const snap = await getDocs(query(collection(db, "schedules"), where("month", "==", prev)));
  const tpl = {};
  snap.docs.map(d => d.data()).sort((a, b) => a.date.localeCompare(b.date)).forEach(s => {
    const wd = new Date(s.date + "T00:00:00").getDay();
    tpl[`${s.empId}_${wd}`] = s.shiftIds;
  });
  let batch = writeBatch(db), n = 0, total = 0;
  for (const u of activeEmployees()) {
    for (const d of daysOfMonth(month)) {
      const ids = tpl[`${u.id}_${d.getDay()}`];
      if (!ids?.length) continue;
      const date = ymd(d);
      batch.set(doc(db, "schedules", `${u.id}_${date}`), { empId: u.id, date, month, shiftIds: ids });
      total++;
      if (++n >= 450) { await batch.commit(); batch = writeBatch(db); n = 0; }
    }
  }
  if (!total) return toast("上月沒有班表可複製");
  if (n) await batch.commit();
  toast(`已複製 ${total} 筆`);
  loadScheduling();
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

/* ================= 啟動 ================= */
boot();
