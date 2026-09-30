# ESP32-S3 N16R8: Camera + Firebase + STM32

Open `smarthome.ino` in this folder and upload this single sketch. The sources
were moved out of the incorrectly named `smarthome.ino/` folder; only old AVR
build artifacts remain there. `camera_source.txt` is the original reference,
not another sketch to upload.

## Build settings verified locally

- Board: ESP32S3 Dev Module, Espressif ESP32 core 3.3.7
- Flash: 16 MB; PSRAM: OPI PSRAM (8 MB on N16R8)
- Partition: 16M Flash (3MB APP/9.9MB FATFS)
- USB Mode: USB-OTG (TinyUSB); USB CDC/MSC/DFU On Boot: Disabled
- FirebaseClient 2.2.13; ArduinoJson 7.4.3

GPIO19/20 are used by UART, so do not enable native USB at runtime or connect
the native USB data interface while using these pins for STM32. Use the board's
USB-to-UART bridge for upload/Serial Monitor, or an external UART adapter as
appropriate for the board. `Serial` logs use UART0 with these build settings.

FQBN:
`esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB,USBMode=default,CDCOnBoot=default`

## Preserved behavior

- STM32 PA9 TX -> ESP32 GPIO19 RX; STM32 PA10 RX <- ESP32 GPIO20 TX;
  common GND; UART1, 115200, SERIAL_8N1.
- One Wi-Fi connection. After connection, setup calls `initSmartHomeCamera()`
  once, then initializes Firebase. Camera failure is logged and does not skip
  Firebase initialization.
- Camera settings come from `camera_source.txt`: ESP32S3_EYE pins, 20 MHz XCLK,
  VGA JPEG quality 20, latest-frame mode, two PSRAM buffers; existing sensor tuning.
- `http://<ESP_IP>/capture`: JPEG with `Access-Control-Allow-Origin: *`.
- `http://<ESP_IP>:81/stream`: MJPEG on the separate existing HTTP server task.
- Firebase auth, async client, polling (1 s), command mapping, ACK matching,
  timeout (5 s), STATE parser and uploads are unchanged. `espMillis` is uploaded
  with STM32 STATE, as before; it is not a separate heartbeat timer.
- Existing ALL MANUAL command retains its two 30 ms inter-command delays.
  The firmware loop has no added delay. The original startup UART test sending
  `CMD,LIGHT,MANUAL` is retained.
- `camera_index.h` was restored from the locally installed Espressif camera
  example (Arduino ESP32 2.0.18-arduino.5). Camera HTTP handlers are unchanged.
  Legacy on-device face features compile only when their ESP-DL headers exist;
  they are unavailable in the tested core 3.3.7. Browser MediaPipe is unaffected.

## Hardware acceptance checks (not yet performed)

1. Boot with OPI PSRAM enabled; check IP, camera initialization and Firebase auth.
2. Open dashboard preview and run MediaPipe `/capture` requests concurrently.
   Confirm JPEG/CORS and gesture recognition still work.
3. While streaming, test LIGHT, FAN, DOOR, CURTAIN, each MANUAL/AUTO mode and ALL.
   Verify UART text and that `applied` occurs only after every expected ACK.
4. Withhold an ACK (including one of the three ALL MANUAL ACKs): expect `timeout`
   after 5 s, never `applied`. An unrelated ACK must not complete the command.
5. Confirm TEMP/HUM/LDR/MQ2/LIGHT/FAN/LMODE/FMODE/DHT and espMillis continue
   updating during preview and gestures. Test DHT=ERROR and Wi-Fi recovery.

Local compilation succeeded: 1,180,102 bytes flash; 72,108 bytes static RAM.
This verifies compilation/linking, not live camera/Firebase/UART concurrency.
