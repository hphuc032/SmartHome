// ESP32 camera preview and browser-local gesture recognition.
// Camera frames are fetched from the ESP32 and never stored or uploaded.

console.log("=== GESTURE JS NEW VERSION - FIST 2.5S ===");
const CAMERA_HOST_STORAGE_KEY = "espCameraHost";
const MIN_CONFIDENCE = 0.7;
const HOLD_MS = 800;
const DOOR_OPEN_HOLD_MS = 1200;
const COOLDOWN_MS = 2000;
const INFERENCE_INTERVAL_MS = 160;
const CAPTURE_TIMEOUT_MS = 10000;
const CAMERA_CONNECT_TIMEOUT_MS = 10000;
const MAX_CAPTURE_FAILURES = 3;
const FIST_DOOR_HOLD_MS = 800;
const FIST_CURTAIN_HOLD_MS = 2500;

const GESTURE_ACTIONS = Object.freeze({
  Open_Palm: { key: "doorCommand", value: "OPEN", label: "OPEN DOOR" },
  Closed_Fist: { key: "doorCommand", value: "CLOSE", label: "CLOSE DOOR" },

  Thumb_Up: { key: "lightBrightness", value: 100, label: "LIGHT ON" },
  Thumb_Down: { key: "lightBrightness", value: 0, label: "LIGHT OFF" },

  // 2 ngón hướng lên = bật quạt
  Victory: { key: "fanLevel", value: 1, label: "FAN ON" },

  // 1 ngón hướng lên = tắt quạt
  Pointing_Up: { key: "fanLevel", value: 0, label: "FAN OFF" },

  // 3 ngón = mở rèm
  Three_Fingers: {
    key: "curtainPosition",
    value: 100,
    label: "OPEN CURTAIN"
  },

  
  
});

const preview = document.getElementById("espCameraPreview");
const placeholder = document.getElementById("cameraPlaceholder");
const hostInput = document.getElementById("cameraHostInput");
const connectButton = document.getElementById("connectCameraButton");
const disconnectButton = document.getElementById("disconnectCameraButton");
const enableGestureButton = document.getElementById("enableGestureButton");
const disableGestureButton = document.getElementById("disableGestureButton");
const doorSafetyOption = document.getElementById("doorGestureSafety");

let fistStartTime = 0;
let fistDoorSent = false;
let fistCurtainSent = false;
let cameraHost = "";
let captureUrl = "";
let cameraConnected = false;
let cameraConnecting = false;
let cameraConnectAttempt = 0;
let cameraConnectTimer = null;

const MEDIAPIPE_VERSION = "1.0.1";

const MEDIAPIPE_MODULE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;

const MEDIAPIPE_WASM_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

const GESTURE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task";

let gestureRecognizer = null;
let gestureRecognizerPromise = null;
const pendingRecognitionRequests = new Map();

let gestureEnabled = false;
let gestureLoopGeneration = 0;
let captureController = null;
let captureFailureCount = 0;

let candidateGesture = "";
let candidateSince = 0;
let cooldownUntil = 0;
let commandInProgress = false;
let lockedGesture = "";

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



function rejectPendingRecognitionRequests(error) {
  pendingRecognitionRequests.forEach(({ reject }) => reject(error));
  pendingRecognitionRequests.clear();
}

async function initializeGestureRecognizer() {
  // Nếu đã khởi tạo rồi thì dùng lại
  if (gestureRecognizer) {
    return gestureRecognizer;
  }

  // Nếu đang load thì chờ Promise hiện tại
  if (gestureRecognizerPromise) {
    return gestureRecognizerPromise;
  }

  gestureRecognizerPromise = (async () => {
    console.log("[GESTURE] Loading MediaPipe module...");

    const visionModule = await import(MEDIAPIPE_MODULE_URL);

    const {
      FilesetResolver,
      GestureRecognizer
    } = visionModule;

    console.log("[GESTURE] Loading MediaPipe WASM...");

    const vision = await FilesetResolver.forVisionTasks(
      MEDIAPIPE_WASM_URL
    );

    console.log("[GESTURE] Loading gesture model...");

    gestureRecognizer =
      await GestureRecognizer.createFromOptions(
        vision,
        {
          baseOptions: {
            modelAssetPath: GESTURE_MODEL_URL
          },

          runningMode: "IMAGE",

          numHands: 1
        }
      );

    console.log("[GESTURE] GestureRecognizer READY");

    return gestureRecognizer;
  })();

  try {
    return await gestureRecognizerPromise;
  } catch (error) {
    gestureRecognizer = null;
    gestureRecognizerPromise = null;
    throw error;
  }
}

async function recognizeFrame(frame) {
  if (!gestureRecognizer) {
    frame?.close?.();

    const error = new Error(
      "GestureRecognizer is not initialized."
    );

    error.source = "gesture";
    throw error;
  }

  try {
    return gestureRecognizer.recognize(frame);
  } catch (error) {
    error.source = "gesture";
    throw error;
  } finally {
    frame?.close?.();
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
      if (error.name === "AbortError") {
        console.warn("[CAMERA] capture timeout - retrying...");
        await delay(300);
        continue;
      }

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

// =====================================================
// CUSTOM GESTURE: 3 NGÓN = OPEN CURTAIN
// Trỏ + giữa + áp út duỗi
// Ngón út gập
// =====================================================

function isThreeFingersUp(result) {
  const landmarks = result.landmarks?.[0];

  if (!landmarks || landmarks.length < 21) {
    return false;
  }

  // MediaPipe:
  // y nhỏ hơn = điểm nằm cao hơn trong ảnh

  // Ngón trỏ duỗi
  const indexUp =
    landmarks[8].y < landmarks[6].y;

  // Ngón giữa duỗi
  const middleUp =
    landmarks[12].y < landmarks[10].y;

  // Ngón áp út duỗi
  const ringUp =
    landmarks[16].y < landmarks[14].y;

  // Ngón út gập
  const pinkyFolded =
    landmarks[20].y > landmarks[18].y;

  return (
    indexUp &&
    middleUp &&
    ringUp &&
    pinkyFolded
  );
}

async function processGestureResult(result, generation) {
  const topGesture = result.gestures?.[0]?.[0];

  let name = topGesture?.categoryName || "";
  let score = Number(topGesture?.score || 0);


  // =====================================================
  // CUSTOM: 3 NGÓN = OPEN CURTAIN
  // =====================================================

  if (isThreeFingersUp(result)) {
    name = "Three_Fingers";

    // Đây là gesture tự nhận bằng landmark,
    // nên cho confidence = 100%
    score = 1.0;

    console.log(
      "[GESTURE CUSTOM] Three_Fingers detected"
    );
  }


  const now = Date.now();

  // =====================================================
  // CLOSED FIST
  //
  // Giữ 0.8 giây  -> CLOSE DOOR
  // Giữ 2.5 giây  -> CLOSE CURTAIN
  // =====================================================

  if (name === "Closed_Fist" && score >= MIN_CONFIDENCE) {

    // Bắt đầu nắm tay
    if (fistStartTime === 0) {
      fistStartTime = now;
      fistDoorSent = false;
      fistCurtainSent = false;

      console.log("[FIST] START");
    }

    const fistHeldFor = now - fistStartTime;
    const seconds = (fistHeldFor / 1000).toFixed(1);

    // ---------------------------------------------------
    // MỐC 2.5 GIÂY -> CLOSE CURTAIN
    // Kiểm tra cái này TRƯỚC.
    // ---------------------------------------------------

    if (
      fistHeldFor >= FIST_CURTAIN_HOLD_MS &&
      !fistCurtainSent
    ) {
      fistCurtainSent = true;

      console.log(
        `[FIST] CLOSE CURTAIN at ${seconds}s`
      );

      setGestureReadout(
        "Closed_Fist",
        score,
        "CLOSE CURTAIN"
      );

      setGestureState("SENDING");
      setCommandStatus("CLOSING CURTAIN");

      try {
        const result = await window.sendCommand(
          "curtainPosition",
          0
        );

        console.log(
          "[FIST] CURTAIN COMMAND",
          result
        );

        setGestureState("APPLIED");
        setCommandStatus("CURTAIN CLOSED");

      } catch (error) {
        console.error(
          "[FIST] CLOSE CURTAIN FAILED",
          error
        );

        setGestureState("ERROR");
        setCommandStatus(
          "CURTAIN COMMAND ERROR"
        );
      }

      return;
    }

    // ---------------------------------------------------
    // MỐC 0.8 GIÂY -> CLOSE DOOR
    // ---------------------------------------------------

    if (
      fistHeldFor >= FIST_DOOR_HOLD_MS &&
      !fistDoorSent
    ) {
      fistDoorSent = true;

      console.log(
        `[FIST] CLOSE DOOR at ${seconds}s`
      );

      setGestureReadout(
        "Closed_Fist",
        score,
        "CLOSE DOOR"
      );

      setGestureState("SENDING");
      setCommandStatus(
        "CLOSING DOOR - KEEP HOLDING"
      );

      try {
        const result = await window.sendCommand(
          "doorCommand",
          "CLOSE"
        );

        console.log(
          "[FIST] DOOR COMMAND",
          result
        );

        setGestureState("HOLDING");
        setCommandStatus(
          "DOOR CLOSED - KEEP HOLDING"
        );

      } catch (error) {
        console.error(
          "[FIST] CLOSE DOOR FAILED",
          error
        );

        setGestureState("ERROR");
        setCommandStatus(
          "DOOR COMMAND ERROR"
        );
      }

      return;
    }

    // ---------------------------------------------------
    // HIỂN THỊ TRẠNG THÁI KHI ĐANG GIỮ
    // ---------------------------------------------------

    setGestureReadout(
      "Closed_Fist",
      score,
      fistDoorSent
        ? "KEEP HOLDING FOR CURTAIN"
        : "CLOSE DOOR"
    );

    setGestureState("HOLDING");

    if (!fistDoorSent) {

      const progress = Math.min(
        100,
        Math.round(
          (fistHeldFor / FIST_DOOR_HOLD_MS) * 100
        )
      );

      setCommandStatus(
        `DOOR ${progress}%`
      );

    } else if (!fistCurtainSent) {

      const progress = Math.min(
        100,
        Math.round(
          (fistHeldFor / FIST_CURTAIN_HOLD_MS) * 100
        )
      );

      setCommandStatus(
        `KEEP HOLDING ${seconds}s | CURTAIN ${progress}%`
      );

    } else {
      setCommandStatus(
        "CURTAIN CLOSED"
      );
    }

    return;
  }


  // =====================================================
  // KHÔNG CÒN CLOSED_FIST -> RESET
  // =====================================================

  if (fistStartTime !== 0) {
    console.log("[FIST] RELEASE");

    fistStartTime = 0;
    fistDoorSent = false;
    fistCurtainSent = false;

    candidateGesture = "";
    candidateSince = 0;
  }


  // =====================================================
  // CÁC GESTURE CÒN LẠI
  // =====================================================

  const action = GESTURE_ACTIONS[name];

  if (
    !action ||
    name === "None" ||
    score < MIN_CONFIDENCE
  ) {
    candidateGesture = "";
    candidateSince = 0;

    if (
      lockedGesture &&
      now >= cooldownUntil
    ) {
      lockedGesture = "";
    }

    setGestureReadout();

    if (!commandInProgress) {
      setGestureState(
        now < cooldownUntil
          ? "COOLDOWN"
          : "DETECTING"
      );

      if (now >= cooldownUntil) {
        setCommandStatus("READY");
      }
    }

    return;
  }


  setGestureReadout(
    name,
    score,
    action.label
  );


  if (commandInProgress) {
    return;
  }


  if (lockedGesture === name) {
    setGestureState("COOLDOWN");

    if (now >= cooldownUntil) {
      setCommandStatus(
        "RELEASE HAND TO REARM"
      );
    }

    return;
  }


  if (
    lockedGesture &&
    lockedGesture !== name
  ) {
    lockedGesture = "";
  }


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

    console.info(
      `[GESTURE] ${name} ${score.toFixed(2)}`
    );

    return;
  }


  const requiredHold =
    name === "Open_Palm" &&
    doorSafetyOption.checked
      ? DOOR_OPEN_HOLD_MS
      : HOLD_MS;


  const heldFor =
    now - candidateSince;


  if (heldFor < requiredHold) {
    const progress = Math.min(
      100,
      Math.round(
        (heldFor / requiredHold) * 100
      )
    );

    setGestureState("HOLDING");

    setCommandStatus(
      `HOLDING ${progress}%`
    );

    return;
  }


  await executeGestureAction(
    name,
    action,
    generation
  );
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
});
