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
  ws.send(JSON.stringify({ action: 'set_fan_speed', speed: parseInt(fanSpeedSlider.value, 10) }));
});

fanSpeedValueEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    fanSpeedValueEl.blur(); // Blur triggers the change logic
  }
});

fanSpeedValueEl.addEventListener('blur', () => {
  let val = parseInt(fanSpeedValueEl.textContent, 10);
  if (isNaN(val)) {
    val = parseInt(fanSpeedSlider.value, 10);
  } else {
    val = Math.max(0, Math.min(100, Math.round(val)));
  }

  fanSpeedValueEl.textContent = val;

  if (parseInt(fanSpeedSlider.value, 10) !== val) {
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
    }

    // Scatter plot data from Pico: { type: "plot_data", airspeed: number, power: number }
    if (data.type === "plot_data") {
      if (window.liveGraph && window.liveGraph.isRecording && data.airspeed != null && data.power != null) {
        const pitchSelect = document.getElementById('pitch-angle-select');
        const pitch = pitchSelect ? Number(pitchSelect.value) : 0;
        window.liveGraph.addScatterPoint(data.airspeed, data.power, pitch);
      }
    }

    if (data.type === "settings") {
      const fmt = v => (v != null ? Number(v).toFixed(4) : '—');
      document.getElementById('kp-current').innerText = fmt(data.Kp);
      document.getElementById('ki-current').innerText = fmt(data.Ki);
      document.getElementById('kd-current').innerText = fmt(data.Kd);
      document.getElementById('shunt-current').innerText = data.shunt_value;
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
      Kp: Number(document.getElementById("kp-value").value),
      Ki: Number(document.getElementById("ki-value").value),
      Kd: Number(document.getElementById("kd-value").value),
      shunt_value: Number(document.getElementById("shunt-value").value),
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
  'shunt-value',
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
// Scatter Plot Engine — Power vs Airspeed, coloured by Pitch Angle
// ══════════════════════════════════════════════════════════════════════════════

// One colour per pitch-angle value (0°–30° in 5° steps)
const PITCH_COLORS = {
  0: '#4680ff',   // blue
  5: '#51cf66',   // green
  10: '#fcc419',   // yellow
  15: '#ff922b',   // orange
  20: '#ff6b6b',   // red
  25: '#cc5de8',   // purple
  30: '#20c997',   // teal
};

class LiveGraph {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.tooltip = null;

    // Data state — flat array of { x, y, pitch }
    this.points = [];
    this.isRecording = false;
    this.xLabel = 'Airspeed (m/s)';
    this.yLabel = 'Power (mW)';

    // Which pitch angles are currently hidden by the user
    this.hiddenPitches = new Set();

    // Layout constants (CSS pixels)
    this.pad = { top: 18, right: 20, bottom: 56, left: 62 };

    this._rafId = null;
    this._hoverX = null;
    this._hoverY = null;

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
      this._scheduleFrame();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._hoverX = null;
      this._hoverY = null;
      this.tooltip.classList.remove('visible');
      this._scheduleFrame();
    });
  }

  // ── Data methods ────────────────────────────────────────────────

  /** Called when a scatter data point arrives while recording.
   *  data = { target_airspeed: number, measured_power: number }
   *  pitchAngle comes from the UI selector. */
  addScatterPoint(airspeed, power, pitchAngle) {
    if (!this.isRecording) return;
    this.points.push({ x: Number(airspeed), y: Number(power), pitch: Number(pitchAngle) });
    this._updateLegend();
    this._scheduleFrame();
  }

  // ── Legend (clickable to toggle pitch visibility) ──────────────
  _updateLegend() {
    const container = document.getElementById('graph-legend');
    if (!container) return;
    container.innerHTML = '';

    // Collect unique pitch angles present in data, sorted
    const pitches = [...new Set(this.points.map(p => p.pitch))].sort((a, b) => a - b);

    for (const pitch of pitches) {
      const hidden = this.hiddenPitches.has(pitch);
      const color = PITCH_COLORS[pitch] || '#888';
      const chip = document.createElement('span');
      chip.className = 'graph-legend-chip' + (hidden ? ' disabled' : '');
      chip.innerHTML = `<span class="graph-legend-swatch" style="background:${hidden ? '#ccc' : color}"></span>${pitch}°`;
      chip.style.cursor = 'pointer';
      chip.addEventListener('click', () => {
        if (this.hiddenPitches.has(pitch)) {
          this.hiddenPitches.delete(pitch);
        } else {
          this.hiddenPitches.add(pitch);
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
    this.points = [];
    this.hiddenPitches.clear();
    this._updateLegend();
    document.getElementById('graph-no-data')?.classList.remove('hidden');
    this._drawEmpty();
  }

  // ── CSV Export ──────────────────────────────────────────────────
  async exportCSV() {
    if (this.points.length === 0) return;

    const header = ['Airspeed (m/s)', 'Power (mW)', 'Pitch Angle (°)'];
    const rows = this.points.map(p => `${p.x},${p.y},${p.pitch}`);
    const csv = [header.join(','), ...rows].join('\n');

    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const defaultName = `PowerVsAirspeed_${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.csv`;

    try {
      const result = await window.__TAURI__.core.invoke('save_csv', {
        csvContent: csv,
        defaultName: defaultName,
      });
      if (result && result !== 'cancelled') {
        console.log('CSV saved to', result);
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

    // Filter visible points
    const visible = this.points.filter(p => !this.hiddenPitches.has(p.pitch));

    // Compute bounds
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of visible) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }

    if (!isFinite(xMin)) {
      // No visible data
      if (this.isRecording) {
        this._rafId = requestAnimationFrame(() => { this._rafId = null; this._draw(); });
      }
      return;
    }

    // Add padding to bounds
    if (xMax === xMin) { xMin -= 0.5; xMax += 0.5; }
    if (yMax === yMin) { yMin -= 0.5; yMax += 0.5; }
    const xRange = xMax - xMin;
    const yRange = yMax - yMin;
    xMin -= xRange * 0.06; xMax += xRange * 0.06;
    yMin -= yRange * 0.08; yMax += yRange * 0.08;

    // Mapping helpers
    const mapX = (v) => pad.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const mapY = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // ── Grid + axes ──────────────────────────────────────────────
    ctx.save();
    const FONT_TICK = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const FONT_LABEL = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const LABEL_COLOR = '#8a92a3';

    // Y-axis ticks
    const yTicks = this._niceTicks(yMin, yMax, 5);
    ctx.strokeStyle = '#e9ecef';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_TICK;
    ctx.fillStyle = LABEL_COLOR;
    for (const v of yTicks) {
      const y = Math.round(mapY(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillText(this._fmtTickValue(v), pad.left - 6, y);
    }

    // Y-axis label (rotated)
    ctx.font = FONT_LABEL;
    ctx.fillStyle = LABEL_COLOR;
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(this.yLabel, 0, 0);
    ctx.restore();

    // X-axis ticks
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

    // X-axis label
    ctx.font = FONT_LABEL;
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = 'center';
    ctx.fillText(this.xLabel, pad.left + plotW / 2, h - 6);

    // Plot border
    ctx.strokeStyle = '#dee2e6';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    // ── Draw scatter dots ────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, plotW, plotH);
    ctx.clip();

    for (const p of visible) {
      const px = mapX(p.x);
      const py = mapY(p.y);
      const color = PITCH_COLORS[p.pitch] || '#888';

      // Filled dot with subtle border
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore(); // clip
    ctx.restore(); // global save

    // ── Hover tooltip (nearest point) ────────────────────────────
    if (this._hoverX != null && this._hoverX >= pad.left && this._hoverX <= w - pad.right &&
      this._hoverY != null && this._hoverY >= pad.top && this._hoverY <= h - pad.bottom) {

      // Find nearest visible point to cursor
      let best = null, bestDist = Infinity;
      for (const p of visible) {
        const px = mapX(p.x);
        const py = mapY(p.y);
        const d = Math.hypot(px - this._hoverX, py - this._hoverY);
        if (d < bestDist) { bestDist = d; best = p; }
      }

      if (best && bestDist < 30) {
        const px = mapX(best.x);
        const py = mapY(best.y);
        const color = PITCH_COLORS[best.pitch] || '#888';

        // Highlight ring
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Tooltip
        this.tooltip.innerHTML = [
          `<strong style="color:${color}">${best.pitch}° pitch</strong>`,
          `Airspeed: ${this._fmtTickValue(best.x)} m/s`,
          `Power: ${this._fmtTickValue(best.y)} mW`,
        ].join('<br>');
        this.tooltip.classList.add('visible');

        const ttW = this.tooltip.offsetWidth;
        const ttH = this.tooltip.offsetHeight;
        let tx = px + 14;
        let ty = py - ttH / 2;
        if (tx + ttW > w - 4) tx = px - ttW - 14;
        if (ty < 4) ty = 4;
        if (ty + ttH > h - 4) ty = h - ttH - 4;
        this.tooltip.style.left = tx + 'px';
        this.tooltip.style.top = ty + 'px';
      } else {
        this.tooltip.classList.remove('visible');
      }
    } else {
      this.tooltip.classList.remove('visible');
    }

    // Keep drawing while recording
    if (this.isRecording) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        this._draw();
      });
    }
  }

  // ── Utilities ──────────────────────────────────────────────────
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
  const sendDataBtn = document.getElementById('graph-send-data-btn');
  const pitchSelect = document.getElementById('pitch-angle-select');

  toggleBtn?.addEventListener('click', () => {
    const active = toggleBtn.getAttribute('data-graphing') === 'true';
    if (!active) {
      graph.start();
      toggleBtn.setAttribute('data-graphing', 'true');
      toggleBtn.classList.remove('btn-success');
      toggleBtn.classList.add('btn-danger');
      toggleText.textContent = 'Stop Graphing';
      toggleBtn.querySelector('i').className = 'ti ti-player-stop me-1';

      if (ws) ws.send(JSON.stringify({ action: 'start_graphing' }));
    } else {
      graph.stop();
      toggleBtn.setAttribute('data-graphing', 'false');
      toggleBtn.classList.remove('btn-danger');
      toggleBtn.classList.add('btn-success');
      toggleText.textContent = 'Start Graphing';
      toggleBtn.querySelector('i').className = 'ti ti-player-play me-1';

      if (ws) ws.send(JSON.stringify({ action: 'stop_graphing' }));
    }
  });

  sendDataBtn?.addEventListener('click', () => {
    if (!ws) return;
    ws.send(JSON.stringify({ action: 'send_data' }));
  });

  clearBtn?.addEventListener('click', () => {
    graph.clear();
  });

  exportBtn?.addEventListener('click', () => {
    graph.exportCSV();
  });
}

