// =====================================================================
// 旅行計畫 App
// - 已設定 firebase-config.js → 雲端模式（所有旅伴即時同步）
// - 未設定 → 本機模式（資料只存在這台裝置的瀏覽器）
// =====================================================================
import { firebaseConfig } from "./firebase-config.js";

// 刪除欄位的哨兵值。開頭的空格是刻意的（避免撞到使用者真的輸入 __DELETE__），不要「修正」掉。
const DELETE = " __DELETE__";
const $app = document.getElementById("app");
const $modalRoot = document.getElementById("modal-root");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const isConfigured =
  firebaseConfig && firebaseConfig.projectId && firebaseConfig.projectId !== "PASTE_HERE";

// =====================================================================
// 資料層：兩種後端共用同一介面
//   subscribeTrips(cb) / subscribeTrip(id, cb)
//   createTrip(id, doc) / updateTrip(id, patch) / deleteTrip(id)
//   patch 的 key 支援點路徑（"luggage.abc.checked"），值為 DELETE 表示刪除
// =====================================================================
function applyPatch(obj, patch) {
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    let node = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (value === DELETE) delete node[last];
    else node[last] = value;
  }
}

function makeLocalStore() {
  const KEY = "travel-planner-data";
  let data;
  try {
    data = JSON.parse(localStorage.getItem(KEY) || "null") || { trips: {} };
  } catch {
    data = { trips: {} };
  }
  const listListeners = new Set();
  const docListeners = new Map(); // tripId -> Set<cb>
  const save = () => localStorage.setItem(KEY, JSON.stringify(data));
  const emitList = () => listListeners.forEach((cb) => cb(tripSummaries()));
  const emitDoc = (id) => (docListeners.get(id) || []).forEach((cb) => cb(data.trips[id] || null));
  const tripSummaries = () =>
    Object.entries(data.trips)
      .map(([id, t]) => ({ id, ...t }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    try {
      data = JSON.parse(e.newValue || "null") || { trips: {} };
    } catch {
      return;
    }
    emitList();
    for (const id of docListeners.keys()) emitDoc(id);
  });

  return {
    mode: "local",
    subscribeTrips(cb) {
      listListeners.add(cb);
      cb(tripSummaries());
      return () => listListeners.delete(cb);
    },
    subscribeTrip(id, cb) {
      if (!docListeners.has(id)) docListeners.set(id, new Set());
      docListeners.get(id).add(cb);
      cb(data.trips[id] || null);
      return () => docListeners.get(id).delete(cb);
    },
    async createTrip(id, doc) {
      data.trips[id] = doc;
      save();
      emitList();
    },
    async updateTrip(id, patch) {
      if (!data.trips[id]) return;
      applyPatch(data.trips[id], patch);
      save();
      emitList();
      emitDoc(id);
    },
    async deleteTrip(id) {
      delete data.trips[id];
      save();
      emitList();
      emitDoc(id);
    },
  };
}

async function makeFirebaseStore() {
  const [appMod, fsMod, authMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const db = fsMod.getFirestore(app);
  let authWarning = "";
  try {
    await authMod.signInAnonymously(authMod.getAuth(app));
  } catch (e) {
    authWarning =
      "Firebase 匿名登入失敗（請到 Firebase 主控台 → Authentication → 啟用「匿名」登入）：" + e.code;
  }
  const col = fsMod.collection(db, "trips");
  const toPatch = (patch) => {
    const out = {};
    for (const [k, v] of Object.entries(patch)) out[k] = v === DELETE ? fsMod.deleteField() : v;
    return out;
  };
  return {
    mode: "cloud",
    authWarning,
    subscribeTrips(cb) {
      return fsMod.onSnapshot(
        col,
        (snap) => {
          const list = snap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          cb(list);
        },
        (err) => cb([], err)
      );
    },
    subscribeTrip(id, cb) {
      return fsMod.onSnapshot(
        fsMod.doc(db, "trips", id),
        (snap) => cb(snap.exists() ? snap.data() : null),
        (err) => cb(null, err)
      );
    },
    async createTrip(id, docData) {
      await fsMod.setDoc(fsMod.doc(db, "trips", id), docData);
    },
    async updateTrip(id, patch) {
      await fsMod.updateDoc(fsMod.doc(db, "trips", id), toPatch(patch));
    },
    async deleteTrip(id) {
      await fsMod.deleteDoc(fsMod.doc(db, "trips", id));
    },
  };
}

// =====================================================================
// 全域狀態
// =====================================================================
let store = null;
let trips = []; // 首頁列表
let trip = null; // 目前旅行的完整資料
let tripUnsub = null;
let currentTripId = null;
let lastError = "";

// 頁面內暫存（切頁籤不重置資料，只是顯示狀態）
const view = {
  bagPerson: null, // 行李頁看誰的勾選
  bagManage: false, // 行李頁管理模式
  mapQuery: null, // 大綱頁目前地圖查詢字
  schedDay: null, // 每日行程頁目前選的天（dayId 或 "all"）
};

const TABS = [
  { key: "flight", icon: "✈️", label: "航班交通" },
  { key: "bag", icon: "🧳", label: "行李清單" },
  { key: "outline", icon: "🗺️", label: "行程大綱" },
  { key: "day", icon: "📅", label: "每日行程" },
  { key: "money", icon: "💰", label: "記帳" },
];

const DEFAULT_LUGGAGE = [
  ["證件", "護照"],
  ["證件", "簽證／入境資料"],
  ["證件", "現金・信用卡"],
  ["電子", "手機充電器"],
  ["電子", "行動電源"],
  ["電子", "轉接頭"],
  ["盥洗", "牙刷牙膏"],
  ["盥洗", "保養品"],
  ["衣物", "換洗衣物"],
  ["藥品", "常備藥"],
];

// =====================================================================
// 路由：#/t/<tripId>/<tab>，其餘 → 首頁
// =====================================================================
function parseRoute() {
  const m = location.hash.match(/^#\/t\/([^/]+)\/?([a-z]*)/);
  if (m) return { tripId: m[1], tab: TABS.some((t) => t.key === m[2]) ? m[2] : "flight" };
  return { tripId: null, tab: null };
}
function nav(hash) {
  location.hash = hash;
}

// 分享模式：網址帶 ?trip=<id> 時鎖定單一行程（旅伴看不到其他旅行、沒有返回列表鈕）
const lockedTripId = new URLSearchParams(location.search).get("trip");
window.addEventListener("hashchange", onRoute);

// 寫入失敗（規則擋下、斷線、登入失敗）時給使用者看得懂的提示，而不是靜默沒反應
window.addEventListener("unhandledrejection", (e) => {
  const msg = (e.reason && (e.reason.code || e.reason.message)) || String(e.reason);
  alert("儲存失敗，請檢查網路或 Firebase 設定：\n" + msg);
});

function onRoute() {
  if (lockedTripId && !parseRoute().tripId) {
    location.hash = "#/t/" + lockedTripId + "/flight";
    return; // hashchange 會再進來一次
  }
  const { tripId } = parseRoute();
  if (tripId !== currentTripId) {
    if (tripUnsub) tripUnsub();
    tripUnsub = null;
    trip = null;
    currentTripId = tripId;
    view.bagPerson = null;
    view.bagManage = false;
    view.mapQuery = null;
    view.schedDay = null;
    if (tripId) {
      tripUnsub = store.subscribeTrip(tripId, (doc, err) => {
        if (err) lastError = "讀取失敗：" + (err.code || err.message);
        trip = doc;
        render();
      });
    }
  }
  render();
}

// =====================================================================
// 使用者身分（每台裝置記住自己的名字）
// =====================================================================
const userKey = (tripId) => "tp-user-" + tripId;
const getUser = () => localStorage.getItem(userKey(currentTripId)) || "";
const setUser = (name) => localStorage.setItem(userKey(currentTripId), name);

function ensureUser() {
  if (!trip) return true;
  const me = getUser();
  if (me && (trip.members || []).includes(me)) return true;
  openUserPicker();
  return false;
}

function openUserPicker() {
  const members = trip.members || [];
  openModal(`
    <h3>你是誰？</h3>
    <p class="form-hint">選自己的名字，行李勾選和記帳會記在你名下（只需選一次）。</p>
    <div class="check-grid" id="pick-list">
      ${members.map((m) => `<button class="chip" data-name="${esc(m)}">${esc(m)}</button>`).join("")}
    </div>
    <hr class="divider" />
    <div class="field"><label>或加入新旅伴</label>
      <div class="field-row">
        <input id="pick-new" placeholder="輸入名字" />
        <button class="btn secondary" id="pick-add" style="flex:none">加入</button>
      </div>
    </div>
  `, (el) => {
    el.querySelectorAll("#pick-list .chip").forEach((b) =>
      b.addEventListener("click", () => {
        setUser(b.dataset.name);
        closeModal();
        render();
      })
    );
    el.querySelector("#pick-add").addEventListener("click", async () => {
      const name = el.querySelector("#pick-new").value.trim();
      if (!name) return;
      if (!(trip.members || []).includes(name))
        await store.updateTrip(currentTripId, { members: [...(trip.members || []), name] });
      setUser(name);
      closeModal();
      render();
    });
  });
}

// =====================================================================
// Modal 工具
// =====================================================================
function openModal(innerHtml, onMount) {
  $modalRoot.innerHTML = `<div class="modal-mask"><div class="modal">${innerHtml}</div></div>`;
  const mask = $modalRoot.querySelector(".modal-mask");
  mask.addEventListener("click", (e) => {
    if (e.target === mask) closeModal();
  });
  if (onMount) onMount($modalRoot.querySelector(".modal"));
}
function closeModal() {
  $modalRoot.innerHTML = "";
}

// 勾選藥丸群組（記帳分帳、成員選擇用）
function checkPills(name, options, checkedSet) {
  return options
    .map(
      (o) => `<label class="check-pill ${checkedSet.has(o) ? "on" : ""}">
        <input type="checkbox" name="${name}" value="${esc(o)}" ${checkedSet.has(o) ? "checked" : ""}/>${esc(o)}
      </label>`
    )
    .join("");
}
function bindPills(el) {
  el.querySelectorAll(".check-pill input").forEach((i) =>
    i.addEventListener("change", () => i.closest(".check-pill").classList.toggle("on", i.checked))
  );
}

// 24 小時制時間選單（小時 + 每 5 分鐘）
function timeSelects(idPrefix, value) {
  const [h, m] = (value || ":").split(":");
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const mins = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
  return `<div class="field-row">
    <select id="${idPrefix}-h"><option value="">-- 時</option>${hours
      .map((x) => `<option ${x === h ? "selected" : ""}>${x}</option>`)
      .join("")}</select>
    <select id="${idPrefix}-m"><option value="">-- 分</option>${mins
      .map((x) => `<option ${x === m ? "selected" : ""}>${x}</option>`)
      .join("")}</select>
  </div>`;
}
function readTime(el, idPrefix) {
  const h = el.querySelector(`#${idPrefix}-h`).value;
  const m = el.querySelector(`#${idPrefix}-m`).value;
  return h === "" ? "" : `${h}:${m || "00"}`;
}

// =====================================================================
// 渲染入口
// =====================================================================
// 依旅行出發月份決定季節主題（3-5 春、6-8 夏＝預設、9-11 秋、12-2 冬）
function seasonOf(t) {
  const m = parseInt((t.startDate || "").slice(5, 7), 10);
  if (!m) return "";
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}
function applySeason(t) {
  const s = t ? seasonOf(t) : "";
  if (s) document.body.dataset.season = s;
  else document.body.removeAttribute("data-season");
}

function render() {
  const { tripId, tab } = parseRoute();
  if (!tripId) {
    applySeason(null);
    renderHome();
    return;
  }
  applySeason(trip);
  if (trip === null) {
    $app.innerHTML = `
      ${topbar("旅行計畫", true)}
      <div class="page"><div class="empty">載入中…（如果一直停在這裡，這筆旅行可能已被刪除）</div></div>`;
    bindTopbar();
    return;
  }
  if (!ensureUser()) {
    // 先渲染底層畫面，modal 蓋在上面
  }
  renderTrip(tab);
}

function topbar(title, backToHome) {
  const me = currentTripId ? getUser() : "";
  return `<header class="topbar">
    ${backToHome && !lockedTripId ? `<button class="icon-btn" id="btn-back" title="回旅行列表">←</button>` : `<span style="font-size:20px">🧳</span>`}
    <h1>${esc(title)}</h1>
    ${me ? `<button class="userchip" id="btn-user" title="切換使用者">👤 ${esc(me)}</button>` : ""}
  </header>`;
}
function bindTopbar() {
  const back = document.getElementById("btn-back");
  if (back) back.addEventListener("click", () => nav("#/"));
  const u = document.getElementById("btn-user");
  if (u) u.addEventListener("click", openUserPicker);
}

function modeNotice() {
  if (lastError)
    return `<div class="notice">⚠️ ${esc(lastError)}</div>`;
  if (store.mode === "local")
    return `<div class="notice">📴 本機模式：資料只存在這台裝置。完成 Firebase 設定後即可與旅伴同步（見 firebase-config.js）。</div>`;
  if (store.authWarning) return `<div class="notice">⚠️ ${esc(store.authWarning)}</div>`;
  return "";
}

// =====================================================================
// 首頁
// =====================================================================
function renderHome() {
  $app.innerHTML = `
    ${topbar("旅行計畫", false)}
    <div class="page">
      ${modeNotice()}
      ${
        trips.length === 0
          ? `<div class="empty">還沒有旅行 —— 按右下角「＋」建立第一個！</div>`
          : trips
              .map(
                (t) => `<div class="card trip-card" data-id="${esc(t.id)}">
                  <span class="t-emoji">✈️</span>
                  <div class="t-info">
                    <div class="t-name">${esc(t.name)}</div>
                    <div class="t-meta">${esc(t.destination || "")}　${esc(t.startDate || "")}${
                  t.endDate ? " ~ " + esc(t.endDate) : ""
                }</div>
                  </div>
                  <span class="t-arrow">›</span>
                </div>`
              )
              .join("")
      }
    </div>
    <button class="fab" id="fab-new" title="新增旅行">＋</button>`;
  bindTopbar();
  document.querySelectorAll(".trip-card").forEach((c) =>
    c.addEventListener("click", () => nav("#/t/" + c.dataset.id + "/flight"))
  );
  document.getElementById("fab-new").addEventListener("click", openNewTripModal);
}

function openNewTripModal() {
  openModal(`
    <h3>新增旅行</h3>
    <div class="field"><label>旅行名稱 *</label><input id="nt-name" placeholder="例：2026 東京自由行" /></div>
    <div class="field"><label>目的地</label><input id="nt-dest" placeholder="例：東京" /></div>
    <div class="field-row">
      <div class="field"><label>出發日</label><input id="nt-start" type="date" /></div>
      <div class="field"><label>回程日</label><input id="nt-end" type="date" /></div>
    </div>
    <div class="field"><label>旅伴（用逗號或頓號分隔）</label><input id="nt-members" placeholder="例：婷瑋、小明" /></div>
    <div class="field"><label>記帳幣別（結算用的本幣）</label><input id="nt-cur" value="NT$" /></div>
    <div class="field-row">
      <div class="field"><label>外幣代號（不用就留空）</label><input id="nt-fx" placeholder="例：EUR" /></div>
      <div class="field"><label>匯率（1 外幣 = ? 本幣）</label><input id="nt-rate" type="number" inputmode="decimal" step="0.0001" min="0" placeholder="例：36" /></div>
    </div>
    <div class="btn-row">
      <button class="btn secondary" id="nt-cancel">取消</button>
      <button class="btn" id="nt-save">建立</button>
    </div>
  `, (el) => {
    el.querySelector("#nt-cancel").addEventListener("click", closeModal);
    el.querySelector("#nt-save").addEventListener("click", async () => {
      const name = el.querySelector("#nt-name").value.trim();
      if (!name) return alert("請填旅行名稱");
      const members = [...new Set(el.querySelector("#nt-members").value.split(/[,、，\s]+/).map((s) => s.trim()).filter(Boolean))];
      const luggage = {};
      DEFAULT_LUGGAGE.forEach(([cat, item], i) => {
        luggage[uid() + i] = { cat, name: item, note: "", order: i, checked: {} };
      });
      const id = uid();
      const fxCode = el.querySelector("#nt-fx").value.trim().toUpperCase();
      const fxRate = parseFloat(el.querySelector("#nt-rate").value);
      await store.createTrip(id, {
        name,
        destination: el.querySelector("#nt-dest").value.trim(),
        startDate: el.querySelector("#nt-start").value,
        endDate: el.querySelector("#nt-end").value,
        currency: el.querySelector("#nt-cur").value.trim() || "NT$",
        ...(fxCode ? { fx: { code: fxCode, rate: fxRate > 0 ? fxRate : 0 } } : {}),
        members: members.length ? members : [],
        pax: {}, // 每位旅客各自的航班與機場交通（key=uid，name 存在值裡）
        luggage,
        days: {},
        sched: {},
        exp: {},
        createdAt: Date.now(),
      });
      closeModal();
      nav("#/t/" + id + "/flight");
    });
  });
}

// =====================================================================
// 旅行主畫面（五頁籤）
// =====================================================================
function renderTrip(tab) {
  const tabsHtml = TABS.map(
    (t) =>
      `<button class="tab ${t.key === tab ? "active" : ""}" data-tab="${t.key}">
        <span class="t-icon">${t.icon}</span>${t.label}
      </button>`
  ).join("");
  let body = "";
  if (tab === "flight") body = pageFlight();
  else if (tab === "bag") body = pageBag();
  else if (tab === "outline") body = pageOutline();
  else if (tab === "day") body = pageDay();
  else if (tab === "money") body = pageMoney();

  $app.innerHTML = `
    ${topbar(trip.name, true)}
    <nav class="tabs">${tabsHtml}</nav>
    <div class="page">${modeNotice()}${body}</div>
    ${fabFor(tab)}`;
  bindTopbar();
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => nav(`#/t/${currentTripId}/${b.dataset.tab}`))
  );
  bindTripPage(tab);
}

function fabFor(tab) {
  const map = { bag: "新增行李", outline: "新增一天", day: "新增行程", money: "新增一筆帳" };
  if (!map[tab]) return "";
  return `<button class="fab" id="fab-add" title="${map[tab]}">＋</button>`;
}

function bindTripPage(tab) {
  const fab = document.getElementById("fab-add");
  if (fab)
    fab.addEventListener("click", () => {
      if (tab === "bag") openBagItemModal();
      else if (tab === "outline") openDayModal();
      else if (tab === "day") openSchedModal();
      else if (tab === "money") openExpenseModal();
    });
  if (tab === "flight") bindFlight();
  else if (tab === "bag") bindBag();
  else if (tab === "outline") bindOutline();
  else if (tab === "day") bindDay();
  else if (tab === "money") bindMoney();
}

// ---------------------------------------------------------------------
// 頁 1：航班交通
// ---------------------------------------------------------------------
function flightSeg(seg, fallback) {
  const s = seg || {};
  if (!s.no && !s.from && !s.to)
    return `<div class="empty" style="padding:12px">${fallback}</div>`;
  return `<div class="flight-seg">
    <div class="f-col">
      <div class="f-air">${esc(s.from || "—")}</div>
      <div class="f-term">${s.fromT ? "第 " + esc(s.fromT) + " 航廈" : ""}</div>
      <div class="f-time">${esc(s.dep || "")}</div>
    </div>
    <div class="f-mid"><div class="f-no">${esc(s.no || "")}</div>✈ ──────</div>
    <div class="f-col">
      <div class="f-air">${esc(s.to || "—")}</div>
      <div class="f-term">${s.toT ? "第 " + esc(s.toT) + " 航廈" : ""}</div>
      <div class="f-time">${esc(s.arr || "")}</div>
    </div>
  </div>`;
}

// 找某成員的航班區塊（pax key=uid，name 存在值裡，不拿名字當 key）
function paxEntryOf(name) {
  return Object.entries(trip.pax || {}).find(([, p]) => p && p.name === name) || null;
}
// 某人的額外航段（依 order 排）
function legsOf(pax) {
  return Object.entries((pax && pax.legs) || {})
    .map(([id, l]) => ({ id, ...l }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// 單一旅客的航班卡（去程／回程／額外航段／機場交通／貴賓室）
function paxCard(name, pax, isMe) {
  const f = pax || {};
  const legHtml = legsOf(pax)
    .map((l) => `<h3 class="flight-sub">🔀 ${esc(l.label || "額外航段")}</h3>${flightSeg(l, "—")}`)
    .join("");
  return `
    <div class="card${isMe ? " me-card" : ""}">
      <div class="card-head">
        <h2>👤 ${esc(name)}${isMe ? "（我）" : ""} 的航班</h2>
        <button class="edit-btn" data-pax="${esc(name)}">編輯</button>
      </div>
      <h3 class="flight-sub">🛫 去程</h3>
      ${flightSeg(f.ob, "尚未填寫去程航班")}
      <h3 class="flight-sub">🛬 回程</h3>
      ${flightSeg(f.ib, "尚未填寫回程航班")}
      ${legHtml}
      <h3 class="flight-sub">🚌 機場交通</h3>
      <dl class="kv">
        <dt>去程</dt><dd style="white-space:pre-wrap">${esc(f.goTrans || "—")}</dd>
        <dt>回程</dt><dd style="white-space:pre-wrap">${esc(f.backTrans || "—")}</dd>
      </dl>
      <h3 class="flight-sub">🛋️ 貴賓室</h3>
      <div style="font-size:14px; white-space:pre-wrap">${
        f.lounge ? `<span class="badge">使用</span>　${esc(f.lounge)}` : "不使用／未填寫"
      }</div>
    </div>`;
}

function pageFlight() {
  const me = getUser();
  const members = trip.members || [];
  const cards = members
    .map((name) => paxCard(name, paxEntryOf(name)?.[1] || null, name === me))
    .join("");
  return `
    <div class="card">
      <div class="card-head"><h2>ℹ️ 旅行資訊</h2>
        <button class="edit-btn" id="share-trip">🔗 分享給旅伴</button>
        <button class="edit-btn" id="edit-info">編輯</button>
      </div>
      <dl class="kv">
        <dt>目的地</dt><dd>${esc(trip.destination || "—")}</dd>
        <dt>日期</dt><dd>${esc(trip.startDate || "—")}${trip.endDate ? " ~ " + esc(trip.endDate) : ""}</dd>
        <dt>旅伴</dt><dd>${members.map((m) => esc(m)).join("、") || "—"}</dd>
        <dt>記帳幣別</dt><dd>${esc(trip.currency || "NT$")}</dd>
      </dl>
      <p class="form-hint">每個人各自填自己的航班與機場交通，互不覆蓋。按自己那張卡的「編輯」。</p>
    </div>
    ${cards || `<div class="empty">還沒有旅伴。按上面「編輯」加入旅伴後，再各自填航班。</div>`}`;
}

function bindFlight() {
  document.getElementById("edit-info").addEventListener("click", openTripInfoModal);
  document.querySelectorAll("[data-pax]").forEach((b) =>
    b.addEventListener("click", () => openPaxModal(b.dataset.pax))
  );
  document.getElementById("share-trip").addEventListener("click", async () => {
    // 專屬連結：旅伴打開只看到這一個行程
    const url = location.origin + location.pathname + "?trip=" + currentTripId + "#/t/" + currentTripId + "/flight";
    if (navigator.share) {
      try { await navigator.share({ title: trip.name, url }); return; } catch { /* 使用者取消分享，改走複製 */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      alert("已複製專屬連結！傳給旅伴即可，他們只會看到這個行程：\n" + url);
    } catch {
      prompt("複製這個連結傳給旅伴（只會看到這個行程）：", url);
    }
  });
}

function openTripInfoModal() {
  openModal(`
    <h3>編輯旅行資訊</h3>
    <div class="field"><label>旅行名稱</label><input id="ti-name" value="${esc(trip.name)}" /></div>
    <div class="field"><label>目的地</label><input id="ti-dest" value="${esc(trip.destination || "")}" /></div>
    <div class="field-row">
      <div class="field"><label>出發日</label><input id="ti-start" type="date" value="${esc(trip.startDate || "")}" /></div>
      <div class="field"><label>回程日</label><input id="ti-end" type="date" value="${esc(trip.endDate || "")}" /></div>
    </div>
    <div class="field"><label>旅伴（用逗號或頓號分隔）</label><input id="ti-members" value="${esc((trip.members || []).join("、"))}" /></div>
    <p class="form-hint">⚠️ 改名字會讓舊名字的勾選與帳目對不上，旅行中途盡量不要改名。</p>
    <div class="field"><label>記帳幣別（結算用的本幣）</label><input id="ti-cur" value="${esc(trip.currency || "NT$")}" /></div>
    <div class="field-row">
      <div class="field"><label>外幣代號（不用就留空）</label><input id="ti-fx" value="${esc((trip.fx || {}).code || "")}" placeholder="例：EUR" /></div>
      <div class="field"><label>匯率（1 外幣 = ? 本幣）</label><input id="ti-rate" type="number" inputmode="decimal" step="0.0001" min="0" value="${(trip.fx || {}).rate || ""}" placeholder="例：36" /></div>
    </div>
    <p class="form-hint">設了外幣後，記帳時每筆可選用外幣或本幣輸入，總結一律換算成本幣。改匯率會即時重算所有帳。</p>
    <div class="btn-row">
      <button class="btn danger" id="ti-del">刪除旅行</button>
      <button class="btn secondary" id="ti-cancel">取消</button>
      <button class="btn" id="ti-save">儲存</button>
    </div>
  `, (el) => {
    el.querySelector("#ti-cancel").addEventListener("click", closeModal);
    el.querySelector("#ti-del").addEventListener("click", async () => {
      if (!confirm(`確定要刪除「${trip.name}」？所有行程、行李、帳目都會消失，無法復原。`)) return;
      await store.deleteTrip(currentTripId);
      closeModal();
      nav("#/");
    });
    el.querySelector("#ti-save").addEventListener("click", async () => {
      const members = [...new Set(el.querySelector("#ti-members").value.split(/[,、，\s]+/).map((s) => s.trim()).filter(Boolean))];
      const fxCode = el.querySelector("#ti-fx").value.trim().toUpperCase();
      const fxRate = parseFloat(el.querySelector("#ti-rate").value);
      await store.updateTrip(currentTripId, {
        name: el.querySelector("#ti-name").value.trim() || trip.name,
        destination: el.querySelector("#ti-dest").value.trim(),
        startDate: el.querySelector("#ti-start").value,
        endDate: el.querySelector("#ti-end").value,
        members,
        currency: el.querySelector("#ti-cur").value.trim() || "NT$",
        fx: fxCode ? { code: fxCode, rate: fxRate > 0 ? fxRate : 0 } : DELETE,
      });
      closeModal();
    });
  });
}

function segFields(p, s) {
  s = s || {};
  return `
    <div class="field"><label>航班編號</label><input id="${p}-no" value="${esc(s.no || "")}" placeholder="例：JX800" /></div>
    <div class="field-row">
      <div class="field"><label>出發機場</label><input id="${p}-from" value="${esc(s.from || "")}" placeholder="例：TPE 桃園" /></div>
      <div class="field"><label>航廈</label><input id="${p}-fromT" value="${esc(s.fromT || "")}" placeholder="例：1" /></div>
    </div>
    <div class="field"><label>出發時間</label><input id="${p}-dep" value="${esc(s.dep || "")}" placeholder="例：7/20 09:30" /></div>
    <div class="field-row">
      <div class="field"><label>抵達機場</label><input id="${p}-to" value="${esc(s.to || "")}" placeholder="例：NRT 成田" /></div>
      <div class="field"><label>航廈</label><input id="${p}-toT" value="${esc(s.toT || "")}" placeholder="例：2" /></div>
    </div>
    <div class="field"><label>抵達時間</label><input id="${p}-arr" value="${esc(s.arr || "")}" placeholder="例：7/20 13:40" /></div>`;
}
function readSeg(el, p) {
  const g = (k) => el.querySelector(`#${p}-${k}`).value.trim();
  return { no: g("no"), from: g("from"), fromT: g("fromT"), dep: g("dep"), to: g("to"), toT: g("toT"), arr: g("arr") };
}

function openPaxModal(name) {
  const entry = paxEntryOf(name);          // [uid, pax] 或 null
  const paxUid = entry ? entry[0] : uid(); // 沒有就開新的（uid 開頭是字母，可當 field path）
  const f = entry ? entry[1] : {};
  openModal(`
    <h3>編輯 ${esc(name)} 的航班與交通</h3>
    <h3 style="font-size:14px;color:var(--brand)">🛫 去程</h3>
    ${segFields("ob", f.ob)}
    <hr class="divider" />
    <h3 style="font-size:14px;color:var(--brand)">🛬 回程</h3>
    ${segFields("ib", f.ib)}
    <hr class="divider" />
    <div class="card-head" style="margin:0">
      <h3 style="font-size:14px;color:var(--brand);flex:1">🔀 額外航段（沒有就留空）</h3>
      <button class="btn secondary" id="pax-addleg" style="flex:none">＋ 新增航段</button>
    </div>
    <div id="pax-legs"></div>
    <hr class="divider" />
    <div class="field"><label>去程機場交通（怎麼去機場）</label><textarea id="fl-go" rows="2" placeholder="例：搭機捷 07:00 從台北車站出發">${esc(f.goTrans || "")}</textarea></div>
    <div class="field"><label>回程機場交通（落地後怎麼走）</label><textarea id="fl-back" rows="2" placeholder="例：Skyliner 到上野">${esc(f.backTrans || "")}</textarea></div>
    <div class="field"><label>貴賓室（不使用就留空）</label><input id="fl-lounge" value="${esc(f.lounge || "")}" placeholder="例：環亞貴賓室 T1，龍騰卡" /></div>
    <div class="btn-row">
      <button class="btn secondary" id="fl-cancel">取消</button>
      <button class="btn" id="fl-save">儲存</button>
    </div>
  `, (el) => {
    const legsBox = el.querySelector("#pax-legs");
    let legSeq = 0;
    function addLeg(l) {
      l = l || {};
      const lid = "leg" + legSeq++;
      const div = document.createElement("div");
      div.className = "leg-block";
      div.dataset.lid = lid;
      div.innerHTML = `
        <div class="card-head" style="margin:0">
          <label style="flex:1;font-weight:600;font-size:13px">額外航段</label>
          <button type="button" class="mini-btn danger" data-rmleg>🗑️ 移除</button>
        </div>
        <div class="field"><label>標籤</label><input id="${lid}-label" value="${esc(l.label || "")}" placeholder="例：DUB→AMS 10/1" /></div>
        ${segFields(lid, l)}
        <hr class="divider" />`;
      legsBox.appendChild(div);
      div.querySelector("[data-rmleg]").addEventListener("click", () => div.remove());
    }
    legsOf(f).forEach(addLeg);
    el.querySelector("#pax-addleg").addEventListener("click", (e) => { e.preventDefault(); addLeg(); });

    el.querySelector("#fl-cancel").addEventListener("click", closeModal);
    el.querySelector("#fl-save").addEventListener("click", async () => {
      const legsObj = {};
      let order = 0;
      legsBox.querySelectorAll(".leg-block").forEach((div) => {
        const lid = div.dataset.lid;
        const label = div.querySelector(`#${lid}-label`).value.trim();
        const seg = readSeg(div, lid);
        if (!label && !seg.no && !seg.from && !seg.to) return; // 整段空白就略過
        legsObj[uid()] = { label, ...seg, order: order++ };
      });
      await store.updateTrip(currentTripId, {
        [`pax.${paxUid}`]: {
          name,
          order: f.order ?? (trip.members || []).indexOf(name),
          ob: readSeg(el, "ob"),
          ib: readSeg(el, "ib"),
          legs: legsObj,
          goTrans: el.querySelector("#fl-go").value.trim(),
          backTrans: el.querySelector("#fl-back").value.trim(),
          lounge: el.querySelector("#fl-lounge").value.trim(),
        },
      });
      closeModal();
    });
  });
}

// ---------------------------------------------------------------------
// 頁 2：行李清單
// ---------------------------------------------------------------------
const CAT_ORDER = ["證件", "衣物", "電子", "盥洗", "藥品", "其他"];

function bagItems() {
  return Object.entries(trip.luggage || {})
    .map(([id, it]) => ({ id, ...it }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function pageBag() {
  const members = trip.members || [];
  const me = getUser();
  if (!view.bagPerson || !members.includes(view.bagPerson))
    view.bagPerson = members.includes(me) ? me : members[0] || "";
  const person = view.bagPerson;
  const items = bagItems();
  const done = items.filter((it) => it.checked && it.checked[person]).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  const cats = [...new Set([...CAT_ORDER.filter((c) => items.some((i) => i.cat === c)), ...items.map((i) => i.cat || "其他")])];
  const groups = cats
    .map((cat) => {
      const list = items.filter((it) => (it.cat || "其他") === cat);
      if (!list.length) return "";
      return `<div class="card">
        <div class="card-head"><h2>${esc(cat)}</h2><span class="sub">${list.filter((i) => i.checked && i.checked[person]).length}/${list.length}</span></div>
        ${list
          .map(
            (it) => `<div class="lug-item ${it.checked && it.checked[person] ? "checked" : ""}">
              <input type="checkbox" data-id="${it.id}" ${it.checked && it.checked[person] ? "checked" : ""} />
              <div class="l-name">${esc(it.name)}${it.note ? `<div class="l-note">${esc(it.note)}</div>` : ""}</div>
              ${
                view.bagManage
                  ? `<button class="mini-btn" data-edit="${it.id}">✏️</button><button class="mini-btn danger" data-del="${it.id}">🗑️</button>`
                  : ""
              }
            </div>`
          )
          .join("")}
      </div>`;
    })
    .join("");

  return `
    <div class="card">
      <div class="card-head"><h2>誰的打包進度</h2>
        <button class="edit-btn" id="bag-manage">${view.bagManage ? "完成管理" : "管理清單"}</button>
      </div>
      <div class="chips">${members
        .map((m) => `<button class="chip ${m === person ? "active" : ""}" data-person="${esc(m)}">${esc(m)}${m === me ? "（我）" : ""}</button>`)
        .join("") || `<span class="sub">先在「航班交通 → 旅行資訊」加入旅伴</span>`}</div>
      <div class="progress-wrap">
        <div class="progress-bar"><div style="width:${pct}%"></div></div>
        <div class="progress-text">${esc(person)}：${done}/${items.length}（${pct}%）</div>
      </div>
    </div>
    ${groups || `<div class="empty">清單是空的，按「＋」新增行李項目</div>`}`;
}

function bindBag() {
  document.querySelectorAll("[data-person]").forEach((b) =>
    b.addEventListener("click", () => {
      view.bagPerson = b.dataset.person;
      render();
    })
  );
  document.getElementById("bag-manage").addEventListener("click", () => {
    view.bagManage = !view.bagManage;
    render();
  });
  document.querySelectorAll(".lug-item input[type=checkbox]").forEach((cb) =>
    cb.addEventListener("change", async () => {
      const it = (trip.luggage || {})[cb.dataset.id];
      if (!it) return;
      const person = view.bagPerson;
      const checked = { ...(it.checked || {}) };
      if (cb.checked) checked[person] = true;
      else delete checked[person];
      await store.updateTrip(currentTripId, { [`luggage.${cb.dataset.id}.checked`]: checked });
    })
  );
  document.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openBagItemModal(b.dataset.edit))
  );
  document.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      const it = (trip.luggage || {})[b.dataset.del];
      if (!it || !confirm(`刪除「${it.name}」？`)) return;
      await store.updateTrip(currentTripId, { [`luggage.${b.dataset.del}`]: DELETE });
    })
  );
}

function openBagItemModal(editId) {
  const it = editId ? (trip.luggage || {})[editId] : null;
  const existingCats = [...new Set([...CAT_ORDER, ...bagItems().map((i) => i.cat || "其他")])];
  openModal(`
    <h3>${it ? "編輯行李" : "新增行李"}</h3>
    <div class="field"><label>名稱 *</label><input id="bg-name" value="${esc(it ? it.name : "")}" placeholder="例：泳衣" /></div>
    <div class="field"><label>分類</label>
      <select id="bg-cat">${existingCats.map((c) => `<option ${it && it.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
        <option value="__new__">＋ 新分類…</option>
      </select>
    </div>
    <div class="field" id="bg-newcat-wrap" style="display:none"><label>新分類名稱</label><input id="bg-newcat" /></div>
    <div class="field"><label>備註</label><input id="bg-note" value="${esc(it ? it.note || "" : "")}" placeholder="例：兩套" /></div>
    <div class="btn-row">
      <button class="btn secondary" id="bg-cancel">取消</button>
      <button class="btn" id="bg-save">儲存</button>
    </div>
  `, (el) => {
    el.querySelector("#bg-cat").addEventListener("change", (e) => {
      el.querySelector("#bg-newcat-wrap").style.display = e.target.value === "__new__" ? "" : "none";
    });
    el.querySelector("#bg-cancel").addEventListener("click", closeModal);
    el.querySelector("#bg-save").addEventListener("click", async () => {
      const name = el.querySelector("#bg-name").value.trim();
      if (!name) return alert("請填名稱");
      let cat = el.querySelector("#bg-cat").value;
      if (cat === "__new__") cat = el.querySelector("#bg-newcat").value.trim() || "其他";
      const id = editId || uid();
      const maxOrder = Math.max(0, ...bagItems().map((i) => i.order ?? 0));
      await store.updateTrip(currentTripId, {
        [`luggage.${id}`]: {
          cat,
          name,
          note: el.querySelector("#bg-note").value.trim(),
          order: it ? it.order ?? 0 : maxOrder + 1,
          checked: it ? it.checked || {} : {},
        },
      });
      closeModal();
    });
  });
}

// ---------------------------------------------------------------------
// 頁 3：行程大綱（左：每天大點；右：地圖）
// ---------------------------------------------------------------------
function dayList() {
  return Object.entries(trip.days || {})
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
}

// ---- 行程簡圖（旅行團式總覽）----
// trip.route = [{name, lat, lng, d:"Day 2-6", side:true(住宿點外的一日遊), fly:true(前一段是飛機)}]
let leafletLoading = null;
function ensureLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = resolve;
    s.onerror = () => { leafletLoading = null; reject(new Error("Leaflet 載入失敗")); };
    document.body.appendChild(s);
  });
  return leafletLoading;
}

function initRouteMap() {
  const el = document.getElementById("route-map");
  const pts = trip && trip.route ? trip.route : [];
  if (!el || !pts.length) return;
  ensureLeaflet()
    .then(() => {
      if (!document.getElementById("route-map")) return; // 已切走就不畫
      const css = getComputedStyle(document.body);
      const brand = css.getPropertyValue("--brand").trim() || "#0e7490";
      const accent = css.getPropertyValue("--accent").trim() || "#f59e0b";
      const map = L.map(el, { scrollWheelZoom: false });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO",
        maxZoom: 18,
      }).addTo(map);
      let lastBase = null;
      // 線段中點放交通時間小標籤（route 項目的 t 欄位＝「從上一個點過來」的時間）
      const timeLabel = (a, b, text) => {
        if (!text) return;
        L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], {
          interactive: false,
          icon: L.divIcon({ className: "", html: `<div class="rt-time">${esc(text)}</div>`, iconSize: [0, 0] }),
        }).addTo(map);
      };
      pts.forEach((p, i) => {
        const ll = [p.lat, p.lng];
        if (p.side) {
          if (lastBase) {
            L.polyline([lastBase, ll], { color: accent, weight: 2, dashArray: "4 6", opacity: 0.85 }).addTo(map);
            timeLabel(lastBase, ll, p.t);
          }
        } else {
          if (lastBase) {
            L.polyline([lastBase, ll], p.fly
              ? { color: brand, weight: 2.5, dashArray: "1 8", opacity: 0.9 }
              : { color: brand, weight: 3, opacity: 0.9 }).addTo(map);
            timeLabel(lastBase, ll, p.t);
          }
          lastBase = ll;
        }
        const size = p.side ? 17 : 22;
        L.marker(ll, {
          icon: L.divIcon({ className: "", html: `<div class="rt-dot ${p.side ? "side" : ""}">${i + 1}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        })
          .addTo(map)
          .bindTooltip(esc(p.name) + (p.d ? "（" + esc(p.d) + "）" : ""), { direction: "top", offset: [0, -10], className: "rt-tip" });
      });
      map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), { padding: [34, 34] });
    })
    .catch(() => {
      el.innerHTML = '<div class="empty">簡圖載入失敗（需要網路）</div>';
    });
}

function mapEmbed(query) {
  const q = query || trip.destination || trip.name;
  const src = `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed&hl=zh-TW&z=13`;
  const open = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  return `
    <iframe class="map-frame" src="${src}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
    <div class="map-hint">📍 ${esc(q)}（點行程裡的地點可切換）</div>
    <a class="map-open-link" href="${open}" target="_blank" rel="noopener">在 Google Maps App 開啟 →</a>`;
}

function pageOutline() {
  const days = dayList();
  const left = days.length
    ? days
        .map(
          (d) => `<div class="card day-card">
            <div class="card-head">
              <div style="flex:1">
                <span class="d-title">Day ${d.n}</span>
                <span class="d-date">${esc(d.date || "")}</span>
                ${d.title ? `　<b style="font-size:14px">${esc(d.title)}</b>` : ""}
              </div>
              <button class="edit-btn" data-editday="${d.id}">編輯</button>
            </div>
            ${d.plan ? `<div class="d-plan">${esc(d.plan)}</div>` : ""}
            ${d.transport ? `<div class="d-row"><span class="d-ico">🚃</span><span>${esc(d.transport)}</span></div>` : ""}
            ${d.lodging ? `<div class="d-row"><span class="d-ico">🏨</span><span>${esc(d.lodging)}</span></div>` : ""}
            <div>${(d.spots || [])
              .map(
                (s) =>
                  `<button class="spot-chip ${view.mapQuery === s ? "active" : ""}" data-spot="${esc(s)}">📍 ${esc(s)}</button>`
              )
              .join("")}</div>
          </div>`
        )
        .join("")
    : `<div class="empty">還沒有行程，按「＋」新增第一天</div>`;

  const hasRoute = (trip.route || []).length > 0;
  const mapCard = hasRoute
    ? `<div class="card">
        <div class="card-head"><h2>🗺️ 行程簡圖</h2></div>
        <div id="route-map" class="map-frame"></div>
        <div class="rt-legend">${trip.route
          .map((p, i) => `<span class="rt-leg-item"><b>${i + 1}</b>${esc(p.name)}${p.d ? `<i>・${esc(p.d)}</i>` : ""}</span>`)
          .join("")}</div>
        <div class="map-hint">實線＝移動路線、虛線＝一日遊/飛行段。點各天的 📍 地點會開 Google Maps。</div>
      </div>`
    : `<div class="card">${mapEmbed(view.mapQuery)}</div>`;
  return `<div class="outline-layout">
    <div>${left}</div>
    <div class="map-panel">${mapCard}</div>
  </div>`;
}

function bindOutline() {
  document.querySelectorAll("[data-editday]").forEach((b) =>
    b.addEventListener("click", () => openDayModal(b.dataset.editday))
  );
  const hasRoute = (trip.route || []).length > 0;
  document.querySelectorAll("[data-spot]").forEach((b) =>
    b.addEventListener("click", () => {
      if (hasRoute) {
        // 簡圖模式：點地點直接開 Google Maps（新分頁/App）
        window.open("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(b.dataset.spot), "_blank", "noopener");
        return;
      }
      view.mapQuery = b.dataset.spot;
      render();
      // 手機上地圖在下方，切換後捲到地圖
      if (window.innerWidth < 860) {
        const mp = document.querySelector(".map-panel");
        if (mp) mp.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    })
  );
  initRouteMap();
}

function openDayModal(editId) {
  const d = editId ? (trip.days || {})[editId] : null;
  const nextN = Math.max(0, ...dayList().map((x) => x.n ?? 0)) + 1;
  openModal(`
    <h3>${d ? `編輯 Day ${d.n}` : `新增 Day ${nextN}`}</h3>
    <div class="field-row">
      <div class="field"><label>第幾天</label><input id="dy-n" type="number" min="1" value="${d ? d.n : nextN}" /></div>
      <div class="field"><label>日期</label><input id="dy-date" type="date" value="${esc(d ? d.date || "" : "")}" /></div>
    </div>
    <div class="field"><label>當天主題</label><input id="dy-title" value="${esc(d ? d.title || "" : "")}" placeholder="例：淺草・晴空塔" /></div>
    <div class="field"><label>大概行程</label><textarea id="dy-plan" rows="3" placeholder="例：上午淺草寺 → 午餐鰻魚飯 → 下午晴空塔">${esc(d ? d.plan || "" : "")}</textarea></div>
    <div class="field"><label>交通</label><input id="dy-trans" value="${esc(d ? d.transport || "" : "")}" placeholder="例：地鐵銀座線一日券" /></div>
    <div class="field"><label>住宿</label><input id="dy-lodge" value="${esc(d ? d.lodging || "" : "")}" placeholder="例：上野 APA Hotel" /></div>
    <div class="field"><label>地圖大點（用逗號或頓號分隔，會變成可點的地圖標籤）</label>
      <input id="dy-spots" value="${esc(d ? (d.spots || []).join("、") : "")}" placeholder="例：淺草寺、晴空塔、上野APA Hotel" /></div>
    <div class="btn-row">
      ${d ? `<button class="btn danger" id="dy-del">刪除這天</button>` : ""}
      <button class="btn secondary" id="dy-cancel">取消</button>
      <button class="btn" id="dy-save">儲存</button>
    </div>
  `, (el) => {
    el.querySelector("#dy-cancel").addEventListener("click", closeModal);
    if (d)
      el.querySelector("#dy-del").addEventListener("click", async () => {
        if (!confirm(`刪除 Day ${d.n}？（每日行程頁屬於這天的細項會歸到「未分類」）`)) return;
        await store.updateTrip(currentTripId, { [`days.${editId}`]: DELETE });
        closeModal();
      });
    el.querySelector("#dy-save").addEventListener("click", async () => {
      const spots = el.querySelector("#dy-spots").value.split(/[,、，]+/).map((s) => s.trim()).filter(Boolean);
      await store.updateTrip(currentTripId, {
        [`days.${editId || uid()}`]: {
          n: (() => { const v = parseInt(el.querySelector("#dy-n").value, 10); return Number.isFinite(v) && v >= 1 ? v : nextN; })(),
          date: el.querySelector("#dy-date").value,
          title: el.querySelector("#dy-title").value.trim(),
          plan: el.querySelector("#dy-plan").value.trim(),
          transport: el.querySelector("#dy-trans").value.trim(),
          lodging: el.querySelector("#dy-lodge").value.trim(),
          spots,
        },
      });
      closeModal();
    });
  });
}

// ---------------------------------------------------------------------
// 頁 4：每日細部行程（表格）
// ---------------------------------------------------------------------
function schedRows() {
  return Object.entries(trip.sched || {})
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
}

function pageDay() {
  const days = dayList();
  const rows = schedRows();
  const dayIds = new Set(days.map((d) => d.id));
  const hasOrphan = rows.some((r) => !dayIds.has(r.dayId));
  if (view.schedDay === null || (view.schedDay !== "orphan" && !dayIds.has(view.schedDay)))
    view.schedDay = days[0] ? days[0].id : "orphan";

  const chips = [
    ...days.map((d) => ({ key: d.id, label: `Day ${d.n}` })),
    ...(hasOrphan ? [{ key: "orphan", label: "未分類" }] : []),
  ];
  const current = view.schedDay;
  const shown =
    current === "orphan" ? rows.filter((r) => !dayIds.has(r.dayId)) : rows.filter((r) => r.dayId === current);
  const curDay = days.find((d) => d.id === current);

  return `
    <div class="chips" style="margin-bottom:12px">
      ${chips
        .map((c) => `<button class="chip ${c.key === current ? "active" : ""}" data-schedday="${c.key}">${c.label}</button>`)
        .join("") || `<span class="sub">先到「行程大綱」新增天數</span>`}
    </div>
    <div class="card">
      <div class="card-head">
        <h2>${curDay ? `Day ${curDay.n}${curDay.date ? "・" + esc(curDay.date) : ""}${curDay.title ? "・" + esc(curDay.title) : ""}` : "未分類"}</h2>
      </div>
      ${curDay && curDay.lodging ? `<div class="d-row" style="margin-bottom:8px"><span class="d-ico">🏨</span><span>${esc(curDay.lodging)}</span></div>` : ""}
      ${
        shown.length
          ? `<div class="table-wrap"><table class="sched">
              <thead><tr><th>時間</th><th>行程</th><th>停留</th><th>交通</th><th>備註</th><th></th></tr></thead>
              <tbody>${shown
                .map(
                  (r) => `<tr>
                    <td class="s-time">${esc(r.time || "—")}</td>
                    <td class="s-act">${esc(r.act || "")}${
                      r.place
                        ? ` <a class="s-map" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.place)}" target="_blank" rel="noopener" title="在 Google Maps 開啟：${esc(r.place)}">📍</a>`
                        : ""
                    }</td>
                    <td class="s-trans">${esc(r.stay || "")}</td>
                    <td class="s-trans">${esc(r.trans || "")}</td>
                    <td class="s-note">${esc(r.note || "")}</td>
                    <td class="s-ops"><button class="mini-btn" data-editsched="${r.id}">✏️</button><button class="mini-btn danger" data-delsched="${r.id}">🗑️</button></td>
                  </tr>`
                )
                .join("")}</tbody>
            </table></div>`
          : `<div class="empty">這天還沒有細部行程，按「＋」新增</div>`
      }
    </div>`;
}

function bindDay() {
  document.querySelectorAll("[data-schedday]").forEach((b) =>
    b.addEventListener("click", () => {
      view.schedDay = b.dataset.schedday;
      render();
    })
  );
  document.querySelectorAll("[data-editsched]").forEach((b) =>
    b.addEventListener("click", () => openSchedModal(b.dataset.editsched))
  );
  document.querySelectorAll("[data-delsched]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("刪除這筆行程？")) return;
      await store.updateTrip(currentTripId, { [`sched.${b.dataset.delsched}`]: DELETE });
    })
  );
}

function openSchedModal(editId) {
  const r = editId ? (trip.sched || {})[editId] : null;
  const days = dayList();
  if (!days.length && !r) {
    alert("請先到「行程大綱」頁新增天數");
    return;
  }
  const defaultDay = r ? r.dayId : view.schedDay !== "all" && view.schedDay !== "orphan" ? view.schedDay : days[0]?.id;
  openModal(`
    <h3>${r ? "編輯行程" : "新增行程"}</h3>
    <div class="field"><label>哪一天</label>
      <select id="sc-day">${days
        .map((d) => `<option value="${d.id}" ${d.id === defaultDay ? "selected" : ""}>Day ${d.n}${d.title ? "・" + esc(d.title) : ""}</option>`)
        .join("")}</select>
    </div>
    <div class="field"><label>時間（24 小時制）</label>${timeSelects("sc-time", r ? r.time : "")}</div>
    <div class="field"><label>行程內容 *</label><input id="sc-act" value="${esc(r ? r.act || "" : "")}" placeholder="例：築地市場吃早餐" /></div>
    <div class="field"><label>預計停留</label><input id="sc-stay" value="${esc(r ? r.stay || "" : "")}" placeholder="例：1.5 小時" /></div>
    <div class="field"><label>地點（填了會出現 📍 可開 Google Maps）</label><input id="sc-place" value="${esc(r ? r.place || "" : "")}" placeholder="例：Trinity College Dublin" /></div>
    <div class="field"><label>交通</label><input id="sc-trans" value="${esc(r ? r.trans || "" : "")}" placeholder="例：大江戶線 築地市場站" /></div>
    <div class="field"><label>備註</label><input id="sc-note" value="${esc(r ? r.note || "" : "")}" placeholder="例：週三公休" /></div>
    <div class="btn-row">
      <button class="btn secondary" id="sc-cancel">取消</button>
      <button class="btn" id="sc-save">儲存</button>
    </div>
  `, (el) => {
    el.querySelector("#sc-cancel").addEventListener("click", closeModal);
    el.querySelector("#sc-save").addEventListener("click", async () => {
      const act = el.querySelector("#sc-act").value.trim();
      if (!act) return alert("請填行程內容");
      const dayId = el.querySelector("#sc-day").value;
      await store.updateTrip(currentTripId, {
        [`sched.${editId || uid()}`]: {
          dayId,
          time: readTime(el, "sc-time"),
          act,
          stay: el.querySelector("#sc-stay").value.trim(),
          place: el.querySelector("#sc-place").value.trim(),
          trans: el.querySelector("#sc-trans").value.trim(),
          note: el.querySelector("#sc-note").value.trim(),
        },
      });
      view.schedDay = dayId;
      closeModal();
    });
  });
}

// ---------------------------------------------------------------------
// 頁 5：記帳（付款人、分帳、總結）
// ---------------------------------------------------------------------
function expList() {
  return Object.entries(trip.exp || {})
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.ts || 0) - (a.ts || 0));
}

function money(n) {
  return (Math.round(n * 100) / 100).toLocaleString("zh-TW");
}

const FX_SYMBOLS = { EUR: "€", USD: "$", JPY: "¥", GBP: "£", KRW: "₩", CNY: "¥" };
const fxSymbol = (code) => FX_SYMBOLS[code] || code + " ";

// 一筆帳換算成本幣（台幣）。cur = 外幣代號；沒有 cur（或匯率沒設）就當本幣
function expHome(e, fx) {
  const amt = Number(e.amt) || 0;
  if (e.cur && fx && e.cur === fx.code && fx.rate > 0) return amt * fx.rate;
  return amt;
}

function settle(exps, members, fx) {
  const paid = {}, share = {};
  members.forEach((m) => ((paid[m] = 0), (share[m] = 0)));
  for (const e of exps) {
    const amt = expHome(e, fx);
    const split = (e.split || []).filter((m) => m); // 保留舊名字也算
    if (!(e.payer in paid)) { paid[e.payer] = paid[e.payer] || 0; share[e.payer] = share[e.payer] || 0; }
    split.forEach((m) => { if (!(m in share)) { share[m] = 0; paid[m] = paid[m] || 0; } });
    paid[e.payer] += amt;
    if (split.length) split.forEach((m) => (share[m] += amt / split.length));
  }
  const names = Object.keys(paid);
  const net = names.map((m) => ({ m, v: paid[m] - share[m] }));
  const creditors = net.filter((x) => x.v > 0.005).sort((a, b) => b.v - a.v).map((x) => ({ ...x }));
  const debtors = net.filter((x) => x.v < -0.005).sort((a, b) => a.v - b.v).map((x) => ({ ...x }));
  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const pay = Math.min(creditors[ci].v, -debtors[di].v);
    transfers.push({ from: debtors[di].m, to: creditors[ci].m, amt: pay });
    creditors[ci].v -= pay;
    debtors[di].v += pay;
    if (creditors[ci].v < 0.005) ci++;
    if (debtors[di].v > -0.005) di++;
  }
  return { paid, share, transfers };
}

function pageMoney() {
  const exps = expList();
  const members = trip.members || [];
  const cur = trip.currency || "NT$";
  const fx = trip.fx && trip.fx.code ? trip.fx : null;
  const total = exps.reduce((s, e) => s + expHome(e, fx), 0);
  const fxTotal = fx ? exps.filter((e) => e.cur === fx.code).reduce((s, e) => s + (Number(e.amt) || 0), 0) : 0;
  const fxMissingRate = fx && !(fx.rate > 0) && exps.some((e) => e.cur === fx.code);
  const { paid, share, transfers } = settle(exps, members, fx);

  const byDate = {};
  for (const e of exps) (byDate[e.date || "未填日期"] ||= []).push(e);

  return `
    <div class="card">
      <div class="card-head"><h2>💰 記帳總結</h2></div>
      <div class="total-line">${cur} ${money(total)}</div>
      <div class="total-sub">總支出・共 ${exps.length} 筆${
        fx && fxTotal ? `・其中外幣 ${fxSymbol(fx.code)}${money(fxTotal)}（匯率 1 ${esc(fx.code)} = ${fx.rate || "?"} ${esc(cur)}）` : ""
      }</div>
      ${fxMissingRate ? `<div class="notice">⚠️ 有外幣帳但還沒設匯率——到「航班交通 → 旅行資訊 → 編輯」填匯率，總結才會正確換算。</div>` : ""}
      ${Object.keys(paid)
        .map((m) => {
          const net = paid[m] - share[m];
          return `<div class="sum-row"><span>${esc(m)}</span>
            <span>先付 ${money(paid[m])}・應分 ${money(share[m])}
            <span class="${net >= 0 ? "pos" : "neg"}">${net >= 0 ? "應收" : "應付"} ${money(Math.abs(net))}</span></span></div>`;
        })
        .join("")}
      ${
        transfers.length
          ? `<hr class="divider" />${transfers
              .map(
                (t) =>
                  `<div class="settle-row"><span>${esc(t.from)}</span><span class="arrow">→ ${cur} ${money(t.amt)} →</span><span>${esc(t.to)}</span></div>`
              )
              .join("")}`
          : ""
      }
    </div>
    ${
      exps.length
        ? Object.entries(byDate)
            .map(
              ([date, list]) => `<div class="card">
                <div class="card-head"><h2>${esc(date)}</h2><span class="sub">${cur} ${money(list.reduce((s, e) => s + expHome(e, fx), 0))}</span></div>
                ${list
                  .map((e) => {
                    const foreign = fx && e.cur === fx.code;
                    return `<div class="exp-item" data-exp="${e.id}">
                      <div class="e-main">
                        <div class="e-desc">${esc(e.desc)}</div>
                        <div class="e-meta">${esc(e.payer)} 付款・${(e.split || []).length} 人分（${(e.split || []).map((m) => esc(m)).join("、")}）${
                          foreign ? `・≈ ${cur} ${money(expHome(e, fx))}` : ""
                        }</div>
                      </div>
                      <div class="e-amt">${foreign ? fxSymbol(fx.code) + money(Number(e.amt) || 0) : cur + " " + money(Number(e.amt) || 0)}</div>
                    </div>`;
                  })
                  .join("")}
              </div>`
            )
            .join("")
        : `<div class="empty">還沒有帳目，按「＋」記第一筆</div>`
    }`;
}

function bindMoney() {
  document.querySelectorAll("[data-exp]").forEach((d) =>
    d.addEventListener("click", () => openExpenseModal(d.dataset.exp))
  );
}

function openExpenseModal(editId) {
  const e = editId ? (trip.exp || {})[editId] : null;
  const members = trip.members || [];
  if (!members.length) {
    alert("請先在「航班交通 → 旅行資訊」加入旅伴名單");
    return;
  }
  const me = getUser();
  const today = new Date().toISOString().slice(0, 10);
  const splitSet = new Set(e ? e.split || [] : members);
  const fx = trip.fx && trip.fx.code ? trip.fx : null;
  // 預設幣別：編輯時照原本；新增時若有設外幣，預設用外幣（出國多半刷外幣）
  const defCur = e ? e.cur || "" : fx ? fx.code : "";
  openModal(`
    <h3>${e ? "編輯帳目" : "新增帳目"}</h3>
    ${
      fx
        ? `<div class="field"><label>用哪種幣別記這筆</label>
            <div class="check-grid" id="ex-cur-pills">
              <label class="check-pill ${defCur === fx.code ? "on" : ""}"><input type="radio" name="ex-cur" value="${esc(fx.code)}" ${defCur === fx.code ? "checked" : ""}/>${esc(fx.code)}（${fxSymbol(fx.code).trim()}）</label>
              <label class="check-pill ${defCur === "" ? "on" : ""}"><input type="radio" name="ex-cur" value="" ${defCur === "" ? "checked" : ""}/>${esc(trip.currency || "NT$")}</label>
            </div></div>`
        : ""
    }
    <div class="field-row">
      <div class="field"><label>日期</label><input id="ex-date" type="date" value="${esc(e ? e.date || today : today)}" /></div>
      <div class="field"><label>金額 *</label><input id="ex-amt" type="number" inputmode="decimal" step="0.01" min="0" value="${e ? e.amt : ""}" /></div>
    </div>
    <div class="field"><label>項目 *</label><input id="ex-desc" value="${esc(e ? e.desc || "" : "")}" placeholder="例：晚餐 燒肉" /></div>
    <div class="field"><label>誰付的錢</label>
      <select id="ex-payer">${members
        .map((m) => `<option ${e ? (e.payer === m ? "selected" : "") : m === me ? "selected" : ""}>${esc(m)}</option>`)
        .join("")}</select>
    </div>
    <div class="field"><label>哪些人分帳（平分）</label>
      <div class="check-grid">${checkPills("ex-split", members, splitSet)}</div>
    </div>
    <div class="btn-row">
      ${e ? `<button class="btn danger" id="ex-del">刪除</button>` : ""}
      <button class="btn secondary" id="ex-cancel">取消</button>
      <button class="btn" id="ex-save">儲存</button>
    </div>
  `, (el) => {
    bindPills(el);
    // 幣別單選藥丸：同組互斥的高亮
    el.querySelectorAll('#ex-cur-pills input[type="radio"]').forEach((r) =>
      r.addEventListener("change", () => {
        el.querySelectorAll("#ex-cur-pills .check-pill").forEach((p) =>
          p.classList.toggle("on", p.querySelector("input").checked)
        );
      })
    );
    el.querySelector("#ex-cancel").addEventListener("click", closeModal);
    if (e)
      el.querySelector("#ex-del").addEventListener("click", async () => {
        if (!confirm(`刪除「${e.desc}」這筆帳？`)) return;
        await store.updateTrip(currentTripId, { [`exp.${editId}`]: DELETE });
        closeModal();
      });
    el.querySelector("#ex-save").addEventListener("click", async () => {
      const amt = parseFloat(el.querySelector("#ex-amt").value);
      const desc = el.querySelector("#ex-desc").value.trim();
      if (!desc || !(amt >= 0)) return alert("請填項目與金額");
      const split = [...el.querySelectorAll('input[name="ex-split"]:checked')].map((i) => i.value);
      if (!split.length) return alert("至少要有一個人分帳");
      const curPick = el.querySelector('#ex-cur-pills input[type="radio"]:checked');
      await store.updateTrip(currentTripId, {
        [`exp.${editId || uid()}`]: {
          date: el.querySelector("#ex-date").value,
          desc,
          amt,
          cur: curPick ? curPick.value : e ? e.cur || "" : "",
          payer: el.querySelector("#ex-payer").value,
          split,
          ts: e ? e.ts || Date.now() : Date.now(),
        },
      });
      closeModal();
    });
  });
}

// =====================================================================
// 啟動
// =====================================================================
(async function main() {
  try {
    store = isConfigured ? await makeFirebaseStore() : makeLocalStore();
  } catch (err) {
    $app.innerHTML = `<div class="page"><div class="notice">⚠️ 連線 Firebase 失敗：${esc(err.message)}<br/>請檢查 firebase-config.js 的內容是否貼對。</div></div>`;
    return;
  }
  store.subscribeTrips((list, err) => {
    if (err) lastError = "讀取旅行列表失敗：" + (err.code || err.message);
    trips = list;
    if (!parseRoute().tripId) render();
  });
  // 管理用掛鉤：讓 AI/console 能批次匯入行程資料（一般使用不會碰到）
  window.tpStore = store;
  window.tpUid = uid;
  onRoute();
})();
