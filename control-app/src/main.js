const { invoke, } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let ws = null;

function addToLog(message, type) {
  const log = document.getElementById('websocket-log');
  const entry = document.createElement('div');
  const timestamp = new Date().toLocaleTimeString();

  entry.innerHTML = `<span class="text-muted">[${timestamp}]</span> 
    <span class="${type === 'sent' ? 'text-danger' : 'text-success'}">${type === 'sent' ? 'App' : 'Pico'}:</span> 
    ${JSON.stringify(message)}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

document.getElementById('clear-log-btn').addEventListener('click', () => {
  document.getElementById('websocket-log').innerHTML = '';
});

// Fan speed slider
const fanSpeedSlider = document.getElementById('fan-speed-slider');
const fanSpeedValueEl = document.getElementById('fan-speed-value');

function updateSliderBackground() {
  const percentage = (fanSpeedSlider.value - fanSpeedSlider.min) / (fanSpeedSlider.max - fanSpeedSlider.min) * 100;
  fanSpeedSlider.style.background = `linear-gradient(to right, var(--bs-primary, #4680ff) ${percentage}%, #e9ecef ${percentage}%)`;
}

// Set initial slider fill
updateSliderBackground();

fanSpeedSlider.addEventListener('input', () => {
  if (document.activeElement !== fanSpeedValueEl) {
    fanSpeedValueEl.textContent = fanSpeedSlider.value;
  }
  updateSliderBackground();
});

fanSpeedSlider.addEventListener('change', () => {
  if (!ws) return;
  ws.send(JSON.stringify({ action: 'set_fan_speed', speed: Number(fanSpeedSlider.value) }));
});

fanSpeedValueEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    fanSpeedValueEl.blur(); // Blur triggers the change logic
  }
});

fanSpeedValueEl.addEventListener('blur', () => {
  let val = parseInt(fanSpeedValueEl.textContent);
  if (isNaN(val)) {
    val = Number(fanSpeedSlider.value);
  } else {
    val = Math.max(0, Math.min(100, val));
  }
  
  fanSpeedValueEl.textContent = val;
  
  if (Number(fanSpeedSlider.value) !== val) {
    fanSpeedSlider.value = val;
    updateSliderBackground();
    
    if (ws) {
      ws.send(JSON.stringify({ action: 'set_fan_speed', speed: val }));
    }
  }
});


function updateConnectButton(connected) {
  const connectBtn = document.getElementById("connect-btn");
  const connectBtnText = document.getElementById("connect-btn-text");

  if (connected) {
    connectBtn.classList.remove("btn-success");
    connectBtn.classList.add("btn-danger");
    connectBtnText.textContent = "Close WebSocket Connection";
  } else {
    connectBtn.classList.remove("btn-danger");
    connectBtn.classList.add("btn-success");
    connectBtnText.textContent = "Open WebSocket Connection";
  }
}

async function connectWs(url) {
  ws = new WebSocket(url);

  ws.onopen = () => {
    document.getElementById("status").textContent = "Connected";
    statusDot.classList.add("bg-success");
    statusDot.classList.remove("bg-danger");
    updateConnectButton(true);
    addToLog('Connection established', 'received');
  };

  ws.onclose = () => {
    console.log('WebSocket connection closed');
    statusDot.classList.remove("bg-success");
    statusDot.classList.add("bg-danger");
    document.getElementById("status").textContent = "Disconnected";
    updateConnectButton(false);
    ws = null;
  };

  ws.onmessage = event => {
    const data = JSON.parse(event.data);
    addToLog(data, 'received');

    if (data.type === "telemetry") {
      const fmtTel = (v, unit, decimals = 4) => (v != null ? `${Number(v).toFixed(decimals)} ${unit}` : `- ${unit}`);
      document.getElementById('fan-status').innerText = fmtTel(data.fan_speed, '%', 0);
      document.getElementById('uptime').innerText = fmtTel(data.uptime, 's', 0);
      document.getElementById('speed-display').innerText = fmtTel(data.air_speed, 'm/s', 2);
      document.getElementById('voltage').innerText = fmtTel(data.voltage, 'V', 2);
      document.getElementById('resistance').innerText = fmtTel(data.resistance, 'Ω', 0);
      document.getElementById('power').innerText = fmtTel(data.power, 'mW', 2);

      // Feed telemetry into the live graph when recording
      if (window.liveGraph && window.liveGraph.isRecording) {
        window.liveGraph.addTelemetryPoint(data);
      }
    }

    // Dedicated graph_data message: { type: "graph_data", x_label, y_label, series: { name: value, ... } }
    if (data.type === "graph_data") {
      if (window.liveGraph && window.liveGraph.isRecording) {
        window.liveGraph.addGraphDataPoint(data);
      }
    }

    if (data.type === "settings") {
      const fmt = v => (v != null ? Number(v).toFixed(4) : '—');
      document.getElementById('kp-current').innerText = fmt(data.Kp);
      document.getElementById('ki-current').innerText = fmt(data.Ki);
      document.getElementById('kd-current').innerText = fmt(data.Kd);
      document.getElementById('baseline-current').innerText = fmt(data.sensor_baseline);
      document.getElementById('division-current').innerText = fmt(data.division_ratio);
      document.getElementById('density-current').innerText = fmt(data.air_density);
    }

  };
  ws.onerror = error => {
    console.error(error);
    document.getElementById("status").textContent = "Disconnected";
    statusDot.classList.remove("bg-success");
    statusDot.classList.add("bg-danger");
    updateConnectButton(false);
    ws = null;
  };
  const originalSend = ws.send;
  ws.send = function (data) {
    addToLog(JSON.parse(data), 'sent');
    originalSend.call(this, data);
  };
};

async function scan() {
  const loading = document.getElementById('loading');
  const noNetworks = document.getElementById('no-networks');
  const ssidsList = document.getElementById('wifi-ssids');
  const template = document.getElementById('wifi-network-template');

  loading.classList.remove('d-none');
  ssidsList.innerHTML = '';
  noNetworks.classList.add('d-none');

  try {
    const wifiSSIDs = await invoke("scan");
    loading.classList.add('d-none');

    if (wifiSSIDs.length === 0) {
      noNetworks.classList.remove('d-none');
      return;
    }

    let searchTerm = "Fast Shitbox"
    wifiSSIDs.sort((a, b) => {
      const aIncludes = a.toLowerCase().includes(searchTerm.toLowerCase());
      const bIncludes = b.toLowerCase().includes(searchTerm.toLowerCase());

      if (aIncludes && !bIncludes) return -1; // Move 'a' up
      if (!aIncludes && bIncludes) return 1;  // Move 'b' up
      return 0;
    }).forEach(ssid => {
      const networkItem = template.content.cloneNode(true);
      networkItem.querySelector('.network-name').textContent = ssid;

      const connectBtn = networkItem.querySelector('button');
      connectBtn.addEventListener('click', async () => {
        connectToWifi(ssid)
      });

      ssidsList.appendChild(networkItem);
    });

  } catch (error) {
    console.error('Error scanning networks:', error);
    loading.classList.add('d-none');
    noNetworks.textContent = 'Error scanning networks. Please try again.';
    noNetworks.classList.remove('d-none');
  }
}

async function connectToWifi(ssid) {
  const res = await invoke("connect", { ssid })
  console.log(res)
};

let ssids, loading, ipInput, statusDot

// Initial setup when the page loads
window.addEventListener("DOMContentLoaded", () => {
  persistInputs()

  const connectBtn = document.querySelector("#connect-btn");
  const scanBtn = document.querySelector("#scan-btn")
  const sensorsBtn = document.querySelector("#monitor-btn")
  const getSettingsBtn = document.querySelector("#get-settings-btn")
  const applySettingsBtn = document.querySelector("#apply-settings-btn")
  const calibrateBtn = document.querySelector("#calibrate-dps")
  const testBtn = document.querySelector("#send-test")
  const startFanBtn = document.querySelector("#start-fan")

  loading = document.querySelector("#loading")
  loading.classList.add("d-none")

  ssids = document.querySelector("#wifi-ssids")
  ipInput = document.querySelector("#ip-input")
  statusDot = document.querySelector("#status-dot")

  scanBtn?.addEventListener("click", () => {
    scan()
  })
  connectBtn?.addEventListener("click", async () => {
    if (ws) {
      ws.close();
      console.log('WebSocket connection closed');
      statusDot.classList.remove("bg-success");
      statusDot.classList.add("bg-danger");
      document.getElementById("status").textContent = "Disconnected";
      updateConnectButton(false);
      ws = null;
      return;
    } else {
      const wsUrl = `ws://${ipInput.value}/ws`;
      console.log("Connect to", wsUrl);
      connectWs(wsUrl);
    }
  });

  ipInput?.addEventListener("keyup", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connectBtn?.click();
    }
  });

  sensorsBtn?.addEventListener("click", async () => {
    if (!ws) return;

    // Toggle monitoring state
    const isCurrentlyMonitoring = sensorsBtn.getAttribute("data-monitoring") === "true";
    const newMonitoringState = !isCurrentlyMonitoring;

    // Update button appearance
    if (newMonitoringState) {
      sensorsBtn.classList.remove("btn-success");
      sensorsBtn.classList.add("btn-danger");
      sensorsBtn.textContent = "Stop Monitoring";
    } else {
      sensorsBtn.classList.remove("btn-danger");
      sensorsBtn.classList.add("btn-success");
      sensorsBtn.textContent = "Start Monitoring";
    }

    // Update data attribute
    sensorsBtn.setAttribute("data-monitoring", newMonitoringState);

    // Send command to server
    ws.send(JSON.stringify({ action: newMonitoringState ? "start_monitor" : "stop_monitor" }));

    // If starting monitoring, clear previous values
    if (newMonitoringState) {
      document.getElementById("left-sensor-value").textContent = "--";
      document.getElementById("right-sensor-value").textContent = "--";
      document.getElementById("back-sensor-value").textContent = "--";
    }
  });

  startFanBtn?.addEventListener("click", async () => {
    if (!ws) return;

    // Toggle fan active state
    const isCurrentlyActive = startFanBtn.getAttribute("data-fan-active") === "true";
    const newActiveState = !isCurrentlyActive;

    // Update button appearance
    if (newActiveState) {
      startFanBtn.classList.remove("btn-success");
      startFanBtn.classList.add("btn-danger");
      startFanBtn.textContent = "Stop Fan";
    } else {
      startFanBtn.classList.remove("btn-danger");
      startFanBtn.classList.add("btn-success");
      startFanBtn.textContent = "Start Fan";
    }

    // Update data attribute
    startFanBtn.setAttribute("data-fan-active", newActiveState);

    // Send command to server
    ws.send(JSON.stringify({ action: newActiveState ? "start_fan" : "stop_fan" }));
  });

  getSettingsBtn?.addEventListener("click", () => {
    if (!ws) return;
    ws.send(JSON.stringify({ action: "send_settings" }));
  });

  applySettingsBtn?.addEventListener("click", () => {
    if (!ws) return;
    ws.send(JSON.stringify({
      action: "new_settings",
      sensor_baseline: Number(document.getElementById("baseline-value").value),
      Kp: Number(document.getElementById("kp-value").value),
      Ki: Number(document.getElementById("ki-value").value),
      Kd: Number(document.getElementById("kd-value").value),
      division_ratio: Number(document.getElementById("division-value").value),
      air_density: Number(document.getElementById("density-value").value),
    }));
  });

  testBtn?.addEventListener("click", async () => {
    if (!ws) return
    ws.send(JSON.stringify({ type: "telemetry", fan_speed: 20, power: 40, uptime: 100 }))
  });

  calibrateBtn?.addEventListener("click", async () => {
    if (!ws) return;

    // Show a loading state on the button
    calibrateBtn.disabled = true;
    calibrateBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Calibrating...';

    // Send calibration command
    ws.send(JSON.stringify({ action: "calibrate" }));

    // Reset button after 3 seconds (even if no response)
    setTimeout(() => {
      calibrateBtn.disabled = false;
      calibrateBtn.textContent = "Calibrate DPS";
    }, 3000);
  });

  // ── Live Graph setup ──────────────────────────────────────────────
  initLiveGraph();
});


// Persist individual input values to localStorage.
// Each input uses its own key: "input:<id>".
// Legacy "pid" key is migrated on first load.
const PERSISTED_INPUTS = [
  'kp-value',
  'ki-value',
  'kd-value',
  'baseline-value',
  'division-value',
  'density-value',
];

function persistInputs() {
  // Migrate old "pid" bundle into individual keys
  const oldPID = localStorage.getItem('pid');
  if (oldPID) {
    try {
      const { P, I, D } = JSON.parse(oldPID);
      if (P != null && !localStorage.getItem('input:kp-value')) localStorage.setItem('input:kp-value', P);
      if (I != null && !localStorage.getItem('input:ki-value')) localStorage.setItem('input:ki-value', I);
      if (D != null && !localStorage.getItem('input:kd-value')) localStorage.setItem('input:kd-value', D);
    } catch { }
    localStorage.removeItem('pid');
  }

  PERSISTED_INPUTS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    // Restore saved value
    const saved = localStorage.getItem(`input:${id}`);
    if (saved !== null) el.value = saved;

    // Save on every change (fires when user commits a value)
    el.addEventListener('change', () => {
      localStorage.setItem(`input:${id}`, el.value);
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Live Graph Engine
// ══════════════════════════════════════════════════════════════════════════════

const GRAPH_COLORS = [
  '#4680ff', // blue
  '#ff6b6b', // red
  '#51cf66', // green
  '#fcc419', // yellow
  '#cc5de8', // purple
  '#20c997', // teal
  '#ff922b', // orange
  '#748ffc', // indigo
];

// Map of known telemetry keys → friendly label + unit
const TELEMETRY_FIELDS = {
  voltage:   { label: 'Voltage',   unit: 'V' },
  power:     { label: 'Power',     unit: 'mW' },
  air_speed: { label: 'Airspeed',  unit: 'm/s' },
  fan_speed: { label: 'Fan Speed', unit: '%' },
  resistance:{ label: 'Resistance',unit: 'Ω' },
};

class LiveGraph {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.tooltip = null;

    // Data state
    this.series = {};          // { seriesName: { color, label, unit, points: [{x, y}] } }
    this.seriesOrder = [];     // insertion-order of series names
    this.hiddenSeries = new Set(); // series toggled off by the user
    this.isRecording = false;
    this.startTime = 0;       // ms timestamp of first data point
    this.xLabel = 'Time (s)';
    this.yLabel = 'Value';

    // Layout constants (in CSS pixels; canvas resolution uses DPR)
    this.pad = { top: 18, right: 62, bottom: 56, left: 62 };

    // Animation frame ID
    this._rafId = null;

    // Hover state
    this._hoverX = null;

    this._initTooltip();
    this._bindResize();
    this._bindHover();
    this._resize();
    this._drawEmpty();
  }

  // ── Tooltip DOM ──────────────────────────────────────────────────
  _initTooltip() {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'graph-tooltip';
    this.canvas.parentElement.appendChild(this.tooltip);
  }

  // ── Resize handling ─────────────────────────────────────────────
  _bindResize() {
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.canvas.parentElement);
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = w;
    this.cssH = h;
    this._scheduleFrame();
  }

  // ── Hover / tooltip ─────────────────────────────────────────────
  _bindHover() {
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this._hoverX = e.clientX - rect.left;
      this._hoverY = e.clientY - rect.top;
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._hoverX = null;
      this._hoverY = null;
      this.tooltip.classList.remove('visible');
    });
  }

  // ── Data methods ────────────────────────────────────────────────
  _getOrCreateSeries(name, label, unit) {
    if (!this.series[name]) {
      const colorIdx = this.seriesOrder.length % GRAPH_COLORS.length;
      this.series[name] = {
        color: GRAPH_COLORS[colorIdx],
        label: label || name,
        unit: unit || '',
        points: [],
      };
      this.seriesOrder.push(name);
      this._updateLegend();
    }
    return this.series[name];
  }

  /** Called when a telemetry message arrives while recording. */
  addTelemetryPoint(data) {
    if (!this.isRecording) return;
    const now = Date.now();
    if (this.startTime === 0) this.startTime = now;
    const t = (now - this.startTime) / 1000; // seconds

    for (const key of Object.keys(TELEMETRY_FIELDS)) {
      if (data[key] != null) {
        const { label, unit } = TELEMETRY_FIELDS[key];
        const s = this._getOrCreateSeries(key, label, unit);
        s.points.push({ x: t, y: Number(data[key]) });
      }
    }

    this._scheduleFrame();
  }

  /** Called when a graph_data message arrives while recording.
   *  Expected shape: { type:"graph_data", x_label?, y_label?, series: { name: value } } */
  addGraphDataPoint(data) {
    if (!this.isRecording) return;
    const now = Date.now();
    if (this.startTime === 0) this.startTime = now;
    const t = (now - this.startTime) / 1000;

    if (data.x_label) this.xLabel = data.x_label;
    if (data.y_label) this.yLabel = data.y_label;

    if (data.series && typeof data.series === 'object') {
      for (const [name, value] of Object.entries(data.series)) {
        const s = this._getOrCreateSeries(name, name, '');
        s.points.push({ x: t, y: Number(value) });
      }
    }

    this._scheduleFrame();
  }

  // ── Legend (clickable to toggle visibility) ────────────────────
  _updateLegend() {
    const container = document.getElementById('graph-legend');
    if (!container) return;
    container.innerHTML = '';
    for (const name of this.seriesOrder) {
      const s = this.series[name];
      const hidden = this.hiddenSeries.has(name);
      const chip = document.createElement('span');
      chip.className = 'graph-legend-chip' + (hidden ? ' disabled' : '');
      chip.innerHTML = `<span class="graph-legend-swatch" style="background:${hidden ? '#ccc' : s.color}"></span>${s.label}${s.unit ? ' (' + s.unit + ')' : ''}`;
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', () => {
        if (this.hiddenSeries.has(name)) {
          this.hiddenSeries.delete(name);
        } else {
          this.hiddenSeries.add(name);
        }
        this._updateLegend();
        this._scheduleFrame();
      });
      container.appendChild(chip);
    }
  }

  // ── Start / Stop ───────────────────────────────────────────────
  start() {
    this.isRecording = true;
    document.getElementById('graph-no-data')?.classList.add('hidden');
    this._scheduleFrame();
  }

  stop() {
    this.isRecording = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  clear() {
    this.series = {};
    this.seriesOrder = [];
    this.hiddenSeries.clear();
    this.startTime = 0;
    this.xLabel = 'Time (s)';
    this.yLabel = 'Value';
    this._updateLegend();
    document.getElementById('graph-no-data')?.classList.remove('hidden');
    this._drawEmpty();
  }

  // ── CSV Export ──────────────────────────────────────────────────
  async exportCSV() {
    if (this.seriesOrder.length === 0) return;

    // Collect all unique x values across every series, sorted
    const xSet = new Set();
    for (const name of this.seriesOrder) {
      for (const p of this.series[name].points) xSet.add(p.x);
    }
    const xValues = [...xSet].sort((a, b) => a - b);

    // Build lookup maps for each series: x → y
    const maps = {};
    for (const name of this.seriesOrder) {
      maps[name] = new Map(this.series[name].points.map(p => [p.x, p.y]));
    }

    // Header
    const header = ['Time (s)', ...this.seriesOrder.map(k => {
      const s = this.series[k];
      return s.label + (s.unit ? ` (${s.unit})` : '');
    })];

    // Rows
    const rows = xValues.map(x => {
      const cells = [x.toFixed(3)];
      for (const name of this.seriesOrder) {
        const v = maps[name].get(x);
        cells.push(v != null ? v.toString() : '');
      }
      return cells.join(',');
    });

    const csv = [header.join(','), ...rows].join('\n');

    // Build default filename: WindTunnelGraph_2026-04-18_14-30-52.csv
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const defaultName = `WindTunnelGraph_${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.csv`;

    try {
      // Open native macOS save dialog
      const filePath = await window.__TAURI__.dialog.save({
        defaultPath: defaultName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });

      if (filePath) {
        await window.__TAURI__.fs.writeTextFile(filePath, csv);
        console.log('CSV saved to', filePath);
      }
    } catch (err) {
      console.error('CSV export failed:', err);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────
  _scheduleFrame() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._draw();
    });
  }

  _drawEmpty() {
    const { ctx, cssW: w, cssH: h } = this;
    ctx.clearRect(0, 0, w, h);
  }

  _draw() {
    const { ctx, cssW: w, cssH: h, pad } = this;
    ctx.clearRect(0, 0, w, h);

    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    if (plotW <= 0 || plotH <= 0) return;

    // ── Visible series only ──────────────────────────────────────
    const visibleNames = this.seriesOrder.filter(n => !this.hiddenSeries.has(n));

    // Global X bounds (across all visible series)
    let xMin = Infinity, xMax = -Infinity;
    for (const name of visibleNames) {
      for (const p of this.series[name].points) {
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
      }
    }

    if (!isFinite(xMin)) {
      // No visible data — keep animation loop alive if recording
      if (this.isRecording) {
        this._rafId = requestAnimationFrame(() => { this._rafId = null; this._draw(); });
      }
      return;
    }
    if (xMax === xMin) { xMin -= 0.5; xMax += 0.5; }

    // ── Split visible series into left / right Y-axis groups ────
    const { leftNames, rightNames } = this._splitAxes(visibleNames);
    const hasDualAxes = rightNames.length > 0;

    // Compute Y-bounds per group
    const yBounds = (names) => {
      let lo = Infinity, hi = -Infinity;
      for (const n of names) {
        for (const p of this.series[n].points) {
          if (p.y < lo) lo = p.y;
          if (p.y > hi) hi = p.y;
        }
      }
      const range = hi - lo || 1;
      lo -= range * 0.08;
      hi += range * 0.08;
      return { lo, hi };
    };

    const leftBounds  = leftNames.length  > 0 ? yBounds(leftNames)  : null;
    const rightBounds = rightNames.length > 0 ? yBounds(rightNames) : null;

    // Build a map: seriesName → 'left' | 'right'
    const axisOf = {};
    for (const n of leftNames)  axisOf[n] = 'left';
    for (const n of rightNames) axisOf[n] = 'right';

    // Mapping helpers
    const mapX = (v) => pad.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const makeMapY = (bounds) => bounds
      ? (v) => pad.top + plotH - ((v - bounds.lo) / (bounds.hi - bounds.lo)) * plotH
      : null;
    const mapYL = makeMapY(leftBounds);
    const mapYR = makeMapY(rightBounds);
    const getMapY = (name) => axisOf[name] === 'right' ? mapYR : mapYL;

    // ── Grid + axes ──────────────────────────────────────────────
    ctx.save();
    const FONT_TICK = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const FONT_LABEL = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const LABEL_COLOR = '#8a92a3';

    // ── Left Y-axis ticks ────────────────────────────────────────
    if (leftBounds) {
      const ticks = this._niceTicks(leftBounds.lo, leftBounds.hi, 5);
      // Determine left-axis color (single series → that color, else grey)
      const leftColor = leftNames.length === 1 ? this.series[leftNames[0]].color : LABEL_COLOR;
      ctx.strokeStyle = '#e9ecef';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = FONT_TICK;
      ctx.fillStyle = leftColor;
      for (const v of ticks) {
        const y = Math.round(mapYL(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
        ctx.fillText(this._fmtTickValue(v), pad.left - 6, y);
      }
      // Left axis label (rotated)
      const leftUnits = [...new Set(leftNames.map(n => this.series[n].unit).filter(Boolean))];
      const leftLabel = leftUnits.join(' / ') || 'Value';
      ctx.font = FONT_LABEL;
      ctx.fillStyle = leftColor;
      ctx.save();
      ctx.translate(12, pad.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(leftLabel, 0, 0);
      ctx.restore();
    }

    // ── Right Y-axis ticks (only when dual axes) ─────────────────
    if (rightBounds) {
      const ticks = this._niceTicks(rightBounds.lo, rightBounds.hi, 5);
      const rightColor = rightNames.length === 1 ? this.series[rightNames[0]].color : LABEL_COLOR;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = FONT_TICK;
      ctx.fillStyle = rightColor;
      ctx.strokeStyle = '#e9ecef';
      ctx.setLineDash([4, 4]);
      for (const v of ticks) {
        const y = Math.round(mapYR(v)) + 0.5;
        // Don't re-draw grid lines, just tick labels on the right
        ctx.fillText(this._fmtTickValue(v), w - pad.right + 6, y);
      }
      // Right axis label (rotated)
      const rightUnits = [...new Set(rightNames.map(n => this.series[n].unit).filter(Boolean))];
      const rightLabel = rightUnits.join(' / ') || 'Value';
      ctx.font = FONT_LABEL;
      ctx.fillStyle = rightColor;
      ctx.save();
      ctx.translate(w - 10, pad.top + plotH / 2);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(rightLabel, 0, 0);
      ctx.restore();
    }
    ctx.setLineDash([]);

    // ── X-axis ticks ─────────────────────────────────────────────
    ctx.strokeStyle = '#e9ecef';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    const xTicks = this._niceTicks(xMin, xMax, 6);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = FONT_TICK;
    ctx.fillStyle = LABEL_COLOR;
    for (const v of xTicks) {
      const x = Math.round(mapX(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
      ctx.fillText(this._fmtTickValue(v), x, h - pad.bottom + 6);
    }
    ctx.setLineDash([]);

    // X axis label
    ctx.font = FONT_LABEL;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'center';
    ctx.fillText(this.xLabel, pad.left + plotW / 2, h - 6);

    // Plot border
    ctx.strokeStyle = '#dee2e6';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    // ── Draw series ──────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, plotW, plotH);
    ctx.clip();

    for (const name of visibleNames) {
      const s = this.series[name];
      if (s.points.length === 0) continue;
      const myMapY = getMapY(name);

      // Line
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const px = mapX(s.points[i].x);
        const py = myMapY(s.points[i].y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Data points (small dots)
      ctx.fillStyle = s.color;
      for (const p of s.points) {
        const px = mapX(p.x);
        const py = myMapY(p.y);
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore(); // clip
    ctx.restore(); // global save

    // ── Hover crosshair + tooltip ────────────────────────────────
    if (this._hoverX != null && this._hoverX >= pad.left && this._hoverX <= w - pad.right) {
      const dataX = xMin + ((this._hoverX - pad.left) / plotW) * (xMax - xMin);

      // Draw vertical crosshair
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(this._hoverX, pad.top);
      ctx.lineTo(this._hoverX, h - pad.bottom);
      ctx.stroke();
      ctx.restore();

      // Build tooltip content → find closest point in each visible series
      let tooltipParts = [`<strong>${this._fmtTickValue(dataX)} s</strong>`];
      for (const name of visibleNames) {
        const s = this.series[name];
        const closest = this._closestPoint(s.points, dataX);
        if (closest) {
          const side = hasDualAxes ? (axisOf[name] === 'right' ? ' ▸' : ' ◂') : '';
          tooltipParts.push(
            `<span style="color:${s.color}">${s.label}:</span> ${this._fmtTickValue(closest.y)}${s.unit ? ' ' + s.unit : ''}${side}`
          );

          // Highlight dot
          const myMapY = getMapY(name);
          const px = mapX(closest.x);
          const py = myMapY(closest.y);
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(px, py, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      this.tooltip.innerHTML = tooltipParts.join('<br>');
      this.tooltip.classList.add('visible');

      // Position tooltip
      const ttW = this.tooltip.offsetWidth;
      const ttH = this.tooltip.offsetHeight;
      let tx = this._hoverX + 14;
      let ty = (this._hoverY || pad.top) - ttH / 2;
      if (tx + ttW > w - 4) tx = this._hoverX - ttW - 14;
      if (ty < 4) ty = 4;
      if (ty + ttH > h - 4) ty = h - ttH - 4;
      this.tooltip.style.left = tx + 'px';
      this.tooltip.style.top = ty + 'px';
    } else {
      this.tooltip.classList.remove('visible');
    }

    // Keep drawing while recording (animation loop)
    if (this.isRecording) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        this._draw();
      });
    }
  }

  // ── Dual Y-axis splitting ─────────────────────────────────────
  // Groups visible series by magnitude: if the largest series' max
  // is >5× the smallest, split at the biggest gap (log scale).
  _splitAxes(visibleNames) {
    if (visibleNames.length < 2) return { leftNames: visibleNames, rightNames: [] };

    // Peak absolute value per series
    const peak = {};
    for (const n of visibleNames) {
      let mx = 0;
      for (const p of this.series[n].points) {
        const a = Math.abs(p.y);
        if (a > mx) mx = a;
      }
      peak[n] = mx || 1;
    }

    const sorted = [...visibleNames].sort((a, b) => peak[a] - peak[b]);
    const lo = peak[sorted[0]];
    const hi = peak[sorted[sorted.length - 1]];

    // Only split if the range spans more than 5×
    if (hi / Math.max(lo, 1e-9) <= 5) {
      return { leftNames: sorted, rightNames: [] };
    }

    // Find the largest ratio gap between consecutive sorted maxes
    let bestGap = 0, bestIdx = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const ratio = peak[sorted[i + 1]] / Math.max(peak[sorted[i]], 1e-9);
      if (ratio > bestGap) { bestGap = ratio; bestIdx = i; }
    }

    return {
      leftNames:  sorted.slice(0, bestIdx + 1),
      rightNames: sorted.slice(bestIdx + 1),
    };
  }

  // ── Utilities ──────────────────────────────────────────────────
  _closestPoint(points, targetX) {
    if (points.length === 0) return null;
    let best = points[0];
    let bestDist = Math.abs(points[0].x - targetX);
    for (let i = 1; i < points.length; i++) {
      const d = Math.abs(points[i].x - targetX);
      if (d < bestDist) { best = points[i]; bestDist = d; }
    }
    return best;
  }

  _niceTicks(min, max, targetCount) {
    const range = max - min;
    if (range === 0) return [min];
    const rough = range / targetCount;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const niceStep = [1, 2, 5, 10].map(m => m * pow).find(s => range / s <= targetCount * 1.5) || rough;
    const ticks = [];
    let v = Math.ceil(min / niceStep) * niceStep;
    while (v <= max + niceStep * 0.001) {
      ticks.push(v);
      v += niceStep;
    }
    return ticks;
  }

  _fmtTickValue(v) {
    if (Math.abs(v) >= 1000) return v.toFixed(0);
    if (Math.abs(v) >= 1) return v.toFixed(1);
    if (Math.abs(v) >= 0.01) return v.toFixed(2);
    return v.toFixed(3);
  }
}

// ── Wire everything up ──────────────────────────────────────────
function initLiveGraph() {
  const graph = new LiveGraph('graph-canvas');
  window.liveGraph = graph;

  const toggleBtn = document.getElementById('graph-toggle-btn');
  const toggleText = document.getElementById('graph-toggle-text');
  const clearBtn = document.getElementById('graph-clear-btn');
  const exportBtn = document.getElementById('graph-export-btn');

  toggleBtn?.addEventListener('click', () => {
    const active = toggleBtn.getAttribute('data-graphing') === 'true';
    if (!active) {
      // Start graphing
      graph.start();
      toggleBtn.setAttribute('data-graphing', 'true');
      toggleBtn.classList.remove('btn-success');
      toggleBtn.classList.add('btn-danger');
      toggleText.textContent = 'Stop Graphing';
      toggleBtn.querySelector('i').className = 'ti ti-player-stop me-1';

      // Send WS start_graphing message
      if (ws) ws.send(JSON.stringify({ action: 'start_graphing' }));
    } else {
      // Stop graphing
      graph.stop();
      toggleBtn.setAttribute('data-graphing', 'false');
      toggleBtn.classList.remove('btn-danger');
      toggleBtn.classList.add('btn-success');
      toggleText.textContent = 'Start Graphing';
      toggleBtn.querySelector('i').className = 'ti ti-player-play me-1';

      // Send WS stop_graphing message
      if (ws) ws.send(JSON.stringify({ action: 'stop_graphing' }));
    }
  });

  clearBtn?.addEventListener('click', () => {
    graph.clear();
  });

  exportBtn?.addEventListener('click', () => {
    graph.exportCSV();
  });
}
