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
const MEDIAPIPE_VERSION = "1.0.1";
const MEDIAPIPE_MODULE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MEDIAPIPE_WASM_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const GESTURE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task";

const GESTURE_ACTIONS = Object.freeze({
  Open_Palm: { key: "doorCommand", value: "OPEN", label: "OPEN DOOR" },
  Closed_Fist: { key: "doorCommand", value: "CLOSE", label: "CLOSE DOOR" },
  Thumb_Up: { key: "lightBrightness", value: 100, label: "LIGHT ON" },
  Thumb_Down: { key: "lightBrightness", value: 0, label: "LIGHT OFF" },
  Victory: { key: "fanLevel", value: 1, label: "FAN ON" },
  Pointing_Up: { key: "fanLevel", value: 0, label: "FAN OFF" },
  Three_Fingers: { key: "curtainPosition", value: 100, label: "OPEN CURTAIN" },
  Pinch: { key: "curtainPosition", value: 0, label: "CLOSE CURTAIN" },
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

let gestureRecognizer = null;
let gestureRecognizerPromise = null;
let pageUnloading = false;
let gestureEnabled = false;
let gestureLoopGeneration = 0;
let captureController = null;
let captureFailureCount = 0;

let candidateGesture = "";
let candidateSince = 0;
let cooldownUntil = 0;
let commandInProgress = false;
let lockedGesture = "";
let threeFingersVisible = false;
let pinchVisible = false;

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

  if (
    window.location.protocol === "https:" &&
    normalizedHost.startsWith("http://")
  ) {
    setCameraState(
      "ERROR",
      "Camera HTTP cannot be opened from HTTPS dashboard. Use the local HTTP dashboard."
    );
    return;
  }

  disableGesture();
  clearCameraConnectTimer();

  cameraConnectAttempt += 1;

  cameraHost = normalizedHost;

  const cameraUrl = new URL(cameraHost);

  const streamUrl =
    `${cameraUrl.protocol}//${cameraUrl.hostname}:81/stream`;

  captureUrl = `${cameraHost}/capture`;

  cameraConnected = false;
  cameraConnecting = true;

  hostInput.value = cameraHost;

  placeholder.hidden = false;
  placeholder.querySelector("strong").textContent =
    "CONNECTING TO CAMERA";
  placeholder.querySelector("small").textContent =
    streamUrl;

  setCameraState(
    "CONNECTING",
    "Opening ESP32 MJPEG stream..."
  );

  setCameraButtons();

  console.log("[CAMERA] host =", cameraHost);
  console.log("[CAMERA] stream =", streamUrl);
  console.log("[CAMERA] capture =", captureUrl);

  preview.removeAttribute("src");

  preview.src = `${streamUrl}?t=${Date.now()}`;

  window.setTimeout(() => {
    if (!cameraHost) return;

    cameraConnected = true;
    cameraConnecting = false;

    placeholder.hidden = true;

    saveCameraHost(cameraHost);

    setCameraState(
      "CONNECTED",
      "ESP32 MJPEG stream connected."
    );

    setCameraButtons();

    console.log("[CAMERA] MJPEG preview started");
  }, 1200);
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
  if (gestureRecognizer) return gestureRecognizer;
  if (gestureRecognizerPromise) return gestureRecognizerPromise;

  gestureRecognizerPromise = (async () => {
    console.log("[GESTURE] Loading MediaPipe module...");
    const { FilesetResolver, GestureRecognizer } = await import(MEDIAPIPE_MODULE_URL);
    if (!FilesetResolver || !GestureRecognizer) {
      throw new Error("MediaPipe module is missing FilesetResolver/GestureRecognizer.");
    }

    console.log("[GESTURE] Loading MediaPipe WASM...");
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);

    console.log("[GESTURE] Loading gesture model...");
    const recognizer = await GestureRecognizer.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: GESTURE_MODEL_URL,
        delegate: "CPU",
      },
      runningMode: "IMAGE",
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      cannedGesturesClassifierOptions: {
        scoreThreshold: MIN_CONFIDENCE,
        maxResults: 1,
      },
    });

    // Initialization may finish after the page has started unloading.
    if (pageUnloading) {
      recognizer.close?.();
      throw new Error("Page unloading.");
    }
    gestureRecognizer = recognizer;
    console.log("[GESTURE] GestureRecognizer READY");
    return gestureRecognizer;
  })();

  try {
    return await gestureRecognizerPromise;
  } catch (error) {
    gestureRecognizerPromise = null;
    throw error;
  }
}

function recognizeFrame(bitmap) {
  try {
    if (!gestureRecognizer) throw new Error("Gesture recognizer is unavailable.");
    return gestureRecognizer.recognize(bitmap);
  } catch (error) {
    const recognitionError = new Error(error?.message || String(error));
    recognitionError.source = "gesture";
    throw recognitionError;
  } finally {
    bitmap.close();
  }
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
    if (!gestureEnabled || generation !== gestureLoopGeneration) return;
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

  resetGestureTracking();
  setGestureReadout();
  setGestureState("DISABLED");
  setCommandStatus("READY");
  setCameraButtons();
}

function resetGestureTracking() {
  threeFingersVisible = false;
  pinchVisible = false;
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

      const bitmap = frame;
      frame = null;
      const result = recognizeFrame(bitmap);
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

// Front-facing hand heuristic. Distances are palm-relative; angles and distances
// do not depend on left/right handedness, mirroring or in-plane hand rotation.
function detectThreeFingers(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length !== 21 ||
      !landmarks.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) {
    return false;
  }

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const angle = (a, joint, b) => {
    const length = distance(a, joint) * distance(b, joint);
    if (length < 1e-10) return 0;
    const cosine = ((a.x - joint.x) * (b.x - joint.x) +
      (a.y - joint.y) * (b.y - joint.y)) / length;
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
  };
  const wrist = landmarks[0];
  const palmSize = distance(wrist, landmarks[9]);
  const palmWidth = distance(landmarks[5], landmarks[17]);
  // Reject collapsed/strongly edge-on observations instead of guessing.
  if (palmSize < 1e-6 || palmWidth < palmSize * 0.35) return false;

  const extended = (mcp, pip, dip, tip) =>
    angle(landmarks[mcp], landmarks[pip], landmarks[dip]) >= 160 &&
    angle(landmarks[pip], landmarks[dip], landmarks[tip]) >= 150 &&
    distance(landmarks[tip], wrist) > distance(landmarks[pip], wrist) + palmSize * 0.18 &&
    distance(landmarks[tip], landmarks[mcp]) >
      distance(landmarks[pip], landmarks[mcp]) * 1.5;

  if (!extended(5, 6, 7, 8) || !extended(9, 10, 11, 12) ||
      !extended(13, 14, 15, 16)) return false;

  const pinkyFolded = angle(landmarks[17], landmarks[18], landmarks[19]) < 140 &&
    distance(landmarks[20], wrist) < distance(landmarks[18], wrist) + palmSize * 0.05 &&
    distance(landmarks[20], landmarks[17]) < palmSize * 0.65;

  const palmCenter = {
    x: (wrist.x + landmarks[5].x + landmarks[9].x + landmarks[17].x) / 4,
    y: (wrist.y + landmarks[5].y + landmarks[9].y + landmarks[17].y) / 4,
  };
  const thumbFolded = angle(landmarks[2], landmarks[3], landmarks[4]) < 155 &&
    distance(landmarks[4], palmCenter) < palmSize * 0.75 &&
    distance(landmarks[4], landmarks[5]) < palmSize * 0.65;

  return pinkyFolded && thumbFolded;
}

// Image-space Euclidean distance, relative to wrist -> middle MCP length.
// No pixel threshold or left/right handedness dependency.
function pinchDistanceRatio(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length !== 21 ||
      !landmarks.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) return Infinity;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const size = distance(landmarks[0], landmarks[9]);
  if (size < 1e-6 || distance(landmarks[5], landmarks[17]) < size * 0.35) return Infinity;
  return distance(landmarks[4], landmarks[8]) / size;
}

function detectPinch(landmarks) {
  if (pinchDistanceRatio(landmarks) >= 0.25) return false;
  const wrist = landmarks[0];
  const palm = landmarks[9];
  const dx = palm.x - wrist.x;
  const dy = palm.y - wrist.y;
  // A fist can also bring tips close together. Require both tips to remain
  // outside the palm, beyond the index MCP along the palm's own axis.
  return [4, 8].every((id) =>
    ((landmarks[id].x - landmarks[5].x) * dx +
     (landmarks[id].y - landmarks[5].y) * dy) / (dx * dx + dy * dy) > 0.1);
}

async function processGestureResult(result, generation) {
  const isThreeFingers = detectThreeFingers(result.landmarks?.[0]);
  const isPinch = !isThreeFingers && detectPinch(result.landmarks?.[0]);
  if (isPinch && !pinchVisible) {
    console.info("[GESTURE CUSTOM] Pinch detected");
  }
  pinchVisible = isPinch;
  if (isThreeFingers && !threeFingersVisible) {
    console.info("[GESTURE CUSTOM] Three_Fingers detected");
  }
  threeFingersVisible = isThreeFingers;
  const topGesture = result.gestures?.[0]?.[0];
  const name = isThreeFingers ? "Three_Fingers" : isPinch
    ? "Pinch" : topGesture?.categoryName || "";
  const score = isThreeFingers || isPinch ? 1.0 : Number(topGesture?.score || 0);
  const action = GESTURE_ACTIONS[name];
  const now = Date.now();

  // Release by separating the tips (or removing the hand). A wider release
  // threshold prevents small landmark jitter from rearming a held pinch.
  if (lockedGesture === "Pinch") {
    if (pinchDistanceRatio(result.landmarks?.[0]) < 0.35) {
      setGestureReadout(name || "NONE", action ? score : null, action?.label || "NONE");
      if (!commandInProgress) {
        setGestureState("COOLDOWN");
        if (now >= cooldownUntil) setCommandStatus("RELEASE PINCH TO REARM");
      }
      return;
    }
    lockedGesture = "";
  }

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
  pageUnloading = true;
  gestureEnabled = false;
  gestureLoopGeneration += 1;
  captureController?.abort();
  gestureRecognizer?.close?.();
  gestureRecognizer = null;
});
