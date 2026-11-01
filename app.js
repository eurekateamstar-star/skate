import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, getDocs, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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
  const map = {
    "auth/invalid-credential": "帳號或密碼錯誤",
    "auth/invalid-email": "Email 格式錯誤",
    "auth/email-already-in-use": "此 Email 已註冊",
    "auth/weak-password": "密碼至少 6 碼",
    "auth/too-many-requests": "嘗試次數過多，請稍後再試",
    "permission-denied": "權限不足"
  };
  return map[err.code] || err.message;
}

/* ================= 狀態 ================= */
let me = null;              // 目前登入者資料 {uid, name, empNo, role, email}
let shiftTypes = [];        // 班別清單
let shiftMap = {};          // id -> 班別
let users = [];             // 員工清單（管理者用）
let pendingProfile = null;  // 註冊時暫存

const chipHtml = (id, withX = false) => {
  const s = shiftMap[id];
  if (!s) return "";
  return `<span class="chip" style="background:${esc(s.color)}" data-sid="${id}">${esc(s.name)}${withX ? '<span class="x">×</span>' : ""}</span>`;
};

/* ================= 登入 / 註冊 ================= */
let mode = "login";
$$(".tabs button").forEach(b => b.onclick = () => {
  mode = b.dataset.tab;
  $$(".tabs button").forEach(x => x.classList.toggle("active", x === b));
  $$(".reg-only").forEach(x => x.classList.toggle("hidden", mode !== "register"));
  $("#authSubmit").textContent = mode === "login" ? "登入" : "註冊";
  $("#authMsg").textContent = "";
});

$("#authForm").onsubmit = async e => {
  e.preventDefault();
  $("#authMsg").textContent = "";
  const email = $("#email").value.trim(), pw = $("#password").value;
  $("#authSubmit").disabled = true;
  try {
    if (mode === "login") {
      await signInWithEmailAndPassword(auth, email, pw);
    } else {
      const name = $("#regName").value.trim();
      if (!name) throw new Error("請輸入姓名");
      pendingProfile = { name, empNo: $("#regEmpNo").value.trim() };
      await createUserWithEmailAndPassword(auth, email, pw);
    }
  } catch (err) {
    $("#authMsg").textContent = errMsg(err);
  } finally {
    $("#authSubmit").disabled = false;
  }
};

$("#logoutBtn").onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  if (!user) {
    me = null;
    $("#appView").classList.add("hidden");
    $("#authView").classList.remove("hidden");
    return;
  }
  try {
    const ref = doc(db, "users", user.uid);
    let snap = await getDoc(ref);
    if (!snap.exists()) {
      const p = pendingProfile || { name: user.email.split("@")[0], empNo: "" };
      await setDoc(ref, { ...p, email: user.email, role: "employee", createdAt: serverTimestamp() });
      snap = await getDoc(ref);
    }
    pendingProfile = null;
    me = { uid: user.uid, ...snap.data() };
    $("#userName").textContent = `${me.name}${me.role === "admin" ? "（管理者）" : ""}`;
    $(".admin-only").classList.toggle("hidden", me.role !== "admin");
    await loadShiftTypes();
    $("#authView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    showView("clock");
  } catch (err) {
    console.error(err);
    $("#authMsg").textContent = "載入資料失敗：" + errMsg(err);
    await signOut(auth);
  }
});

/* ================= 導覽 ================= */
const loaders = {
  clock: loadClock,
  records: loadRecords,
  mySchedule: loadMySchedule,
  employees: loadEmployees,
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

// 月份選擇器預設本月
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
  const sch = await getDoc(doc(db, "schedules", `${me.uid}_${today}`));
  const ids = sch.exists() ? sch.data().shiftIds || [] : [];
  $("#todayShift").innerHTML = ids.length
    ? "今日班別：" + ids.map(id => chipHtml(id)).join("")
    : "今日無排班";
  await loadToday();
}

async function loadToday() {
  const today = ymd(new Date());
  const snap = await getDocs(query(collection(db, "attendance"),
    where("uid", "==", me.uid), where("date", "==", today)));
  const list = snap.docs.map(d => d.data())
    .map(r => ({ ...r, t: r.ts?.toDate() || new Date(r.clientTime) }))
    .sort((a, b) => a.t - b.t);
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
      uid: me.uid, name: me.name, empNo: me.empNo || "",
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
// 把打卡紀錄依「人 + 日期」分組：第一筆上班、最後一筆下班
function groupDaily(records) {
  const map = {};
  records.forEach(r => {
    const k = `${r.uid}_${r.date}`;
    map[k] ??= { uid: r.uid, name: r.name, empNo: r.empNo, date: r.date, ins: [], outs: [] };
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

// 結合班表計算每日狀態
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
const toRec = d => { const r = d.data(); return { ...r, t: r.ts?.toDate() || new Date(r.clientTime) }; };

/* ================= 我的出勤紀錄 ================= */
async function loadRecords() {
  const month = $("#recMonth").value;
  const [attSnap, schSnap] = await Promise.all([
    getDocs(query(collection(db, "attendance"), where("uid", "==", me.uid), where("month", "==", month))),
    getDocs(query(collection(db, "schedules"), where("uid", "==", me.uid), where("month", "==", month)))
  ]);
  const groups = groupDaily(attSnap.docs.map(toRec));
  const sch = {};
  schSnap.forEach(d => sch[d.data().date] = d.data().shiftIds || []);

  let rows = "", days = 0, total = 0, late = 0;
  for (const d of daysOfMonth(month)) {
    const ds = ymd(d);
    const g = groups[`${me.uid}_${ds}`];
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
    where("uid", "==", me.uid), where("month", "==", month)));
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
async function loadUsers() {
  const snap = await getDocs(collection(db, "users"));
  users = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
    .sort((a, b) => (a.empNo || "zzz").localeCompare(b.empNo || "zzz") || a.name.localeCompare(b.name));
}

async function loadEmployees() {
  await loadUsers();
  $("#empList").innerHTML = users.map(u => `
    <tr data-uid="${u.uid}">
      <td><input class="e-no" value="${esc(u.empNo)}" size="8"></td>
      <td><input class="e-name" value="${esc(u.name)}" size="10"></td>
      <td>${esc(u.email)}</td>
      <td><select class="e-role">
        <option value="employee" ${u.role === "employee" ? "selected" : ""}>員工</option>
        <option value="admin" ${u.role === "admin" ? "selected" : ""}>管理者</option>
      </select></td>
      <td><button class="btn small primary e-save">儲存</button></td>
    </tr>`).join("");
}
$("#empList").onclick = async e => {
  if (!e.target.classList.contains("e-save")) return;
  const tr = e.target.closest("tr");
  const uid = tr.dataset.uid;
  const data = {
    empNo: $(".e-no", tr).value.trim(),
    name: $(".e-name", tr).value.trim(),
    role: $(".e-role", tr).value
  };
  if (!data.name) return toast("姓名不可空白");
  if (uid === me.uid && data.role !== "admin" && !confirm("確定要取消自己的管理者權限？")) return;
  try {
    await updateDoc(doc(db, "users", uid), data);
    toast("已儲存");
  } catch (err) { toast("儲存失敗：" + errMsg(err)); }
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

/* ================= 排班作業（管理者） ================= */
let selShift = null;
let schedMap = {}; // `${uid}_${date}` -> shiftIds

async function loadScheduling() {
  const month = $("#schMonth").value;
  await Promise.all([loadUsers(), loadShiftTypes()]);
  const snap = await getDocs(query(collection(db, "schedules"), where("month", "==", month)));
  schedMap = {};
  snap.forEach(d => schedMap[d.id] = d.data().shiftIds || []);

  const [y, m] = month.split("-");
  $("#schTitle").textContent = `${y}/${+m}月班表`;

  // 色票
  const pal = cat => shiftTypes.filter(s => (s.cat || "shift") === cat).map(s =>
    `<span class="chip ${selShift === s.id ? "sel" : ""}" style="background:${esc(s.color)}" data-pick="${s.id}">${esc(s.name)}</span>`
  ).join("") || `<span class="hint" style="margin:0">（請先到「班別設定」新增）</span>`;
  $("#palShift").innerHTML = pal("shift");
  $("#palLeave").innerHTML = pal("leave");

  renderSchedTable(month);
}

function renderSchedTable(month) {
  const days = daysOfMonth(month);
  const wk = d => (d.getDay() === 0 || d.getDay() === 6) ? "wkend" : "";
  let html = `<thead><tr><th class="name">姓名/員編</th>${days.map(d =>
    `<th class="${wk(d)}">${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})</th>`).join("")}</tr></thead><tbody>`;
  for (const u of users) {
    html += `<tr><td class="name">${esc(u.name)}<div class="emp-no">${esc(u.empNo || "")}</div></td>`;
    for (const d of days) {
      const key = `${u.uid}_${ymd(d)}`;
      html += `<td class="cell ${wk(d)}" data-key="${key}">${(schedMap[key] || []).map(id => chipHtml(id, true)).join("")}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody>";
  $("#schedTable").innerHTML = users.length ? html : `<tbody><tr><td class="empty">尚無員工</td></tr></tbody>`;
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
  const [uid, date] = key.split("_");
  try {
    if (ids.length) {
      await setDoc(doc(db, "schedules", key), { uid, date, month: date.slice(0, 7), shiftIds: ids });
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
  // 以每位員工上月「每個星期幾最後一次出現的班」當模板
  const tpl = {};
  snap.docs.map(d => d.data()).sort((a, b) => a.date.localeCompare(b.date)).forEach(s => {
    const wd = new Date(s.date + "T00:00:00").getDay();
    tpl[`${s.uid}_${wd}`] = s.shiftIds;
  });
  const batch = writeBatch(db);
  let n = 0;
  for (const u of users) {
    for (const d of daysOfMonth(month)) {
      const ids = tpl[`${u.uid}_${d.getDay()}`];
      if (!ids?.length) continue;
      const date = ymd(d);
      batch.set(doc(db, "schedules", `${u.uid}_${date}`), { uid: u.uid, date, month, shiftIds: ids });
      if (++n >= 490) break; // 單批上限 500
    }
  }
  if (!n) return toast("上月沒有班表可複製");
  await batch.commit();
  toast(`已複製 ${n} 筆`);
  loadScheduling();
};

/* ================= 出勤報表（管理者） ================= */
let reportRows = [];

async function loadReport() {
  const month = $("#repMonth").value;
  await loadUsers();
  const [attSnap, schSnap] = await Promise.all([
    getDocs(query(collection(db, "attendance"), where("month", "==", month))),
    getDocs(query(collection(db, "schedules"), where("month", "==", month)))
  ]);
  const groups = groupDaily(attSnap.docs.map(toRec));
  const sch = {};
  schSnap.forEach(d => sch[d.id] = d.data().shiftIds || []);

  const cur = $("#repEmp").value;
  $("#repEmp").innerHTML = `<option value="">全部員工</option>` +
    users.map(u => `<option value="${u.uid}">${esc(u.empNo)} ${esc(u.name)}</option>`).join("");
  $("#repEmp").value = cur;

  reportRows = [];
  for (const u of users) {
    for (const d of daysOfMonth(month)) {
      const ds = ymd(d), key = `${u.uid}_${ds}`;
      const g = groups[key], ids = sch[key];
      if (!g && !ids) continue;
      reportRows.push({ u, date: ds, g, ids: ids || [], st: dayStatus(g, ids, ds) });
    }
  }
  renderReport();
}

function renderReport() {
  const f = $("#repEmp").value;
  const rows = reportRows.filter(r => !f || r.u.uid === f);

  const sum = {};
  rows.forEach(r => {
    const s = sum[r.u.uid] ??= { u: r.u, days: 0, hrs: 0, late: 0, early: 0, miss: 0 };
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
  const rows = reportRows.filter(r => !f || r.u.uid === f);
  const head = ["日期", "員編", "姓名", "班別", "上班", "下班", "工時", "狀態"];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(",")].concat(rows.map(r => [
    r.date, r.u.empNo, r.u.name,
    r.ids.map(id => shiftMap[id]?.name).filter(Boolean).join("、"),
    hms(r.g?.in), hms(r.g?.out),
    r.g?.hrs ? r.g.hrs.toFixed(2) : "",
    r.st.map(s => s[1]).join("、")
  ].map(q).join(",")));
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `出勤報表_${$("#repMonth").value}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};
