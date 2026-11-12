/*
  ================================================================
  FLOWSTATE (TEAM 10) - ESP32 WATER LEAK DETECTION AND ANALYTICS
  ================================================================
  IoT pipeline: Sense -> Ingest -> Process -> Store -> Analyze

  Hardware pins (ESP32 DevKit V1):
    YF-S201 Sensor 1 signal (through resistor divider) : GPIO 19  (tank outlet)
    YF-S201 Sensor 2 signal (through resistor divider) : GPIO 22  (tap)
    Capacitive water-level sensor analog output        : GPIO 33
    Active buzzer signal                               : GPIO 13
    SG90 servo signal                                  : GPIO 26
    DS3231 SDA / SCL                                   : GPIO 18 / GPIO 21
    DHT22 data                                         : GPIO 4

  The sketch is split into tabs, one per pipeline stage:
    FlowState_ESP32.ino  settings, shared state, setup() and loop()
    sense.ino            SENSE    flow-sensor interrupts, water level, DHT22
    process.ino          PROCESS  leak check, night watch, learning, valve, buzzer
    cloud.ino            INGEST + STORE   Wi-Fi, clock (DS3231 + NTP), HTTPS to Supabase
    mqtt.ino             INGEST   MQTT: live telemetry, online status, signed valve commands
    console.ino          Serial Monitor commands and status
    flowstate_rules.h    the decision rules as plain functions, also tested on a PC

  Two ways the data leaves the ESP32:
    1. HTTPS (REST) to Supabase every 10 s   -> stored for analysis (Store)
    2. MQTT to a broker every 2 s            -> live view, status and valve control
  If MQTT is blocked (some campus networks block port 8883), HTTPS still works and
  the dashboard falls back to the database's own live updates.

  IMPORTANT:
    - Keep the external resistor voltage divider on EACH flow sensor signal.
    - Do not feed a 5V flow-sensor signal directly into an ESP32 GPIO.
    - Use a suitable separate 5V supply for the SG90 and join its GND to ESP32 GND.
    - The servo angles below assume 0 degrees = valve OPEN and 90 degrees = CLOSED.

  Required Arduino libraries:
    1. ArduinoJson (version 6.x)
    2. RTClib by Adafruit
    3. ESP32Servo
    4. DHT sensor library by Adafruit
    5. Adafruit Unified Sensor
    6. PubSubClient by Nick O'Leary (only when ENABLE_MQTT is 1)

  Before uploading: copy secrets.example.h to secrets.h and fill it in.
*/

// Command timestamps are milliseconds since 1970, which need 64-bit numbers.
#define ARDUINOJSON_USE_LONG_LONG 1

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <RTClib.h>
#include <ESP32Servo.h>
#include <DHT.h>
#include <Preferences.h>
#include <time.h>
#include "flowstate_rules.h"
#include "secrets.h"

// Set to 0 to build without MQTT (then only HTTPS is used, exactly like before).
#define ENABLE_MQTT 1
#if ENABLE_MQTT
#include <PubSubClient.h>
#include "mbedtls/md.h"   // HMAC-SHA256 for signed valve commands
#endif

const char* FIRMWARE_VERSION = "2.0.0";

// ---------------- PIN CONFIGURATION ----------------
#define FLOW_SENSOR_1_PIN 19
#define FLOW_SENSOR_2_PIN 22
#define WATER_LEVEL_PIN   33
#define BUZZER_PIN        13
#define SERVO_PIN         26
#define DHT_PIN            4
// Change DHT22 to DHT11 if you use the cheaper sensor.
#define DHT_TYPE        DHT22

// ---------------- SUPABASE TABLES ----------------
const char* SUPABASE_READINGS_TABLE = "water_readings";
const char* SUPABASE_ALERTS_TABLE   = "alerts";

// ---------------- MQTT ----------------
// The public HiveMQ broker needs no account. Anyone can read what is published
// there, so readings are not secret, and valve commands must carry a signature
// made with VALVE_COMMAND_KEY (see mqtt.ino). Use your own broker for real homes.
const char* MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 8883;          // 8883 = MQTT over TLS, 1883 = plain MQTT
// 1 = TLS (port 8883), 0 = plain MQTT (port 1883). Must match MQTT_PORT.
#define MQTT_USE_TLS 1
const char* MQTT_USERNAME = "";           // leave empty for the public broker
const char* MQTT_PASSWORD = "";
const char* MQTT_TOPIC_ROOT = "flowstate/team10-d76014";  // must match the dashboard
const unsigned long MQTT_TELEMETRY_INTERVAL_MS = 2000;
const uint32_t COMMAND_MAX_CLOCK_SKEW_S = 300;

// ---------------- TIME ----------------
const long IST_OFFSET_SECONDS = 19800;    // the DS3231 keeps India time (UTC+05:30)
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.google.com";

// ---------------- FLOW SENSOR CALIBRATION ----------------
const float FLOW_PULSES_PER_LITER = 450.0f;
const uint32_t FLOW_DEBOUNCE_US = 4000;   // rejects pulses faster than 250 Hz
const float MIN_FLOW_FOR_DETECTION_LPM = 0.10f;

// ---------------- WATER LEVEL CALIBRATION ----------------
const int WATER_LEVEL_IN_AIR = 4095;
const int WATER_LEVEL_IN_WATER = 1000;
const float TANK_HEIGHT_CM = 100.0f;

// ---------------- SERVO VALVE POSITIONS ----------------
const int SERVO_OPEN_ANGLE = 0;
const int SERVO_CLOSED_ANGLE = 90;

// ---------------- LEAK DETECTION ----------------
const unsigned long SENSOR_INTERVAL_MS = 1000;
const unsigned long DETECTION_WINDOW_MS = 60000;
const unsigned long SUPABASE_UPLOAD_INTERVAL_MS = 10000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 15000;
const unsigned long PREFERENCES_SAVE_INTERVAL_MS = 60000;

const float NORMAL_LOSS_THRESHOLD_PERCENT = 5.0f;
const float WARNING_LOSS_THRESHOLD_PERCENT = 15.0f;
const float MIN_WINDOW_VOLUME_LITERS = 0.01f; // 10 ml minimum before comparing sensors
const bool AUTO_CLOSE_ON_CRITICAL_LEAK = true;

// ---------------- NIGHTTIME MONITORING ----------------
const uint8_t NIGHT_START_HOUR = 2; // 2:00 AM
const uint8_t NIGHT_END_HOUR = 5;   // 5:00 AM, exclusive
const unsigned long NIGHT_ALERT_DURATION_MS = 300000UL;   // 5 minutes
const unsigned long NIGHT_CRITICAL_DURATION_MS = 600000UL; // 10 minutes
const float NIGHT_VOLUME_ALERT_LITERS = 0.5f;
const unsigned long NIGHT_FLOW_GAP_TOLERANCE_MS = 5000UL;

// ---------------- GLOBAL OBJECTS ----------------
WiFiClientSecure secureClient;   // HTTPS to Supabase (kept open between uploads)
RTC_DS3231 rtc;
Servo valveServo;
DHT dht(DHT_PIN, DHT_TYPE);
Preferences preferences;

#if ENABLE_MQTT
#if MQTT_USE_TLS
WiFiClientSecure mqttNet;
#else
WiFiClient mqttNet;
#endif
PubSubClient mqtt(mqttNet);
#endif

bool rtcAvailable = false;
bool ntpRequested = false;
bool ntpSynced = false;
bool preferencesReady = false;
bool wifiConfigured = false;

// ---------------- FLOW INTERRUPT DATA ----------------
// ESP32 critical section protects the ISR counters while the main loop snapshots them.
portMUX_TYPE flowMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t flowPulseCount1 = 0;
volatile uint32_t flowPulseCount2 = 0;
volatile uint32_t lastPulseMicros1 = 0;
volatile uint32_t lastPulseMicros2 = 0;

// ---------------- SYSTEM STATE ----------------
struct SystemState {
  float flowRate1Lpm = 0.0f;
  float flowRate2Lpm = 0.0f;
  float percentageLoss = 0.0f;
  float waterLevelCm = 0.0f;
  int waterLevelPercent = 0;
  float temperatureC = NAN;
  float humidityPercent = NAN;
  double dailyTotalLiters = 0.0; // measured from Sensor 1 (tank-side)
  uint8_t valveState = 0;        // 0 = CLOSED, 1 = OPEN
  bool systemOnline = false;
  String leakStatus = "Normal";
  String anomalyStatus = "Learning";
  bool nighttimeFlowActive = false;
  unsigned long nighttimeFlowStartMs = 0;
  unsigned long nighttimeLastFlowMs = 0;
  float nighttimeVolumeLiters = 0.0f;
  String nighttimeLeakStatus = "Normal";
} state;

// ---------------- TIMERS / TOTALS ----------------
unsigned long lastSensorReadMs = 0;
unsigned long lastDetectionWindowMs = 0;
unsigned long lastUploadMs = 0;
unsigned long lastWifiRetryMs = 0;
unsigned long lastDhtReadMs = 0;
unsigned long lastPreferencesSaveMs = 0;

float windowVolume1Liters = 0.0f;
float windowVolume2Liters = 0.0f;
float latestIntervalVolume1Liters = 0.0f;

// ---------------- DAILY TOTAL STORAGE ----------------
uint32_t storedDateKey = 0;
uint32_t savedDateKeyAtBoot = 0;

// ---------------- BASIC BASELINE LEARNING ----------------
// Per-hour average volume for one 60-second sample window.
struct HourBaseline {
  float averageWindowMl;
  uint16_t sampleCount;
};
HourBaseline hourlyBaseline[24];
uint32_t lastBaselineDateKey = 0;
uint8_t baselineDaysSeen = 0;
bool baselineInitialized = false;
const uint8_t BASELINE_DAYS_REQUIRED = 3;

// ---------------- BUZZER PATTERN ----------------
bool buzzerActive = false;
uint8_t buzzerStage = 0;
unsigned long buzzerStageStartedMs = 0;
const unsigned long BUZZER_SHORT_MS = 200;
const unsigned long BUZZER_GAP_MS = 200;
const unsigned long BUZZER_LONG_MS = 600;
const unsigned long BUZZER_CYCLE_PAUSE_MS = 1000;

// ---------------- CONTROL FLAGS ----------------
bool manualValveOverride = false;
bool nightAlertSent = false;
bool nightCriticalSent = false;
bool nightVolumeAlertSent = false;
bool anomalyAlertSentThisHour = false;
uint8_t lastAnomalyAlertHour = 255;

// ---------------- CONNECTIVITY HEALTH (sent to the dashboard) ----------------
uint32_t httpFailures = 0;          // failed Supabase uploads since boot
uint32_t lastUploadDurationMs = 0;  // how long the last HTTPS upload took
uint32_t uploadsSent = 0;
uint8_t consecutiveUploadFailures = 0;  // 3 or more: upload once a minute until one works
const unsigned long SLOW_UPLOAD_INTERVAL_MS = 60000;

// ---------------- ALERT UPLOAD QUEUE ----------------
// An alert goes out over MQTT at once; its HTTPS upload waits here and is sent
// from loop(), so a slow network never delays closing the valve.
struct QueuedAlert {
  String type;
  String message;
  String timestamp;
  const char* severity;
};
const uint8_t ALERT_QUEUE_SIZE = 8;
QueuedAlert alertQueue[ALERT_QUEUE_SIZE];
uint8_t alertQueueStart = 0;
uint8_t alertQueueCount = 0;
unsigned long alertWaitStartMs = 0;
unsigned long alertWaitMs = 0;   // after a failed upload, wait before the next try

// ---------------- MQTT STATE ----------------
String topicTelemetry, topicStatus, topicAlert, topicCommand, topicAck, topicPing, topicPong;
unsigned long lastMqttAttemptMs = 0;
unsigned long mqttRetryDelayMs = 5000;
unsigned long lastTelemetryMs = 0;
uint32_t telemetrySeq = 0;
uint32_t mqttReconnects = 0;
uint64_t lastCommandTimestampMs = 0;
bool pongPending = false;
long pendingPongId = 0;
bool commandPending = false;
char pendingAction[8] = "";
char pendingNonce[33] = "";

// ---------------- FORWARD DECLARATIONS ----------------
// sense.ino
void flowSensor1ISR();  // defined with IRAM_ATTR in sense.ino
void flowSensor2ISR();
void readFlowAndLevelSensors(unsigned long elapsedMs);
void readDHTIfDue();
// process.ino
void processDetectionWindow();
void updateNighttimeMonitoring(float newVolumeLiters);
void initializeBaseline();
void updateBaseline(uint8_t hour, float windowMl);
void checkAnomaly(uint8_t hour, float windowMl);
void openValve();
void closeValve(const String& reason);
void soundBuzzer();
void stopBuzzer();
void updateBuzzer();
// cloud.ino
bool credentialsConfigured();
void connectWiFi();
void startNtp();
void serviceClock();
bool clockReady();
DateTime localNow();
uint32_t epochNow();
uint32_t makeDateKey(const DateTime& now);
String currentTimestamp();
int postJson(const char* table, const String& payload);
void sendDataToSupabase();
void logAlert(const String& alertType, const String& message);
void flushAlertQueue();
void saveDailyTotal();
void checkForNewDay();
// mqtt.ino
void mqttSetup();
void mqttService();
bool mqttIsConnected();
void mqttPublishAlert(const String& alertType, const String& message, const char* severity);
#if ENABLE_MQTT
bool hmacSha256Hex(const char* key, const char* message, char* outHex);
#endif
// console.ino
void handleSerialCommands();
void printHelp();
void printStatus();

// ================================================================
// SETUP
// ================================================================
void setup() {
  Serial.begin(115200);
  Serial.setTimeout(50);
  delay(500);

  Serial.println();
  Serial.println("============================================");
  Serial.printf("   FLOWSTATE (TEAM 10) - ESP32 WATER MONITOR v%s\n", FIRMWARE_VERSION);
  Serial.println("============================================");

  pinMode(FLOW_SENSOR_1_PIN, INPUT); // external resistor divider provides safe signal level
  pinMode(FLOW_SENSOR_2_PIN, INPUT); // external resistor divider provides safe signal level
  pinMode(WATER_LEVEL_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  analogReadResolution(12);
  analogSetPinAttenuation(WATER_LEVEL_PIN, ADC_11db);

  // DS3231 uses the custom I2C pins from the wiring.
  Wire.begin(18, 21);
  if (rtc.begin()) {
    rtcAvailable = true;
    Serial.println("[RTC] DS3231 detected.");
    if (rtc.lostPower()) {
      Serial.println("[RTC] Clock lost power; setting it to the sketch compile time (NTP corrects it after Wi-Fi connects).");
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }
    DateTime now = rtc.now();
    Serial.printf("[RTC] %04d-%02d-%02d %02d:%02d:%02d\n",
                  now.year(), now.month(), now.day(),
                  now.hour(), now.minute(), now.second());
    storedDateKey = makeDateKey(now);
  } else {
    Serial.println("[RTC] DS3231 not found. Time will come from the internet (NTP) once Wi-Fi connects.");
  }

  dht.begin();
  Serial.println("[DHT] Initialized on GPIO 4.");

  // Initialize the servo at the CLOSED position for safer startup.
  ESP32PWM::allocateTimer(0);
  valveServo.setPeriodHertz(50);
  valveServo.attach(SERVO_PIN, 500, 2400);
  valveServo.write(SERVO_CLOSED_ANGLE);
  state.valveState = 0;
  Serial.println("[SERVO] Initialized at CLOSED position (90 degrees by default).");

  initializeBaseline();

  // Restore today's total from ESP32 non-volatile storage.
  preferencesReady = preferences.begin("flowstate", false);
  if (preferencesReady) {
    savedDateKeyAtBoot = preferences.getUInt("datekey", 0);
    const double savedTotal = preferences.getDouble("dailyL", 0.0);
    if (rtcAvailable && savedDateKeyAtBoot != storedDateKey) {
      state.dailyTotalLiters = 0.0;
      preferences.putUInt("datekey", storedDateKey);
      preferences.putDouble("dailyL", 0.0);
      Serial.println("[TOTAL] New date detected; today's total starts at 0 L.");
    } else {
      // Without an RTC the date is checked once NTP time arrives (see checkForNewDay).
      state.dailyTotalLiters = savedTotal;
      if (rtcAvailable) storedDateKey = savedDateKeyAtBoot;
      Serial.printf("[TOTAL] Restored today's total: %.3f L\n", state.dailyTotalLiters);
    }
  } else {
    Serial.println("[TOTAL] WARNING: Preferences storage unavailable; total will not survive a restart.");
  }

  // Start interrupts only after the pins and counters are ready.
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_1_PIN), flowSensor1ISR, FALLING);
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_2_PIN), flowSensor2ISR, FALLING);

  secureClient.setInsecure(); // Suitable for prototype testing; use certificate validation in production.
  secureClient.setHandshakeTimeout(10); // seconds; the library default of 120 s could stall the loop
  wifiConfigured = credentialsConfigured();
  mqttSetup();
  if (wifiConfigured) {
    connectWiFi();
  } else {
    Serial.println("[WiFi] Fill in WIFI_SSID, WIFI_PASSWORD, SUPABASE_URL and SUPABASE_ANON_KEY in secrets.h first.");
  }

  const unsigned long nowMs = millis();
  lastSensorReadMs = nowMs;
  lastDetectionWindowMs = nowMs;
  lastUploadMs = nowMs;
  lastWifiRetryMs = nowMs;
  lastDhtReadMs = nowMs - 2000; // take first DHT reading soon
  lastPreferencesSaveMs = nowMs;

  Serial.println();
  Serial.println("[READY] Sensor sampling: 1 second | leak check: 60 seconds");
  Serial.println("[READY] Supabase (HTTPS) upload: every 10 seconds");
#if ENABLE_MQTT
  Serial.printf("[READY] MQTT live telemetry: every %lu ms on %s/telemetry\n", MQTT_TELEMETRY_INTERVAL_MS, MQTT_TOPIC_ROOT);
#endif
  Serial.println("[READY] Type HELP in the Serial Monitor for commands.");
  Serial.println("============================================");
}

// ================================================================
// MAIN LOOP
// ================================================================
void loop() {
  const unsigned long nowMs = millis();

  // Reconnect without continuously blocking the main loop.
  if (wifiConfigured && WiFi.status() != WL_CONNECTED &&
      nowMs - lastWifiRetryMs >= WIFI_RETRY_INTERVAL_MS) {
    lastWifiRetryMs = nowMs;
    connectWiFi();
  }
  serviceClock();

  // SENSE: flow and water-level sampling every second.
  if (nowMs - lastSensorReadMs >= SENSOR_INTERVAL_MS) {
    const unsigned long elapsedMs = nowMs - lastSensorReadMs;
    lastSensorReadMs = nowMs;
    readFlowAndLevelSensors(elapsedMs);
    updateNighttimeMonitoring(latestIntervalVolume1Liters);
  }

  readDHTIfDue();

  // PROCESS: compare the total volume passing the two sensors once per minute.
  if (nowMs - lastDetectionWindowMs >= DETECTION_WINDOW_MS) {
    lastDetectionWindowMs = nowMs;
    processDetectionWindow();
  }

  // INGEST + STORE: upload a reading every 10 seconds (once a minute while uploads keep
  // failing). Flow counting continues in the ISRs.
  const unsigned long uploadIntervalMs =
      consecutiveUploadFailures >= 3 ? SLOW_UPLOAD_INTERVAL_MS : SUPABASE_UPLOAD_INTERVAL_MS;
  if (wifiConfigured && WiFi.status() == WL_CONNECTED &&
      nowMs - lastUploadMs >= uploadIntervalMs) {
    lastUploadMs = nowMs;
    sendDataToSupabase();
  }

  // INGEST (live): MQTT telemetry, status and valve commands.
  mqttService();

  // STORE: send one waiting alert, after the sensing and the valve have had their turn.
  flushAlertQueue();

  // Move to a new day first, then save the daily total so it survives resets and power cuts.
  checkForNewDay();
  if (nowMs - lastPreferencesSaveMs >= PREFERENCES_SAVE_INTERVAL_MS) {
    lastPreferencesSaveMs = nowMs;
    saveDailyTotal();
  }

  handleSerialCommands();
  updateBuzzer();
  delay(5);
}
