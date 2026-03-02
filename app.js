const STORAGE_KEY = "outreachops_mvp_v1";
const SOURCE_WEIGHTS = { public: 1.0, org: 1.2, provider: 1.4 };
const APG_K = 10;
const APG_WINDOW_DAYS = 7;
const EPSILON = 0.1;

const GRID_CELLS = [
  { id: "G-A1", bounds: [[37.772, -122.427], [37.776, -122.421]] },
  { id: "G-A2", bounds: [[37.772, -122.421], [37.776, -122.415]] },
  { id: "G-A3", bounds: [[37.772, -122.415], [37.776, -122.409]] },
  { id: "G-B1", bounds: [[37.768, -122.427], [37.772, -122.421]] },
  { id: "G-B2", bounds: [[37.768, -122.421], [37.772, -122.415]] },
  { id: "G-B3", bounds: [[37.768, -122.415], [37.772, -122.409]] },
  { id: "G-C1", bounds: [[37.764, -122.427], [37.768, -122.421]] },
  { id: "G-C2", bounds: [[37.764, -122.421], [37.768, -122.415]] },
  { id: "G-C3", bounds: [[37.764, -122.415], [37.768, -122.409]] },
];

const defaultResources = [
  { resource_id: "R1", resource_type: "shelter", availability_state: "available", capacity_score: 3, updated_at: Date.now() },
  { resource_id: "R2", resource_type: "food", availability_state: "limited", capacity_score: 2, updated_at: Date.now() },
  { resource_id: "R3", resource_type: "medical", availability_state: "available", capacity_score: 4, updated_at: Date.now() },
];

function seedSignals() {
  const now = Date.now();
  const signals = [];
  GRID_CELLS.forEach((cell, idx) => {
    const base = idx % 3 === 0 ? 11 : 8;
    for (let i = 0; i < base; i++) {
      signals.push({
        created_at: now - (i + idx + 1) * 3600_000,
        source_type: i % 2 === 0 ? "public" : "org",
        category: i % 3 === 0 ? "shelter" : "food",
        grid_id: cell.id,
        status: "open",
        weight: 1,
      });
    }
  });
  return signals;
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw);
  const state = {
    signals: seedSignals(),
    resources: defaultResources,
    logs: [],
    sessionSubmissions: [],
  };
  saveState(state);
  return state;
}

function saveState(state) {
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  state.signals = state.signals.filter((s) => s.created_at >= cutoff);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();
let selectedGridDashboard = null;
let selectedGridRequest = null;
let mapsReady = false;

const dashboardMap = L.map("dashboardMap", { zoomControl: false }).setView([37.77, -122.418], 15);
const requestMap = L.map("requestMap", { zoomControl: false }).setView([37.77, -122.418], 15);

function addTiles(map) {
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
}
addTiles(dashboardMap);
addTiles(requestMap);

const dashboardLayers = {};
const requestLayers = {};

function getAnomalyFlag(gridId) {
  const tenMin = Date.now() - 10 * 60_000;
  const recent = state.signals.filter((s) => s.grid_id === gridId && s.created_at >= tenMin).length;
  return recent >= 4;
}

function getDemand(gridId) {
  const now = Date.now();
  return state.signals
    .filter((s) => s.grid_id === gridId && s.status === "open")
    .reduce((sum, s) => {
      const ageHours = (now - s.created_at) / 3600_000;
      const timeDecay = Math.max(0.3, 1 - ageHours / (24 * 7));
      const anomalyPenalty = getAnomalyFlag(gridId) ? 0.6 : 1;
      const sourceW = SOURCE_WEIGHTS[s.source_type] || 1;
      return sum + s.weight * sourceW * timeDecay * anomalyPenalty;
    }, 0);
}

function getCoverage(gridId) {
  const since = Date.now() - APG_WINDOW_DAYS * 24 * 3600_000;
  return state.signals.filter((s) => s.grid_id === gridId && s.created_at >= since).length;
}

function getCapacity() {
  return state.resources.reduce((sum, r) => {
    const mult = r.availability_state === "available" ? 1 : r.availability_state === "limited" ? 0.6 : 0.2;
    return sum + (r.capacity_score || 0) * mult;
  }, 0);
}

function computePriority() {
  const capacity = getCapacity();
  return GRID_CELLS.map((cell) => {
    const demand = getDemand(cell.id);
    const apgCoverage = getCoverage(cell.id);
    const anomaly = getAnomalyFlag(cell.id);
    const p = demand / (capacity + EPSILON);
    return { grid_id: cell.id, demand, capacity, priority: p, insufficient: apgCoverage < APG_K, anomaly, coverage: apgCoverage };
  }).sort((a, b) => b.priority - a.priority);
}

function calculateKPIs() {
  const backlog = state.signals.filter((s) => {
    if (s.status !== "open") return false;
    const resolved = state.logs.some((l) => l.grid_id === s.grid_id && l.outcome === "resolved");
    return !resolved;
  }).length;

  const responseMinutes = state.signals
    .map((s) => {
      const firstLog = state.logs
        .filter((l) => l.grid_id === s.grid_id && l.created_at >= s.created_at)
        .sort((a, b) => a.created_at - b.created_at)[0];
      return firstLog ? (firstLog.created_at - s.created_at) / 60000 : null;
    })
    .filter((m) => m !== null);

  const avg = responseMinutes.length
    ? (responseMinutes.reduce((a, b) => a + b, 0) / responseMinutes.length).toFixed(1)
    : "0.0";

  return { backlog, avg };
}

function renderMaps() {
  const priority = computePriority();
  const lookup = Object.fromEntries(priority.map((p) => [p.grid_id, p]));
  GRID_CELLS.forEach((cell) => {
    const p = lookup[cell.id];
    const color = p.insufficient ? "#f5a623" : p.anomaly ? "#f97316" : "#0d9488";
    const weightDash = selectedGridDashboard === cell.id ? 4 : 2;
    const weightReq = selectedGridRequest === cell.id ? 4 : 2;

    if (!dashboardLayers[cell.id]) {
      const rect = L.rectangle(cell.bounds, { color, weight: weightDash, fillOpacity: 0.18 }).addTo(dashboardMap);
      rect.bindTooltip(`${cell.id}\n${p.demand.toFixed(1)}`, { permanent: true, direction: "center", className: "cell-label" });
      rect.on("click", () => {
        selectedGridDashboard = cell.id;
        document.getElementById("dashboardSelected").textContent = cell.id;
        syncLogGrid();
        renderAll();
      });
      dashboardLayers[cell.id] = rect;
    } else {
      dashboardLayers[cell.id].setStyle({ color, weight: weightDash });
      dashboardLayers[cell.id].setTooltipContent(`${cell.id}\n${p.demand.toFixed(1)}`);
    }

    if (!requestLayers[cell.id]) {
      const rect2 = L.rectangle(cell.bounds, { color, weight: weightReq, fillOpacity: 0.18 }).addTo(requestMap);
      rect2.bindTooltip(`${cell.id}\n${p.demand.toFixed(1)}`, { permanent: true, direction: "center", className: "cell-label" });
      rect2.on("click", () => {
        selectedGridRequest = cell.id;
        document.getElementById("requestSelected").textContent = cell.id;
        toggleRequestButton();
        renderAll();
      });
      requestLayers[cell.id] = rect2;
    } else {
      requestLayers[cell.id].setStyle({ color, weight: weightReq });
      requestLayers[cell.id].setTooltipContent(`${cell.id}\n${p.demand.toFixed(1)}`);
    }
  });

  if (!mapsReady) {
    mapsReady = true;
    setTimeout(() => {
      dashboardMap.invalidateSize();
      requestMap.invalidateSize();
    }, 200);
  }
}

function renderPriority() {
  const list = document.getElementById("priorityList");
  list.innerHTML = "";
  computePriority().slice(0, 6).forEach((item) => {
    const li = document.createElement("li");
    li.className = "priority-item";
    li.innerHTML = `<strong>${item.grid_id}</strong> P=${item.priority.toFixed(2)} · Demand=${item.demand.toFixed(1)} · Capacity=${item.capacity.toFixed(1)}
      ${item.insufficient ? '<span class="badge warn">데이터 부족</span>' : ""}
      ${item.anomaly ? '<span class="badge alert">검토/감점</span>' : ""}`;
    list.appendChild(li);
  });
}

function renderResources() {
  const board = document.getElementById("resourceBoard");
  board.innerHTML = "";
  state.resources.forEach((res) => {
    const card = document.createElement("div");
    card.className = "resource-card";
    card.innerHTML = `
      <h4>${res.resource_type.toUpperCase()}</h4>
      <label>State
        <select data-id="${res.resource_id}" data-field="availability_state">
          <option value="available" ${res.availability_state === "available" ? "selected" : ""}>available</option>
          <option value="limited" ${res.availability_state === "limited" ? "selected" : ""}>limited</option>
          <option value="offline" ${res.availability_state === "offline" ? "selected" : ""}>offline</option>
        </select>
      </label>
      <label>Capacity (0-5)
        <input type="number" min="0" max="5" step="1" value="${res.capacity_score}" data-id="${res.resource_id}" data-field="capacity_score" />
      </label>
    `;
    board.appendChild(card);
  });
}

function renderKPIs() {
  const k = calculateKPIs();
  document.getElementById("kpiBacklog").textContent = String(k.backlog);
  document.getElementById("kpiResponse").textContent = String(k.avg);
}

function renderAll() {
  renderKPIs();
  renderPriority();
  renderResources();
  renderMaps();
}

function toggleRequestButton() {
  const category = document.getElementById("categorySelect").value;
  document.getElementById("submitRequest").disabled = !(category && selectedGridRequest);
}

function showToast(text) {
  const toast = document.getElementById("toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 1600);
}

function rateLimited() {
  const now = Date.now();
  state.sessionSubmissions = state.sessionSubmissions.filter((t) => now - t < 120_000);
  return state.sessionSubmissions.length >= 3;
}

function submitRequest() {
  const category = document.getElementById("categorySelect").value;
  if (!category || !selectedGridRequest) return;
  const limited = rateLimited();
  const weight = limited ? 0.3 : 1;
  state.sessionSubmissions.push(Date.now());
  state.signals.push({
    created_at: Date.now(),
    source_type: "public",
    category,
    grid_id: selectedGridRequest,
    status: "open",
    weight,
  });
  saveState(state);
  renderAll();
  setScreen("dashboard");
  selectedGridDashboard = selectedGridRequest;
  document.getElementById("dashboardSelected").textContent = selectedGridDashboard;
  showToast(limited ? "Submitted with rate-limit down-weight" : "Request submitted");
}

function syncLogGrid() {
  const logGrid = document.getElementById("logGrid");
  logGrid.innerHTML = '<option value="">Select grid</option>';
  GRID_CELLS.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.id;
    if (selectedGridDashboard === c.id) opt.selected = true;
    logGrid.appendChild(opt);
  });
  document.getElementById("saveLog").disabled = !logGrid.value;
}

function saveLog() {
  const grid = document.getElementById("logGrid").value;
  if (!grid) return;
  state.logs.push({
    created_at: Date.now(),
    org_id: "demo-org",
    grid_id: grid,
    action: document.getElementById("logAction").value,
    outcome: document.getElementById("logOutcome").value,
  });
  if (document.getElementById("logOutcome").value === "resolved") {
    state.signals = state.signals.map((s) => (s.grid_id === grid ? { ...s, status: "closed" } : s));
  }
  saveState(state);
  renderAll();
  closeLogModal();
  showToast("Outreach log saved");
}

function closeLogModal() {
  document.getElementById("logModal").classList.add("hidden");
}

function setScreen(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.screen === screenId));
  setTimeout(() => {
    dashboardMap.invalidateSize();
    requestMap.invalidateSize();
  }, 60);
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => setScreen(btn.dataset.screen));
});

document.querySelectorAll(".sheet-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".sheet-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".sheet-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
  });
});

document.getElementById("categorySelect").addEventListener("change", toggleRequestButton);
document.getElementById("submitRequest").addEventListener("click", submitRequest);
document.getElementById("cancelRequest").addEventListener("click", () => setScreen("dashboard"));
document.getElementById("openLogBtn").addEventListener("click", () => {
  syncLogGrid();
  document.getElementById("logModal").classList.remove("hidden");
});
document.getElementById("closeLog").addEventListener("click", closeLogModal);
document.getElementById("saveLog").addEventListener("click", saveLog);
document.getElementById("logGrid").addEventListener("change", (e) => {
  document.getElementById("saveLog").disabled = !e.target.value;
});

document.getElementById("resourceBoard").addEventListener("change", (e) => {
  const target = e.target;
  const id = target.dataset.id;
  const field = target.dataset.field;
  if (!id || !field) return;
  state.resources = state.resources.map((r) => {
    if (r.resource_id !== id) return r;
    return {
      ...r,
      [field]: field === "capacity_score" ? Number(target.value) : target.value,
      updated_at: Date.now(),
    };
  });
  saveState(state);
  renderAll();
});

syncLogGrid();
renderAll();
