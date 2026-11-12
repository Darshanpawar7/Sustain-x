#include "flowstate_cloud.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <math.h>
#include <stdarg.h>
#include <string.h>

#include <atomic>

#include "flowstate_config.h"
#include "flowstate_logic.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Missing secrets.h: copy secrets.example.h to secrets.h in the same folder and fill in your Wi-Fi, Supabase and device key."
#endif

#if ARDUINOJSON_VERSION_MAJOR < 7
#error "FlowState needs ArduinoJson 7 or newer. Update it in the Library Manager."
#endif

namespace {

const UBaseType_t kAlertQueueLength = 16;
const UBaseType_t kCommandQueueLength = 4;
const uint32_t kTaskStackBytes = 16384;  // HTTPS handshakes need plenty; STATUS shows what is left
const uint32_t kConfigErrorBackoffMs = 60000;
const uint32_t kErrorLogPeriodMs = 30000;

struct AlertMessage {
  char type[40];
  char severity[10];
  char message[200];
};

QueueHandle_t alert_queue = nullptr;
QueueHandle_t command_queue = nullptr;

portMUX_TYPE snapshot_mux = portMUX_INITIALIZER_UNLOCKED;
ReadingSnapshot latest_snapshot;
bool snapshot_ready = false;

std::atomic<bool> wifi_connected(false);
std::atomic<int> last_http_code(0);
std::atomic<uint32_t> last_upload_ok_ms(0);
std::atomic<uint32_t> alerts_dropped(0);
std::atomic<uint32_t> stack_free_bytes(0);
bool credentials_configured = false;

// Used only by the network task.
WiFiClientSecure tls_client;
HTTPClient http;
uint32_t sent_pulses_1 = 0;
uint32_t sent_pulses_2 = 0;
uint32_t backoff_started_ms = 0;
uint32_t backoff_ms = 0;
uint32_t last_error_log_ms = 0;

// Uses the ESP32 core's built-in list of trusted certificate authorities, so
// the device only talks to the genuine Supabase server.
template <typename Client>
auto enable_certificate_checks(Client &client, int) -> decltype(client.useBuiltinCACertBundle(), void()) {
  client.useBuiltinCACertBundle();
}

template <typename Client>
void enable_certificate_checks(Client &, long) {
  static_assert(sizeof(Client) == 0,
                "This ESP32 core cannot check HTTPS certificates with its built-in bundle. "
                "Update 'esp32 by Espressif Systems' to 3.3.0 or newer in the Boards Manager.");
}

const char *severity_name(AlertSeverity severity) {
  switch (severity) {
    case AlertSeverity::Low: return "low";
    case AlertSeverity::High: return "high";
    case AlertSeverity::Critical: return "critical";
    default: return "medium";
  }
}

float round2(float value) {
  if (!isfinite(value)) return 0.0f;
  return roundf(value * 100.0f) / 100.0f;
}

bool contains(const char *text, const char *part) { return strstr(text, part) != nullptr; }

bool looks_configured() {
  return !contains(SUPABASE_URL, "YOUR_PROJECT") && strncmp(SUPABASE_URL, "https://", 8) == 0 &&
         !contains(SUPABASE_ANON_KEY, "YOUR_") && !contains(DEVICE_KEY, "PASTE_") && strlen(DEVICE_KEY) >= 32 &&
         !contains(WIFI_SSID, "YOUR_");
}

bool in_backoff() { return backoff_ms != 0 && millis() - backoff_started_ms < backoff_ms; }

void start_backoff(uint32_t duration_ms) {
  backoff_started_ms = millis();
  backoff_ms = duration_ms;
}

// POSTs a JSON body to a Supabase RPC function. Returns the HTTP status, or a
// negative number for connection errors.
int post_rpc(const char *function_name, const String &body, String &response) {
  String url = String(SUPABASE_URL) + "/rest/v1/rpc/" + function_name;
  if (!http.begin(tls_client, url)) {
    last_http_code = -1;
    return -1;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  // Legacy anon keys are JWTs and also go in Authorization; newer publishable keys do not.
  if (strncmp(SUPABASE_ANON_KEY, "eyJ", 3) == 0) {
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  }

  int code = http.POST(body);
  response = code > 0 ? http.getString() : String();
  http.end();
  last_http_code = code;
  return code;
}

void report_failure(const char *what, int code, const String &response) {
  if (code == 401 || code == 403 || code == 404) start_backoff(kConfigErrorBackoffMs);
  if (last_error_log_ms != 0 && millis() - last_error_log_ms < kErrorLogPeriodMs) return;
  last_error_log_ms = millis();

  if (code < 0) {
    Serial.printf("[CLOUD] %s failed: %s\n", what, HTTPClient::errorToString(code).c_str());
  } else if (code == 401) {
    Serial.printf("[CLOUD] %s rejected (401): check SUPABASE_ANON_KEY in secrets.h\n", what);
  } else if (code == 403) {
    Serial.printf("[CLOUD] %s rejected (403): check DEVICE_KEY in secrets.h (create one with "
                  "private.create_access_key)\n", what);
  } else if (code == 404) {
    Serial.printf("[CLOUD] %s failed (404): apply the Supabase migrations 005-008\n", what);
  } else {
    Serial.printf("[CLOUD] %s failed (HTTP %d): %.160s\n", what, code, response.c_str());
  }
}

void queue_command_from_reply(const String &response) {
  JsonDocument reply;
  if (deserializeJson(reply, response)) return;

  JsonVariant command = reply["command"];
  if (command.isNull()) return;

  const char *action = command["action"] | "";
  ValveCommand parsed;
  parsed.id = command["id"] | 0;
  if (strcmp(action, "open") == 0) {
    parsed.open = true;
  } else if (strcmp(action, "close") == 0) {
    parsed.open = false;
  } else {
    return;
  }
  xQueueSend(command_queue, &parsed, 0);
}

void upload_latest_reading() {
  ReadingSnapshot snapshot;
  bool ready;
  portENTER_CRITICAL(&snapshot_mux);
  snapshot = latest_snapshot;
  ready = snapshot_ready;
  portEXIT_CRITICAL(&snapshot_mux);
  if (!ready) return;

  // Volumes are sent as "since the last successful upload", so nothing is
  // lost or counted twice when an upload fails.
  uint32_t new_pulses_1 = snapshot.total_pulses_1 - sent_pulses_1;
  uint32_t new_pulses_2 = snapshot.total_pulses_2 - sent_pulses_2;

  JsonDocument doc;
  doc["p_device_key"] = DEVICE_KEY;
  doc["p_flow_rate_1"] = round2(snapshot.flow_rate_1_lpm);
  doc["p_flow_rate_2"] = round2(snapshot.flow_rate_2_lpm);
  doc["p_percentage_loss"] = round2(snapshot.percentage_loss);
  doc["p_water_level"] = round2(snapshot.water_level_cm);
  doc["p_valve_state"] = snapshot.valve_open ? 1 : 0;
  doc["p_leak_status"] = snapshot.leak_status;
  doc["p_anomaly_status"] = snapshot.anomaly_status;
  doc["p_daily_total_liters"] = roundf(snapshot.daily_total_liters * 1000.0f) / 1000.0f;
  if (snapshot.humidity_valid) {
    doc["p_humidity"] = round2(snapshot.humidity_percent);
  } else {
    doc["p_humidity"] = nullptr;
  }
  doc["p_volume_1_ml"] = round2(flowstate::pulses_to_ml(new_pulses_1, FLOW_SENSOR_1_PULSES_PER_LITER));
  doc["p_volume_2_ml"] = round2(flowstate::pulses_to_ml(new_pulses_2, FLOW_SENSOR_2_PULSES_PER_LITER));

  String body;
  serializeJson(doc, body);
  String response;
  int code = post_rpc("ingest_reading", body, response);
  if (code != 200) {
    report_failure("Reading upload", code, response);
    return;
  }

  sent_pulses_1 = snapshot.total_pulses_1;
  sent_pulses_2 = snapshot.total_pulses_2;
  last_upload_ok_ms = millis();
  backoff_ms = 0;
  queue_command_from_reply(response);
}

void send_queued_alerts() {
  AlertMessage alert;
  for (int sent = 0; sent < 5 && xQueuePeek(alert_queue, &alert, 0) == pdTRUE; ++sent) {
    JsonDocument doc;
    doc["p_device_key"] = DEVICE_KEY;
    doc["p_alert_type"] = alert.type;
    doc["p_message"] = alert.message;
    doc["p_severity"] = alert.severity;
    String body;
    serializeJson(doc, body);

    String response;
    int code = post_rpc("log_device_alert", body, response);
    if (code == 200) {
      xQueueReceive(alert_queue, &alert, 0);
      continue;
    }
    bool rejected_for_good = code == 400 || code == 409 || code == 413 || code == 422;
    if (rejected_for_good) {
      // The server refused this particular alert; drop it so it cannot block the queue.
      xQueueReceive(alert_queue, &alert, 0);
      alerts_dropped++;
      Serial.printf("[CLOUD] Alert %s rejected (HTTP %d) and dropped: %.120s\n", alert.type, code, response.c_str());
      continue;
    }
    report_failure("Alert upload", code, response);
    return;
  }
}

void cloud_task(void *) {
  enable_certificate_checks(tls_client, 0);
  tls_client.setHandshakeTimeout(TLS_HANDSHAKE_TIMEOUT_S);
  http.setReuse(true);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t last_wifi_attempt_ms = millis();
  uint32_t last_upload_attempt_ms = 0;
  bool was_connected = false;
  bool time_sync_started = false;

  for (;;) {
    bool connected = WiFi.status() == WL_CONNECTED;
    wifi_connected = connected;
    if (connected != was_connected) {
      was_connected = connected;
      if (connected) {
        Serial.printf("[WiFi] Connected to %s, IP %s, signal %d dBm\n", WIFI_SSID,
                      WiFi.localIP().toString().c_str(), WiFi.RSSI());
      } else {
        Serial.println("[WiFi] Disconnected; readings are kept locally and alerts are queued");
      }
    }

    if (!connected) {
      if (millis() - last_wifi_attempt_ms >= WIFI_RETRY_MS) {
        last_wifi_attempt_ms = millis();
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }

    if (!time_sync_started) {
      configTzTime(TIMEZONE, NTP_SERVER_1, NTP_SERVER_2);
      time_sync_started = true;
    }

    if (credentials_configured && !in_backoff()) {
      send_queued_alerts();
      if (last_upload_attempt_ms == 0 || millis() - last_upload_attempt_ms >= UPLOAD_INTERVAL_MS) {
        last_upload_attempt_ms = millis();
        upload_latest_reading();
      }
    }
    // On ESP-IDF this is the smallest amount of stack (in bytes) that has stayed free.
    stack_free_bytes = uxTaskGetStackHighWaterMark(nullptr);
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

}  // namespace

void cloud_begin() {
  alert_queue = xQueueCreate(kAlertQueueLength, sizeof(AlertMessage));
  command_queue = xQueueCreate(kCommandQueueLength, sizeof(ValveCommand));
  credentials_configured = looks_configured();
  if (!credentials_configured) {
    Serial.println("[CLOUD] secrets.h still has placeholder values; uploads are off until you fill it in");
  }
  xTaskCreatePinnedToCore(cloud_task, "flowstate-cloud", kTaskStackBytes, nullptr, 1, nullptr, 0);
}

void cloud_publish(const ReadingSnapshot &snapshot) {
  portENTER_CRITICAL(&snapshot_mux);
  latest_snapshot = snapshot;
  snapshot_ready = true;
  portEXIT_CRITICAL(&snapshot_mux);
}

void cloud_alert(const char *type, AlertSeverity severity, const char *format, ...) {
  AlertMessage alert;
  strlcpy(alert.type, type, sizeof(alert.type));
  strlcpy(alert.severity, severity_name(severity), sizeof(alert.severity));
  va_list args;
  va_start(args, format);
  vsnprintf(alert.message, sizeof(alert.message), format, args);
  va_end(args);

  Serial.printf("[ALERT] %s (%s): %s\n", alert.type, alert.severity, alert.message);
  if (alert_queue == nullptr) return;
  if (xQueueSend(alert_queue, &alert, 0) != pdTRUE) {
    // Queue full (long outage): drop the oldest so the newest alerts survive.
    AlertMessage oldest;
    xQueueReceive(alert_queue, &oldest, 0);
    alerts_dropped++;
    xQueueSend(alert_queue, &alert, 0);
  }
}

bool cloud_next_command(ValveCommand &command) {
  return command_queue != nullptr && xQueueReceive(command_queue, &command, 0) == pdTRUE;
}

CloudStatus cloud_status() {
  CloudStatus status;
  status.configured = credentials_configured;
  status.wifi_connected = wifi_connected;
  status.last_http_code = last_http_code;
  status.last_upload_ok_ms = last_upload_ok_ms;
  status.alerts_waiting = alert_queue ? uxQueueMessagesWaiting(alert_queue) : 0;
  status.alerts_dropped = alerts_dropped;
  status.stack_free_bytes = stack_free_bytes;
  return status;
}
