# Firebase Realtime Database cho SmartHome

Dashboard sử dụng Firebase Authentication hiện có và hai nhánh Realtime Database:

- `/smartHome/state`: trạng thái do ESP32 cập nhật; đây là nguồn sự thật duy nhất cho UI.
- `/smartHome/commands/{commandId}`: hàng đợi lệnh do web tạo, ESP32 xử lý và cập nhật kết quả ACK từ STM32.

## State schema

```json
{
  "smartHome": {
    "state": {
      "temperature": 30.5,
      "humidity": 68,
      "ldr": 1720,
      "mq2": 430,
      "light": 1,
      "fan": 0,
      "door": "CLOSED",
      "curtain": "OPEN",
      "lightMode": "AUTO",
      "fanMode": "MANUAL",
      "curtainMode": "MANUAL",
      "gas": 0,
      "dht": "OK",
      "espMillis": 123456
    }
  }
}
```

Ý nghĩa các giá trị:

| Field | Giá trị |
|---|---|
| `temperature` | Nhiệt độ °C |
| `humidity` | Độ ẩm % |
| `ldr` | Giá trị ánh sáng thô |
| `mq2` | Giá trị MQ2 thô |
| `light`, `fan` | `0` = OFF, `1` = ON |
| `door`, `curtain` | `OPEN` hoặc `CLOSED` |
| `lightMode`, `fanMode`, `curtainMode` | `AUTO` hoặc `MANUAL` |
| `gas` | `0` = SAFE, `1` = DANGER |
| `dht` | `OK` hoặc `ERROR` |
| `espMillis` | Uptime ESP32; dashboard dùng thay đổi của field này để xác định thiết bị online |

Field chưa tồn tại phải được xem là chưa có dữ liệu. Dashboard hiển thị `--`, `UNKNOWN` hoặc `N/A` và không giả định trạng thái ON/OFF.

## Command schema

Mỗi thao tác điều khiển tạo một child mới bằng Firebase `push()`:

```json
{
  "smartHome": {
    "commands": {
      "-generatedCommandId": {
        "key": "doorCommand",
        "value": "OPEN",
        "status": "pending",
        "createdAt": 1790730000000
      }
    }
  }
}
```

`createdAt` sử dụng `firebase.database.ServerValue.TIMESTAMP`.

Vòng đời command:

1. Web ghi command với `status: "pending"`.
2. ESP32 đọc command, gửi lệnh qua UART cho STM32 và chờ ACK thật.
3. ESP32 cập nhật `status` thành một trong:
   - `applied`: STM32 ACK thành công.
   - `timeout`: không nhận được ACK trong thời gian cho phép.
   - `rejected`: key hoặc value không hợp lệ.
4. Web theo dõi status của đúng command ID và chỉ hiển thị kết quả command. Trạng thái thiết bị trên card vẫn chỉ lấy từ `/smartHome/state`.

## Command mapping

| Thao tác | `key` | `value` |
|---|---|---|
| Light ON | `lightBrightness` | `100` |
| Light OFF | `lightBrightness` | `0` |
| Fan ON | `fanLevel` | `1` |
| Fan OFF | `fanLevel` | `0` |
| Door OPEN | `doorCommand` | `"OPEN"` |
| Door CLOSE | `doorCommand` | `"CLOSE"` |
| Curtain OPEN | `curtainPosition` | `100` |
| Curtain CLOSE | `curtainPosition` | `0` |
| Light mode | `lightMode` | `"AUTO"` hoặc `"MANUAL"` |
| Fan mode | `fanMode` | `"AUTO"` hoặc `"MANUAL"` |
| Curtain mode | `curtainMode` | `"AUTO"` hoặc `"MANUAL"` |
| Tất cả mode | `allDeviceModes` | `"AUTO"` hoặc `"MANUAL"` |

## AUTO behavior hiện tại

- Light: dùng LDR, ngưỡng `1800`.
- Fan: bật khi nhiệt độ DHT11 từ `35°C`, tắt khi thấp hơn.
- Curtain: giữ nguyên vị trí hiện tại vì chưa có thuật toán AUTO.
- Door: không có mode AUTO/MANUAL.

## Connection indicators

- `FIREBASE: ONLINE/OFFLINE` lấy từ `/.info/connected`.
- `DEVICE: ONLINE/OFFLINE` dựa trên việc `espMillis` có thay đổi trong vòng 10 giây hay không.

## Authentication và cấu hình

- Firebase config tiếp tục nằm trong `firebase-config.js`.
- `auth.js` bảo vệ dashboard và xử lý login/logout.
- Không thêm credential Firebase vào `script.js` hoặc HTML.
