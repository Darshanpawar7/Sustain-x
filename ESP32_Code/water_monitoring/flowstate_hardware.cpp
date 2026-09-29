#include "flowstate_hardware.h"

#include <DHT.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <math.h>

#include "flowstate_config.h"

namespace {

const char *kPrefsNamespace = "flowstate";
const char *kValveKey = "valve_open";
const char *kBaselineKey = "baseline";
const char *kLockoutKey = "leak_lockout";
const char *kLockoutLossKey = "lockout_loss";

// Flow pulses are counted in interrupts and read under the same lock.
portMUX_TYPE pulse_mux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t pulse_count_1 = 0;
volatile uint32_t pulse_count_2 = 0;
volatile uint32_t last_pulse_us_1 = 0;
volatile uint32_t last_pulse_us_2 = 0;

Preferences prefs;
bool prefs_ready = false;

DHT dht(DHT_PIN, DHT22);
bool humidity_sampled = false;
bool humidity_valid = false;
uint32_t last_humidity_sample_ms = 0;
uint32_t last_valid_humidity_ms = 0;
float last_humidity_percent = 0.0f;

Servo valve_servo;
bool valve_open = true;

bool buzzer_on = false;
uint32_t buzzer_started_ms = 0;

bool level_initialised = false;
float smoothed_level_cm = 0.0f;

void IRAM_ATTR on_flow_pulse_1() {
  uint32_t now_us = micros();
  portENTER_CRITICAL_ISR(&pulse_mux);
  if (now_us - last_pulse_us_1 >= FLOW_PULSE_DEBOUNCE_US) {
    pulse_count_1 = pulse_count_1 + 1;
    last_pulse_us_1 = now_us;
  }
  portEXIT_CRITICAL_ISR(&pulse_mux);
}

void IRAM_ATTR on_flow_pulse_2() {
  uint32_t now_us = micros();
  portENTER_CRITICAL_ISR(&pulse_mux);
  if (now_us - last_pulse_us_2 >= FLOW_PULSE_DEBOUNCE_US) {
    pulse_count_2 = pulse_count_2 + 1;
    last_pulse_us_2 = now_us;
  }
  portEXIT_CRITICAL_ISR(&pulse_mux);
}

}  // namespace

void storage_begin() {
  prefs_ready = prefs.begin(kPrefsNamespace, false);
  if (!prefs_ready) Serial.println("[STORAGE] Flash storage unavailable; valve position and learning will not be saved");
}

// ---------------------------------------------------------------------------
// Flow sensors
// ---------------------------------------------------------------------------
void flow_sensors_begin() {
  pinMode(FLOW_SENSOR_1_PIN, INPUT_PULLUP);
  pinMode(FLOW_SENSOR_2_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_1_PIN), on_flow_pulse_1, FALLING);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_2_PIN), on_flow_pulse_2, FALLING);
}

void flow_take_pulses(uint32_t &sensor1, uint32_t &sensor2) {
  portENTER_CRITICAL(&pulse_mux);
  sensor1 = pulse_count_1;
  sensor2 = pulse_count_2;
  pulse_count_1 = 0;
  pulse_count_2 = 0;
  portEXIT_CRITICAL(&pulse_mux);
}

// ---------------------------------------------------------------------------
// Tank level
// ---------------------------------------------------------------------------
float water_level_read_cm(int &raw_adc) {
  const int kSamples = 8;
  uint32_t total = 0;
  for (int i = 0; i < kSamples; ++i) total += analogRead(WATER_LEVEL_PIN);
  raw_adc = static_cast<int>(total / kSamples);

  float level = flowstate::adc_to_level_cm(static_cast<float>(raw_adc), WATER_LEVEL_ADC_IN_AIR,
                                           WATER_LEVEL_ADC_IN_WATER, TANK_HEIGHT_CM);
  if (!level_initialised) {
    smoothed_level_cm = level;
    level_initialised = true;
  } else {
    smoothed_level_cm += WATER_LEVEL_SMOOTHING * (level - smoothed_level_cm);
  }
  return smoothed_level_cm;
}

// ---------------------------------------------------------------------------
// Humidity
// ---------------------------------------------------------------------------
void humidity_begin() { dht.begin(); }

bool humidity_read(uint32_t now_ms, float &percent) {
  if (!humidity_sampled || now_ms - last_humidity_sample_ms >= HUMIDITY_PERIOD_MS) {
    humidity_sampled = true;
    last_humidity_sample_ms = now_ms;
    float value = dht.readHumidity();
    if (isfinite(value) && value >= 0.0f && value <= 100.0f) {
      last_humidity_percent = value;
      last_valid_humidity_ms = now_ms;
      humidity_valid = true;
    }
  }
  if (!humidity_valid || now_ms - last_valid_humidity_ms > HUMIDITY_STALE_MS) return false;
  percent = last_humidity_percent;
  return true;
}

// ---------------------------------------------------------------------------
// Valve
// ---------------------------------------------------------------------------
void valve_begin() {
  // First start-up defaults to open; after that the last position is restored,
  // so a valve closed by a leak stays closed through a power cut.
  valve_open = prefs_ready ? prefs.getBool(kValveKey, true) : true;
  ESP32PWM::allocateTimer(0);
  valve_servo.setPeriodHertz(50);
  valve_servo.attach(SERVO_PIN, SERVO_MIN_PULSE_US, SERVO_MAX_PULSE_US);
  valve_servo.write(valve_open ? SERVO_OPEN_ANGLE : SERVO_CLOSED_ANGLE);
  Serial.printf("[VALVE] Restored %s\n", valve_open ? "OPEN" : "CLOSED");
}

bool valve_is_open() { return valve_open; }

void valve_move(bool open) {
  valve_servo.write(open ? SERVO_OPEN_ANGLE : SERVO_CLOSED_ANGLE);
  if (open == valve_open) return;
  valve_open = open;
  if (prefs_ready) prefs.putBool(kValveKey, open);
  Serial.printf("[VALVE] Now %s\n", open ? "OPEN" : "CLOSED");
}

// ---------------------------------------------------------------------------
// Buzzer
// ---------------------------------------------------------------------------
void buzzer_begin() {
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
}

void buzzer_start(uint32_t now_ms) {
  buzzer_on = true;
  buzzer_started_ms = now_ms;
}

void buzzer_stop() {
  buzzer_on = false;
  digitalWrite(BUZZER_PIN, LOW);
}

bool buzzer_is_on() { return buzzer_on; }

void buzzer_update(uint32_t now_ms) {
  if (!buzzer_on) return;
  digitalWrite(BUZZER_PIN, flowstate::alarm_pattern_on(now_ms - buzzer_started_ms) ? HIGH : LOW);
}

// ---------------------------------------------------------------------------
// Baseline storage
// ---------------------------------------------------------------------------
void baseline_load(flowstate::BaselineState &state) {
  flowstate::baseline_state_reset(state);
  if (!prefs_ready || !prefs.isKey(kBaselineKey)) return;
  if (prefs.getBytesLength(kBaselineKey) != sizeof(state)) return;

  flowstate::BaselineState saved;
  prefs.getBytes(kBaselineKey, &saved, sizeof(saved));
  if (saved.version == flowstate::kBaselineVersion) state = saved;
}

void baseline_save(const flowstate::BaselineState &state) {
  if (prefs_ready) prefs.putBytes(kBaselineKey, &state, sizeof(state));
}

// ---------------------------------------------------------------------------
// Leak lockout storage
// ---------------------------------------------------------------------------
bool leak_lockout_load(float &loss_percent) {
  loss_percent = 0.0f;
  if (!prefs_ready || !prefs.getBool(kLockoutKey, false)) return false;
  loss_percent = prefs.getFloat(kLockoutLossKey, 0.0f);
  return true;
}

void leak_lockout_save(bool active, float loss_percent) {
  if (!prefs_ready) return;
  if (prefs.getBool(kLockoutKey, false) != active) prefs.putBool(kLockoutKey, active);
  if (active) prefs.putFloat(kLockoutLossKey, loss_percent);
}
