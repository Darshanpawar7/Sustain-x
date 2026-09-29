/*
  FlowState - ESP32 water monitoring and leak detection

  Every second (main loop, never waits on the network):
    - counts pulses from two flow sensors: one near the tank, one near the tap
    - compares them; water that goes missing between the two is a leak
    - closes the valve and sounds the alarm when the leak is critical
  Every minute: night-time flow watch (2-5 AM local time) and usage learning.
  Every 5 seconds (network task): uploads a reading to Supabase and collects
  any valve command sent from the dashboard.

  Setup:
    1. Copy secrets.example.h to secrets.h and fill it in.
    2. Check pins, calibration and TIMEZONE in flowstate_config.h.
    3. Board: "ESP32 Dev Module" with the esp32 core 3.3 or newer.

  Serial commands (115200 baud): STATUS, VALVE_OPEN, VALVE_CLOSE, VALVE_TOGGLE,
  OVERRIDE_ON, OVERRIDE_OFF, SILENCE, HELP
*/

#include "flowstate_config.h"
#include "flowstate_logic.h"
#include "flowstate_hardware.h"
#include "flowstate_clock.h"
#include "flowstate_cloud.h"

using flowstate::LeakAssessment;
using flowstate::LeakLevel;
using flowstate::LeakTrigger;

static const flowstate::LeakSettings kLeakSettings = {
    FLOW_SENSOR_1_PULSES_PER_LITER, FLOW_SENSOR_2_PULSES_PER_LITER,
    LEAK_WARNING_FROM_PERCENT,      LEAK_CRITICAL_ABOVE_PERCENT,
    LEAK_MIN_WINDOW_ML,             LEAK_MIN_FAST_ML,
    LEAK_FAST_WINDOW_S,             LEAK_FAST_CONSECUTIVE_S,
    LEAK_WINDOW_CONSECUTIVE_S};

static const flowstate::NightSettings kNightSettings = {
    NIGHT_START_HOUR,     NIGHT_END_HOUR,         NIGHT_MIN_MINUTE_ML,
    NIGHT_ALERT_MINUTES,  NIGHT_CRITICAL_MINUTES, NIGHT_EXCESS_VOLUME_LITERS};

static const flowstate::BaselineSettings kBaselineSettings = {
    BASELINE_DAYS_REQUIRED, BASELINE_ALPHA,            BASELINE_ALPHA_ANOMALOUS,
    ANOMALY_RATIO,          ANOMALY_MIN_EXCESS_LITERS, BASELINE_MIN_MINUTES_OBSERVED};

static flowstate::LeakDetector leak_detector(kLeakSettings);
static flowstate::NightWatch night_watch(kNightSettings);
static flowstate::DailyTotals daily_totals;
static flowstate::BaselineState baseline_state;
static flowstate::HourlyBaseline *baseline = nullptr;  // created once the saved state is loaded

static LeakAssessment last_assessment = {0.0f, LeakLevel::Normal, LeakTrigger::None};
static bool manual_override = false;      // true: automatic shut-off is disabled
static bool leak_lockout = false;         // valve closed by leak protection; stays Critical until reopened
static float lockout_loss_percent = 0.0f;

static uint32_t total_pulses_1 = 0;
static uint32_t total_pulses_2 = 0;
static float minute_ml_1 = 0.0f;
static uint8_t minute_seconds = 0;
static uint32_t last_sensor_ms = 0;
static uint32_t last_status_log_ms = 0;

static float water_level_cm = 0.0f;
static int water_level_raw = 0;
static float humidity_percent = 0.0f;
static bool humidity_ok = false;

static char serial_line[40];
static size_t serial_length = 0;
static uint32_t last_serial_char_ms = 0;

// ---------------------------------------------------------------------------
// Valve actions
// ---------------------------------------------------------------------------
static void close_valve_for_leak(const char *alert_type, float loss_percent, const char *reason) {
  valve_move(false);
  leak_lockout = true;
  lockout_loss_percent = loss_percent;
  leak_lockout_save(true, loss_percent);
  leak_detector.reset();
  buzzer_start(millis());
  cloud_alert(alert_type, AlertSeverity::Critical, "%s. Valve closed automatically.", reason);
}

static void set_valve_by_operator(bool open, const char *source) {
  if (open == valve_is_open()) {
    Serial.printf("[VALVE] Already %s (request from the %s)\n", open ? "open" : "closed", source);
    return;
  }
  valve_move(open);
  if (open) {
    leak_lockout = false;
    lockout_loss_percent = 0.0f;
    leak_lockout_save(false, 0.0f);
    buzzer_stop();
    leak_detector.reset();
  }
  cloud_alert(open ? "VALVE_OPENED" : "VALVE_CLOSED", AlertSeverity::Low, "Valve %s from the %s.",
              open ? "opened" : "closed", source);
}

static void handle_leak_trigger(const LeakAssessment &assessment);

static void set_manual_override(bool enabled) {
  if (enabled == manual_override) return;
  manual_override = enabled;
  if (enabled) {
    cloud_alert("MANUAL_OVERRIDE_ON", AlertSeverity::Medium,
                "Automatic leak shut-off turned OFF from the serial console.");
    return;
  }
  cloud_alert("MANUAL_OVERRIDE_OFF", AlertSeverity::Low,
              "Automatic leak shut-off turned back ON from the serial console.");
  // Leak triggers fire when a leak starts. A leak that started while the
  // override was on is still critical now, so act on it straight away.
  if (last_assessment.level == LeakLevel::Critical && valve_is_open()) {
    LeakAssessment ongoing = last_assessment;
    ongoing.trigger = LeakTrigger::Window;
    handle_leak_trigger(ongoing);
  }
}

// ---------------------------------------------------------------------------
// Leak responses
// ---------------------------------------------------------------------------
static void handle_leak_trigger(const LeakAssessment &assessment) {
  const char *type = assessment.trigger == LeakTrigger::Fast ? "IMMEDIATE_CRITICAL_LEAK" : "CRITICAL_LEAK";
  char reason[120];
  snprintf(reason, sizeof(reason), "%.1f%% of the water leaving the tank is not reaching the tap",
           assessment.loss_percent);

  if (manual_override) {
    cloud_alert(type, AlertSeverity::Critical, "%s. Manual override is on, so the valve was NOT closed.", reason);
  } else if (!valve_is_open()) {
    cloud_alert(type, AlertSeverity::Critical, "%s while the valve reads closed. Check the valve.", reason);
  } else {
    close_valve_for_leak(type, assessment.loss_percent, reason);
  }
}

static void handle_night_events(uint8_t events, const struct tm &local_time) {
  if (events & flowstate::NIGHT_FLOW_STARTED) {
    cloud_alert("NIGHTTIME_FLOW_START", AlertSeverity::Medium,
                "Water started flowing at %02d:%02d, during the %d-%d AM night watch.", local_time.tm_hour,
                local_time.tm_min, NIGHT_START_HOUR, NIGHT_END_HOUR);
  }
  if (events & flowstate::NIGHT_FLOW_ALERT) {
    cloud_alert("NIGHTTIME_LEAK_ALERT", AlertSeverity::High,
                "Water has flowed for %u minutes without a break during the night watch (%.1f L so far).",
                static_cast<unsigned>(night_watch.minutes()), night_watch.liters());
  }
  if (events & flowstate::NIGHT_EXCESS_VOLUME) {
    cloud_alert("NIGHTTIME_EXCESSIVE_VOLUME", AlertSeverity::High,
                "%.1f L used in one night-time flow (alert level %.0f L).", night_watch.liters(),
                NIGHT_EXCESS_VOLUME_LITERS);
  }
  if (events & flowstate::NIGHT_FLOW_CRITICAL) {
    char reason[120];
    snprintf(reason, sizeof(reason), "Water has flowed for %u minutes without a break at night (%.1f L)",
             static_cast<unsigned>(night_watch.minutes()), night_watch.liters());
    if (!manual_override && valve_is_open()) {
      close_valve_for_leak("NIGHTTIME_LEAK_CRITICAL", last_assessment.loss_percent, reason);
    } else {
      cloud_alert("NIGHTTIME_LEAK_CRITICAL", AlertSeverity::Critical, "%s. Valve %s.", reason,
                  valve_is_open() ? "left open (manual override is on)" : "already closed");
    }
  }
  if ((events & flowstate::NIGHT_FLOW_ENDED) && night_watch.ended_liters() >= 0.1f) {
    cloud_alert("NIGHTTIME_FLOW_ENDED", AlertSeverity::Low, "Night-time flow stopped after %u min, %.1f L in total.",
                static_cast<unsigned>(night_watch.ended_minutes()), night_watch.ended_liters());
  }
}

static void run_minute_cycle(bool time_valid, const struct tm &local_time, int32_t day_key) {
  uint8_t hour = time_valid ? static_cast<uint8_t>(local_time.tm_hour) : 0;
  handle_night_events(night_watch.update_minute(time_valid, hour, minute_ml_1), local_time);

  if (time_valid && baseline != nullptr) {
    if (baseline->add_minute(day_key, hour, minute_ml_1 / 1000.0f)) baseline_save(baseline_state);
    if (baseline->take_new_anomaly()) {
      cloud_alert("USAGE_ANOMALY", AlertSeverity::High,
                  "Unusual water use between %02u:00 and %02u:00: %.1f L (usually about %.1f L).",
                  static_cast<unsigned>(baseline->last_hour()), static_cast<unsigned>((baseline->last_hour() + 1) % 24),
                  baseline->last_hour_liters(), baseline->last_expected_liters());
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
static const char *current_leak_status() {
  return leak_lockout ? "Critical" : flowstate::leak_level_name(last_assessment.level);
}

static float current_loss_percent() { return leak_lockout ? lockout_loss_percent : last_assessment.loss_percent; }

static float liters_1(uint32_t pulses) {
  return flowstate::pulses_to_ml(pulses, FLOW_SENSOR_1_PULSES_PER_LITER) / 1000.0f;
}

static float liters_2(uint32_t pulses) {
  return flowstate::pulses_to_ml(pulses, FLOW_SENSOR_2_PULSES_PER_LITER) / 1000.0f;
}

static void publish_snapshot() {
  ReadingSnapshot snapshot;
  snapshot.flow_rate_1_lpm = leak_detector.average_lpm_1(5);
  snapshot.flow_rate_2_lpm = leak_detector.average_lpm_2(5);
  snapshot.percentage_loss = current_loss_percent();
  snapshot.water_level_cm = water_level_cm;
  snapshot.humidity_percent = humidity_percent;
  snapshot.humidity_valid = humidity_ok;
  snapshot.valve_open = valve_is_open();
  snapshot.leak_status = current_leak_status();
  snapshot.anomaly_status =
      flowstate::anomaly_status_name(baseline != nullptr ? baseline->status() : flowstate::AnomalyStatus::Learning);
  snapshot.daily_total_liters = liters_1(daily_totals.pulses1());
  snapshot.total_pulses_1 = total_pulses_1;
  snapshot.total_pulses_2 = total_pulses_2;
  cloud_publish(snapshot);
}

static void print_sensor_line() {
  char humidity_text[8] = "--";
  if (humidity_ok) snprintf(humidity_text, sizeof(humidity_text), "%.0f%%", humidity_percent);
  Serial.printf("[SENSOR] Flow %.2f / %.2f L/min | loss %.1f%% %s | level %.1f cm (ADC %d) | humidity %s | valve %s | Wi-Fi %s\n",
                leak_detector.average_lpm_1(5), leak_detector.average_lpm_2(5), current_loss_percent(),
                current_leak_status(), water_level_cm, water_level_raw, humidity_text,
                valve_is_open() ? "OPEN" : "CLOSED", cloud_status().wifi_connected ? "OK" : "down");
}

static void print_status() {
  CloudStatus cloud = cloud_status();
  struct tm local_time;
  char time_text[32] = "unknown";
  if (clock_local_time(local_time)) strftime(time_text, sizeof(time_text), "%Y-%m-%d %H:%M:%S", &local_time);

  Serial.println();
  Serial.println("============== FlowState status ==============");
  Serial.printf("Flow 1 / Flow 2   : %.2f / %.2f L/min (5 s average)\n", leak_detector.average_lpm_1(5),
                leak_detector.average_lpm_2(5));
  Serial.printf("Loss (60 s)       : %.1f %% -> %s%s\n", current_loss_percent(), current_leak_status(),
                leak_lockout ? " (valve closed by leak protection)" : "");
  Serial.printf("Tank level        : %.1f cm (raw ADC %d)\n", water_level_cm, water_level_raw);
  if (humidity_ok) {
    Serial.printf("Humidity          : %.1f %%\n", humidity_percent);
  } else {
    Serial.println("Humidity          : unknown (no valid DHT22 reading)");
  }
  Serial.printf("Valve             : %s | automatic shut-off %s | alarm %s\n", valve_is_open() ? "OPEN" : "CLOSED",
                manual_override ? "OFF (override)" : "ON", buzzer_is_on() ? "sounding" : "off");
  Serial.printf("Night watch       : %s\n", night_watch.status());
  Serial.printf("Usage baseline    : %s (%u of %u days learned)\n",
                flowstate::anomaly_status_name(baseline != nullptr ? baseline->status()
                                                                   : flowstate::AnomalyStatus::Learning),
                static_cast<unsigned>(baseline_state.days_learned), static_cast<unsigned>(BASELINE_DAYS_REQUIRED));
  Serial.printf("Today             : %.2f L (sensor 1), %.2f L (sensor 2)\n", liters_1(daily_totals.pulses1()),
                liters_2(daily_totals.pulses2()));
  Serial.printf("Pulses since start: %lu / %lu\n", static_cast<unsigned long>(total_pulses_1),
                static_cast<unsigned long>(total_pulses_2));
  Serial.printf("Local time        : %s (source: %s)\n", time_text, clock_source());
  if (!cloud.configured) {
    Serial.println("Cloud             : not configured (fill in secrets.h)");
  } else {
    unsigned long seconds_ago = cloud.last_upload_ok_ms ? (millis() - cloud.last_upload_ok_ms) / 1000UL : 0;
    Serial.printf("Cloud             : Wi-Fi %s | last HTTP %d | last upload %s%lu s ago | %lu alerts waiting, %lu dropped\n",
                  cloud.wifi_connected ? "connected" : "down", cloud.last_http_code,
                  cloud.last_upload_ok_ms ? "" : "never, ", seconds_ago, static_cast<unsigned long>(cloud.alerts_waiting),
                  static_cast<unsigned long>(cloud.alerts_dropped));
  }
  Serial.printf("Network task      : %lu bytes of stack never used (should stay above 2000)\n",
                static_cast<unsigned long>(cloud.stack_free_bytes));
  Serial.println("==============================================");
}

static void print_help() {
  Serial.println("Commands: STATUS, VALVE_OPEN, VALVE_CLOSE, VALVE_TOGGLE, OVERRIDE_ON, OVERRIDE_OFF, SILENCE, HELP");
}

// ---------------------------------------------------------------------------
// Inputs: serial console and dashboard commands
// ---------------------------------------------------------------------------
static void run_serial_command(char *line) {
  char *start = line;
  while (*start == ' ' || *start == '\t') start++;
  for (char *c = start; *c; ++c) *c = static_cast<char>(toupper(static_cast<unsigned char>(*c)));
  size_t length = strlen(start);
  while (length > 0 && (start[length - 1] == ' ' || start[length - 1] == '\t')) start[--length] = '\0';
  if (length == 0) return;

  if (strcmp(start, "VALVE_OPEN") == 0) {
    set_valve_by_operator(true, "serial console");
  } else if (strcmp(start, "VALVE_CLOSE") == 0) {
    set_valve_by_operator(false, "serial console");
  } else if (strcmp(start, "VALVE_TOGGLE") == 0) {
    set_valve_by_operator(!valve_is_open(), "serial console");
  } else if (strcmp(start, "OVERRIDE_ON") == 0) {
    set_manual_override(true);
  } else if (strcmp(start, "OVERRIDE_OFF") == 0) {
    set_manual_override(false);
  } else if (strcmp(start, "SILENCE") == 0) {
    buzzer_stop();
    Serial.println("[ALARM] Silenced (the valve stays as it is)");
  } else if (strcmp(start, "STATUS") == 0) {
    print_status();
  } else if (strcmp(start, "HELP") == 0) {
    print_help();
  } else {
    Serial.printf("Unknown command '%s'. ", start);
    print_help();
  }
}

// Accepts commands ending in a newline, or none at all (a short pause ends
// the command), so any Serial Monitor line-ending setting works.
static void handle_serial_input(uint32_t now) {
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    last_serial_char_ms = now;
    if (c == '\r' || c == '\n') {
      serial_line[serial_length] = '\0';
      run_serial_command(serial_line);
      serial_length = 0;
    } else if (serial_length < sizeof(serial_line) - 1) {
      serial_line[serial_length++] = c;
    }
  }
  if (serial_length > 0 && now - last_serial_char_ms > 300) {
    serial_line[serial_length] = '\0';
    run_serial_command(serial_line);
    serial_length = 0;
  }
}

static void handle_dashboard_commands() {
  ValveCommand command;
  while (cloud_next_command(command)) {
    Serial.printf("[VALVE] Dashboard command #%ld: %s\n", static_cast<long>(command.id), command.open ? "open" : "close");
    set_valve_by_operator(command.open, "dashboard");
  }
}

// ---------------------------------------------------------------------------
// Main cycle
// ---------------------------------------------------------------------------
static void run_sensor_cycle(uint32_t now) {
  uint32_t pulses1 = 0;
  uint32_t pulses2 = 0;
  flow_take_pulses(pulses1, pulses2);
  total_pulses_1 += pulses1;
  total_pulses_2 += pulses2;

  struct tm local_time;
  memset(&local_time, 0, sizeof(local_time));
  bool time_valid = clock_local_time(local_time);
  int32_t day_key = time_valid ? clock_day_key(local_time) : 0;
  if (daily_totals.add(pulses1, pulses2, time_valid, day_key)) Serial.println("[DAY] New day: daily totals reset");

  last_assessment = leak_detector.update(pulses1, pulses2);
  if (last_assessment.trigger != LeakTrigger::None) handle_leak_trigger(last_assessment);

  water_level_cm = water_level_read_cm(water_level_raw);
  humidity_ok = humidity_read(now, humidity_percent);
  clock_update();

  minute_ml_1 += flowstate::pulses_to_ml(pulses1, FLOW_SENSOR_1_PULSES_PER_LITER);
  if (++minute_seconds >= 60) {
    run_minute_cycle(time_valid, local_time, day_key);
    minute_ml_1 = 0.0f;
    minute_seconds = 0;
  }

  publish_snapshot();
  if (LOG_EVERY_SECOND || now - last_status_log_ms >= STATUS_LOG_PERIOD_MS) {
    last_status_log_ms = now;
    print_sensor_line();
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("=== FlowState starting ===");

  storage_begin();
  buzzer_begin();
  valve_begin();
  flow_sensors_begin();
  humidity_begin();
  clock_begin();

  baseline_load(baseline_state);
  static flowstate::HourlyBaseline baseline_instance(kBaselineSettings, baseline_state);
  baseline = &baseline_instance;

  // A valve closed by leak protection stays in lockout across restarts.
  leak_lockout = leak_lockout_load(lockout_loss_percent) && !valve_is_open();

  cloud_begin();
  cloud_alert("DEVICE_STARTED", leak_lockout ? AlertSeverity::High : AlertSeverity::Low,
              "Device started. Valve restored %s%s.", valve_is_open() ? "open" : "closed",
              leak_lockout ? " after an automatic leak shut-off; check for the leak before reopening" : "");
  last_sensor_ms = millis();
  print_help();
}

void loop() {
  uint32_t now = millis();
  handle_serial_input(now);
  handle_dashboard_commands();
  buzzer_update(now);

  if (now - last_sensor_ms >= SENSOR_PERIOD_MS) {
    last_sensor_ms = now;
    run_sensor_cycle(now);
  }
  delay(5);
}
