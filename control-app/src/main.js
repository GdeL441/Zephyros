const { invoke, } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let ws = null;
let pendingFanMode = null;
// True while the user is intentionally tearing down the socket (clicking the
// disconnect button). Distinguishes a clean close from an unexpected drop so
// we only notify on the latter.
let intentionalClose = false;
// Latest telemetry snapshot used by "Collect Data" to capture a scatter
// point without round-tripping to the Pico.
let latestTelemetry = null;

// ── Toast notifications ─────────────────────────────────────────
// Lightweight in-app toast. Levels: 'info' (default) | 'success' | 'warning' | 'danger'.
function showToast(message, { title = '', level = 'info', duration = 5000 } = {}) {
  const container = document.getElementById('toast-container');
  if (!container) {
    console[level === 'danger' ? 'error' : 'log'](title ? `[${title}] ${message}` : message);
    return;
  }
  const ICONS = {
    info:    'ti ti-info-circle',
    success: 'ti ti-circle-check',
    warning: 'ti ti-alert-triangle',
    danger:  'ti ti-plug-connected-x',
  };
  const toast = document.createElement('div');
  toast.className = `app-toast toast-${level}`;
  toast.innerHTML = `
    <i class="${ICONS[level] || ICONS.info} toast-icon"></i>
    <div class="toast-body">
      ${title ? `<div class="toast-title">${title}</div>` : ''}
      <div class="toast-message"></div>
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss">×</button>
  `;
  toast.querySelector('.toast-message').textContent = message;

  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };
  toast.querySelector('.toast-close').addEventListener('click', remove);
  container.appendChild(toast);
  if (duration > 0) setTimeout(remove, duration);
}

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

let currentSliderMode = 'percent';

function updateSliderMode(mode) {
  if (currentSliderMode === mode) return;
  currentSliderMode = mode;

  const unitEl = document.getElementById('fan-speed-unit');
  if (!unitEl) return;

  if (mode === 'percent') {
    fanSpeedSlider.min = 0;
    fanSpeedSlider.max = 100;
    fanSpeedSlider.step = 1;
    unitEl.textContent = '%';
    // Reset to 0 when coming back from PID
    fanSpeedSlider.value = 0;
    fanSpeedValueEl.textContent = '0';
  } else if (mode === 'pid') {
    fanSpeedSlider.min = 0;
    fanSpeedSlider.max = 10;
    fanSpeedSlider.step = 0.1;
    unitEl.textContent = 'm/s';
    // Default to 5 m/s (matches backend default setpoint)
    fanSpeedSlider.value = 5;
    fanSpeedValueEl.textContent = '5.0';
  }

  updateSliderBackground();
}

function setFanModeButton(mode) {
  const fanModeBtn = document.getElementById('fan-control-mode-btn');
  if (!fanModeBtn) return;
  if (mode === 'percent') {
    fanModeBtn.textContent = 'Percentage';
    fanModeBtn.className = 'btn btn-primary flex-grow-1';
    fanModeBtn.setAttribute('data-mode', 'percent');
    updateSliderMode('percent');
  } else if (mode === 'pid') {
    fanModeBtn.textContent = 'PID';
    fanModeBtn.className = 'btn btn-success flex-grow-1';
    fanModeBtn.setAttribute('data-mode', 'pid');
    updateSliderMode('pid');
  }
}

function setDimmerCurveButton(mode) {
  const btn = document.getElementById('dimmer-curve-mode-btn');
  if (!btn) return;
  if (mode === 'rms') {
    btn.textContent = 'Dimmer curve: RMS';
    btn.className = 'btn btn-warning w-100 mt-2';
    btn.setAttribute('data-mode', 'rms');
  } else if (mode === 'linear') {
    btn.textContent = 'Dimmer curve: LINEAR';
    btn.className = 'btn btn-outline-secondary w-100 mt-2';
    btn.setAttribute('data-mode', 'linear');
  } else {
    btn.textContent = 'Dimmer curve: UNKNOWN';
    btn.className = 'btn btn-outline-dark w-100 mt-2';
    btn.setAttribute('data-mode', 'unknown');
  }
}

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
  let val = Number(fanSpeedValueEl.textContent);
  if (isNaN(val)) {
    val = Number(fanSpeedSlider.value);
  } else {
    val = Math.max(Number(fanSpeedSlider.min), Math.min(Number(fanSpeedSlider.max), val));
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

// Global left/right arrow keys nudge the fan speed by one slider step
// (1% in percent mode, 0.1 m/s in PID mode). Skipped while the user is
// typing in an input, textarea, or the contenteditable speed value.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const target = e.target;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (target?.isContentEditable) return;

  const step = Number(fanSpeedSlider.step) || 1;
  const min = Number(fanSpeedSlider.min);
  const max = Number(fanSpeedSlider.max);
  const current = Number(fanSpeedSlider.value);
  const delta = e.key === 'ArrowRight' ? step : -step;
  let next = current + delta;
  // Avoid binary-float drift like 5.1 + 0.1 = 5.199999…
  next = Math.round(next / step) * step;
  next = Math.max(min, Math.min(max, next));
  if (next === current) return;

  e.preventDefault();
  fanSpeedSlider.value = next;
  const decimals = currentSliderMode === 'pid' ? 1 : 0;
  fanSpeedValueEl.textContent = next.toFixed(decimals);
  updateSliderBackground();
  if (ws) {
    ws.send(JSON.stringify({ action: 'set_fan_speed', speed: Number(fanSpeedSlider.value) }));
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

function setPidBadge(mode, active) {
  const stateEl = document.getElementById('pid-state-display');
  if (!stateEl) return;
  if (mode !== 'pid') {
    stateEl.innerText = 'Inactive';
    stateEl.className = 'badge bg-secondary text-white';
  } else if (active) {
    stateEl.innerText = 'Active';
    stateEl.className = 'badge bg-success';
  } else {
    stateEl.innerText = 'Wind-up';
    stateEl.className = 'badge bg-warning text-dark';
  }
}

async function connectWs(url) {
  intentionalClose = false;
  ws = new WebSocket(url);

  ws.onopen = () => {
    document.getElementById("status").textContent = "Connected";
    statusDot.classList.add("bg-success");
    statusDot.classList.remove("bg-danger");
    updateConnectButton(true);
    addToLog('Connection established', 'received');
  };

  ws.onclose = (event) => {
    const wasIntentional = intentionalClose;
    console.log('WebSocket connection closed', { code: event?.code, reason: event?.reason, wasIntentional });
    statusDot.classList.remove("bg-success");
    statusDot.classList.add("bg-danger");
    document.getElementById("status").textContent = "Disconnected";
    updateConnectButton(false);
    ws = null;
    pendingFanMode = null;
    latestTelemetry = null;
    if (!wasIntentional) {
      const codeStr = event?.code ? ` (code ${event.code})` : '';
      const reason = event?.reason ? `: ${event.reason}` : '';
      showToast(
        `Lost connection to the wind tunnel${codeStr}${reason}. Click "Open WebSocket Connection" to retry.`,
        { title: 'WebSocket disconnected', level: 'danger', duration: 8000 },
      );
    }
    intentionalClose = false;
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
      const tempEl = document.getElementById('temperature');
      if (tempEl) tempEl.innerText = fmtTel(data.temperature, '°C', 2);
      const densityEl = document.getElementById('air-density');
      if (densityEl) densityEl.innerText = fmtTel(data.air_density, 'kg/m³', 4);

      // Cache the freshest airspeed/power so "Collect Data" can grab them
      // without asking the Pico for an extra round-trip.
      latestTelemetry = {
        airspeed: data.air_speed,
        power: data.power,
        temperature: data.temperature,
        airDensity: data.air_density,
        receivedAt: performance.now(),
      };

      // PID status row (always visible — badge reflects state)
      if (data.fan_mode === 'pid') {
        const setpointEl = document.getElementById('pid-setpoint-display');
        const outputEl = document.getElementById('pid-output-display');
        if (setpointEl) setpointEl.innerText = `${data.pid_setpoint != null ? Number(data.pid_setpoint).toFixed(2) : '-'} m/s`;
        if (outputEl) outputEl.innerText = `${data.pid_output != null ? Number(data.pid_output).toFixed(1) : '-'} %`;
        setPidBadge('pid', !!data.pid_active);
      } else {
        const setpointEl = document.getElementById('pid-setpoint-display');
        const outputEl = document.getElementById('pid-output-display');
        if (setpointEl) setpointEl.innerText = '-';
        if (outputEl) outputEl.innerText = '-';
        setPidBadge('percent', false);
      }

      if (data.fan_mode) {
        setFanModeButton(data.fan_mode);
        if (pendingFanMode && data.fan_mode === pendingFanMode) {
          pendingFanMode = null;
        }
      }

      if (data.dimmer_curve_mode) {
        setDimmerCurveButton(data.dimmer_curve_mode);
      }
    }

    if (data.type === "settings") {
      const fmt = v => (v != null ? Number(v).toFixed(4) : '—');
      document.getElementById('kp-current').innerText = fmt(data.Kp);
      document.getElementById('ki-current').innerText = fmt(data.Ki);
      document.getElementById('kd-current').innerText = fmt(data.Kd);
      document.getElementById('kt-current').innerText = fmt(data.Kt);
      document.getElementById('tf-current').innerText = fmt(data.Tf);
      document.getElementById('shunt-current').innerText = data.shunt_value;
    }

  };
  ws.onerror = error => {
    // `onerror` fires immediately before `onclose`; let `onclose` own the UI
    // update and toast so we don't fire two notifications for one drop.
    console.error('WebSocket error', error);
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
    // Surface the Rust-side error string (typed as String in #[tauri::command]).
    const msg = typeof error === 'string' ? error : (error?.message ?? 'Unknown error');
    noNetworks.textContent = `Wi-Fi scan failed: ${msg}`;
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
  const resetDPSBtn = document.querySelector("#reset-dps")
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
      // Flag that this close is user-initiated so onclose doesn't toast.
      intentionalClose = true;
      ws.close();
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

  const fanControlModeBtn = document.querySelector("#fan-control-mode-btn");
  fanControlModeBtn?.addEventListener("click", () => {
    if (!ws) return;
    const currentMode = fanControlModeBtn.getAttribute("data-mode");
    const newMode = currentMode === "percent" ? "pid" : "percent";
    pendingFanMode = newMode;
    ws.send(JSON.stringify({ action: newMode === "pid" ? "pid_mode" : "percent_mode" }));

    // Retry once if telemetry hasn't confirmed the mode yet.
    setTimeout(() => {
      if (!ws || pendingFanMode !== newMode) return;
      ws.send(JSON.stringify({ action: newMode === "pid" ? "pid_mode" : "percent_mode" }));
    }, 250);
  });

  const emergencyStopBtn = document.querySelector("#emergency-stop-btn");
  emergencyStopBtn?.addEventListener("click", () => {
    if (!ws) return;
    ws.send(JSON.stringify({ action: "emergency_stop" }));
    // Immediately reset the local slider to 0
    fanSpeedSlider.value = 0;
    fanSpeedValueEl.textContent = '0';
    updateSliderBackground();
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
      Kt: Number(document.getElementById("kt-value").value),
      Tf: Number(document.getElementById("tf-value").value),
      shunt_value: Number(document.getElementById("shunt-value").value),
    }));
  });

  const dimmerCurveBtn = document.querySelector("#dimmer-curve-mode-btn");
  dimmerCurveBtn?.addEventListener("click", () => {
    if (!ws) return;
    const currentCurve = dimmerCurveBtn.getAttribute("data-mode");
    const nextCurve = currentCurve === "rms" ? "linear" : "rms";
    ws.send(JSON.stringify({ action: "set_dimmer_curve", mode: nextCurve }));
  });

  const recalibrateBtn = document.querySelector("#recalibrate-dimmerlink-btn");
  recalibrateBtn?.addEventListener("click", () => {
    if (!ws) return;
    recalibrateBtn.disabled = true;
    const originalHTML = recalibrateBtn.innerHTML;
    recalibrateBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Recalibrating…';
    ws.send(JSON.stringify({ action: "recalibrate_dimmerlink" }));
    setTimeout(() => {
      recalibrateBtn.disabled = false;
      recalibrateBtn.innerHTML = originalHTML;
    }, 1500);
  });

  resetDPSBtn?.addEventListener("click", async () => {
    if (!ws) return;

    // Show a loading state on the button
    resetDPSBtn.disabled = true;
    resetDPSBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Resetting DPS...';

    // Send calibration command
    ws.send(JSON.stringify({ action: "reset_dps" }));

    // Reset button after 3 seconds (even if no response)
    setTimeout(() => {
      resetDPSBtn.disabled = false;
      resetDPSBtn.textContent = "Reset DPS";
    }, 500);
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
  'kt-value',
  'tf-value',
  'shunt-value',
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
  12: '#51cf66',   // green
  24: '#fcc419',   // yellow
  36: '#ff922b',   // orange
  48: '#ff6b6b',   // red
  60: '#cc5de8',   // purple
  72: '#20c997',   // teal
  84: '#ff0052',   // red
  96: '#49c6ff',   // blue
  108: '#277d43',   // green
};

class LiveGraph {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.tooltip = null;

    // Data state — flat array of { x, y, pitch }
    this.points = [];
    this.xLabel = 'Airspeed (m/s)';
    this.yLabel = 'Power (mW)';

    // Which pitch angles are currently hidden by the user
    this.hiddenPitches = new Set();

    // Layout constants (CSS pixels)
    this.pad = { top: 18, right: 20, bottom: 45, left: 62 };

    this._rafId = null;
    this._hoverX = null;
    this._hoverY = null;

    this._initTooltip();
    this._bindResize();
    this._bindHover();
    this._bindContextMenu();
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

  // ── Context menu (delete point) ──────────────────────────────────
  _bindContextMenu() {
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const { cssW: w, cssH: h, pad } = this;
      const plotW = w - pad.left - pad.right;
      const plotH = h - pad.top - pad.bottom;
      if (plotW <= 0 || plotH <= 0) return;

      const visible = this.points.filter(p => !this.hiddenPitches.has(p.pitch));
      if (visible.length === 0) return;

      // Compute bounds (same as _draw)
      let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (const p of visible) {
        if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
        if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
      }
      if (!isFinite(xMin)) return;
      if (xMax === xMin) { xMin -= 0.5; xMax += 0.5; }
      if (yMax === yMin) { yMin -= 0.5; yMax += 0.5; }
      const xRange = xMax - xMin;
      const yRange = yMax - yMin;
      xMin -= xRange * 0.06; xMax += xRange * 0.06;
      yMin -= yRange * 0.08; yMax += yRange * 0.08;

      const mapX = (v) => pad.left + ((v - xMin) / (xMax - xMin)) * plotW;
      const mapY = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < this.points.length; i++) {
        const p = this.points[i];
        if (this.hiddenPitches.has(p.pitch)) continue;
        const px = mapX(p.x);
        const py = mapY(p.y);
        const d = Math.hypot(px - mouseX, py - mouseY);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }

      if (bestIdx !== -1 && bestDist < 20) {
        this.points.splice(bestIdx, 1);
        this._updateLegend();
        this._scheduleFrame();
      }
    });
  }

  // ── Data methods ────────────────────────────────────────────────

  /** Add one scatter point. */
  addScatterPoint(airspeed, power, pitchAngle, temperature, airDensity) {
    this.points.push({
      x: Number(airspeed),
      y: Number(power),
      pitch: Number(pitchAngle),
      temperature: temperature != null ? Number(temperature) : null,
      airDensity: airDensity != null ? Number(airDensity) : null,
    });
    document.getElementById('graph-no-data')?.classList.add('hidden');
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

  clear() {
    this.points = [];
    this.hiddenPitches.clear();
    this._updateLegend();
    document.getElementById('graph-no-data')?.classList.remove('hidden');
    this._drawEmpty();
  }

  // ── CSV Import ──────────────────────────────────────────────────
  // Parses a CSV string previously produced by exportCSV() (or any file with
  // 3 columns: airspeed, power, pitch). Returns { added, skipped }.
  importCSV(csvText) {
    let added = 0;
    let skipped = 0;
    const lines = csvText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',').map(s => s.trim());
      // Skip a header row if its first column isn't a number.
      if (i === 0 && cols[0] && isNaN(Number(cols[0]))) continue;
      if (cols.length < 3) { skipped++; continue; }
      const x = Number(cols[0]);
      const y = Number(cols[1]);
      const pitch = Number(cols[2]);
      if (!isFinite(x) || !isFinite(y) || !isFinite(pitch)) { skipped++; continue; }
      const parseOptional = (s) => {
        if (s === undefined || s === '') return null;
        const n = Number(s);
        return isFinite(n) ? n : null;
      };
      const temperature = parseOptional(cols[3]);
      const airDensity = parseOptional(cols[4]);
      this.points.push({ x, y, pitch, temperature, airDensity });
      added++;
    }
    if (added > 0) {
      document.getElementById('graph-no-data')?.classList.add('hidden');
      this._updateLegend();
      this._scheduleFrame();
    }
    return { added, skipped };
  }

  // ── CSV Export ──────────────────────────────────────────────────
  async exportCSV() {
    if (this.points.length === 0) return;

    const header = ['Airspeed (m/s)', 'Power (mW)', 'Pitch Angle (°)', 'Temperature (°C)', 'Air Density (kg/m³)'];
    const fmt = (v) => (v == null || !isFinite(v) ? '' : v);
    const rows = this.points.map(p => `${p.x},${p.y},${p.pitch},${fmt(p.temperature)},${fmt(p.airDensity)}`);
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
      // No visible data — nothing to draw, no need to keep redrawing.
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
    ctx.fillText(this.xLabel, pad.left + plotW / 2, h - 12);

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

  const clearBtn      = document.getElementById('graph-clear-btn');
  const exportBtn     = document.getElementById('graph-export-btn');
  const importBtn     = document.getElementById('graph-import-btn');
  const pointBtn      = document.getElementById('graph-point-btn');
  const autoBtn       = document.getElementById('graph-auto-btn');
  const autoText      = document.getElementById('graph-auto-text');
  const autoInterval  = document.getElementById('graph-auto-interval');
  const pitchSelect   = document.getElementById('pitch-angle-select');

  // Capture one point from the latest telemetry frame. Returns true on
  // success, false (with a toast) when telemetry is missing or stale.
  // No Pico round-trip — telemetry is already streaming at ~10 Hz.
  const TELEMETRY_STALE_MS = 1500;
  function capturePoint({ silent = false } = {}) {
    if (!latestTelemetry || latestTelemetry.airspeed == null || latestTelemetry.power == null) {
      if (!silent) {
        showToast(
          ws ? 'Waiting for the first telemetry frame from the wind tunnel…'
             : 'Connect to the wind tunnel first.',
          { title: 'No data yet', level: 'warning', duration: 3500 },
        );
      }
      return false;
    }
    const age = performance.now() - latestTelemetry.receivedAt;
    if (age > TELEMETRY_STALE_MS) {
      if (!silent) {
        showToast(
          `Latest telemetry is ${(age / 1000).toFixed(1)}s old — connection may have stalled.`,
          { title: 'Stale data', level: 'warning', duration: 4000 },
        );
      }
      return false;
    }
    const pitch = pitchSelect ? Number(pitchSelect.value) : 0;
    graph.addScatterPoint(
      latestTelemetry.airspeed,
      latestTelemetry.power,
      pitch,
      latestTelemetry.temperature,
      latestTelemetry.airDensity,
    );
    // Subtle click feedback — a brief shift to a whiter blue. Removing and
    // re-adding the class forces the CSS animation to restart on repeat clicks.
    pointBtn.classList.remove('collected');
    void pointBtn.offsetWidth;
    pointBtn.classList.add('collected');
    return true;
  }

  pointBtn?.addEventListener('click', () => capturePoint());

  // ── Auto-capture timer ────────────────────────────────────────
  let autoTimer = null;

  function stopAuto() {
    if (autoTimer != null) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    autoBtn.setAttribute('data-auto', 'false');
    autoBtn.classList.remove('btn-danger');
    autoBtn.classList.add('btn-success');
    autoBtn.querySelector('i').className = 'ti ti-player-play me-1';
    autoText.textContent = 'Start Auto';
    autoInterval.disabled = false;
  }

  function startAuto() {
    const intervalSec = Number(autoInterval.value);
    if (!isFinite(intervalSec) || intervalSec < 0.1) {
      showToast('Auto interval must be at least 0.1 seconds.',
        { title: 'Invalid interval', level: 'warning', duration: 3500 });
      return;
    }
    // Fire one immediately so the user gets a point right away, then on a timer.
    capturePoint({ silent: true });
    autoTimer = setInterval(() => capturePoint({ silent: true }), intervalSec * 1000);
    autoBtn.setAttribute('data-auto', 'true');
    autoBtn.classList.remove('btn-success');
    autoBtn.classList.add('btn-danger');
    autoBtn.querySelector('i').className = 'ti ti-player-stop me-1';
    autoText.textContent = `Stop Auto (${intervalSec}s)`;
    autoInterval.disabled = true;
  }

  autoBtn?.addEventListener('click', () => {
    const running = autoBtn.getAttribute('data-auto') === 'true';
    if (running) stopAuto(); else startAuto();
  });

  // Live-update the "Stop Auto (Ns)" label if the user edits the interval
  // while paused; restart the timer if they edit it while running.
  autoInterval?.addEventListener('change', () => {
    if (autoBtn.getAttribute('data-auto') === 'true') {
      stopAuto();
      startAuto();
    }
  });

  clearBtn?.addEventListener('click', () => {
    graph.clear();
  });

  exportBtn?.addEventListener('click', () => {
    graph.exportCSV();
  });

  importBtn?.addEventListener('click', async () => {
    try {
      const loaded = await invoke('load_csv');
      if (!loaded) return; // user cancelled
      const result = graph.importCSV(loaded.content);
      if (result.added === 0) {
        showToast(
          'No valid rows found. Expected columns: Airspeed (m/s), Power (mW), Pitch Angle (°).',
          { title: 'Nothing imported', level: 'warning', duration: 5000 },
        );
        return;
      }
      const skippedMsg = result.skipped > 0 ? ` (${result.skipped} rows skipped)` : '';
      showToast(
        `Imported ${result.added} point${result.added === 1 ? '' : 's'}${skippedMsg}.`,
        { title: 'CSV loaded', level: 'success', duration: 3500 },
      );
    } catch (err) {
      console.error('Load CSV failed:', err);
      showToast(typeof err === 'string' ? err : (err?.message ?? 'Unknown error'),
        { title: 'Load CSV failed', level: 'danger', duration: 6000 });
    }
  });
}

