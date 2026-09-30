// ESP32 camera preview and browser-local gesture recognition.
// Camera frames are fetched from the ESP32 and never stored or uploaded.

const CAMERA_HOST_STORAGE_KEY = "espCameraHost";
const MIN_CONFIDENCE = 0.7;
const HOLD_MS = 800;
const DOOR_OPEN_HOLD_MS = 1200;
const COOLDOWN_MS = 2000;
const INFERENCE_INTERVAL_MS = 160;
const CAPTURE_TIMEOUT_MS = 4500;
const CAMERA_CONNECT_TIMEOUT_MS = 10000;
const MAX_CAPTURE_FAILURES = 3;

const GESTURE_ACTIONS = Object.freeze({
  Open_Palm: { key: "doorCommand", value: "OPEN", label: "OPEN DOOR" },
  Closed_Fist: { key: "doorCommand", value: "CLOSE", label: "CLOSE DOOR" },
  Thumb_Up: { key: "lightBrightness", value: 100, label: "LIGHT ON" },
  Thumb_Down: { key: "lightBrightness", value: 0, label: "LIGHT OFF" },
  Victory: { key: "fanLevel", value: 1, label: "FAN ON" },
  Pointing_Up: { key: "fanLevel", value: 0, label: "FAN OFF" },
});

const preview = document.getElementById("espCameraPreview");
const placeholder = document.getElementById("cameraPlaceholder");
const hostInput = document.getElementById("cameraHostInput");
const connectButton = document.getElementById("connectCameraButton");
const disconnectButton = document.getElementById("disconnectCameraButton");
const enableGestureButton = document.getElementById("enableGestureButton");
const disableGestureButton = document.getElementById("disableGestureButton");
const doorSafetyOption = document.getElementById("doorGestureSafety");

let cameraHost = "";
let captureUrl = "";
let cameraConnected = false;
let cameraConnecting = false;
let cameraConnectAttempt = 0;
let cameraConnectTimer = null;

let gestureWorker = null;
let gestureWorkerReadyPromise = null;
let gestureWorkerReadyResolve = null;
let gestureWorkerReadyReject = null;
let recognitionRequestId = 0;
let gestureEnabled = false;
let gestureLoopGeneration = 0;
let captureController = null;
let captureFailureCount = 0;

let candidateGesture = "";
let candidateSince = 0;
let cooldownUntil = 0;
let commandInProgress = false;
let lockedGesture = "";
const pendingRecognitionRequests = new Map();

function normalizeCameraHost(rawHost) {
  const trimmed = rawHost.trim();
  if (!trimmed) throw new Error("Enter the ESP32 camera IP or host.");

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Camera host must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Do not include credentials in the camera host.");
  }

  return url.origin;
}

function readSavedCameraHost() {
  try {
    return window.localStorage.getItem(CAMERA_HOST_STORAGE_KEY) || "";
  } catch (error) {
    console.warn("[CAMERA] localStorage unavailable", error);
    return "";
  }
}

function saveCameraHost(host) {
  try {
    window.localStorage.setItem(CAMERA_HOST_STORAGE_KEY, host);
  } catch (error) {
    console.warn("[CAMERA] unable to save host", error);
  }
}

function setCameraState(state, message = "") {
  const stateElement = document.getElementById("cameraState");
  stateElement.textContent = `CAMERA: ${state}`;
  stateElement.className = `camera-state camera-state--${state.toLowerCase()}`;

  if (message) {
    const messageElement = document.getElementById("cameraMessage");
    messageElement.textContent = message;
    messageElement.classList.toggle("camera-message--error", state === "ERROR");
  }
}

function setGestureState(state) {
  const stateElement = document.getElementById("gestureState");
  stateElement.textContent = `GESTURE: ${state}`;
  stateElement.className = `camera-state camera-state--${state.toLowerCase().replace(/\s+/g, "-")}`;
}

function setCommandStatus(status) {
  const element = document.getElementById("gestureCommandStatus");
  element.textContent = status;
  element.dataset.status = status.toLowerCase();
}

function setGestureReadout(name = "NONE", score = null, action = "NONE") {
  document.getElementById("detectedGesture").textContent = name;
  document.getElementById("gestureConfidence").textContent =
    score === null ? "--%" : `${Math.round(score * 100)}%`;
  document.getElementById("gestureAction").textContent = action;
}

function setCameraButtons() {
  connectButton.disabled = cameraConnected || cameraConnecting;
  disconnectButton.disabled = !cameraHost;
  enableGestureButton.disabled = !cameraConnected || gestureEnabled;
  disableGestureButton.disabled = !gestureEnabled;
  hostInput.disabled = gestureEnabled;
}

function clearCameraConnectTimer() {
  if (!cameraConnectTimer) return;
  window.clearTimeout(cameraConnectTimer);
  cameraConnectTimer = null;
}

function connectCamera() {
  let normalizedHost;

  try {
    normalizedHost = normalizeCameraHost(hostInput.value);
  } catch (error) {
    setCameraState("ERROR", error.message);
    return;
  }

  if (window.location.protocol === "https:" && normalizedHost.startsWith("http://")) {
    setCameraState(
      "ERROR",
      "This HTTPS dashboard cannot access an HTTP camera because browsers block mixed content. Use an HTTPS camera endpoint or serve the dashboard over HTTP on the same LAN.",
    );
    return;
  }

  disableGesture();
  clearCameraConnectTimer();
  cameraConnectAttempt += 1;
  const attempt = cameraConnectAttempt;

  cameraHost = normalizedHost;
  captureUrl = `${cameraHost}/capture`;
  cameraConnected = false;
  cameraConnecting = true;
  hostInput.value = cameraHost;
  placeholder.hidden = false;
  placeholder.querySelector("strong").textContent = "CONNECTING TO CAMERA";
  placeholder.querySelector("small").textContent = `${cameraHost}/stream`;
  setCameraState("CONNECTING", "Waiting for the first MJPEG frame...");
  setCameraButtons();

  preview.src = `${cameraHost}/stream?t=${Date.now()}`;
  cameraConnectTimer = window.setTimeout(() => {
    if (attempt !== cameraConnectAttempt || cameraConnected) return;
    cameraConnecting = false;
    setCameraState("ERROR", "Camera stream timed out. Check the host and ESP32 camera server.");
    placeholder.querySelector("strong").textContent = "CAMERA CONNECTION FAILED";
    setCameraButtons();
  }, CAMERA_CONNECT_TIMEOUT_MS);
}

function disconnectCamera() {
  disableGesture();
  clearCameraConnectTimer();
  cameraConnectAttempt += 1;
  cameraConnected = false;
  cameraConnecting = false;
  cameraHost = "";
  captureUrl = "";
  preview.removeAttribute("src");
  placeholder.hidden = false;
  placeholder.querySelector("strong").textContent = "CAMERA DISCONNECTED";
  placeholder.querySelector("small").textContent = "Enter the ESP32 camera host and connect.";
  setCameraState("DISCONNECTED", "Camera disconnected. The saved host remains available.");
  setCameraButtons();
}

preview.addEventListener("load", () => {
  if (!cameraHost) return;

  clearCameraConnectTimer();
  cameraConnected = true;
  cameraConnecting = false;
  placeholder.hidden = true;
  saveCameraHost(cameraHost);
  setCameraState("CONNECTED", "MJPEG preview connected. Gesture frames use /capture.");
  setCameraButtons();
  console.info("[CAMERA] connected");
});

preview.addEventListener("error", () => {
  if (!cameraHost) return;

  clearCameraConnectTimer();
  cameraConnected = false;
  cameraConnecting = false;
  placeholder.hidden = false;
  placeholder.querySelector("strong").textContent = "CAMERA STREAM ERROR";
  placeholder.querySelector("small").textContent = "Check the ESP32 host and /stream endpoint.";
  setCameraState("ERROR", "Unable to load the MJPEG stream from the ESP32 camera.");
  setCameraButtons();
  console.warn("[CAMERA] stream failed");
});

async function initializeGestureRecognizer() {
  if (gestureWorkerReadyPromise) return gestureWorkerReadyPromise;

  gestureWorker = new Worker("gesture-worker.js", { type: "module" });
  gestureWorkerReadyPromise = new Promise((resolve, reject) => {
    gestureWorkerReadyResolve = resolve;
    gestureWorkerReadyReject = reject;
  });

  gestureWorker.addEventListener("message", handleGestureWorkerMessage);
  gestureWorker.addEventListener("error", (event) => {
    const error = new Error(event.message || "Gesture worker failed to load.");
    error.source = "gesture";
    gestureWorkerReadyReject?.(error);
    rejectPendingRecognitionRequests(error);
    gestureWorkerReadyPromise = null;
    gestureWorkerReadyResolve = null;
    gestureWorkerReadyReject = null;
    gestureWorker?.terminate();
    gestureWorker = null;
    if (gestureEnabled) stopGestureWithError(error.message);
  });
  gestureWorker.postMessage({ type: "INITIALIZE" });
  return gestureWorkerReadyPromise;
}

function handleGestureWorkerMessage(event) {
  const { type, requestId, result, error } = event.data;

  if (type === "READY") {
    gestureWorkerReadyResolve?.(true);
    gestureWorkerReadyResolve = null;
    gestureWorkerReadyReject = null;
    return;
  }
  if (type === "INITIALIZE_ERROR") {
    gestureWorkerReadyReject?.(new Error(error));
    gestureWorkerReadyPromise = null;
    gestureWorkerReadyResolve = null;
    gestureWorkerReadyReject = null;
    gestureWorker?.terminate();
    gestureWorker = null;
    return;
  }

  const pending = pendingRecognitionRequests.get(requestId);
  if (!pending) return;
  pendingRecognitionRequests.delete(requestId);

  if (type === "RECOGNIZE_RESULT") {
    pending.resolve(result);
  } else {
    const recognitionError = new Error(error || "Gesture recognition failed.");
    recognitionError.source = "gesture";
    pending.reject(recognitionError);
  }
}

function recognizeFrame(bitmap) {
  if (!gestureWorker) {
    bitmap.close?.();
    return Promise.reject(new Error("Gesture worker is unavailable."));
  }

  const requestId = ++recognitionRequestId;
  const resultPromise = new Promise((resolve, reject) => {
    pendingRecognitionRequests.set(requestId, { resolve, reject });
  });
  try {
    gestureWorker.postMessage({ type: "RECOGNIZE", requestId, bitmap }, [bitmap]);
  } catch (error) {
    pendingRecognitionRequests.delete(requestId);
    bitmap.close?.();
    return Promise.reject(error);
  }
  return resultPromise;
}

function rejectPendingRecognitionRequests(error) {
  pendingRecognitionRequests.forEach(({ reject }) => reject(error));
  pendingRecognitionRequests.clear();
}

async function enableGesture() {
  if (gestureEnabled) return;
  if (!cameraConnected || !captureUrl) {
    setGestureState("ERROR");
    setCommandStatus("CONNECT CAMERA FIRST");
    return;
  }
  if (typeof window.sendCommand !== "function") {
    setGestureState("ERROR");
    setCommandStatus("COMMAND PIPELINE UNAVAILABLE");
    return;
  }

  gestureEnabled = true;
  gestureLoopGeneration += 1;
  const generation = gestureLoopGeneration;
  resetGestureTracking();
  setGestureState("LOADING MODEL");
  setCommandStatus("LOADING MODEL");
  setCameraButtons();

  try {
    await initializeGestureRecognizer();
    if (!gestureEnabled || generation !== gestureLoopGeneration) return;

    setGestureState("READY");
    setCommandStatus("READY");
    setCameraState("CONNECTED", "Gesture recognizer ready. Frames are processed locally in your browser.");
    void runGestureLoop(generation);
  } catch (error) {
    console.error("[GESTURE] model loading failed", error);
    stopGestureWithError("MediaPipe model loading failed. Check internet access and CDN availability.");
  }
}

function disableGesture() {
  gestureEnabled = false;
  gestureLoopGeneration += 1;

  if (captureController) {
    captureController.abort();
    captureController = null;
  }
  rejectPendingRecognitionRequests(new Error("Gesture recognition disabled."));

  resetGestureTracking();
  setGestureReadout();
  setGestureState("DISABLED");
  setCommandStatus("READY");
  setCameraButtons();
}

function resetGestureTracking() {
  candidateGesture = "";
  candidateSince = 0;
  if (!commandInProgress) {
    cooldownUntil = 0;
    lockedGesture = "";
  }
  captureFailureCount = 0;
}

async function getEspCameraFrame() {
  if (!captureUrl) throw new Error("Camera capture URL is not configured.");
  if (typeof window.createImageBitmap !== "function") {
    throw new Error("This browser does not support createImageBitmap().");
  }

  const controller = new AbortController();
  captureController = controller;
  const timeout = window.setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);

  try {
    const response = await fetch(`${captureUrl}?t=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Camera capture failed: ${response.status}`);
    }

    const blob = await response.blob();
    if (!blob.size) throw new Error("Camera returned an empty JPEG frame.");
    return await createImageBitmap(blob);
  } finally {
    window.clearTimeout(timeout);
    if (captureController === controller) captureController = null;
  }
}

async function runGestureLoop(generation) {
  while (gestureEnabled && generation === gestureLoopGeneration) {
    const iterationStartedAt = Date.now();
    let frame = null;

    try {
      if (!commandInProgress && Date.now() >= cooldownUntil) {
        setGestureState(candidateGesture ? "HOLDING" : "DETECTING");
      }

      frame = await getEspCameraFrame();
      if (!gestureEnabled || generation !== gestureLoopGeneration) {
        frame.close?.();
        return;
      }

      const recognitionPromise = recognizeFrame(frame);
      frame = null;
      const result = await recognitionPromise;
      captureFailureCount = 0;

      if (!cameraConnected) {
        cameraConnected = true;
        setCameraState("CONNECTED", "Camera capture recovered.");
        setCameraButtons();
      }

      await processGestureResult(result, generation);
    } catch (error) {
      frame?.close?.();
      if (!gestureEnabled || generation !== gestureLoopGeneration) return;
      if (error.name === "AbortError" && !gestureEnabled) return;

      if (error.source === "gesture") {
        console.error("[GESTURE] inference failed", error);
        stopGestureWithError(`Gesture inference failed: ${error.message}`);
        return;
      }

      captureFailureCount += 1;
      cameraConnected = false;
      cameraConnecting = false;
      const message = cameraCaptureErrorMessage(error);
      setGestureState("ERROR");
      setCommandStatus("CAPTURE ERROR");
      setCameraState("ERROR", message);

      if (captureFailureCount === 1) {
        console.warn("[CAMERA] capture failed", error);
      }
      if (captureFailureCount >= MAX_CAPTURE_FAILURES) {
        stopGestureWithError(message, true);
        return;
      }

      await delay(750);
    }

    const elapsed = Date.now() - iterationStartedAt;
    await delay(Math.max(0, INFERENCE_INTERVAL_MS - elapsed));
  }
}

function cameraCaptureErrorMessage(error) {
  if (error.name === "AbortError") {
    return "Camera capture timed out. Check the ESP32 /capture endpoint.";
  }
  if (error instanceof TypeError) {
    return "Camera frame access failed. Ensure the ESP32 /capture endpoint allows browser access using Access-Control-Allow-Origin.";
  }
  return error.message || "Camera capture failed.";
}

async function processGestureResult(result, generation) {
  const topGesture = result.gestures?.[0]?.[0];
  const name = topGesture?.categoryName || "";
  const score = Number(topGesture?.score || 0);
  const action = GESTURE_ACTIONS[name];
  const now = Date.now();

  if (!action || name === "None" || score < MIN_CONFIDENCE) {
    candidateGesture = "";
    candidateSince = 0;
    if (lockedGesture && now >= cooldownUntil) lockedGesture = "";
    setGestureReadout();

    if (!commandInProgress) {
      setGestureState(now < cooldownUntil ? "COOLDOWN" : "DETECTING");
      if (now >= cooldownUntil) setCommandStatus("READY");
    }
    return;
  }

  setGestureReadout(name, score, action.label);
  if (commandInProgress) return;

  if (lockedGesture === name) {
    setGestureState("COOLDOWN");
    if (now >= cooldownUntil) setCommandStatus("RELEASE HAND TO REARM");
    return;
  }
  if (lockedGesture && lockedGesture !== name) lockedGesture = "";

  if (now < cooldownUntil) {
    candidateGesture = "";
    candidateSince = 0;
    setGestureState("COOLDOWN");
    return;
  }

  if (candidateGesture !== name) {
    candidateGesture = name;
    candidateSince = now;
    setGestureState("HOLDING");
    setCommandStatus("HOLDING");
    console.info(`[GESTURE] ${name} ${score.toFixed(2)}`);
    return;
  }

  const requiredHold = name === "Open_Palm" && doorSafetyOption.checked
    ? DOOR_OPEN_HOLD_MS
    : HOLD_MS;
  const heldFor = now - candidateSince;

  if (heldFor < requiredHold) {
    const progress = Math.min(100, Math.round((heldFor / requiredHold) * 100));
    setGestureState("HOLDING");
    setCommandStatus(`HOLDING ${progress}%`);
    return;
  }

  await executeGestureAction(name, action, generation);
}

async function executeGestureAction(name, action, generation) {
  commandInProgress = true;
  candidateGesture = "";
  candidateSince = 0;
  lockedGesture = name;
  setGestureState("SENDING");
  setCommandStatus("SENDING");
  console.info(`[GESTURE] action ${action.label}`);

  try {
    const result = await window.sendCommand(action.key, action.value);
    const finalStatus = result.status.toUpperCase();

    if (gestureEnabled && generation === gestureLoopGeneration) {
      setGestureState(finalStatus);
      setCommandStatus(finalStatus);
    }
    console.info(`[GESTURE] command ${result.status}`);
  } catch (error) {
    console.error("[GESTURE] command failed", error);
    if (gestureEnabled && generation === gestureLoopGeneration) {
      setGestureState("ERROR");
      setCommandStatus("FIREBASE COMMAND ERROR");
    }
  } finally {
    commandInProgress = false;
    cooldownUntil = Date.now() + COOLDOWN_MS;
  }

  await delay(700);
  if (gestureEnabled && generation === gestureLoopGeneration) {
    setGestureState("COOLDOWN");
  }
}

function stopGestureWithError(message, cameraError = false) {
  gestureEnabled = false;
  gestureLoopGeneration += 1;
  candidateGesture = "";
  candidateSince = 0;
  rejectPendingRecognitionRequests(new Error(message));
  setGestureState("ERROR");
  setCommandStatus("ERROR");
  if (cameraError) {
    setCameraState("ERROR", message);
  } else {
    const messageElement = document.getElementById("cameraMessage");
    messageElement.textContent = message;
    messageElement.classList.add("camera-message--error");
  }
  setCameraButtons();
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

connectButton.addEventListener("click", connectCamera);
disconnectButton.addEventListener("click", disconnectCamera);
enableGestureButton.addEventListener("click", enableGesture);
disableGestureButton.addEventListener("click", disableGesture);
hostInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") connectCamera();
});

hostInput.value = readSavedCameraHost();
setCameraButtons();

window.addEventListener("beforeunload", () => {
  gestureEnabled = false;
  captureController?.abort();
  rejectPendingRecognitionRequests(new Error("Page unloading."));
  gestureWorker?.terminate();
});
