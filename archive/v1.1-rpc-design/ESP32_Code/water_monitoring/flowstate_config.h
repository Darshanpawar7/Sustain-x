// FlowState firmware settings. Secrets (Wi-Fi, Supabase and the device key)
// live in secrets.h, which you create from secrets.example.h.
#pragma once

#include <stdint.h>

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------
constexpr uint8_t FLOW_SENSOR_1_PIN = 19;  // upstream sensor, near the tank
constexpr uint8_t FLOW_SENSOR_2_PIN = 22;  // downstream sensor, near the tap
constexpr uint8_t WATER_LEVEL_PIN = 33;    // capacitive level sensor (ADC1)
constexpr uint8_t BUZZER_PIN = 13;
constexpr uint8_t SERVO_PIN = 26;          // shut-off valve servo
constexpr uint8_t DHT_PIN = 4;             // DHT22 humidity sensor
constexpr uint8_t I2C_SDA_PIN = 18;        // DS3231 real-time clock
constexpr uint8_t I2C_SCL_PIN = 21;

// ---------------------------------------------------------------------------
// Valve servo
// ---------------------------------------------------------------------------
constexpr int SERVO_OPEN_ANGLE = 0;
constexpr int SERVO_CLOSED_ANGLE = 90;
constexpr int SERVO_MIN_PULSE_US = 500;
constexpr int SERVO_MAX_PULSE_US = 2400;

// ---------------------------------------------------------------------------
// Flow sensor calibration
// A YF-S201 gives about 450 pulses per litre (7.5 pulses per second per L/min).
// To calibrate a sensor, run exactly 10 L through it, read the pulse total with
// the STATUS command, and divide by 10.
// ---------------------------------------------------------------------------
constexpr float FLOW_SENSOR_1_PULSES_PER_LITER = 450.0f;
constexpr float FLOW_SENSOR_2_PULSES_PER_LITER = 450.0f;
constexpr uint32_t FLOW_PULSE_DEBOUNCE_US = 500;  // ignore edges closer together than this

// ---------------------------------------------------------------------------
// Tank level calibration
// The serial log prints the raw ADC value. Note it with the sensor dry, then
// fully submerged, and enter both numbers here. If the tank reads full when it
// is empty, the two numbers are the wrong way round.
// ---------------------------------------------------------------------------
constexpr int WATER_LEVEL_ADC_IN_AIR = 4095;
constexpr int WATER_LEVEL_ADC_IN_WATER = 1000;
constexpr float TANK_HEIGHT_CM = 100.0f;
constexpr float WATER_LEVEL_SMOOTHING = 0.3f;  // 0..1; lower is smoother

// ---------------------------------------------------------------------------
// Leak detection (compares the two flow sensors)
// ---------------------------------------------------------------------------
constexpr float LEAK_WARNING_FROM_PERCENT = 5.0f;     // 5-15 % loss = Warning
constexpr float LEAK_CRITICAL_ABOVE_PERCENT = 15.0f;  // over 15 % = Critical, valve closes
constexpr float LEAK_MIN_WINDOW_ML = 200.0f;          // water needed in 60 s before judging
constexpr float LEAK_MIN_FAST_ML = 60.0f;             // water needed in the fast window before judging
constexpr uint16_t LEAK_FAST_WINDOW_S = 5;            // fast check for sudden, large leaks
constexpr uint16_t LEAK_FAST_CONSECUTIVE_S = 3;       // fast check must hold this many seconds
constexpr uint16_t LEAK_WINDOW_CONSECUTIVE_S = 5;     // 60 s check must hold this many seconds

// ---------------------------------------------------------------------------
// Night watch (local time): steady flow at night usually means a leak
// ---------------------------------------------------------------------------
constexpr uint8_t NIGHT_START_HOUR = 2;
constexpr uint8_t NIGHT_END_HOUR = 5;                 // exclusive
constexpr float NIGHT_MIN_MINUTE_ML = 50.0f;          // a minute with less than this counts as no flow
constexpr uint16_t NIGHT_ALERT_MINUTES = 5;           // alert after this many minutes without a break
constexpr uint16_t NIGHT_CRITICAL_MINUTES = 10;       // close the valve after this many
constexpr float NIGHT_EXCESS_VOLUME_LITERS = 10.0f;   // alert when one night-time flow uses more

// ---------------------------------------------------------------------------
// Usage baseline: learns normal litres per hour of the day, then flags
// hours that use far more than usual
// ---------------------------------------------------------------------------
constexpr uint8_t BASELINE_DAYS_REQUIRED = 3;
constexpr float BASELINE_ALPHA = 0.3f;
constexpr float BASELINE_ALPHA_ANOMALOUS = 0.1f;
constexpr float ANOMALY_RATIO = 1.5f;
constexpr float ANOMALY_MIN_EXCESS_LITERS = 5.0f;
constexpr uint8_t BASELINE_MIN_MINUTES_OBSERVED = 50;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
constexpr uint32_t SENSOR_PERIOD_MS = 1000;
constexpr uint32_t UPLOAD_INTERVAL_MS = 5000;   // keep in step with deviceUploadIntervalMs in the dashboard
constexpr uint32_t HUMIDITY_PERIOD_MS = 5000;   // the DHT22 cannot be read more often than every 2 s
constexpr uint32_t HUMIDITY_STALE_MS = 60000;   // report humidity as unknown after a minute without a valid reading
constexpr uint32_t HTTP_TIMEOUT_MS = 5000;
constexpr uint32_t TLS_HANDSHAKE_TIMEOUT_S = 10;
constexpr uint32_t WIFI_RETRY_MS = 20000;
constexpr uint32_t STATUS_LOG_PERIOD_MS = 10000;

// ---------------------------------------------------------------------------
// Time zone, used for the night watch, daily totals and the usage baseline.
// POSIX format. Examples:
//   India "IST-5:30"   UK "GMT0BST,M3.5.0/1,M10.5.0"   US Eastern "EST5EDT,M3.2.0,M11.1.0"
// ---------------------------------------------------------------------------
constexpr const char *TIMEZONE = "IST-5:30";
constexpr const char *NTP_SERVER_1 = "pool.ntp.org";
constexpr const char *NTP_SERVER_2 = "time.google.com";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
constexpr bool LOG_EVERY_SECOND = false;  // true prints a sensor line every second
