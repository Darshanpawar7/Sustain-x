/*
  ========================================================
  WATER LEAK DETECTION SYSTEM - ESP32 FIRMWARE
  ========================================================

  FEATURES:
  - Real-time flow monitoring (2 flow sensors)
  - Water level tracking
  - Percentage loss calculation
  - Automatic anomaly detection with time-based baseline learning
  - NIGHTTIME LEAK DETECTION (2 AM - 5 AM)
  - Solenoid valve control with manual override
  - Supabase cloud integration for data logging and alerts
  - Serial command interface for system control

  NIGHTTIME LEAK DETECTION (2-5 AM):
  This system specifically monitors for leaks during early morning hours
  (2 AM - 5 AM) when water usage should be minimal or zero. If any flow
  is detected during this window, the system:

  1. Logs the start time and initial flow detection
  2. Accumulates volume during the continuous flow event
  3. Triggers ALERT if flow persists for 5+ minutes
  4. Triggers CRITICAL if flow persists for 10+ minutes
  5. Triggers ALERT if volume exceeds 0.5L during 2-5 AM window
  6. Automatically closes the solenoid valve if critical threshold reached
  7. Logs detailed event summaries to cloud and serial console

  PIPE SPECIFICATIONS:
  - Diameter: 3/4 inch (19.05 mm)
  - Flow range: 0.3-50 L/min (depends on pressure and velocity)
  - Sensor limitation: YF-S201 rated for 0.3-6 L/min typical use

  ========================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Arduino.h>
#include <Wire.h>
#include <RTClib.h>
#include <time.h>
#include <math.h>
#include <ESP32Servo.h>
#include <DHT.h>

// ============== PIN CONFIGURATION ==============
#define FLOW_SENSOR_1_PIN 19 // Flow sensor near tank (GPIO 19 - supports interrupts)
#define FLOW_SENSOR_2_PIN 22 // Flow sensor near tap (GPIO 22 - supports interrupts)
#define WATER_LEVEL_PIN 33   // Water level sensor (GPIO 33, ADC)
#define BUZZER_PIN 13        // Buzzer/alarm pin (GPIO 13 - standard I/O)
#define SERVO_PIN 26         // Servo motor pin for valve control (GPIO 26)
#define DHT_PIN 4            // DHT22 data pin (GPIO 4)
#define DHT_TYPE DHT22

// ============== PIPE SPECIFICATIONS ==============
// Pipe diameter: 3/4 inch (19.05 mm)
// Typical flow range for 3/4" pipe: 0.3-50 L/min depending on pressure and velocity
// Sensor max: YF-S201 rated for 0.3-6 L/min (standard water distribution)
#define PIPE_DIAMETER_INCH 0.75
#define PIPE_DIAMETER_MM 19.05

// ============== WiFi & SUPABASE CONFIGURATION ==============
const char *SSID = "YOUR_WIFI_SSID";
const char *PASSWORD = "YOUR_WIFI_PASSWORD";

// Supabase configuration

const char *SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const char *SUPABASE_KEY = "YOUR_SUPABASE_ANON_KEY";
const char *SUPABASE_TABLE = "water_readings";
const char *ALERT_TABLE = "alerts";

// ============== SENSOR CALIBRATION ==============
const float FLOW_SENSOR_CALIBRATION = 7.5; // YF-S201: 7.5 Hz per L/min (frequency/calibration = flow rate)
const int WATER_LEVEL_IN_AIR = 4095;       // ADC value when sensor is in air
const int WATER_LEVEL_IN_WATER = 1000;     // ADC value when sensor is fully submerged
const float TANK_HEIGHT_CM = 100.0;        // Tank height in cm

// ============== NOISE FILTERING ==============
const unsigned int FLOW_SENSOR_NOISE_THRESHOLD = 1; // Minimum pulses per second to register as flow (1 pulse = 0.133 L/min)
const float FLOW_RATE_MIN_THRESHOLD = 0.05;         // Minimum L/min to consider as actual flow (very sensitive)
const unsigned long FLOW_PULSE_DEBOUNCE_US = 500;   // Ignore implausibly fast edges (contact/noise bounce)

// ============== HUMIDITY MONITORING ==============
const float HUMIDITY_MIN_VALID = 0.0;
const float HUMIDITY_MAX_VALID = 100.0;

// ============== DETECTION THRESHOLDS ==============
const float NORMAL_LOSS_THRESHOLD = 5.0;    // <5% normal loss
const float WARNING_LOSS_THRESHOLD = 15.0;  // 5-15% warning
const float CRITICAL_LOSS_THRESHOLD = 15.0; // >15% critical

const float ANOMALY_THRESHOLD = 1.5;        // Ratio to baseline
const unsigned long TIME_WINDOW_MS = 60000; // 60 second window for volume calculation

// ============== NIGHTTIME LEAK DETECTION (2 AM - 5 AM) ==============
const uint8_t NIGHTTIME_START_HOUR = 2;                        // 2 AM
const uint8_t NIGHTTIME_END_HOUR = 5;                          // 5 AM (exclusive)
const float NIGHTTIME_FLOW_THRESHOLD = 0.1;                    // L/min - minimum flow to trigger detection (avoids sensor noise)
const unsigned long NIGHTTIME_FLOW_ALERT_DURATION = 300000;    // 5 minutes - alert if flow persists 5+ min
const unsigned long NIGHTTIME_FLOW_CRITICAL_DURATION = 600000; // 10 minutes - critical if flow persists 10+ min
const float NIGHTTIME_VOLUME_THRESHOLD = 0.5;                  // Liters (500 ml) - alert if volume exceeds this during 2-5 AM

// ============== VARIABLES ==============
WiFiClientSecure wifiClient;
volatile unsigned long pulse1_count = 0;
volatile unsigned long pulse2_count = 0;

unsigned long last_window_time = 0;
unsigned long accumulated_volume_1 = 0; // In ml
unsigned long accumulated_volume_2 = 0; // In ml
unsigned long oldTime = 0;              // For flow sensor timing

// Baseline usage tracking
struct BaselineData
{
  uint8_t hour;
  float hourly_usage_ml;
} baseline[24]; // One entry per hour

bool baseline_initialized = false;
int baseline_days_collected = 0;
const int BASELINE_DAYS_REQUIRED = 3; // Collect 3 days of baseline before activation
bool rtc_available = false;

volatile unsigned long last_pulse1_us = 0;
volatile unsigned long last_pulse2_us = 0;

// Global variables for monitoring
struct SystemState
{
  float current_flow_rate_1;
  float current_flow_rate_2;
  float percentage_loss;
  float water_level_cm;
  float humidity_percent;
  uint8_t valve_state; // 0 = CLOSED, 1 = OPEN
  String leak_status;  // "Normal", "Warning", "Critical"
  String anomaly_status;
  uint8_t system_online;
  unsigned long last_reading_time;
  float daily_total_ml;
  unsigned long last_upload_time;

  // Nighttime leak detection (2-5 AM)
  bool nighttime_flow_active;                // True if flow detected during 2-5 AM window
  unsigned long nighttime_flow_start_time;   // Timestamp when flow first detected
  float nighttime_accumulated_volume_liters; // Volume accumulated during 2-5 AM window
  String nighttime_leak_status;              // "Normal", "Alert", "Critical" for nighttime
} system_state;

// RTC
RTC_DS3231 rtc;

// Servo valve control
Servo valveServo;

// DHT22 sensor
DHT dht(DHT_PIN, DHT_TYPE);

// Buzzer state management - Morse code pattern (short-short-long)
bool buzzer_active = false; // Whether buzzer should buzz
unsigned long last_buzzer_action_time = 0;
uint8_t buzzer_pattern_stage = 0; // 0=off, 1=beep1_on, 2=beep1_off, 3=beep2_on, 4=beep2_off, 5=beep3_on, 6=beep3_off, 7=pause
bool buzzer_state = LOW;          // Current buzzer state

// Buzzer timing constants (in milliseconds)
const unsigned long BUZZER_BEEP_SHORT = 200;   // 200ms short beep
const unsigned long BUZZER_PAUSE_SHORT = 200;  // 200ms pause between short beeps
const unsigned long BUZZER_BEEP_LONG = 600;    // 600ms long beep
const unsigned long BUZZER_PAUSE_LONG = 600;   // 600ms pause after long beep
const unsigned long BUZZER_PAUSE_CYCLE = 1000; // 1000ms pause before repeating pattern

// Manual control flag
bool manual_valve_override = false;

// ============== HELPER FUNCTIONS ==============
bool is_valid_rtc_datetime(const DateTime &dt)
{
  return (dt.year() >= 2020 && dt.year() <= 2100 &&
          dt.month() >= 1 && dt.month() <= 12 &&
          dt.day() >= 1 && dt.day() <= 31 &&
          dt.hour() <= 23 && dt.minute() <= 59 && dt.second() <= 59);
}

float clamp_percentage(float value)
{
  if (!isfinite(value))
    return 0.0;
  if (value < 0.0)
    return 0.0;
  if (value > 100.0)
    return 100.0;
  return value;
}

String normalize_leak_status(const String &status)
{
  if (status == "Normal" || status == "Warning" || status == "Critical")
    return status;
  return "Normal";
}

uint8_t get_safe_current_hour()
{
  if (rtc_available)
  {
    DateTime now = rtc.now();
    if (is_valid_rtc_datetime(now))
    {
      return now.hour();
    }
    Serial.println("[RTC] Invalid datetime while reading hour, using millis fallback");
  }

  // Fallback if RTC is unavailable/invalid
  return (millis() / 3600000UL) % 24;
}

// ============== INTERRUPT HANDLERS ==============
void IRAM_ATTR flow_sensor_1_interrupt()
{
  unsigned long now_us = micros();
  if ((now_us - last_pulse1_us) >= FLOW_PULSE_DEBOUNCE_US)
  {
    pulse1_count++;
    last_pulse1_us = now_us;
  }
}

void IRAM_ATTR flow_sensor_2_interrupt()
{
  unsigned long now_us = micros();
  if ((now_us - last_pulse2_us) >= FLOW_PULSE_DEBOUNCE_US)
  {
    pulse2_count++;
    last_pulse2_us = now_us;
  }
}

// ============== SETUP ==============
void setup()
{
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n\n=== Water Monitoring System Starting ===");

  // Initialize pins
  pinMode(FLOW_SENSOR_1_PIN, INPUT_PULLUP);
  pinMode(FLOW_SENSOR_2_PIN, INPUT_PULLUP);
  pinMode(WATER_LEVEL_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  // Initial state
  digitalWrite(BUZZER_PIN, LOW); // Buzzer off initially

  system_state.valve_state = 0;
  system_state.daily_total_ml = 0;
  system_state.humidity_percent = 0;
  system_state.leak_status = "Normal";
  system_state.anomaly_status = "Learning";
  system_state.percentage_loss = 0;
  system_state.current_flow_rate_1 = 0;
  system_state.current_flow_rate_2 = 0;
  system_state.water_level_cm = 0;
  system_state.system_online = 0;
  system_state.nighttime_flow_active = false;
  system_state.nighttime_accumulated_volume_liters = 0;
  system_state.nighttime_leak_status = "Normal";

  // Initialize I²C with custom pins: SDA=18, SCL=21
  Wire.begin(18, 21);

  // Initialize Servo
  ESP32PWM::allocateTimer(0);
  valveServo.setPeriodHertz(50);
  valveServo.attach(SERVO_PIN, 500, 2400);
  valveServo.write(0);

  // Initialize DHT22
  dht.begin();

  // Initialize RTC
  if (!rtc.begin())
  {
    rtc_available = false;
    Serial.println("ERROR: RTC not found!");
    Serial.println("WARNING: Timestamps will be incorrect. RTC module may be disconnected.");
  }
  else
  {
    rtc_available = true;
    Serial.println("RTC initialized successfully");

    // Check if RTC needs time adjustment (lost power or first time)
    if (rtc.lostPower())
    {
      Serial.println("RTC lost power! Setting time to compilation time...");
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }

    DateTime now = rtc.now();
    Serial.printf("Current RTC time: %04d-%02d-%02d %02d:%02d:%02d\n",
                  now.year(), now.month(), now.day(),
                  now.hour(), now.minute(), now.second());
  }

  // Initialize baseline (will be populated over time)
  initialize_baseline();

  // Attach interrupts (FALLING edge for more reliable detection)
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_1_PIN), flow_sensor_1_interrupt, FALLING);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_2_PIN), flow_sensor_2_interrupt, FALLING);

  // Connect to WiFi
  connect_wifi();

  // Disable SSL certificate verification for Supabase
  // WARNING: Not secure for production! Use proper certificates instead.
  wifiClient.setInsecure();

  // Initialize last window time
  last_window_time = millis();
  oldTime = millis(); // Initialize timing for flow sensor calculation
  system_state.last_reading_time = millis();
  system_state.last_upload_time = millis();

  // Print initialization diagnostics
  Serial.println("\n=== SYSTEM DIAGNOSTICS ===");
  Serial.print("Flow Sensor 1 (GPIO ");
  Serial.print(FLOW_SENSOR_1_PIN);
  Serial.println("): Ready");
  Serial.print("Flow Sensor 2 (GPIO ");
  Serial.print(FLOW_SENSOR_2_PIN);
  Serial.println("): Ready");
  Serial.print("Water Level (GPIO ");
  Serial.print(WATER_LEVEL_PIN);
  Serial.println("): Ready");
  Serial.print("DHT22 Humidity (GPIO ");
  Serial.print(DHT_PIN);
  Serial.println("): Ready");
  Serial.print("Servo Valve (GPIO ");
  Serial.print(SERVO_PIN);
  Serial.println("): Ready");
  Serial.print("Flow Calibration: ");
  Serial.print(FLOW_SENSOR_CALIBRATION);
  Serial.println(" Hz per L/min");
  Serial.print("Noise Threshold: ");
  Serial.print(FLOW_SENSOR_NOISE_THRESHOLD);
  Serial.print(" pulses/sec (");
  Serial.print(FLOW_SENSOR_NOISE_THRESHOLD / FLOW_SENSOR_CALIBRATION, 2);
  Serial.println(" L/min)");
  Serial.println("System ready. Logging sensor data every 1 second...");
  Serial.println("Uploading to Supabase every 1 second...");
  Serial.println("=========================\n");
}

// ============== MAIN LOOP ==============
void loop()
{
  // Maintain WiFi connection
  if (WiFi.status() != WL_CONNECTED)
  {
    connect_wifi();
  }

  // Read sensors every second
  unsigned long current_time = millis();

  if (current_time - system_state.last_reading_time >= 1000)
  {
    system_state.last_reading_time = current_time;

    // Read all sensors
    read_sensors();

    // REAL-TIME LEAK DETECTION: Check immediately if sensor 1 is high but sensor 2 is very low
    // This allows immediate valve closure without waiting for 60-second window
    if (!manual_valve_override)
    {
      float immediate_loss_percentage = 0;

      if (system_state.current_flow_rate_1 > 0.5)
      { // Only check if there's significant flow
        immediate_loss_percentage = ((system_state.current_flow_rate_1 - system_state.current_flow_rate_2) / system_state.current_flow_rate_1) * 100.0;
        immediate_loss_percentage = clamp_percentage(immediate_loss_percentage);

        // Update system_state.percentage_loss with real-time value (every second)
        system_state.percentage_loss = immediate_loss_percentage;

        // Immediate critical threshold: >15% loss detected in real-time (same as CRITICAL_LOSS_THRESHOLD)
        if (immediate_loss_percentage > CRITICAL_LOSS_THRESHOLD)
        {
          Serial.println("[REAL-TIME ALERT] ⚠️  IMMEDIATE LEAK DETECTED!");
          Serial.print("  Flow1: ");
          Serial.print(system_state.current_flow_rate_1, 2);
          Serial.print(" L/min | Flow2: ");
          Serial.print(system_state.current_flow_rate_2, 2);
          Serial.print(" L/min | Loss: ");
          Serial.print(immediate_loss_percentage, 1);
          Serial.println("%");

          if (system_state.valve_state == 1)
          { // Only close if currently open
            close_solenoid_valve();
            log_alert("IMMEDIATE_CRITICAL_LEAK", "Immediate leak detected! Loss: " + String(immediate_loss_percentage, 1) + "% - Valve closed!");
          }
        }
      }
      else
      {
        // No significant flow - reset percentage loss to 0
        system_state.percentage_loss = 0;
      }
    }

    // Check for leaks/theft every TIME_WINDOW
    if (current_time - last_window_time >= TIME_WINDOW_MS)
    {
      process_detection_logic();
      last_window_time = current_time;
    }

    // Upload data to Supabase every 1 second
    if (current_time - system_state.last_upload_time >= 1000)
    {
      send_data_to_supabase();
      system_state.last_upload_time = current_time;
    }
  }

  // Handle serial commands for manual valve control
  handleSerialCommand();

  // Handle buzzer pattern - non-blocking Morse code (short-short-long)
  if (buzzer_active)
  {
    unsigned long current_time = millis();
    unsigned long elapsed = current_time - last_buzzer_action_time;
    bool state_changed = false;

    switch (buzzer_pattern_stage)
    {
    case 0: // Waiting to start or off
      break;
    case 1: // Beep 1 - short ON
      if (elapsed >= BUZZER_BEEP_SHORT)
      {
        digitalWrite(BUZZER_PIN, LOW);
        buzzer_pattern_stage = 2;
        last_buzzer_action_time = current_time;
      }
      break;
    case 2: // Beep 1 - short OFF
      if (elapsed >= BUZZER_PAUSE_SHORT)
      {
        digitalWrite(BUZZER_PIN, HIGH);
        buzzer_pattern_stage = 3;
        last_buzzer_action_time = current_time;
      }
      break;
    case 3: // Beep 2 - short ON
      if (elapsed >= BUZZER_BEEP_SHORT)
      {
        digitalWrite(BUZZER_PIN, LOW);
        buzzer_pattern_stage = 4;
        last_buzzer_action_time = current_time;
      }
      break;
    case 4: // Beep 2 - short OFF
      if (elapsed >= BUZZER_PAUSE_SHORT)
      {
        digitalWrite(BUZZER_PIN, HIGH);
        buzzer_pattern_stage = 5;
        last_buzzer_action_time = current_time;
      }
      break;
    case 5: // Beep 3 - long ON
      if (elapsed >= BUZZER_BEEP_LONG)
      {
        digitalWrite(BUZZER_PIN, LOW);
        buzzer_pattern_stage = 6;
        last_buzzer_action_time = current_time;
      }
      break;
    case 6: // Beep 3 - long OFF
      if (elapsed >= BUZZER_PAUSE_LONG)
      {
        buzzer_pattern_stage = 7;
        last_buzzer_action_time = current_time;
      }
      break;
    case 7: // Pause before repeat
      if (elapsed >= BUZZER_PAUSE_CYCLE)
      {
        digitalWrite(BUZZER_PIN, HIGH);
        buzzer_pattern_stage = 1;
        last_buzzer_action_time = current_time;
      }
      break;
    }
  }

  delay(10);
}

// ============== SENSOR READING FUNCTIONS ==============

void read_sensors()
{
  // Detach interrupts temporarily for accurate timing
  detachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_1_PIN));
  detachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_2_PIN));

  unsigned long currentTime = millis();
  unsigned long elapsedTime = currentTime - oldTime;

  // Guard against zero/invalid elapsed time to avoid inf/nan flow rates.
  if (elapsedTime == 0)
  {
    elapsedTime = 1;
  }

  // Calculate flow rates using accurate timing (L/min)
  // Formula: flowRate = ((1000.0 / elapsedTime) * pulseCount) / calibration
  system_state.current_flow_rate_1 = ((1000.0 / elapsedTime) * pulse1_count) / FLOW_SENSOR_CALIBRATION;
  system_state.current_flow_rate_2 = ((1000.0 / elapsedTime) * pulse2_count) / FLOW_SENSOR_CALIBRATION;

  // Debug: Log raw pulse counts and timing
  if (pulse1_count > 0 || pulse2_count > 0)
  {
    Serial.print("[DEBUG] Pulses - Sensor1: ");
    Serial.print(pulse1_count);
    Serial.print(" | Sensor2: ");
    Serial.print(pulse2_count);
    Serial.print(" | Time: ");
    Serial.print(elapsedTime);
    Serial.println("ms");
  }

  // Calculate volume in ml (mL/sec = (L/min / 60) * 1000)
  unsigned int flowMilliLitres1 = (system_state.current_flow_rate_1 / 60.0) * 1000;
  unsigned int flowMilliLitres2 = (system_state.current_flow_rate_2 / 60.0) * 1000;

  // Update accumulated volumes (for 60-second window) - only if above noise threshold
  if (pulse1_count >= FLOW_SENSOR_NOISE_THRESHOLD)
  {
    accumulated_volume_1 += flowMilliLitres1;        // Add ml for this second
    system_state.daily_total_ml += flowMilliLitres1; // Update daily total
  }
  if (pulse2_count >= FLOW_SENSOR_NOISE_THRESHOLD)
  {
    accumulated_volume_2 += flowMilliLitres2; // Add ml for this second
  }

  // Update timing for next iteration
  oldTime = currentTime;

  // Reset pulse counts
  pulse1_count = 0;
  pulse2_count = 0;

  // Reattach interrupts
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_1_PIN), flow_sensor_1_interrupt, FALLING);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_2_PIN), flow_sensor_2_interrupt, FALLING);

  // Read water level
  int adc_value = analogRead(WATER_LEVEL_PIN);

  // Read humidity and keep last known value if sensor returns NAN intermittently.
  float humidity = dht.readHumidity();
  if (isfinite(humidity) && humidity >= HUMIDITY_MIN_VALID && humidity <= HUMIDITY_MAX_VALID)
  {
    system_state.humidity_percent = humidity;
  }
  else
  {
    Serial.println("[HUMIDITY] Invalid DHT22 reading, keeping previous value");
  }

  // Debug: Print raw ADC value
  Serial.print("[WATER LEVEL] Raw ADC: ");
  Serial.print(adc_value);

  // Map ADC to tank height in cm
  system_state.water_level_cm = map(adc_value, WATER_LEVEL_IN_AIR, WATER_LEVEL_IN_WATER, 0, (int)TANK_HEIGHT_CM);

  // Clamp water level between 0 and tank height
  if (system_state.water_level_cm < 0)
    system_state.water_level_cm = 0;
  if (system_state.water_level_cm > TANK_HEIGHT_CM)
    system_state.water_level_cm = TANK_HEIGHT_CM;

  // Optional: Print water level as percentage
  int waterPercent = map(adc_value, WATER_LEVEL_IN_AIR, WATER_LEVEL_IN_WATER, 0, 100);
  if (waterPercent < 0)
    waterPercent = 0;
  if (waterPercent > 100)
    waterPercent = 100;
  Serial.print(" | % Full: ");
  Serial.print(waterPercent);
  Serial.println("%");

  system_state.system_online = 1;

  Serial.print("[SENSOR] Flow1: ");
  Serial.print(system_state.current_flow_rate_1, 2);
  Serial.print(" L/min | Flow2: ");
  Serial.print(system_state.current_flow_rate_2, 2);
  Serial.print(" L/min | Level: ");
  Serial.print(system_state.water_level_cm, 1);
  Serial.print(" cm | Humidity: ");
  Serial.print(system_state.humidity_percent, 1);
  Serial.print(" %");
  Serial.print(" | Valve: ");
  Serial.print(system_state.valve_state ? "OPEN" : "CLOSE");
  Serial.print(" | WiFi: ");
  Serial.println(WiFi.status() == WL_CONNECTED ? "OK" : "NO");
  // NOTE: System status check removed
}

// Note: Flow rate calculation has been moved into read_sensors() for better timing accuracy
// The calculate_flow_rate function is no longer used

// ============== DETECTION LOGIC ==============
void process_detection_logic()
{
  // Calculate percentage loss
  // Minimum threshold to avoid noise: 10ml accumulated at each sensor
  const unsigned int MIN_ACCUMULATED_VOLUME = 10; // 10ml minimum to calculate loss percentage

  if (accumulated_volume_1 > MIN_ACCUMULATED_VOLUME)
  {
    // Only calculate percentage loss if flow is significant
    system_state.percentage_loss = ((accumulated_volume_1 - accumulated_volume_2) / (float)accumulated_volume_1) * 100.0;

    // Add sanity check - loss percentage should not exceed 100%
    if (system_state.percentage_loss < 0)
      system_state.percentage_loss = 0;
    if (system_state.percentage_loss > 100)
      system_state.percentage_loss = 100;
  }
  else
  {
    // No significant flow detected - reset loss to 0 (flow is regulated/off)
    system_state.percentage_loss = 0;
  }

  // Classify leak status based on percentage loss
  if (system_state.percentage_loss < NORMAL_LOSS_THRESHOLD)
  {
    system_state.leak_status = "Normal";
  }
  else if (system_state.percentage_loss < WARNING_LOSS_THRESHOLD)
  {
    system_state.leak_status = "Warning";
  }
  else
  {
    system_state.leak_status = "Critical";
  }

  Serial.print("[DETECTION] Accumulated Vol1: ");
  Serial.print(accumulated_volume_1);
  Serial.print("ml | Vol2: ");
  Serial.print(accumulated_volume_2);
  Serial.print("ml | Loss: ");
  Serial.print(system_state.percentage_loss, 1);
  Serial.print("% | Status: ");
  Serial.println(system_state.leak_status);

  // REGULATION CHECK: If both sensors show very low flow (<0.1 L/min), reset status to Normal
  // This handles the case where flow is regulated/controlled and not leaking anymore
  if (system_state.current_flow_rate_1 < 0.1 && system_state.current_flow_rate_2 < 0.1)
  {
    system_state.leak_status = "Normal";
    system_state.percentage_loss = 0;
    Serial.println("[REGULATION] ✓ Flow is regulated/OFF - Leak status reset to NORMAL");
  }

  // Check for anomalies based on time-based pattern
  uint8_t current_hour = get_safe_current_hour();

  check_anomaly_detection(current_hour, accumulated_volume_1);

  // Check for nighttime leaks (2 AM - 5 AM)
  check_nighttime_leak(current_hour, accumulated_volume_1);

  // Auto-control solenoid valve based on leak status
  if (!manual_valve_override)
  {
    if (system_state.leak_status == "Critical")
    {
      close_solenoid_valve();
      log_alert("CRITICAL_LEAK", "Critical leak detected! Valve closed automatically.");
    }
  }

  // Update baseline if not yet initialized
  if (!baseline_initialized)
  {
    update_baseline(current_hour, accumulated_volume_1);
    check_baseline_ready();
  }

  // Reset accumulated volumes for next window
  accumulated_volume_1 = 0;
  accumulated_volume_2 = 0;
}

void check_anomaly_detection(uint8_t current_hour, unsigned long volume_ml)
{
  if (!baseline_initialized)
  {
    system_state.anomaly_status = "Learning";
    return;
  }

  float expected_usage = baseline[current_hour].hourly_usage_ml;
  float threshold = expected_usage * ANOMALY_THRESHOLD;

  if (volume_ml > threshold && expected_usage > 100)
  { // Avoid false positives during low usage
    system_state.anomaly_status = "Anomaly Detected";
    log_alert("USAGE_ANOMALY", "Abnormal water usage detected for hour " + String(current_hour));
  }
  else
  {
    system_state.anomaly_status = "Normal";
  }
}

void check_nighttime_leak(uint8_t current_hour, unsigned long volume_ml)
{
  // Monitor for leaks during nighttime hours (2 AM - 5 AM)
  // Typical usage during these hours should be minimal or zero

  bool in_nighttime_window = (current_hour >= NIGHTTIME_START_HOUR && current_hour < NIGHTTIME_END_HOUR);

  if (!in_nighttime_window)
  {
    // Outside nighttime window - reset tracking
    system_state.nighttime_flow_active = false;
    system_state.nighttime_accumulated_volume_liters = 0;
    system_state.nighttime_leak_status = "Normal";
    return;
  }

  // ===== INSIDE NIGHTTIME WINDOW (2 AM - 5 AM) =====

  // Convert volume from ml to liters for threshold comparison
  float current_volume_liters = volume_ml / 1000.0;

  // Check if flow is still occurring
  bool flow_detected = (system_state.current_flow_rate_1 > NIGHTTIME_FLOW_THRESHOLD);

  if (flow_detected)
  {
    // Flow is occurring during nighttime hours

    if (!system_state.nighttime_flow_active)
    {
      // Flow just started - initialize tracking
      system_state.nighttime_flow_active = true;
      system_state.nighttime_flow_start_time = millis();
      system_state.nighttime_accumulated_volume_liters = 0;
      system_state.nighttime_leak_status = "Alert";

      Serial.println();
      Serial.println("[NIGHTTIME LEAK DETECTION] *** FLOW DETECTED DURING 2-5 AM ***");
      Serial.print("  Flow Rate: ");
      Serial.print(system_state.current_flow_rate_1, 2);
      Serial.println(" L/min");
      log_alert("NIGHTTIME_FLOW_START", "Water flow detected during 2-5 AM nighttime hours!");
    }

    // Accumulate volume during nighttime flow
    system_state.nighttime_accumulated_volume_liters += current_volume_liters;

    // Calculate how long flow has been active
    unsigned long flow_duration_ms = millis() - system_state.nighttime_flow_start_time;
    unsigned long flow_duration_sec = flow_duration_ms / 1000;

    // Alert thresholds
    if (flow_duration_ms >= NIGHTTIME_FLOW_CRITICAL_DURATION)
    {
      // Flow persisted for 10 minutes - CRITICAL
      system_state.nighttime_leak_status = "Critical";

      log_alert("NIGHTTIME_LEAK_CRITICAL",
                "CRITICAL: Continuous flow for " + String(flow_duration_sec / 60) + " minutes during 2-5 AM! "
                                                                                    "Volume: " +
                    String(system_state.nighttime_accumulated_volume_liters, 2) + " liters");

      Serial.println();
      Serial.println("[NIGHTTIME LEAK DETECTION] *** CRITICAL - 10+ MIN CONTINUOUS FLOW ***");
      Serial.print("  Duration: ");
      Serial.print(flow_duration_sec);
      Serial.print("s | Volume: ");
      Serial.print(system_state.nighttime_accumulated_volume_liters, 2);
      Serial.println(" L");

      // Consider auto-closing valve for critical nighttime leak
      if (!manual_valve_override && system_state.valve_state == 1)
      {
        close_solenoid_valve();
        log_alert("VALVE_AUTO_CLOSED", "Solenoid valve auto-closed due to critical nighttime leak!");
      }
    }
    else if (flow_duration_ms >= NIGHTTIME_FLOW_ALERT_DURATION)
    {
      // Flow persisted for 5 minutes - ALERT
      system_state.nighttime_leak_status = "Alert";

      log_alert("NIGHTTIME_LEAK_ALERT",
                "WARNING: Flow detected for " + String(flow_duration_sec / 60) + " minutes during 2-5 AM. "
                                                                                 "Volume: " +
                    String(system_state.nighttime_accumulated_volume_liters, 2) + " liters");

      Serial.println();
      Serial.println("[NIGHTTIME LEAK DETECTION] *** ALERT - 5+ MIN CONTINUOUS FLOW ***");
      Serial.print("  Duration: ");
      Serial.print(flow_duration_sec);
      Serial.print("s | Volume: ");
      Serial.print(system_state.nighttime_accumulated_volume_liters, 2);
      Serial.println(" L");
    }
    else
    {
      // Still monitoring - print progress every 60 seconds
      if (flow_duration_sec > 0 && flow_duration_sec % 60 == 0)
      {
        Serial.print("[NIGHTTIME] Flow active for ");
        Serial.print(flow_duration_sec);
        Serial.print("s, volume: ");
        Serial.print(system_state.nighttime_accumulated_volume_liters, 2);
        Serial.println(" L");
      }
    }

    // Additional check: volume threshold independent of duration
    if (system_state.nighttime_accumulated_volume_liters > NIGHTTIME_VOLUME_THRESHOLD)
    {
      if (system_state.nighttime_leak_status != "Critical")
      {
        system_state.nighttime_leak_status = "Alert";
      }

      log_alert("NIGHTTIME_EXCESSIVE_VOLUME",
                "Excessive water usage during 2-5 AM: " + String(system_state.nighttime_accumulated_volume_liters, 2) +
                    " liters (threshold: " + String(NIGHTTIME_VOLUME_THRESHOLD, 1) + " L)");
    }
  }
  else
  {
    // No flow during nighttime window

    if (system_state.nighttime_flow_active)
    {
      // Flow just stopped after being active
      unsigned long total_flow_duration_ms = millis() - system_state.nighttime_flow_start_time;
      unsigned long total_flow_duration_sec = total_flow_duration_ms / 1000;

      Serial.println();
      Serial.println("[NIGHTTIME LEAK DETECTION] Flow stopped.");
      Serial.print("  Total Duration: ");
      Serial.print(total_flow_duration_sec);
      Serial.print("s | Total Volume: ");
      Serial.print(system_state.nighttime_accumulated_volume_liters, 2);
      Serial.println(" L");

      // Log summary
      if (system_state.nighttime_accumulated_volume_liters > 0.1)
      {
        log_alert("NIGHTTIME_FLOW_ENDED",
                  "Nighttime flow event ended. Duration: " + String(total_flow_duration_sec) + "s, "
                                                                                               "Volume: " +
                      String(system_state.nighttime_accumulated_volume_liters, 2) + "L");
      }

      system_state.nighttime_flow_active = false;
      system_state.nighttime_leak_status = "Normal";
    }
  }
}

void initialize_baseline()
{
  for (int i = 0; i < 24; i++)
  {
    baseline[i].hour = i;
    baseline[i].hourly_usage_ml = 500; // Default 500ml per hour for each hour
  }
}

void update_baseline(uint8_t hour, unsigned long current_volume)
{
  // Simple moving average update
  float alpha = 0.1; // Learning rate
  baseline[hour].hourly_usage_ml = (alpha * current_volume) + ((1.0 - alpha) * baseline[hour].hourly_usage_ml);
}

void check_baseline_ready()
{
  // After collecting data from ~3 different days, mark as initialized
  // This is a simplified check - in production, store to EEPROM
  static unsigned long last_check = 0;
  static int unique_days = 0;
  static uint8_t last_day = 0;

  DateTime now = rtc.now();
  if (now.day() != last_day)
  {
    last_day = now.day();
    unique_days++;
  }

  if (unique_days >= BASELINE_DAYS_REQUIRED)
  {
    baseline_initialized = true;
    Serial.println("BASELINE INITIALIZED - Anomaly detection active!");
  }
}

// ============== VALVE CONTROL ==============
void sound_buzzer()
{
  // Activate buzzer with Morse code pattern: short-short-long beeps
  buzzer_active = true;
  buzzer_pattern_stage = 1; // Start with first short beep ON
  digitalWrite(BUZZER_PIN, HIGH);
  last_buzzer_action_time = millis();
  Serial.println("[BUZZER] Morse pattern activated (short-short-long) - valve closed!");
}

void open_solenoid_valve()
{
  valveServo.write(0);
  system_state.valve_state = 1;
  Serial.println("Solenoid valve OPENED");
  log_alert("VALVE_OPENED", "Solenoid valve opened");

  // Turn off buzzer when valve opens
  buzzer_active = false;
  buzzer_pattern_stage = 0;
  digitalWrite(BUZZER_PIN, LOW);
  Serial.println("[BUZZER] Turned OFF - valve is open");
}

void close_solenoid_valve()
{
  valveServo.write(90);
  system_state.valve_state = 0;
  Serial.println("Solenoid valve CLOSED");
  log_alert("VALVE_CLOSED", "Solenoid valve closed");

  // Sound buzzer alarm pattern
  sound_buzzer();
}

void toggle_valve()
{
  if (system_state.valve_state == 0)
  {
    open_solenoid_valve();
  }
  else
  {
    close_solenoid_valve();
  }
}

void set_manual_override(bool is_override_enabled)
{
  manual_valve_override = is_override_enabled;
  if (is_override_enabled)
  {
    Serial.println("Manual override ENABLED");
  }
  else
  {
    Serial.println("Manual override DISABLED");
  }
}

// ============== WiFi CONNECTION ==============
void connect_wifi()
{
  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println("[WiFi] Already connected");
    return;
  }

  Serial.println("\n[WiFi] Connecting to WiFi...");
  Serial.print("[WiFi] SSID: ");
  Serial.println(SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(SSID, PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40)
  {
    delay(250);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.println("\n[WiFi] SUCCESS!");
    Serial.print("[WiFi] IP address: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WiFi] Gateway: ");
    Serial.println(WiFi.gatewayIP());
    Serial.print("[WiFi] DNS: ");
    Serial.println(WiFi.dnsIP());
    Serial.print("[WiFi] Signal strength: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
    system_state.system_online = 1;

    // Test basic internet connectivity first (HTTP to Google)
    Serial.println("\n[CONNECTIVITY TEST] Testing basic internet...");
    HTTPClient testHttp;
    wifiClient.setInsecure();
    testHttp.setTimeout(5000);
    testHttp.setConnectTimeout(5000);

    // Try Google DNS to verify internet
    int googleTest = 0;
    if (testHttp.begin(wifiClient, "http://8.8.8.8"))
    {
      googleTest = testHttp.GET();
      testHttp.end();
    }

    if (googleTest > 0)
    {
      Serial.print("[CONNECTIVITY TEST] Basic internet: OK (HTTP ");
      Serial.print(googleTest);
      Serial.println(")");
    }
    else
    {
      Serial.println("[CONNECTIVITY TEST] WARNING: No internet connection from ESP32!");
      Serial.println("[CONNECTIVITY CHECK] Possible issues:");
      Serial.println("  1. ESP32 on different WiFi than your PC");
      Serial.println("  2. WiFi network blocks this device");
      Serial.println("  3. DNS not working properly");
      Serial.println("[CONNECTIVITY TEST] Continuing anyway - Supabase HTTPS may still work");
    }

    // Now test Supabase connectivity
    Serial.println("\n[SUPABASE] Testing Supabase connectivity...");
    HTTPClient supabaseHttp;
    supabaseHttp.setTimeout(5000);
    supabaseHttp.setConnectTimeout(5000);

    Serial.println("[SUPABASE] Attempting HTTPS connection...");
    Serial.print("[SUPABASE] URL: ");
    Serial.println(SUPABASE_URL);

    int testCode = 0;
    unsigned long testStart = millis();

    if (supabaseHttp.begin(wifiClient, String(SUPABASE_URL)))
    {
      testCode = supabaseHttp.GET();
      unsigned long testDuration = millis() - testStart;

      Serial.print("[SUPABASE] Response time: ");
      Serial.print(testDuration);
      Serial.println("ms");
    }
    else
    {
      Serial.println("[SUPABASE] ERROR: Failed to begin HTTP connection!");
      Serial.println("[SUPABASE] Check URL and WiFi connectivity");
    }

    supabaseHttp.end();

    if (testCode > 0)
    {
      Serial.print("[SUPABASE] HTTP ");
      Serial.print(testCode);

      if (testCode == 200 || testCode == 404 || testCode == 401 || testCode == 403)
      {
        Serial.println(" - URL is reachable!");
        Serial.println("[SUPABASE] Ready to send sensor data");
      }
      else
      {
        Serial.println(" - Response received");
      }
    }
    else
    {
      Serial.print("[SUPABASE] Failed! Error: ");
      Serial.println(testCode);
      Serial.println("[SUPABASE] Troubleshooting:");
      Serial.println("  - Verify Supabase URL is correct");
      Serial.println("  - Check if ESP32 is on same WiFi as your PC");
      Serial.println("  - Try: SSID is 'Apple' on ESP32?");
      Serial.println("[SUPABASE] System will continue - data upload will retry");
    }
  }
  else
  {
    Serial.println("\n[WiFi] FAILED to connect");
    Serial.print("[WiFi] Status: ");
    Serial.println(WiFi.status());
    system_state.system_online = 0;
  }
}

// ============== SUPABASE DATA SENDING ==============
void send_data_to_supabase()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("[SUPABASE] WiFi not connected, skipping upload");
    return;
  }

  Serial.println("\n=========================================");
  Serial.println("[SUPABASE] Starting data upload...");
  Serial.println("=========================================");

  HTTPClient http;
  wifiClient.setInsecure();

  // Create JSON payload with structure matching Supabase table
  StaticJsonDocument<256> doc;

  char timestamp[25];
  bool has_valid_timestamp = false;
  if (rtc_available)
  {
    DateTime now = rtc.now();
    if (is_valid_rtc_datetime(now))
    {
      snprintf(timestamp, sizeof(timestamp), "%04d-%02d-%02d %02d:%02d:%02d",
               now.year(), now.month(), now.day(),
               now.hour(), now.minute(), now.second());
      has_valid_timestamp = true;
    }
    else
    {
      Serial.println("[RTC] Invalid datetime detected, letting Supabase set server timestamp");
    }
  }

  // Build JSON object with exact field names (only fields that exist in water_readings table)
  float safe_flow_1 = isfinite(system_state.current_flow_rate_1) ? system_state.current_flow_rate_1 : 0.0;
  float safe_flow_2 = isfinite(system_state.current_flow_rate_2) ? system_state.current_flow_rate_2 : 0.0;
  float safe_loss = clamp_percentage(system_state.percentage_loss);
  float safe_level = isfinite(system_state.water_level_cm) ? system_state.water_level_cm : 0.0;
  float safe_humidity = isfinite(system_state.humidity_percent) ? system_state.humidity_percent : 0.0;

  if (has_valid_timestamp)
  {
    doc["timestamp"] = timestamp;
  }
  doc["flow_rate_1"] = round(safe_flow_1 * 100.0) / 100.0;
  doc["flow_rate_2"] = round(safe_flow_2 * 100.0) / 100.0;
  // percentage_loss is already 0-100, just send directly (don't multiply by 100 again)
  doc["percentage_loss"] = safe_loss;
  doc["water_level"] = round(safe_level * 100.0) / 100.0;
  doc["humidity"] = round(safe_humidity * 100.0) / 100.0;
  doc["valve_state"] = system_state.valve_state;
  doc["leak_status"] = normalize_leak_status(system_state.leak_status);
  doc["anomaly_status"] = system_state.anomaly_status;
  doc["system_online"] = system_state.system_online;
  doc["daily_total_liters"] = system_state.daily_total_ml / 1000.0;

  // NOTE: nighttime_leak_status and nighttime_volume_liters removed - not in table schema
  // These will be logged to alerts table instead via log_alert() function

  // Serialize JSON to String (instead of char buffer) - more reliable
  String jsonPayload;
  serializeJson(doc, jsonPayload);

  if (has_valid_timestamp)
  {
    Serial.print("[SUPABASE] Timestamp: ");
    Serial.println(timestamp);
  }
  else
  {
    Serial.println("[SUPABASE] Timestamp: <server default>");
  }
  Serial.print("[SUPABASE] Payload size: ");
  Serial.print(jsonPayload.length());
  Serial.println(" bytes");
  Serial.print("[SUPABASE] Payload: ");
  Serial.println(jsonPayload);

  // Create Supabase URL
  String url = String(SUPABASE_URL) + "/rest/v1/" + SUPABASE_TABLE;

  Serial.print("[SUPABASE] URL: ");
  Serial.println(url);
  Serial.print("[SUPABASE] API Key (first 20 chars): ");
  Serial.println(String(SUPABASE_KEY).substring(0, 20) + "...");

  // Initialize HTTP connection
  Serial.println("[SUPABASE] Initializing HTTP connection...");
  http.begin(wifiClient, url);

  // Set timeouts to prevent hanging
  http.setTimeout(5000);        // 5 second timeout
  http.setConnectTimeout(5000); // 5 second connect timeout

  // Add required headers for Supabase
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);

  Serial.println("[SUPABASE] Headers added, sending POST request...");

  // Send POST request
  int httpCode = http.POST(jsonPayload);

  Serial.print("[SUPABASE] HTTP Response Code: ");
  Serial.println(httpCode);

  // Get response
  String response = http.getString();
  Serial.print("[SUPABASE] Response length: ");
  Serial.println(response.length());

  if (response.length() > 0)
  {
    Serial.print("[SUPABASE] Response body: ");
    Serial.println(response);
  }

  // Handle response
  if (httpCode == 201 || httpCode == 200)
  {
    Serial.println("=========================================");
    Serial.println("[SUPABASE] ✓ SUCCESS - Data uploaded!");
    Serial.print("[SUPABASE] HTTP: ");
    Serial.print(httpCode);
    Serial.print(" | Flow1: ");
    Serial.print(system_state.current_flow_rate_1, 2);
    Serial.print(" L/min | Flow2: ");
    Serial.print(system_state.current_flow_rate_2, 2);
    Serial.print(" L/min | Level: ");
    Serial.print(system_state.water_level_cm, 1);
    Serial.print(" cm | Humidity: ");
    Serial.print(system_state.humidity_percent, 1);
    Serial.println(" %");
    Serial.println("=========================================\n");
  }
  else
  {
    Serial.println("=========================================");
    Serial.println("[SUPABASE] ✗ ERROR - Upload failed!");
    Serial.print("[SUPABASE] HTTP Code: ");
    Serial.println(httpCode);
    Serial.println("[SUPABASE] Possible issues:");
    Serial.println("  - Check Supabase URL and credentials");
    Serial.println("  - Verify RLS permissions");
    Serial.println("  - Check table name: water_readings");
    Serial.println("  - Verify all column names match exactly");
    Serial.println("  - Check internet connectivity");
    Serial.println("=========================================\n");
  }

  http.end();
}

void log_alert(String alert_type, String message)
{
  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("[ALERT] WiFi not connected, alert not logged to server");
    return;
  }

  HTTPClient http;
  wifiClient.setInsecure();

  StaticJsonDocument<256> doc;

  if (rtc_available)
  {
    DateTime now = rtc.now();
    if (is_valid_rtc_datetime(now))
    {
      char timestamp[25];
      snprintf(timestamp, sizeof(timestamp), "%04d-%02d-%02d %02d:%02d:%02d",
               now.year(), now.month(), now.day(),
               now.hour(), now.minute(), now.second());
      doc["timestamp"] = timestamp;
    }
  }
  doc["alert_type"] = alert_type;
  doc["message"] = message;
  doc["severity"] = (alert_type == "CRITICAL_LEAK") ? "high" : "medium";

  // Serialize to String for consistency
  String jsonPayload;
  serializeJson(doc, jsonPayload);

  // Create Supabase URL
  String url = String(SUPABASE_URL) + "/rest/v1/" + ALERT_TABLE;

  http.begin(wifiClient, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);

  // Set timeouts
  http.setTimeout(5000);
  http.setConnectTimeout(5000);

  int httpCode = http.POST(jsonPayload);

  if (httpCode == 201 || httpCode == 200)
  {
    Serial.println("=========================================");
    Serial.println("[ALERT LOGGED] Successfully sent to Supabase");
    Serial.print("[ALERT] Type: ");
    Serial.println(alert_type);
    Serial.print("[ALERT] Message: ");
    Serial.println(message);
    Serial.print("[ALERT] Severity: ");
    Serial.println((alert_type == "CRITICAL_LEAK") ? "HIGH" : "MEDIUM");
    Serial.println("=========================================");
  }
  else
  {
    Serial.println("=========================================");
    Serial.println("[ALERT ERROR] Failed to log alert!");
    Serial.print("[ALERT] HTTP Code: ");
    Serial.println(httpCode);
    Serial.print("[ALERT] Type: ");
    Serial.println(alert_type);
    Serial.print("[ALERT] Message: ");
    Serial.println(message);
    Serial.println("=========================================");
  }

  http.end();
}

// ============== SERIAL COMMAND HANDLER ==============
void handleSerialCommand()
{
  if (Serial.available())
  {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "VALVE_OPEN")
    {
      open_solenoid_valve();
    }
    else if (command == "VALVE_CLOSE")
    {
      close_solenoid_valve();
    }
    else if (command == "VALVE_TOGGLE")
    {
      toggle_valve();
    }
    else if (command == "STATUS")
    {
      print_status();
    }
    else if (command == "OVERRIDE_ON")
    {
      set_manual_override(true);
    }
    else if (command == "OVERRIDE_OFF")
    {
      set_manual_override(false);
    }
  }
}

void print_status()
{
  Serial.println("\n========== SYSTEM STATUS ==========");
  Serial.print("Flow Rate 1: ");
  Serial.print(system_state.current_flow_rate_1, 2);
  Serial.println(" L/min");
  Serial.print("Flow Rate 2: ");
  Serial.print(system_state.current_flow_rate_2, 2);
  Serial.println(" L/min");
  Serial.print("Water Level: ");
  Serial.print(system_state.water_level_cm, 1);
  Serial.println(" cm");
  Serial.print("Humidity: ");
  Serial.print(system_state.humidity_percent, 1);
  Serial.println(" %");
  Serial.print("Loss %: ");
  Serial.print(system_state.percentage_loss, 1);
  Serial.println("%");
  Serial.print("Leak Status: ");
  Serial.println(system_state.leak_status);
  Serial.print("Anomaly: ");
  Serial.println(system_state.anomaly_status);
  Serial.print("Nighttime Leak Status (2-5 AM): ");
  Serial.println(system_state.nighttime_leak_status);
  if (system_state.nighttime_flow_active)
  {
    Serial.print("  Active Flow Volume: ");
    Serial.print(system_state.nighttime_accumulated_volume_liters, 2);
    Serial.println(" L");
  }
  Serial.print("Valve State: ");
  Serial.println(system_state.valve_state ? "OPEN" : "CLOSED");
  Serial.print("Daily Total: ");
  Serial.print(system_state.daily_total_ml / 1000.0, 2);
  Serial.println(" L");
  Serial.println("Pipe: 3/4 inch (19.05mm diameter)");
  Serial.println("==================================\n");
}
