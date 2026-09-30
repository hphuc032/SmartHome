// MediaPipe Gesture Recognition Worker
// Receives ImageBitmap frames from gesture.js and performs inference here.

// IMPORTANT:
// Keep JS module and WASM on exactly the same MediaPipe version.
const MEDIAPIPE_VERSION = "1.0.1";

const MEDIAPIPE_MODULE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;

const MEDIAPIPE_WASM_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

const GESTURE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task";

const MIN_CONFIDENCE = 0.7;

let recognizer = null;
let initializing = null;

/**
 * Initialize MediaPipe GestureRecognizer.
 */
async function initializeRecognizer() {
  if (recognizer) {
    return recognizer;
  }

  if (initializing) {
    return initializing;
  }

  initializing = (async () => {
    console.log("[WORKER] Loading MediaPipe module...");

    const visionModule = await import(MEDIAPIPE_MODULE_URL);

    const { FilesetResolver, GestureRecognizer } = visionModule;

    if (!FilesetResolver || !GestureRecognizer) {
      throw new Error(
        "MediaPipe module loaded but FilesetResolver/GestureRecognizer is unavailable."
      );
    }

    console.log("[WORKER] Loading MediaPipe WASM...");

    const vision = await FilesetResolver.forVisionTasks(
      MEDIAPIPE_WASM_URL
    );

    console.log("[WORKER] Loading gesture model...");

    recognizer = await GestureRecognizer.createFromOptions(
      vision,
      {
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
      }
    );

    console.log("[WORKER] GestureRecognizer READY");

    return recognizer;
  })();

  try {
    return await initializing;
  } catch (error) {
    initializing = null;
    recognizer = null;
    throw error;
  }
}

/**
 * Worker message handler
 */
self.addEventListener("message", async (event) => {
  const {
    type,
    requestId,
    bitmap
  } = event.data;

  /*
   * --------------------------------
   * INITIALIZE
   * --------------------------------
   */
  if (type === "INITIALIZE") {
    try {
      console.log("[WORKER] INITIALIZE");

      await initializeRecognizer();

      self.postMessage({
        type: "READY"
      });

    } catch (error) {
      console.error(
        "[WORKER] MediaPipe initialization failed:",
        error
      );

      self.postMessage({
        type: "INITIALIZE_ERROR",
        error:
          error?.message ||
          String(error)
      });
    }

    return;
  }

  /*
   * --------------------------------
   * RECOGNIZE
   * --------------------------------
   */
  if (type !== "RECOGNIZE") {
    return;
  }

  if (!recognizer) {
    bitmap?.close?.();

    self.postMessage({
      type: "RECOGNIZE_ERROR",
      requestId,
      error: "Recognizer is not initialized."
    });

    return;
  }

  if (!bitmap) {
    self.postMessage({
      type: "RECOGNIZE_ERROR",
      requestId,
      error: "ImageBitmap frame is missing."
    });

    return;
  }

  try {
    const result =
      recognizer.recognize(bitmap);

    bitmap.close?.();

    self.postMessage({
      type: "RECOGNIZE_RESULT",
      requestId,

      result: {
        gestures:
          result?.gestures || []
      }
    });

  } catch (error) {
    bitmap?.close?.();

    console.error(
      "[WORKER] Gesture recognition failed:",
      error
    );

    self.postMessage({
      type: "RECOGNIZE_ERROR",
      requestId,

      error:
        error?.message ||
        String(error)
    });
  }
});