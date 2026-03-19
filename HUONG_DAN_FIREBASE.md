# Hướng dẫn kết nối Firebase & cấu trúc dữ liệu cho ESP32

---

## PHẦN 1 — Kết nối Firebase vào Dashboard Web

### Bước 1: Tạo dự án Firebase
1. Truy cập https://console.firebase.google.com
2. Nhấn **"Add project"** → Đặt tên (vd: `smart-home-iot`) → Tạo
3. Vào **Build → Realtime Database** → Nhấn **"Create Database"**
4. Chọn vùng phù hợp (Singapore gần VN nhất)
5. Chọn **Start in test mode** (dùng trong lúc phát triển)

### Bước 2: Lấy firebaseConfig
1. Vào **Project Settings** (bánh răng ⚙ góc trái)
2. Kéo xuống phần **"Your apps"** → nhấn **</>** (Web app)
3. Đặt tên app → **Register app**
4. Sao chép đoạn `firebaseConfig = { ... }`

### Bước 3: Dán vào script.js
Mở file `script.js`, thay thế phần:
```js
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  ...
};
```
bằng config thực tế lấy từ Firebase Console.

⚠️ **Lưu ý:** `databaseURL` phải có đúng định dạng:
`https://TÊN_DỰ_ÁN-default-rtdb.firebaseio.com`

---

## PHẦN 2 — Cấu trúc dữ liệu Firebase (JSON)

Cấu trúc đề xuất cho Realtime Database:

```
smartHome/
│
├── status/                  ← ESP32 GHI VÀO ĐÂY
│   ├── door:         "OPEN"     (string: "OPEN" / "CLOSED")
│   ├── light:        true       (boolean: true / false)
│   ├── fan:          false      (boolean: true / false)
│   ├── rack:         "IN"       (string: "IN" / "OUT")
│   ├── rain:         false      (boolean: true / false)
│   ├── gas:          false      (boolean: true / false)
│   ├── temperature:  30         (number: độ Celsius)
│   ├── lightMode:    "MANUAL"   (string: "AUTO" / "MANUAL")
│   └── fanMode:      "AUTO"     (string: "AUTO" / "MANUAL")
│
└── control/                 ← WEB GHI VÀO, ESP32 ĐỌC TỪ ĐÂY
    ├── doorCommand:       "OPEN"    (string: "OPEN" / "CLOSE")
    ├── lightCommand:      true      (boolean)
    ├── fanCommand:        false     (boolean)
    ├── rackCommand:       "IN"      (string: "IN" / "OUT")
    ├── lightModeCommand:  "MANUAL"  (string: "AUTO" / "MANUAL")
    └── fanModeCommand:    "AUTO"    (string: "AUTO" / "MANUAL")
```

### Khởi tạo dữ liệu mẫu trong Firebase Console:
1. Vào **Realtime Database**
2. Nhấn dấu **+** hoặc import JSON bên dưới:

```json
{
  "smartHome": {
    "status": {
      "door": "CLOSED",
      "light": false,
      "fan": false,
      "rack": "IN",
      "rain": false,
      "gas": false,
      "temperature": 30,
      "lightMode": "MANUAL",
      "fanMode": "MANUAL"
    },
    "control": {
      "doorCommand": "CLOSE",
      "lightCommand": false,
      "fanCommand": false,
      "rackCommand": "IN",
      "lightModeCommand": "MANUAL",
      "fanModeCommand": "MANUAL"
    }
  }
}
```

---

## PHẦN 3 — Code ESP32 (Arduino) đọc/ghi Firebase

### Thư viện cần cài:
- `Firebase ESP Client` của Mobizt (cài qua Arduino Library Manager)
- `ArduinoJson`

### Ví dụ code cơ bản ESP32:

```cpp
#include <WiFi.h>
#include <FirebaseESP32.h>

#define WIFI_SSID     "TÊN_WIFI"
#define WIFI_PASSWORD "MẬT_KHẨU_WIFI"
#define FIREBASE_HOST "TÊN_DỰ_ÁN-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH "DATABASE_SECRET"  // Lấy từ Project Settings > Service Accounts

FirebaseData   fbData;
FirebaseConfig fbConfig;
FirebaseAuth   fbAuth;

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(300);

  fbConfig.host         = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);
}

void loop() {
  // ── GHI trạng thái lên Firebase ──────────────────────────
  Firebase.setFloat(fbData,  "smartHome/status/temperature", readTemp());
  Firebase.setBool(fbData,   "smartHome/status/gas",         readGasSensor());
  Firebase.setBool(fbData,   "smartHome/status/rain",        readRainSensor());
  Firebase.setString(fbData, "smartHome/status/door",        getDoorState()); // "OPEN"/"CLOSED"
  Firebase.setBool(fbData,   "smartHome/status/light",       getLightState());
  Firebase.setBool(fbData,   "smartHome/status/fan",         getFanState());
  Firebase.setString(fbData, "smartHome/status/rack",        getRackState()); // "IN"/"OUT"

  // ── ĐỌC lệnh điều khiển từ Firebase ─────────────────────
  if (Firebase.getString(fbData, "smartHome/control/doorCommand")) {
    String cmd = fbData.stringData();
    if (cmd == "OPEN")  openDoor();
    else                closeDoor();
  }

  if (Firebase.getBool(fbData, "smartHome/control/lightCommand")) {
    bool lightOn = fbData.boolData();
    digitalWrite(LIGHT_PIN, lightOn ? HIGH : LOW);
  }

  if (Firebase.getBool(fbData, "smartHome/control/fanCommand")) {
    bool fanOn = fbData.boolData();
    digitalWrite(FAN_PIN, fanOn ? HIGH : LOW);
  }

  if (Firebase.getString(fbData, "smartHome/control/rackCommand")) {
    String rackCmd = fbData.stringData();
    if (rackCmd == "IN")  pullRackIn();
    else                  pullRackOut();
  }

  delay(500); // Cập nhật mỗi 500ms
}
```

---

## PHẦN 4 — Cấu trúc file dự án

```
smart-home-dashboard/
├── index.html    ← File chính, mở trực tiếp trên trình duyệt
├── style.css     ← Toàn bộ CSS
└── script.js     ← Logic Firebase + điều khiển
```

### Cách chạy:
1. Điền `firebaseConfig` đúng vào `script.js`
2. Mở `index.html` trực tiếp trong Chrome/Edge
   *(hoặc dùng Live Server trong VS Code)*
3. Dữ liệu sẽ cập nhật realtime khi ESP32 ghi lên Firebase

---

## LƯU Ý BẢO MẬT (dành cho bài nộp / demo thực tế)

- Trong **Firebase Console → Realtime Database → Rules**, thay:
  ```json
  { "rules": { ".read": true, ".write": true } }
  ```
  bằng rules giới hạn khi deploy thực tế.
- **Không commit** `firebaseConfig` lên GitHub public.
- Dùng **Environment Variables** hoặc file `.env` khi production.
