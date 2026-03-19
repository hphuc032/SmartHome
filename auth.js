// ═══════════════════════════════════════════════════════════════
//  auth.js
//  Xử lý toàn bộ Authentication: login, logout, kiểm tra phiên
//
//  File này được dùng TRÊN CẢ HAI TRANG:
//    - login.html  → khởi tạo Firebase Auth, xử lý login form
//    - dashboard.html → kiểm tra phiên, hiện email, xử lý logout
//
//  Cách hoạt động:
//    auth.js tự phát hiện đang chạy ở trang nào dựa vào
//    document.getElementById("btnLogin") (chỉ có ở login.html)
// ═══════════════════════════════════════════════════════════════

// ── Khởi tạo Firebase App (chỉ 1 lần, tránh lỗi duplicate) ──
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

// ── Lấy instance Auth ──
const auth = firebase.auth();

// ── Xác định đang ở trang nào ──
const IS_LOGIN_PAGE     = !!document.getElementById("btnLogin");
const IS_DASHBOARD_PAGE = !!document.getElementById("btnLogout");

// ═══════════════════════════════════════════════════════════════
//  onAuthStateChanged — chạy mỗi khi trạng thái đăng nhập thay đổi
//  Đây là "bảo vệ route" chính của ứng dụng
// ═══════════════════════════════════════════════════════════════
auth.onAuthStateChanged((user) => {
  if (IS_LOGIN_PAGE) {
    // Nếu đang ở login page mà đã đăng nhập → chuyển sang dashboard
    if (user) {
      window.location.href = "dashboard.html";
    }
    // Nếu chưa đăng nhập → ở lại login page, không làm gì
  }

  if (IS_DASHBOARD_PAGE) {
    if (user) {
      // Đã đăng nhập → hiển thị email người dùng
      renderUserEmail(user.email);
    } else {
      // Chưa đăng nhập → chuyển ngay về login page
      window.location.href = "login.html";
    }
  }
});

// ═══════════════════════════════════════════════════════════════
//  HANDLE LOGIN — xử lý khi nhấn nút Login
// ═══════════════════════════════════════════════════════════════

/**
 * Được gọi khi nhấn nút Login (onclick trên login.html)
 */
function handleLogin() {
  const emailInput    = document.getElementById("inputEmail");
  const passwordInput = document.getElementById("inputPassword");
  const btnLogin      = document.getElementById("btnLogin");
  const errorBox      = document.getElementById("errorBox");

  const email    = emailInput.value.trim();
  const password = passwordInput.value;

  // ── Validate đầu vào ──
  if (!email || !password) {
    showError("Vui lòng nhập đầy đủ email và mật khẩu.");
    return;
  }

  // ── Hiện trạng thái loading ──
  setLoginLoading(true);
  hideError();

  // ── Gọi Firebase signIn ──
  auth.signInWithEmailAndPassword(email, password)
    .then((userCredential) => {
      // Đăng nhập thành công → onAuthStateChanged sẽ tự redirect
      console.log("Đăng nhập thành công:", userCredential.user.email);
    })
    .catch((error) => {
      // Đăng nhập thất bại → hiển thị lỗi
      setLoginLoading(false);
      showError(getAuthErrorMessage(error.code));
      console.error("Lỗi đăng nhập:", error.code, error.message);
    });
}

// ── Cho phép nhấn Enter để login ──
document.addEventListener("DOMContentLoaded", () => {
  const passwordInput = document.getElementById("inputPassword");
  if (passwordInput) {
    passwordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleLogin();
    });
  }
  const emailInput = document.getElementById("inputEmail");
  if (emailInput) {
    emailInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        document.getElementById("inputPassword")?.focus();
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  HANDLE LOGOUT — xử lý khi nhấn nút Logout trên dashboard
// ═══════════════════════════════════════════════════════════════

/**
 * Được gọi khi nhấn nút Logout (onclick trên dashboard.html)
 */
function handleLogout() {
  auth.signOut()
    .then(() => {
      // Đăng xuất thành công → chuyển về login
      console.log("Đã đăng xuất.");
      window.location.href = "login.html";
    })
    .catch((error) => {
      console.error("Lỗi đăng xuất:", error);
    });
}

// ═══════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Hiển thị email người dùng trên header dashboard
 * @param {string} email
 */
function renderUserEmail(email) {
  const emailEl = document.getElementById("userEmail");
  if (emailEl) {
    // Rút ngắn email nếu quá dài
    emailEl.textContent = email.length > 22
      ? email.substring(0, 20) + "…"
      : email;
  }
}

/**
 * Hiện / ẩn trạng thái loading trên nút Login
 * @param {boolean} isLoading
 */
function setLoginLoading(isLoading) {
  const btn = document.getElementById("btnLogin");
  if (!btn) return;
  if (isLoading) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> ĐANG XÁC THỰC...';
  } else {
    btn.disabled = false;
    btn.innerHTML = 'LOGIN';
  }
}

/**
 * Hiện thông báo lỗi
 * @param {string} message
 */
function showError(message) {
  const box = document.getElementById("errorBox");
  if (!box) return;
  box.textContent = "⚠ " + message;
  box.className = "error-box visible";
}

/**
 * Ẩn thông báo lỗi
 */
function hideError() {
  const box = document.getElementById("errorBox");
  if (box) box.className = "error-box";
}

/**
 * Chuyển mã lỗi Firebase Auth sang tiếng Việt dễ hiểu
 * @param {string} code - Firebase error code
 * @returns {string}
 */
function getAuthErrorMessage(code) {
  const messages = {
    "auth/invalid-email":          "Email không hợp lệ.",
    "auth/user-not-found":         "Tài khoản không tồn tại.",
    "auth/wrong-password":         "Mật khẩu không đúng.",
    "auth/invalid-credential":     "Email hoặc mật khẩu không đúng.",
    "auth/too-many-requests":      "Quá nhiều lần thử. Vui lòng thử lại sau.",
    "auth/user-disabled":          "Tài khoản đã bị vô hiệu hóa.",
    "auth/network-request-failed": "Lỗi kết nối mạng. Kiểm tra internet.",
    "auth/email-already-in-use":   "Email này đã được đăng ký.",  // dùng khi có register
    "auth/weak-password":          "Mật khẩu cần ít nhất 6 ký tự.", // dùng khi có register
  };
  return messages[code] || `Lỗi đăng nhập (${code}). Vui lòng thử lại.`;
}