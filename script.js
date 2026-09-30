// Smart Home dashboard: Firebase state is the only source of device truth.

// ── Firebase refs ─────────────────────────────────────────────
const db = firebase.database();
const stateRef = db.ref("smartHome/state");
const commandsRef = db.ref("smartHome/commands");
const firebaseConnectionRef = db.ref(".info/connected");

const DEVICE_STALE_AFTER_MS = 10000;
const DEVICE_CHECK_INTERVAL_MS = 2000;
const TERMINAL_COMMAND_STATUSES = new Set(["applied", "timeout", "rejected"]);

let dashboardInitialized = false;
let firebaseConnected = false;
let lastEspMillis = null;
let lastEspChangeAt = 0;
let heartbeatCheckStartedAt = 0;
let heartbeatObserved = false;
let deviceConnectionTimer = null;

const currentModes = {
  light: "UNKNOWN",
  fan: "UNKNOWN",
  curtain: "UNKNOWN",
};

const pendingGroups = new Set();
const commandListeners = new Map();
const feedbackTimers = new Map();

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function toFiniteNumber(value) {
  if (!hasValue(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEnum(value, allowed) {
  if (!hasValue(value)) return "UNKNOWN";
  const normalized = String(value).trim().toUpperCase();
  return allowed.includes(normalized) ? normalized : "UNKNOWN";
}

function setStatusPill(element, text, statusClass) {
  element.textContent = text;
  element.className = `card-status-pill ${statusClass}`;
}

// ── State listener ────────────────────────────────────────────
function startStateListener() {
  stateRef.on("value", (snapshot) => {
    const state = snapshot.val();

    if (!state || typeof state !== "object") {
      console.warn("Firebase: no device state at smartHome/state");
      renderState({});
      startHeartbeatGracePeriod();
      return;
    }

    renderState(state);
    observeEspHeartbeat(state.espMillis);
    updateTimestamp();
  }, (error) => {
    console.error("Unable to read smartHome/state:", error);
    renderState({});
  });
}

// ── Render functions ──────────────────────────────────────────
function renderState(state) {
  renderTemperatureAndHumidity(state.temperature, state.humidity, state.dht);
  renderDoorStatus(state.door);
  renderLightStatus(state.light, state.lightMode, state.ldr);
  renderFanStatus(state.fan, state.fanMode);
  renderCurtainStatus(state.curtain, state.curtainMode);
  renderGasStatus(state.gas, state.mq2);
}

function renderTemperatureAndHumidity(temperature, humidity, dht) {
  const card = document.getElementById("cardTemperature");
  const tempEl = document.getElementById("tempValue");
  const humidityEl = document.getElementById("humidityValue");
  const subEl = document.getElementById("tempSub");
  const dhtEl = document.getElementById("dhtStatus");
  const ring = document.getElementById("tempRing");
  const temp = toFiniteNumber(temperature);
  const humidityValue = toFiniteNumber(humidity);
  const dhtState = normalizeEnum(dht, ["OK", "ERROR"]);

  tempEl.textContent = temp === null ? "--°C" : `${temp}°C`;
  humidityEl.textContent = humidityValue === null ? "--%" : `${humidityValue}%`;
  dhtEl.textContent = `DHT: ${dhtState}`;
  dhtEl.className = `sensor-health ${dhtState === "ERROR" ? "sensor-health--error" : ""}`;
  card.classList.toggle("sensor-error", dhtState === "ERROR");

  if (dhtState === "ERROR") {
    subEl.textContent = "SENSOR ERROR — check DHT11 connection";
  } else if (temp === null) {
    subEl.textContent = "Temperature data unavailable";
  } else if (temp < 20) {
    subEl.textContent = "Cool — comfortable";
  } else if (temp < 28) {
    subEl.textContent = "Normal — comfortable";
  } else if (temp < 35) {
    subEl.textContent = "Warm — slightly hot";
  } else {
    subEl.textContent = "Hot — AUTO fan threshold reached";
  }

  const circumference = 213.6;
  const percentage = temp === null ? 0 : Math.min(Math.max(temp / 50, 0), 1);
  ring.style.strokeDashoffset = String(circumference * (1 - percentage));
  ring.style.stroke = temperatureRingColor(temp);
}

function temperatureRingColor(temp) {
  if (temp === null) return "#4a6480";
  if (temp < 20) return "#1a8cff";
  if (temp < 28) return "#00e676";
  if (temp < 35) return "#ff9100";
  return "#ff1744";
}

function renderDoorStatus(value) {
  const pill = document.getElementById("doorStatus");
  const icon = document.getElementById("doorIcon");
  const door = normalizeEnum(value, ["OPEN", "CLOSED"]);

  if (door === "OPEN") {
    setStatusPill(pill, "🟢 DOOR OPEN", "status-open");
    icon.textContent = "🔓";
    icon.classList.add("door-open-glow");
  } else if (door === "CLOSED") {
    setStatusPill(pill, "⚫ DOOR CLOSED", "status-closed");
    icon.textContent = "🚪";
    icon.classList.remove("door-open-glow");
  } else {
    setStatusPill(pill, "DOOR UNKNOWN", "status-unknown");
    icon.textContent = "🚪";
    icon.classList.remove("door-open-glow");
  }
}

function renderLightStatus(value, modeValue, ldr) {
  const pill = document.getElementById("lightStatus");
  const icon = document.getElementById("lightIcon");
  const mode = normalizeEnum(modeValue, ["AUTO", "MANUAL"]);
  const light = toFiniteNumber(value);

  if (light === 1) {
    setStatusPill(pill, "💡 LIGHT ON", "status-on");
    icon.textContent = "💡";
  } else if (light === 0) {
    setStatusPill(pill, "🌑 LIGHT OFF", "status-off");
    icon.textContent = "🔦";
  } else {
    setStatusPill(pill, "LIGHT UNKNOWN", "status-unknown");
    icon.textContent = "💡";
  }

  document.getElementById("lightMode").textContent = `MODE: ${mode}`;
  document.getElementById("ldrValue").textContent = hasValue(ldr) ? String(ldr) : "N/A";
  currentModes.light = mode;
  refreshControlButtons("light");
}

function renderFanStatus(value, modeValue) {
  const pill = document.getElementById("fanStatus");
  const icon = document.getElementById("fanIcon");
  const mode = normalizeEnum(modeValue, ["AUTO", "MANUAL"]);
  const fan = toFiniteNumber(value);

  if (fan === 1) {
    setStatusPill(pill, "🌀 FAN ON", "status-on");
    icon.innerHTML = '<span class="fan-spinning">🌀</span>';
  } else if (fan === 0) {
    setStatusPill(pill, "⭕ FAN OFF", "status-off");
    icon.textContent = "🌀";
  } else {
    setStatusPill(pill, "FAN UNKNOWN", "status-unknown");
    icon.textContent = "🌀";
  }

  document.getElementById("fanMode").textContent = `MODE: ${mode}`;
  currentModes.fan = mode;
  refreshControlButtons("fan");
}

function renderCurtainStatus(value, modeValue) {
  const pill = document.getElementById("curtainStatus");
  const icon = document.getElementById("curtainIcon");
  const mode = normalizeEnum(modeValue, ["AUTO", "MANUAL"]);
  const curtain = normalizeEnum(value, ["OPEN", "CLOSED"]);

  if (curtain === "OPEN") {
    setStatusPill(pill, "CURTAIN OPEN", "status-open");
    icon.textContent = "🪟";
  } else if (curtain === "CLOSED") {
    setStatusPill(pill, "CURTAIN CLOSED", "status-closed");
    icon.textContent = "▦";
  } else {
    setStatusPill(pill, "CURTAIN UNKNOWN", "status-unknown");
    icon.textContent = "🪟";
  }

  document.getElementById("curtainMode").textContent = `MODE: ${mode}`;
  currentModes.curtain = mode;
  refreshControlButtons("curtain");
}

function renderGasStatus(value, mq2) {
  const pill = document.getElementById("gasStatus");
  const card = document.getElementById("cardGas");
  const warning = document.getElementById("gasWarning");
  const gas = toFiniteNumber(value);

  document.getElementById("mq2Value").textContent = hasValue(mq2) ? String(mq2) : "N/A";

  if (gas === 1) {
    setStatusPill(pill, "⚠ DANGER — GAS LEAK", "status-danger");
    card.classList.add("gas-danger");
    warning.hidden = false;
    renderSystemAlert("danger");
  } else if (gas === 0) {
    setStatusPill(pill, "✔ SAFE", "status-safe");
    card.classList.remove("gas-danger");
    warning.hidden = true;
    renderSystemAlert("safe");
  } else {
    setStatusPill(pill, "GAS: N/A", "status-unknown");
    card.classList.remove("gas-danger");
    warning.hidden = true;
    renderSystemAlert("unknown");
  }
}

function renderSystemAlert(status) {
  const banner = document.getElementById("alertBanner");
  const icon = document.getElementById("alertIcon");
  const text = document.getElementById("alertText");

  if (status === "danger") {
    banner.className = "alert-banner danger";
    icon.textContent = "⚠";
    text.textContent = "WARNING: GAS LEAK DETECTED — VENTILATE IMMEDIATELY";
  } else if (status === "safe") {
    banner.className = "alert-banner";
    icon.textContent = "✔";
    text.textContent = "SYSTEM SAFE — GAS SENSOR NORMAL";
  } else {
    banner.className = "alert-banner neutral";
    icon.textContent = "…";
    text.textContent = "GAS SENSOR STATE UNAVAILABLE";
  }
}

function updateTimestamp() {
  document.getElementById("lastUpdated").textContent = new Date().toLocaleTimeString("en-GB");
}

// ── Command creation ──────────────────────────────────────────
async function sendCommand(key, value) {
  const commandRef = commandsRef.push();
  const commandId = commandRef.key;

  if (!commandId) {
    throw new Error("Firebase did not create a command ID");
  }

  await commandRef.set({
    key,
    value,
    status: "pending",
    createdAt: firebase.database.ServerValue.TIMESTAMP,
  });

  return waitForCommandResult(commandRef, commandId);
}

// ── Command tracking ──────────────────────────────────────────
function waitForCommandResult(commandRef, commandId) {
  const statusRef = commandRef.child("status");

  return new Promise((resolve, reject) => {
    const stopTracking = () => {
      statusRef.off("value", handleStatus);
      commandListeners.delete(commandId);
    };

    const handleStatus = (snapshot) => {
      if (!snapshot.exists()) return;

      const status = String(snapshot.val()).trim().toLowerCase();
      if (!TERMINAL_COMMAND_STATUSES.has(status)) return;

      stopTracking();
      resolve({ commandId, status });
    };

    const handleError = (error) => {
      stopTracking();
      reject(new Error(`Unable to track command ${commandId}: ${error.message}`));
    };

    commandListeners.set(commandId, { ref: statusRef, handler: handleStatus });
    statusRef.on("value", handleStatus, handleError);
  });
}

async function runDeviceCommand(group, key, value, button) {
  if (pendingGroups.has(group)) return null;

  pendingGroups.add(group);
  markTriggerButtonSending(button);
  refreshControlButtons(group);
  setCommandFeedback(group, "SENDING...", "pending");

  try {
    const result = await sendCommand(key, value);
    const messages = {
      applied: ["APPLIED", "success"],
      timeout: ["TIMEOUT — STM32 DID NOT ACK", "error"],
      rejected: ["COMMAND REJECTED", "error"],
    };
    const [message, feedbackClass] = messages[result.status];

    pendingGroups.delete(group);
    restoreTriggerButton(button);
    refreshControlButtons(group);
    setCommandFeedback(group, message, feedbackClass, true);
    return result;
  } catch (error) {
    console.error(`Unable to send or track ${key} command:`, error);
    pendingGroups.delete(group);
    restoreTriggerButton(button);
    refreshControlButtons(group);
    setCommandFeedback(group, "FAILED TO SEND", "error", true);
    return null;
  }
}

function markTriggerButtonSending(button) {
  if (!button) return;
  button.dataset.originalHtml = button.innerHTML;
  button.textContent = "SENDING...";
}

function restoreTriggerButton(button) {
  if (!button || !button.dataset.originalHtml) return;
  button.innerHTML = button.dataset.originalHtml;
  delete button.dataset.originalHtml;
}

function setCommandFeedback(group, message, feedbackClass, resetLater = false) {
  const feedback = document.getElementById(`${group}Feedback`);
  if (!feedback) return;

  const existingTimer = feedbackTimers.get(group);
  if (existingTimer) window.clearTimeout(existingTimer);

  feedback.textContent = message;
  feedback.className = `command-feedback command-feedback--${feedbackClass}`;

  if (resetLater) {
    const timer = window.setTimeout(() => {
      feedback.textContent = "READY";
      feedback.className = "command-feedback";
      feedbackTimers.delete(group);
    }, 4000);
    feedbackTimers.set(group, timer);
  }
}

function refreshControlButtons(group) {
  const controls = document.querySelector(`[data-control-group="${group}"]`);
  if (!controls) return;

  const isPending = pendingGroups.has(group);
  const isAuto = currentModes[group] === "AUTO";

  controls.querySelectorAll("button").forEach((button) => {
    const manualBlocked = button.hasAttribute("data-manual-control") && isAuto;
    button.disabled = isPending || manualBlocked;

    if (manualBlocked) {
      button.title = "Switch this device to MANUAL mode before direct control.";
    } else {
      button.removeAttribute("title");
    }
  });
}

// ── Device controls ───────────────────────────────────────────
function sendDoorCommand(command, button) {
  const normalized = normalizeEnum(command, ["OPEN", "CLOSE"]);
  if (normalized === "UNKNOWN") return Promise.resolve(null);
  return runDeviceCommand("door", "doorCommand", normalized, button);
}

function sendLightCommand(turnOn, button) {
  return runDeviceCommand("light", "lightBrightness", turnOn ? 100 : 0, button);
}

function sendLightModeCommand(mode, button) {
  return sendModeCommand("light", "lightMode", mode, button);
}

function sendFanCommand(turnOn, button) {
  return runDeviceCommand("fan", "fanLevel", turnOn ? 1 : 0, button);
}

function sendFanModeCommand(mode, button) {
  return sendModeCommand("fan", "fanMode", mode, button);
}

function sendCurtainCommand(command, button) {
  const normalized = normalizeEnum(command, ["OPEN", "CLOSE"]);
  if (normalized === "UNKNOWN") return Promise.resolve(null);
  return runDeviceCommand("curtain", "curtainPosition", normalized === "OPEN" ? 100 : 0, button);
}

function sendCurtainModeCommand(mode, button) {
  return sendModeCommand("curtain", "curtainMode", mode, button);
}

function sendAllDeviceModesCommand(mode, button) {
  const normalized = normalizeEnum(mode, ["AUTO", "MANUAL"]);
  if (normalized === "UNKNOWN") return Promise.resolve(null);
  return runDeviceCommand("allModes", "allDeviceModes", normalized, button);
}

function sendModeCommand(group, key, mode, button) {
  const normalized = normalizeEnum(mode, ["AUTO", "MANUAL"]);
  if (normalized === "UNKNOWN") return Promise.resolve(null);
  return runDeviceCommand(group, key, normalized, button);
}

// ── Connection status ─────────────────────────────────────────
function startConnectionListeners() {
  firebaseConnectionRef.on("value", (snapshot) => {
    setFirebaseConnection(snapshot.val() === true);
  }, (error) => {
    console.error("Unable to read Firebase connection state:", error);
    setFirebaseConnection(false);
  });

  deviceConnectionTimer = window.setInterval(updateDeviceConnection, DEVICE_CHECK_INTERVAL_MS);
  updateDeviceConnection();
}

function setFirebaseConnection(isOnline) {
  firebaseConnected = isOnline;
  updateConnectionBadge(
    "firebaseConnectionBadge",
    isOnline ? "FIREBASE: ONLINE" : "FIREBASE: OFFLINE",
    isOnline ? "online" : "offline",
  );
  updateDeviceConnection();
}

function startHeartbeatGracePeriod() {
  if (heartbeatCheckStartedAt === 0) heartbeatCheckStartedAt = Date.now();
}

function observeEspHeartbeat(value) {
  startHeartbeatGracePeriod();
  const espMillis = toFiniteNumber(value);

  if (espMillis === null) {
    updateDeviceConnection();
    return;
  }

  if (lastEspMillis === null || espMillis !== lastEspMillis) {
    lastEspMillis = espMillis;
    lastEspChangeAt = Date.now();
    heartbeatObserved = true;
  }

  updateDeviceConnection();
}

function updateDeviceConnection() {
  if (!firebaseConnected) {
    updateConnectionBadge("deviceConnectionBadge", "DEVICE: OFFLINE", "offline");
    return;
  }

  if (!heartbeatObserved) {
    const graceExpired = heartbeatCheckStartedAt > 0
      && Date.now() - heartbeatCheckStartedAt > DEVICE_STALE_AFTER_MS;
    updateConnectionBadge(
      "deviceConnectionBadge",
      graceExpired ? "DEVICE: OFFLINE" : "DEVICE: CHECKING",
      graceExpired ? "offline" : "checking",
    );
    return;
  }

  const isFresh = Date.now() - lastEspChangeAt <= DEVICE_STALE_AFTER_MS;
  updateConnectionBadge(
    "deviceConnectionBadge",
    isFresh ? "DEVICE: ONLINE" : "DEVICE: OFFLINE",
    isFresh ? "online" : "offline",
  );
}

function updateConnectionBadge(id, text, status) {
  const badge = document.getElementById(id);
  if (!badge) return;
  badge.className = `status-badge ${status}`;
  badge.querySelector(".badge-text").textContent = text;
}

// ── Init ──────────────────────────────────────────────────────
function initializeDashboard() {
  if (dashboardInitialized) return;
  dashboardInitialized = true;

  document.getElementById("footerYear").textContent = String(new Date().getFullYear());
  startStateListener();
  startConnectionListeners();
}

function cleanupDashboardListeners() {
  stateRef.off();
  firebaseConnectionRef.off();

  commandListeners.forEach(({ ref, handler }) => ref.off("value", handler));
  commandListeners.clear();

  if (deviceConnectionTimer) window.clearInterval(deviceConnectionTimer);
  feedbackTimers.forEach((timer) => window.clearTimeout(timer));
}

document.addEventListener("DOMContentLoaded", () => {
  firebase.auth().onAuthStateChanged((user) => {
    if (!user) return;
    document.body.classList.add("auth-ready");
    initializeDashboard();
  });
});

window.addEventListener("beforeunload", cleanupDashboardListeners);
