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

fanSpeedSlider.addEventListener('input', () => {
  fanSpeedValueEl.textContent = fanSpeedSlider.value;
});

fanSpeedSlider.addEventListener('change', () => {
  if (!ws) return;
  ws.send(JSON.stringify({ action: 'set_fan_speed', speed: Number(fanSpeedSlider.value) }));
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
      document.getElementById('power').innerText = `${data.power} W`;
      document.getElementById('fan-status').innerText = `${data.fan_speed} %`;
      document.getElementById('uptime').innerText = `${data.uptime}`;
      document.getElementById('speed-display').innerText = `${data.air_speed} m/s`;
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
  loadThresholds()
  loadPID()
  loadSpeed()

  const connectBtn = document.querySelector("#connect-btn");
  const scanBtn = document.querySelector("#scan-btn")
  const sensorsBtn = document.querySelector("#monitor-btn")
  const applyThresholdBtn = document.querySelector("#apply-thresholds-btn")
  const applySpeedBtn = document.querySelector("#apply-speed-btn")
  const applyPIDBtn = document.querySelector("#apply-pid-btn")
  const calibrateBtn = document.querySelector("#calibrate-dps")
  const testBtn = document.querySelector("#send-test")

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
    ws.send(JSON.stringify({ action: "monitor_sensor" }));

    // If starting monitoring, clear previous values
    if (newMonitoringState) {
      document.getElementById("left-sensor-value").textContent = "--";
      document.getElementById("right-sensor-value").textContent = "--";
      document.getElementById("back-sensor-value").textContent = "--";
    }
  });

  applyThresholdBtn?.addEventListener("click", async () => {
    if (!ws) return
    let L = Number(document.querySelector("#left-sensor-threshold").value)
    let R = Number(document.querySelector("#right-sensor-threshold").value)
    let B = Number(document.querySelector("#back-sensor-threshold").value)
    let L_R_calibration_threshold = Number(document.querySelector("#calibration-threshold").value)
    let B_calibration_threshold = Number(document.querySelector("#back-calibration-threshold").value)

    // Validate calibration thresholds are within range
    L_R_calibration_threshold = Math.min(Math.max(L_R_calibration_threshold, 0.1), 1.0);
    B_calibration_threshold = Math.min(Math.max(B_calibration_threshold, 0.1), 1.0);

    thresholds = { L, R, B, L_R_calibration_threshold, B_calibration_threshold }
    // Save to localStorage
    localStorage.setItem("thresholds", JSON.stringify(thresholds));

    ws.send(JSON.stringify({
      action: "set_threshold",
      L,
      R,
      B,
      L_R_calibration_threshold,
      B_calibration_threshold
    }))
  });

  applyPIDBtn?.addEventListener("click", async () => {
    if (!ws) return
    let P = Number(document.querySelector("#kp-value").value)
    let I = Number(document.querySelector("#ki-value").value)
    let D = Number(document.querySelector("#kd-value").value)
    // Save to localStorage
    localStorage.setItem("pid", JSON.stringify({ P, I, D }));

    ws.send(JSON.stringify({ action: "update_pid", P, I, D }))
  });

  applySpeedBtn?.addEventListener("click", async () => {
    if (!ws) return
    let speed = Number(document.querySelector("#speed-value").value)
    let turnSpeed = Number(document.querySelector("#turn-speed-value").value)
    speeds = { speed, turnSpeed }
    // Save to localStorage
    localStorage.setItem("speed", JSON.stringify({ speed, turnSpeed }));

    ws.send(JSON.stringify({ action: "update_speed", speed, turnSpeed }))
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

let thresholds
function loadThresholds() {
  let savedThresholds = localStorage.getItem("thresholds");
  console.log(savedThresholds)

  if (savedThresholds) {
    let { L, R, B, L_R_calibration_threshold, B_calibration_threshold } = JSON.parse(savedThresholds);
    thresholds = { L, R, B, L_R_calibration_threshold, B_calibration_threshold }
    setThresholds(L, R, B, L_R_calibration_threshold, B_calibration_threshold)
  }
}

function setThresholds(L, R, B, L_R_calibration_threshold, B_calibration_threshold) {
  document.querySelector("#left-sensor-threshold").value = L;
  document.querySelector("#right-sensor-threshold").value = R;
  document.querySelector("#back-sensor-threshold").value = B;
  document.querySelector("#calibration-threshold").value = L_R_calibration_threshold || 0.8;
  document.querySelector("#back-calibration-threshold").value = B_calibration_threshold || 0.9;
}

function loadPID() {
  let savedPID = localStorage.getItem("pid");
  console.log(savedPID)

  if (savedPID) {
    let { P, I, D } = JSON.parse(savedPID);
    setPID(P, I, D)
  }
}

function setPID(P, I, D) {
  document.querySelector("#kp-value").value = P
  document.querySelector("#ki-value").value = I
  document.querySelector("#kd-value").value = D
}

let speeds
function loadSpeed() {
  let savedSpeed = localStorage.getItem("speed");
  console.log(savedSpeed)

  if (savedSpeed) {
    let { speed, turnSpeed } = JSON.parse(savedSpeed);
    speeds = { speed, turnSpeed }
    setSpeed(speed, turnSpeed)
  }
}

function setSpeed(speed, turnSpeed) {
  document.querySelector("#speed-value").value = speed
  document.querySelector("#turn-speed-value").value = turnSpeed
}

// Update sensor value display with color coding
function updateSensorValueDisplay(elementId, value, threshold) {
  const element = document.getElementById(elementId);
  if (!element) return;

  element.textContent = value;

  if (value < threshold) {
    element.classList.remove("text-success");
    element.classList.add("text-danger");
  } else {
    element.classList.remove("text-danger");
    element.classList.add("text-success");
  }
}
