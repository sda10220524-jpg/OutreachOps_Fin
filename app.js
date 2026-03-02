const STORAGE_KEY = "outreachops_mvp_v2";
const SOURCE_WEIGHTS = { public: 1.0, org: 1.2, provider: 1.4 };
const APG_K = 3;
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

function seededState() {
  const now = Date.now();
  return {
    signals: [
      { created_at: now - 35 * 60000, source_type: "public", category: "shelter", grid_id: "G-B2", status: "open", weight: 1 },
      { created_at: now - 24 * 60000, source_type: "org", category: "food", grid_id: "G-A2", status: "open", weight: 1 },
      { created_at: now - 20 * 60000, source_type: "public", category: "medical", grid_id: "G-C1", status: "open", weight: 1 },
      { created_at: now - 18 * 60000, source_type: "provider", category: "food", grid_id: "G-B2", status: "closed", weight: 1 },
      { created_at: now - 14 * 60000, source_type: "org", category: "shelter", grid_id: "G-A1", status: "open", weight: 1 },
      { created_at: now - 8 * 60000, source_type: "public", category: "hygiene", grid_id: "G-B3", status: "open", weight: 1 },
      { created_at: now - 6 * 60000, source_type: "public", category: "food", grid_id: "G-C2", status: "open", weight: 1 },
    ],
    resources: [
      { resource_id: "R1", resource_type: "shelter", availability_state: "available", capacity_score: 3, updated_at: now },
      { resource_id: "R2", resource_type: "food", availability_state: "limited", capacity_score: 2, updated_at: now },
      { resource_id: "R3", resource_type: "medical", availability_state: "available", capacity_score: 2, updated_at: now },
    ],
    logs: [
      { created_at: now - 10 * 60000, org_id: "demo-org", grid_id: "G-B2", action: "visit", outcome: "resolved" },
      { created_at: now - 7 * 60000, org_id: "demo-org", grid_id: "G-C3", action: "call", outcome: "pending" },
    ],
    sessionSubmissions: [],
    selectedGridId: "G-B2",
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const initial = seededState();
    saveState(initial);
    return initial;
  }
  return JSON.parse(raw);
}

function saveState(s) {
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  s.signals = s.signals.filter((x) => x.created_at >= cutoff);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

let state = loadState();
let mapsReady = false;
let highlight = { cell: null, priority: null, kpi: false, resource: null };

const dashboardMap = L.map("dashboardMap", { zoomControl: false }).setView([37.77, -122.418], 15);
const requestMap = L.map("requestMap", { zoomControl: false }).setView([37.77, -122.418], 15);

function addTiles(map) {
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
}
addTiles(dashboardMap);
addTiles(requestMap);

const dashboardLayers = {};
const requestLayers = {};

function flash(type, value = true) {
  highlight[type] = value;
  renderAll();
  setTimeout(() => {
    highlight[type] = type === "resource" || type === "priority" ? null : false;
    if (type === "cell") highlight.cell = null;
    renderAll();
  }, 600);
}

function setSelectedGrid(gridId) {
  state.selectedGridId = gridId;
  saveState(state);
  updateSelectedChip();
  syncLogGrid();
  toggleRequestButton();
  renderMaps();
}

function updateSelectedChip() {
  document.querySelectorAll(".selected-grid").forEach((el) => {
    el.textContent = state.selectedGridId || "None";
  });
}

function getAnomalyFlag(gridId) {
  const tenMin = Date.now() - 10 * 60000;
  return state.signals.filter((s) => s.grid_id === gridId && s.created_at >= tenMin).length >= 4;
}

function getCoverage(gridId) {
  const since = Date.now() - APG_WINDOW_DAYS * 24 * 3600_000;
  return state.signals.filter((s) => s.grid_id === gridId && s.created_at >= since).length;
}

function getCount(gridId) {
  return state.signals.filter((s) => s.grid_id === gridId && s.status === "open").length;
}

function getDemand(gridId) {
  const now = Date.now();
  return state.signals.filter((s) => s.grid_id === gridId && s.status === "open").reduce((sum, s) => {
    const ageHours = (now - s.created_at) / 3600_000;
    const timeDecay = Math.max(0.5, 1 - ageHours / (24 * 7));
    const anomalyPenalty = getAnomalyFlag(gridId) ? 0.7 : 1;
    const sourceW = SOURCE_WEIGHTS[s.source_type] || 1;
    return sum + s.weight * sourceW * timeDecay * anomalyPenalty;
  }, 0);
}

function getCapacity() {
  return state.resources.reduce((sum, r) => {
    const m = r.availability_state === "available" ? 1 : r.availability_state === "limited" ? 0.5 : 0.1;
    return sum + r.capacity_score * m;
  }, 0);
}

function computePriority() {
  const cap = getCapacity();
  return GRID_CELLS.map((cell) => {
    const insufficient = getCoverage(cell.id) < APG_K;
    const demand = getDemand(cell.id);
    return {
      grid_id: cell.id,
      insufficient,
      anomaly: getAnomalyFlag(cell.id),
      demand,
      count: getCount(cell.id),
      capacity: cap,
      priority: insufficient ? 0 : demand / (cap + EPSILON),
    };
  }).sort((a, b) => b.priority - a.priority);
}

function calculateKPIs() {
  const backlog = state.signals.filter((s) => {
    if (s.status !== "open") return false;
    const resolved = state.logs.some((l) => l.grid_id === s.grid_id && l.outcome === "resolved" && l.created_at >= s.created_at);
    return !resolved;
  }).length;

  const responseSet = state.logs
    .filter((l) => l.outcome === "resolved")
    .map((log) => {
      const req = state.signals
        .filter((s) => s.grid_id === log.grid_id && s.created_at <= log.created_at)
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (!req) return null;
      return (log.created_at - req.created_at) / 60000;
    })
    .filter((x) => x !== null);

  const avg = responseSet.length ? (responseSet.reduce((a, b) => a + b, 0) / responseSet.length).toFixed(1) : "0.0";
  return { backlog, avg };
}

function styleForCell(item, isSelected) {
  const color = item.insufficient ? "#f59e0b" : item.anomaly ? "#f97316" : item.priority > 0.26 ? "#0ea5e9" : item.priority > 0.15 ? "#0d9488" : "#64748b";
  const weight = isSelected ? 5 : 3;
  return { color, weight, fillOpacity: 0.28 };
}

function labelForCell(item) {
  if (item.insufficient) return `${item.grid_id}\n데이터 부족`;
  return `${item.grid_id}\nCount ${item.count}`;
}

function renderMaps() {
  const priority = computePriority();
  const byGrid = Object.fromEntries(priority.map((p) => [p.grid_id, p]));

  GRID_CELLS.forEach((cell) => {
    const item = byGrid[cell.id];
    const style = styleForCell(item, state.selectedGridId === cell.id);

    if (!dashboardLayers[cell.id]) {
      const rect = L.rectangle(cell.bounds, style).addTo(dashboardMap);
      rect.bindTooltip(labelForCell(item), { permanent: true, direction: "center", className: "cell-label" });
      rect.on("click", () => setSelectedGrid(cell.id));
      dashboardLayers[cell.id] = rect;
    } else {
      dashboardLayers[cell.id].setStyle(style);
      dashboardLayers[cell.id].setTooltipContent(labelForCell(item));
    }

    if (!requestLayers[cell.id]) {
      const rect2 = L.rectangle(cell.bounds, style).addTo(requestMap);
      rect2.bindTooltip(labelForCell(item), { permanent: true, direction: "center", className: "cell-label" });
      rect2.on("click", () => setSelectedGrid(cell.id));
      requestLayers[cell.id] = rect2;
    } else {
      requestLayers[cell.id].setStyle(style);
      requestLayers[cell.id].setTooltipContent(labelForCell(item));
    }

    if (highlight.cell === cell.id) {
      dashboardLayers[cell.id].setStyle({ weight: 7, color: "#2563eb" });
      requestLayers[cell.id].setStyle({ weight: 7, color: "#2563eb" });
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
  const oldTop = list.firstElementChild?.dataset.grid || "";
  list.innerHTML = "";

  computePriority().slice(0, 6).forEach((item) => {
    const li = document.createElement("li");
    li.className = "priority-item";
    li.dataset.grid = item.grid_id;
    li.innerHTML = `<strong>${item.grid_id}</strong> P=${item.priority.toFixed(2)} · Demand=${item.insufficient ? "-" : item.demand.toFixed(1)} · Capacity=${item.capacity.toFixed(1)}
      ${item.insufficient ? '<span class="badge warn">데이터 부족</span>' : ""}
      ${item.anomaly ? '<span class="badge alert">검토/감점</span>' : ""}`;
    if (highlight.priority === item.grid_id || oldTop !== li.dataset.grid && li.dataset.grid === computePriority()[0].grid_id) {
      li.classList.add("flash");
    }
    list.appendChild(li);
  });
}

function renderResources() {
  const board = document.getElementById("resourceBoard");
  board.innerHTML = "";
  state.resources.forEach((res) => {
    const card = document.createElement("div");
    card.className = `resource-card ${highlight.resource === res.resource_id ? "flash" : ""}`;
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
      </label>`;
    board.appendChild(card);
  });
}

function renderKPIs(flashKpi = false) {
  const k = calculateKPIs();
  document.getElementById("kpiBacklog").textContent = String(k.backlog);
  document.getElementById("kpiResponse").textContent = String(k.avg);
  if (flashKpi || highlight.kpi) {
    document.getElementById("backlogCard").classList.add("flash");
    document.getElementById("responseCard").classList.add("flash");
    setTimeout(() => {
      document.getElementById("backlogCard").classList.remove("flash");
      document.getElementById("responseCard").classList.remove("flash");
    }, 600);
  }
}

function renderAll(flashKpi = false) {
  updateSelectedChip();
  renderKPIs(flashKpi);
  renderPriority();
  renderResources();
  renderMaps();
}

function toggleRequestButton() {
  const category = document.getElementById("categorySelect").value;
  document.getElementById("submitRequest").disabled = !(category && state.selectedGridId);
}

function showToast(text) {
  const toast = document.getElementById("toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 1600);
}

function rateLimited() {
  const now = Date.now();
  state.sessionSubmissions = state.sessionSubmissions.filter((t) => now - t < 2 * 60000);
  return state.sessionSubmissions.length >= 3;
}

function submitRequest() {
  const category = document.getElementById("categorySelect").value;
  if (!category || !state.selectedGridId) return;

  const before = calculateKPIs().backlog;
  const limited = rateLimited();
  const weight = limited ? 0.3 : 1;
  state.sessionSubmissions.push(Date.now());
  state.signals.push({
    created_at: Date.now(),
    source_type: "public",
    category,
    grid_id: state.selectedGridId,
    status: "open",
    weight,
  });
  saveState(state);

  highlight.cell = state.selectedGridId;
  highlight.priority = state.selectedGridId;
  highlight.kpi = true;
  setScreen("dashboard");
  renderAll(true);

  const after = calculateKPIs().backlog;
  showToast(`Request submitted · Backlog ${before}→${after}${limited ? " (rate-limited)" : ""}`);
  flash("cell", state.selectedGridId);
  flash("priority", state.selectedGridId);
}

function syncLogGrid() {
  const logGrid = document.getElementById("logGrid");
  logGrid.innerHTML = '<option value="">Select grid</option>';
  GRID_CELLS.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.id;
    logGrid.appendChild(opt);
  });
  logGrid.value = state.selectedGridId || "";
  const hasGrid = Boolean(logGrid.value);
  document.getElementById("saveLog").disabled = !hasGrid;
  document.getElementById("logHint").textContent = hasGrid ? `Selected grid: ${logGrid.value}` : "Grid is required to save log.";
}

function saveLog() {
  const grid = document.getElementById("logGrid").value;
  if (!grid) return;
  setSelectedGrid(grid);
  const backlogBefore = calculateKPIs().backlog;
  const avgBefore = calculateKPIs().avg;

  const outcome = document.getElementById("logOutcome").value;
  state.logs.push({
    created_at: Date.now(),
    org_id: "demo-org",
    grid_id: grid,
    action: document.getElementById("logAction").value,
    outcome,
  });

  if (outcome === "resolved") {
    const target = state.signals
      .filter((s) => s.grid_id === grid && s.status === "open")
      .sort((a, b) => a.created_at - b.created_at)[0];
    if (target) target.status = "closed";
  }

  saveState(state);
  renderAll(true);
  closeLogModal();

  const nowKpi = calculateKPIs();
  showToast(`Log saved · Backlog ${backlogBefore}→${nowKpi.backlog}, Avg ${avgBefore}→${nowKpi.avg}`);
  flash("kpi");
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

document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => setScreen(btn.dataset.screen)));

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
  setSelectedGrid(e.target.value || null);
  syncLogGrid();
});

document.getElementById("resourceBoard").addEventListener("change", (e) => {
  const id = e.target.dataset.id;
  const field = e.target.dataset.field;
  if (!id || !field) return;

  state.resources = state.resources.map((r) => {
    if (r.resource_id !== id) return r;
    return { ...r, [field]: field === "capacity_score" ? Number(e.target.value) : e.target.value, updated_at: Date.now() };
  });
  saveState(state);
  highlight.resource = id;
  highlight.priority = computePriority()[0]?.grid_id || null;
  renderAll();
  flash("resource", id);
  flash("priority", highlight.priority);
  showToast(`Resource updated · Capacity now ${getCapacity().toFixed(1)} (priority reordered)`);
});

document.getElementById("resetDemo").addEventListener("click", () => {
  state = seededState();
  saveState(state);
  renderAll();
  showToast("Demo data reset");
});

syncLogGrid();
updateSelectedChip();
toggleRequestButton();
renderAll();
