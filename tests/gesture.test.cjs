const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(require('node:path').join(__dirname, '../gesture.js'), 'utf8');

function hand(extended = [5, 9, 13], thumbOpen = false) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.7 }));
  points[0] = { x: 0.5, y: 0.85 };
  points[1] = { x: 0.35, y: 0.78 };
  points[2] = { x: 0.3, y: 0.68 };
  points[3] = thumbOpen ? { x: 0.23, y: 0.61 } : { x: 0.39, y: 0.65 };
  points[4] = thumbOpen ? { x: 0.16, y: 0.54 } : { x: 0.41, y: 0.7 };
  for (const [mcp, x, y] of [[5, 0.4, 0.55], [9, 0.5, 0.53], [13, 0.59, 0.55], [17, 0.65, 0.6]]) {
    points[mcp] = { x, y };
    points[mcp + 1] = { x, y: y - 0.12 };
    points[mcp + 2] = { x: x + (extended.includes(mcp) ? 0 : 0.02), y: y - (extended.includes(mcp) ? 0.2 : 0.03) };
    points[mcp + 3] = { x, y: y + (extended.includes(mcp) ? -0.28 : 0.05) };
  }
  return points;
}

function harness() {
  const elements = new Map();
  const states = [];
  const logs = [];
  const commands = [];
  let now = 10000;
  const element = (id) => {
    if (!elements.has(id)) {
      const item = { dataset: {}, checked: true, addEventListener() {}, classList: { toggle() {}, add() {} } };
      Object.defineProperty(item, 'textContent', {
        get() { return this.text; },
        set(value) { this.text = value; states.push([id, value]); },
      });
      elements.set(id, item);
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element },
    console: { info: (...args) => logs.push(args.join(' ')), warn() {}, log() {}, error() {} },
    Date: { now: () => now }, URL,
    window: {
      localStorage: { getItem: () => '' }, addEventListener() {},
      setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
      sendCommand: async (key, value) => { commands.push({ key, value }); return { status: 'applied' }; },
    },
  });
  vm.runInContext(source, context);
  vm.runInContext('gestureEnabled = true; gestureLoopGeneration = 1;', context);
  return {
    context, elements, states, logs, commands,
    detect: (points) => context.detectThreeFingers(points),
    at: (time) => { now = time; },
    frame: (points, name = 'None', score = 0.95) => context.processGestureResult({
      landmarks: points ? [points] : [], gestures: [[{ categoryName: name, score }]],
    }, 1),
  };
}

function pinchHand(ratio = 0.05) {
  const points = hand([9, 13, 17]);
  points[6] = { x: 0.39, y: 0.41 };
  points[7] = { x: 0.37, y: 0.40 };
  points[8] = { x: 0.36, y: 0.44 };
  points[3] = { x: 0.32, y: 0.54 };
  points[4] = { x: points[8].x + ratio * 0.32, y: points[8].y };
  return points;
}

test('Pinch accepts mirrored, rotated, scaled hands; Three_Fingers remains false', () => {
  const h = harness();
  for (const mirror of [-1, 1]) for (const scale of [0.5, 1, 1.3]) for (const angle of [-0.5, 0, 0.5]) {
    const points = pinchHand().map((p, i) => {
      const x = (p.x - 0.5) * mirror * scale;
      const y = (p.y - 0.5) * scale;
      return { x: 0.5 + x * Math.cos(angle) - y * Math.sin(angle) + Math.sin(i) * 0.001,
        y: 0.5 + x * Math.sin(angle) + y * Math.cos(angle) };
    });
    assert.equal(h.context.detectPinch(points), true);
    assert.equal(h.detect(points), false);
  }
});

test('Pinch requires a relative distance below 25 percent and rejects invalid data', () => {
  const h = harness();
  for (const ratio of [0, 0.1, 0.249]) assert.equal(h.context.detectPinch(pinchHand(ratio)), true);
  for (const ratio of [0.251, 0.35, 0.6]) assert.equal(h.context.detectPinch(pinchHand(ratio)), false);
  const invalid = pinchHand(); invalid[4].x = NaN;
  for (const points of [undefined, [], pinchHand().slice(0, 20), invalid,
    pinchHand().map(() => ({ x: 0, y: 0 })), pinchHand().map((p) => ({ x: 0.5, y: p.y }))]) {
    assert.equal(h.context.detectPinch(points), false);
  }
});

test('Pinch rejects Closed_Fist even with touching tips, Open_Palm, Victory and other old poses', async () => {
  const h = harness();
  const touchingFist = hand([]);
  touchingFist[4] = { ...touchingFist[8] };
  for (const points of [hand([]), touchingFist, hand([5, 9, 13, 17], true),
    hand([], true), hand([5, 9]), hand([5]), hand()]) {
    assert.equal(h.context.detectPinch(points), false);
  }
  await h.frame(touchingFist, 'Closed_Fist');
  h.at(10800); await h.frame(touchingFist, 'Closed_Fist');
  assert.deepEqual(h.commands, [{ key: 'doorCommand', value: 'CLOSE' }]);
});

test('Pinch priority, UI, 800ms hold, one command while held and release/rearm without removing hand', async () => {
  const h = harness();
  await h.frame(pinchHand(), 'Closed_Fist');
  assert.equal(h.elements.get('detectedGesture').textContent, 'Pinch');
  assert.equal(h.elements.get('gestureConfidence').textContent, '100%');
  assert.equal(h.elements.get('gestureAction').textContent, 'CLOSE CURTAIN');
  h.at(10799); await h.frame(pinchHand()); assert.equal(h.commands.length, 0);
  h.at(10800); await h.frame(pinchHand());
  assert.deepEqual(h.commands, [{ key: 'curtainPosition', value: 0 }]);
  for (const time of [11000, 13000, 15000]) { h.at(time); await h.frame(pinchHand()); }
  assert.equal(h.commands.length, 1);
  assert.equal(h.logs.filter((line) => line === '[GESTURE CUSTOM] Pinch detected').length, 1);
  for (const status of ['HOLDING', 'SENDING', 'APPLIED', 'COOLDOWN']) {
    assert.ok(h.states.some(([id, text]) => id === 'gestureState' && text === `GESTURE: ${status}`));
  }
  // Above detection threshold, below release threshold: no rearm on jitter/classifier flicker.
  await h.frame(pinchHand(0.3), 'Closed_Fist');
  h.at(16000); await h.frame(pinchHand(0.3), 'Closed_Fist');
  await h.frame(pinchHand());
  h.at(17000); await h.frame(pinchHand()); assert.equal(h.commands.length, 1);
  await h.frame(pinchHand(0.4));
  h.at(18000); await h.frame(pinchHand());
  h.at(18799); await h.frame(pinchHand()); assert.equal(h.commands.length, 1);
  h.at(18800); await h.frame(pinchHand());
  assert.deepEqual(h.commands, [{ key: 'curtainPosition', value: 0 }, { key: 'curtainPosition', value: 0 }]);
  for (const message of ['[GESTURE CUSTOM] Pinch detected', '[GESTURE] Pinch 1.00',
    '[GESTURE] action CLOSE CURTAIN', '[GESTURE] command applied']) assert.ok(h.logs.includes(message));
});

test('Pinch interrupted hold restarts; removing hand rearms but never bypasses cooldown', async () => {
  const h = harness();
  await h.frame(pinchHand());
  h.at(10700); await h.frame(pinchHand(0.4));
  h.at(10800); await h.frame(pinchHand());
  h.at(11599); await h.frame(pinchHand()); assert.equal(h.commands.length, 0);
  h.at(11600); await h.frame(pinchHand());
  h.at(11700); await h.frame(null);
  h.at(11800); await h.frame(pinchHand());
  h.at(13599); await h.frame(pinchHand()); assert.equal(h.commands.length, 1);
  h.at(13600); await h.frame(pinchHand());
  h.at(14399); await h.frame(pinchHand()); assert.equal(h.commands.length, 1);
  h.at(14400); await h.frame(pinchHand()); assert.equal(h.commands.length, 2);
});

test('Pinch waits for command status and does not label timeout as applied', async () => {
  const h = harness();
  let finish;
  let calls = 0;
  h.context.window.sendCommand = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  await h.frame(pinchHand()); h.at(10800);
  const pending = h.frame(pinchHand());
  h.at(13000); await h.frame(pinchHand());
  assert.equal(calls, 1);
  assert.equal(h.elements.get('gestureCommandStatus').textContent, 'SENDING');
  finish({ status: 'timeout' }); await pending;
  assert.ok(h.logs.includes('[GESTURE] command timeout'));
  assert.ok(!h.logs.includes('[GESTURE] command applied'));
});

test('Three_Fingers accepts either hand, scale/rotation and small landmark noise', () => {
  const h = harness();
  for (const mirror of [1, -1]) for (const scale of [0.5, 1, 1.3]) for (const angle of [-0.5, 0, 0.5]) {
    const points = hand().map((p, i) => {
      const x = (p.x - 0.5) * mirror * scale;
      const y = (p.y - 0.5) * scale;
      return { x: 0.5 + x * Math.cos(angle) - y * Math.sin(angle) + Math.sin(i) * 0.001,
        y: 0.5 + x * Math.sin(angle) + y * Math.cos(angle) };
    });
    assert.equal(h.detect(points), true);
  }
});

test('rejects Open_Palm, Victory, Closed_Fist, wrong three fingers and unfolded thumb/pinky', () => {
  const h = harness();
  for (const points of [hand([5, 9, 13, 17], true), hand([5, 9]), hand([]),
    hand([5, 9, 17]), hand([5, 9, 13], true), hand([5, 9, 13, 17]), hand([5])]) {
    assert.equal(h.detect(points), false);
  }
});

test('missing, malformed, collapsed and edge-on landmarks fail closed', () => {
  const h = harness();
  const invalid = hand(); invalid[8].x = NaN;
  for (const points of [undefined, [], hand().slice(0, 20), invalid,
    Array.from({ length: 21 }, () => ({ x: 0, y: 0 })),
    hand().map((p) => ({ x: 0.5, y: p.y }))]) assert.equal(h.detect(points), false);
});

test('recognizeFrame preserves landmarks and closes the bitmap', () => {
  const h = harness();
  const result = { landmarks: [hand()], gestures: [] };
  h.context.expectedResult = result;
  vm.runInContext('gestureRecognizer = { recognize: () => expectedResult };', h.context);
  let closed = false;
  assert.equal(h.context.recognizeFrame({ close() { closed = true; } }), result);
  assert.equal(closed, true);
});

test('custom priority, UI, full hold, applied, cooldown, release and rearm', async () => {
  const h = harness();
  await h.frame(hand(), 'Victory', 0.99);
  assert.equal(h.elements.get('detectedGesture').textContent, 'Three_Fingers');
  assert.equal(h.elements.get('gestureConfidence').textContent, '100%');
  assert.equal(h.elements.get('gestureAction').textContent, 'OPEN CURTAIN');
  h.at(10799); await h.frame(hand()); assert.equal(h.commands.length, 0);
  h.at(10800); await h.frame(hand());
  assert.deepEqual(h.commands, [{ key: 'curtainPosition', value: 100 }]);
  for (const status of ['HOLDING', 'SENDING', 'APPLIED', 'COOLDOWN']) {
    assert.ok(h.states.some(([id, text]) => id === 'gestureState' && text === `GESTURE: ${status}`));
  }
  for (const time of [10960, 12000, 12800, 16000]) { h.at(time); await h.frame(hand()); }
  assert.equal(h.commands.length, 1);
  assert.equal(h.logs.filter((line) => line === '[GESTURE CUSTOM] Three_Fingers detected').length, 1);
  assert.ok(h.logs.includes('[GESTURE] command applied'));
  await h.frame(null);
  h.at(16200); await h.frame(hand());
  h.at(17000); await h.frame(hand());
  assert.equal(h.commands.length, 2);
});

test('all six classifier gestures keep mapping and hold durations', async () => {
  const cases = [
    ['Open_Palm', hand([5, 9, 13, 17], true), 'doorCommand', 'OPEN', 1200],
    ['Closed_Fist', hand([]), 'doorCommand', 'CLOSE', 800],
    ['Thumb_Up', hand([], true), 'lightBrightness', 100, 800],
    ['Thumb_Down', hand([], true), 'lightBrightness', 0, 800],
    ['Victory', hand([5, 9]), 'fanLevel', 1, 800],
    ['Pointing_Up', hand([5]), 'fanLevel', 0, 800],
  ];
  for (const [name, points, key, value, hold] of cases) {
    const h = harness();
    await h.frame(points, name);
    assert.equal(h.elements.get('detectedGesture').textContent, name);
    h.at(10000 + hold - 1); await h.frame(points, name); assert.equal(h.commands.length, 0);
    h.at(10000 + hold); await h.frame(points, name);
    assert.deepEqual(h.commands, [{ key, value }]);
  }
});

test('low classifier confidence and interrupted custom hold do not execute', async () => {
  const h = harness();
  await h.frame(null, 'Victory', 0.69);
  h.at(12000); await h.frame(null, 'Victory', 0.69);
  assert.equal(h.commands.length, 0);
  await h.frame(hand());
  h.at(12700); await h.frame(null);
  h.at(12800); await h.frame(hand());
  h.at(13599); await h.frame(hand()); assert.equal(h.commands.length, 0);
  h.at(13600); await h.frame(hand()); assert.equal(h.commands.length, 1);
});

test('custom gesture does not bypass pending command or report timeout as applied', async () => {
  const h = harness();
  let finish;
  h.context.window.sendCommand = () => new Promise((resolve) => { finish = resolve; });
  await h.frame(hand()); h.at(10800);
  const pending = h.frame(hand());
  assert.equal(h.elements.get('gestureCommandStatus').textContent, 'SENDING');
  h.at(13000); await h.frame(hand());
  assert.equal(h.elements.get('gestureCommandStatus').textContent, 'SENDING');
  finish({ status: 'timeout' }); await pending;
  assert.ok(h.logs.includes('[GESTURE] command timeout'));
  assert.ok(!h.logs.includes('[GESTURE] command applied'));
});
