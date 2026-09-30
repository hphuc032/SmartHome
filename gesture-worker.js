// MediaPipe inference worker. ImageBitmap frames are transferred here so the
// synchronous recognizer does not block the dashboard's main UI thread.

const MEDIAPIPE_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";
const MEDIAPIPE_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const GESTURE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task";
const MIN_CONFIDENCE = 0.7;

let recognizer = null;

async function initializeRecognizer() {
  if (recognizer) return;

  const { FilesetResolver, GestureRecognizer } = await import(MEDIAPIPE_MODULE_URL);
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
  recognizer = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: { modelAssetPath: GESTURE_MODEL_URL },
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
}

self.addEventListener("message", async (event) => {
  const { type, requestId, bitmap } = event.data;

  if (type === "INITIALIZE") {
    try {
      await initializeRecognizer();
      self.postMessage({ type: "READY" });
    } catch (error) {
      self.postMessage({ type: "INITIALIZE_ERROR", error: error.message || String(error) });
    }
    return;
  }

  if (type !== "RECOGNIZE") return;

  if (!recognizer) {
    bitmap?.close?.();
    self.postMessage({ type: "RECOGNIZE_ERROR", requestId, error: "Recognizer is not initialized." });
    return;
  }

  try {
    const result = recognizer.recognize(bitmap);
    bitmap.close?.();
    self.postMessage({
      type: "RECOGNIZE_RESULT",
      requestId,
      result: { gestures: result.gestures },
    });
  } catch (error) {
    bitmap?.close?.();
    self.postMessage({
      type: "RECOGNIZE_ERROR",
      requestId,
      error: error.message || String(error),
    });
  }
});
