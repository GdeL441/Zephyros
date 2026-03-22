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

