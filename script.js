// ═══════════════════════════════════════════════════════════════
//  script.js — SMART HOME DASHBOARD
//  Xử lý Realtime Database: lắng nghe & ghi lệnh điều khiển
//
//  THAY ĐỔI SO VỚI PHIÊN BẢN CŨ:
//    - Xóa firebaseConfig (đã chuyển sang firebase-config.js)
//    - Xóa firebase.initializeApp() (auth.js đã khởi tạo rồi)
//    - Thêm document.body.classList.add("auth-ready") trong
//      DOMContentLoaded để hiện trang sau khi auth xác nhận
//    - Mọi logic Realtime Database giữ nguyên 100%
// ═══════════════════════════════════════════════════════════════

// ── Lấy instance database (Firebase App đã init trong auth.js) ──
const db = firebase.database();

// ── Tham chiếu đường dẫn Firebase — không thay đổi ──
const statusRef  = db.ref("smartHome/status");
const controlRef = db.ref("smartHome/control");

// ═══════════════════════════════════════════════════════════════
//  RENDER FUNCTIONS — không thay đổi so với phiên bản cũ
// ═══════════════════════════════════════════════════════════════

function renderDoorStatus(value) {
  const pill   = document.getElementById("doorStatus");
  const iconEl = document.getElementById("doorIcon");

  if (value === "OPEN") {
    pill.textContent = "🟢 DOOR OPEN";
    pill.className   = "card-status-pill status-open";
    iconEl.textContent = "🔓";
    iconEl.classList.add("door-open-glow");
  } else {
    pill.textContent = "⚫ DOOR CLOSED";
    pill.className   = "card-status-pill status-closed";
    iconEl.textContent = "🚪";
    iconEl.classList.remove("door-open-glow");
  }
}

function renderLightStatus(isOn, mode) {
  const pill   = document.getElementById("lightStatus");
  const modeEl = document.getElementById("lightMode");
  const iconEl = document.getElementById("lightIcon");

  if (isOn) {
    pill.textContent = "💡 LIGHT ON";
    pill.className   = "card-status-pill status-on";
    iconEl.textContent = "💡";
  } else {
    pill.textContent = "🌑 LIGHT OFF";
    pill.className   = "card-status-pill status-off";
    iconEl.textContent = "🔦";
  }
  modeEl.textContent = `MODE: ${mode || "--"}`;
}

function renderFanStatus(isOn, mode) {
  const pill   = document.getElementById("fanStatus");
  const modeEl = document.getElementById("fanMode");
  const iconEl = document.getElementById("fanIcon");

  if (isOn) {
    pill.textContent = "🌀 FAN ON";
    pill.className   = "card-status-pill status-on";
    iconEl.innerHTML = '<span class="fan-spinning">🌀</span>';
  } else {
    pill.textContent = "⭕ FAN OFF";
    pill.className   = "card-status-pill status-off";
    iconEl.innerHTML = "🌀";
  }
  modeEl.textContent = `MODE: ${mode || "--"}`;
}

function renderRackStatus(rackValue, isRaining, mode) {
  const pill     = document.getElementById("rackStatus");
  const rainEl   = document.getElementById("rainIndicator");
  const rainIcon = document.getElementById("rainIcon");
  const rainText = document.getElementById("rainText");
  const modeEl   = document.getElementById("rackMode");

  if (rackValue === "IN") {
    pill.textContent = "⬅ RACK IN";
    pill.className   = "card-status-pill status-on";
  } else {
    pill.textContent = "➡ RACK OUT";
    pill.className   = "card-status-pill status-closed";
  }

  if (isRaining) {
    rainEl.classList.add("raining");
    rainIcon.textContent = "🌧";
    rainText.textContent = "RAINING";
  } else {
    rainEl.classList.remove("raining");
    rainIcon.textContent = "🌤";
    rainText.textContent = "DRY";
  }

  // Hiển thị mode AUTO / MANUAL
  if (modeEl) modeEl.textContent = `MODE: ${mode || "--"}`;
}

function renderGasStatus(isDanger) {
  const pill        = document.getElementById("gasStatus");
  const card        = document.getElementById("cardGas");
  const warning     = document.getElementById("gasWarning");
  const alertBanner = document.getElementById("alertBanner");
  const alertIcon   = document.getElementById("alertIcon");
  const alertText   = document.getElementById("alertText");

  if (isDanger) {
    pill.textContent  = "⚠ DANGER — GAS LEAK";
    pill.className    = "card-status-pill status-danger";
    card.classList.add("gas-danger");
    warning.style.display = "block";
    alertBanner.className = "alert-banner danger";
    alertIcon.textContent = "⚠";
    alertText.textContent = "WARNING: GAS LEAK DETECTED — VENTILATE IMMEDIATELY";
  } else {
    pill.textContent  = "✔ SAFE";
    pill.className    = "card-status-pill status-safe";
    card.classList.remove("gas-danger");
    warning.style.display = "none";
    alertBanner.className = "alert-banner";
    alertIcon.textContent = "✔";
    alertText.textContent = "SYSTEM SAFE — ALL SENSORS NORMAL";
  }
}

function renderTemperature(celsius) {
  const valueEl = document.getElementById("tempValue");
  const subEl   = document.getElementById("tempSub");
  const ring    = document.getElementById("tempRing");
  const temp    = parseFloat(celsius) || 0;

  valueEl.textContent = `${temp}°C`;

  if      (temp < 20) subEl.textContent = "Cool — comfortable";
  else if (temp < 28) subEl.textContent = "Normal — comfortable";
  else if (temp < 35) subEl.textContent = "Warm — slightly hot";
  else                subEl.textContent = "Hot — consider fan";

  const circumference = 213.6;
  const pct = Math.min(Math.max(temp / 50, 0), 1);
  ring.style.strokeDashoffset = circumference * (1 - pct);

  if      (temp < 20) ring.style.stroke = "#1a8cff";
  else if (temp < 28) ring.style.stroke = "#00e676";
  else if (temp < 35) ring.style.stroke = "#ff9100";
  else                ring.style.stroke = "#ff1744";
}

function updateTimestamp() {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, "0");
  const mm  = String(now.getMinutes()).padStart(2, "0");
  const ss  = String(now.getSeconds()).padStart(2, "0");
  document.getElementById("lastUpdated").textContent = `${hh}:${mm}:${ss}`;
}

// ═══════════════════════════════════════════════════════════════
//  FIREBASE LISTENER — không thay đổi
// ═══════════════════════════════════════════════════════════════

function listenToFirebase() {
  statusRef.on("value", (snapshot) => {
    const data = snapshot.val();
    if (!data) {
      console.warn("Firebase: Không có dữ liệu trong smartHome/status");
      return;
    }
    renderDoorStatus(data.door);
    renderLightStatus(data.light, data.lightMode);
    renderFanStatus(data.fan, data.fanMode);
    renderRackStatus(data.rack, data.rain, data.rackMode);
    renderGasStatus(data.gas);
    renderTemperature(data.temperature);
    updateTimestamp();
    console.log("Firebase: Dữ liệu đã cập nhật", data);
  }, (error) => {
    console.error("Firebase error:", error);
    document.getElementById("connectionBadge").className = "status-badge offline";
    document.querySelector(".badge-text").textContent = "OFFLINE";
    document.querySelector(".badge-dot").style.animation = "none";
  });

  db.ref(".info/connected").on("value", (snap) => {
    const badge     = document.getElementById("connectionBadge");
    const badgeText = document.querySelector(".badge-text");
    const badgeDot  = document.querySelector(".badge-dot");

    if (snap.val() === true) {
      badge.className = "status-badge";
      badgeText.textContent = "ONLINE";
      badgeDot.style.animation = "pulse 2s infinite";
    } else {
      badge.className = "status-badge offline";
      badgeText.textContent = "OFFLINE";
      badgeDot.style.animation = "none";
    }
  });
}

// ═══════════════════════════════════════════════════════════════
//  CONTROL FUNCTIONS — không thay đổi
// ═══════════════════════════════════════════════════════════════

function sendDoorCommand(command) {
  controlRef.update({ doorCommand: command })
    .then(() => console.log("Lệnh cửa đã gửi:", command))
    .catch(err => console.error("Lỗi gửi lệnh cửa:", err));
}

function sendLightCommand(state) {
  controlRef.update({ lightCommand: state })
    .then(() => console.log("Lệnh đèn đã gửi:", state))
    .catch(err => console.error("Lỗi gửi lệnh đèn:", err));
}

function sendLightModeCommand(mode) {
  controlRef.update({ lightModeCommand: mode })
    .then(() => console.log("Lệnh mode đèn đã gửi:", mode))
    .catch(err => console.error("Lỗi gửi lệnh mode đèn:", err));
}

function sendFanCommand(state) {
  controlRef.update({ fanCommand: state })
    .then(() => console.log("Lệnh quạt đã gửi:", state))
    .catch(err => console.error("Lỗi gửi lệnh quạt:", err));
}

function sendFanModeCommand(mode) {
  controlRef.update({ fanModeCommand: mode })
    .then(() => console.log("Lệnh mode quạt đã gửi:", mode))
    .catch(err => console.error("Lỗi gửi lệnh mode quạt:", err));
}

function sendRackCommand(command) {
  controlRef.update({ rackCommand: command })
    .then(() => console.log("Lệnh giàn phơi đã gửi:", command))
    .catch(err => console.error("Lỗi gửi lệnh giàn phơi:", err));
}

function sendRackModeCommand(mode) {
  controlRef.update({ rackModeCommand: mode })
    .then(() => console.log("Lệnh mode giàn phơi đã gửi:", mode))
    .catch(err => console.error("Lỗi gửi lệnh mode giàn phơi:", err));
}

function bindButtons() {
  console.log("Buttons ready.");
}

// ═══════════════════════════════════════════════════════════════
//  KHỞI ĐỘNG
// ═══════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("footerYear").textContent = new Date().getFullYear();

  // Lắng nghe trạng thái auth để hiện trang + khởi động DB
  // auth.js đã đăng ký onAuthStateChanged để redirect nếu chưa đăng nhập
  // script.js đăng ký thêm 1 listener nữa để khởi động dashboard
  firebase.auth().onAuthStateChanged((user) => {
    if (user) {
      // Đã đăng nhập → bỏ ẩn trang, bắt đầu lắng nghe Firebase DB
      document.body.classList.add("auth-ready");
      listenToFirebase();
      bindButtons();
    }
    // Nếu chưa đăng nhập → auth.js đã xử lý redirect, không làm gì thêm
  });

  console.log("Smart Home Dashboard khởi động thành công.");
});