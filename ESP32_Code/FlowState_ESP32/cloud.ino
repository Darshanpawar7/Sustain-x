// ================================================================
// INGEST + STORE: Wi-Fi, clock and HTTPS uploads to Supabase
// ================================================================
// Readings go to Supabase's REST API (PostgREST) as JSON over HTTPS. The TLS
// connection is kept open between uploads, so most uploads skip the handshake.

// ---------------- WI-FI ----------------
bool credentialsConfigured() {
  const String ssid = String(WIFI_SSID);
  const String password = String(WIFI_PASSWORD);
  const String url = String(SUPABASE_URL);
  const String key = String(SUPABASE_ANON_KEY);
  return ssid.length() > 0 && password.length() > 0 &&
         ssid != "YOUR_WIFI_NAME" && password != "YOUR_WIFI_PASSWORD" &&
         url.startsWith("https://") && url.indexOf("YOUR_PROJECT") < 0 &&
         key.length() > 20 && key.indexOf("YOUR_SUPABASE") < 0;
}

void connectWiFi() {
  if (!wifiConfigured) return;
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("[WiFi] Connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const unsigned long startMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startMs < 10000UL) {
    delay(250);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    state.systemOnline = true;
    Serial.println();
    Serial.printf("[WiFi] Connected. IP: %s | signal: %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    startNtp();
  } else {
    state.systemOnline = false;
    Serial.println("\n[WiFi] Connection failed; will retry automatically.");
  }
}

// ---------------- CLOCK: DS3231 + INTERNET TIME (NTP) ----------------
// The DS3231 keeps India time even without power. When Wi-Fi is up, internet
// time (NTP) corrects it; without a DS3231, internet time is used directly.
void startNtp() {
  configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);  // the ESP32 clock runs in UTC
  ntpRequested = true;
}

// Called from loop(): notices when internet time has arrived, without waiting for it.
void serviceClock() {
  if (!ntpRequested || ntpSynced) return;
  const time_t nowUtc = time(nullptr);
  if (nowUtc < 1700000000) return;  // not set yet (before November 2023)
  ntpSynced = true;
  if (rtcAvailable) {
    const DateTime ntpLocal((uint32_t)(nowUtc + IST_OFFSET_SECONDS));
    const int32_t drift = (int32_t)(rtc.now().unixtime() - ntpLocal.unixtime());
    if (drift > 2 || drift < -2) {
      rtc.adjust(ntpLocal);
      Serial.printf("[NTP] DS3231 was %ld s off; corrected from internet time.\n", (long)drift);
    } else {
      Serial.println("[NTP] Internet time matches the DS3231.");
    }
  } else {
    Serial.println("[NTP] Clock set from internet time.");
  }
}

bool clockReady() {
  return rtcAvailable || ntpSynced;
}

// Local (India) wall-clock time.
DateTime localNow() {
  if (rtcAvailable) return rtc.now();
  if (ntpSynced) return DateTime((uint32_t)(time(nullptr) + IST_OFFSET_SECONDS));
  return DateTime(2000, 1, 1, 0, 0, 0);
}

// Seconds since 1970 in UTC, used to check that valve commands are recent.
uint32_t epochNow() {
  if (ntpSynced) return (uint32_t)time(nullptr);
  if (rtcAvailable) return rtc.now().unixtime() - IST_OFFSET_SECONDS;
  return 0;
}

uint32_t makeDateKey(const DateTime& now) {
  return (uint32_t)now.year() * 10000UL + (uint32_t)now.month() * 100UL + now.day();
}

String currentTimestamp() {
  if (!clockReady()) return "";
  const DateTime now = localNow();
  char buffer[32];
  snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02d+05:30",
           now.year(), now.month(), now.day(), now.hour(), now.minute(), now.second());
  return String(buffer);
}

// ---------------- SUPABASE (HTTPS REST) ----------------
// POSTs JSON to a Supabase table. A dropped keep-alive connection fails with a
// negative code; then the connection is reopened and the upload tried once more.
int postJson(const char* table, const String& payload) {
  const String url = String(SUPABASE_URL) + "/rest/v1/" + table;
  int code = -1;
  for (uint8_t attempt = 0; attempt < 2; attempt++) {
    HTTPClient http;
    http.setReuse(true);
    if (!http.begin(secureClient, url)) {
      code = -1;
    } else {
      http.setTimeout(7000);
      http.setConnectTimeout(7000);
      http.addHeader("Content-Type", "application/json");
      http.addHeader("apikey", SUPABASE_ANON_KEY);
      http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
      http.addHeader("Prefer", "return=minimal");
      code = http.POST(payload);
      if (code >= 300) Serial.println(http.getString());
      http.end();
    }
    if (code > 0) break;
    secureClient.stop();  // start the next attempt on a fresh connection
  }
  return code;
}

void sendDataToSupabase() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!clockReady()) {
    Serial.println("[Supabase] Skipping upload: the clock is not set yet (no DS3231 and no internet time).");
    return;
  }

  StaticJsonDocument<768> doc;
  doc["timestamp"] = currentTimestamp();
  doc["flow_rate_1"] = roundf(state.flowRate1Lpm * 100.0f) / 100.0f;
  doc["flow_rate_2"] = roundf(state.flowRate2Lpm * 100.0f) / 100.0f;
  doc["percentage_loss"] = roundf(state.percentageLoss * 10.0f) / 10.0f;
  doc["water_level"] = roundf(state.waterLevelCm * 100.0f) / 100.0f;
  doc["valve_state"] = state.valveState;
  doc["leak_status"] = state.leakStatus;
  doc["anomaly_status"] = state.anomalyStatus;
  doc["system_online"] = state.systemOnline ? 1 : 0;
  doc["daily_total_liters"] = state.dailyTotalLiters;
  if (!isnan(state.humidityPercent)) doc["humidity"] = roundf(state.humidityPercent * 10.0f) / 10.0f;
  if (!isnan(state.temperatureC)) doc["temperature"] = roundf(state.temperatureC * 10.0f) / 10.0f;
  // Connectivity health, shown on the dashboard's performance panel.
  doc["wifi_rssi"] = WiFi.RSSI();
  doc["uptime_s"] = millis() / 1000UL;
  doc["free_heap"] = ESP.getFreeHeap();
  doc["upload_ms"] = lastUploadDurationMs;
  doc["http_failures"] = httpFailures;
  doc["mqtt_connected"] = mqttIsConnected() ? 1 : 0;

  String payload;
  serializeJson(doc, payload);

  const unsigned long startedMs = millis();
  const int code = postJson(SUPABASE_READINGS_TABLE, payload);
  lastUploadDurationMs = millis() - startedMs;
  uploadsSent++;
  if (code < 200 || code >= 300) httpFailures++;
  Serial.printf("[Supabase] water_readings HTTP %d in %lu ms (%u bytes)\n",
                code, (unsigned long)lastUploadDurationMs, (unsigned)payload.length());
}

void logAlert(const String& alertType, const String& message) {
  const char* severity = (alertType.indexOf("CRITICAL") >= 0) ? "high" : "medium";
  mqttPublishAlert(alertType, message, severity);  // instant, when MQTT is connected

  if (WiFi.status() != WL_CONNECTED || !clockReady() || !wifiConfigured) {
    Serial.println("[Alert] Not uploaded (Wi-Fi/clock/configuration unavailable): " + alertType);
    return;
  }

  StaticJsonDocument<512> doc;
  doc["timestamp"] = currentTimestamp();
  doc["alert_type"] = alertType;
  doc["message"] = message;
  doc["severity"] = severity;

  String payload;
  serializeJson(doc, payload);
  const int code = postJson(SUPABASE_ALERTS_TABLE, payload);
  Serial.printf("[Alert] %s | HTTP %d\n", alertType.c_str(), code);
}

// ---------------- PERSISTENT DAILY TOTAL ----------------
void saveDailyTotal() {
  if (!preferencesReady) return;
  preferences.putDouble("dailyL", state.dailyTotalLiters);
  if (clockReady() && storedDateKey != 0) {
    storedDateKey = makeDateKey(localNow());
    preferences.putUInt("datekey", storedDateKey);
  }
}

void checkForNewDay() {
  if (!clockReady() || !preferencesReady) return;
  const uint32_t todayKey = makeDateKey(localNow());

  if (storedDateKey == 0) {
    // No DS3231: the date is known only now that internet time has arrived.
    storedDateKey = todayKey;
    if (savedDateKeyAtBoot != todayKey) {
      state.dailyTotalLiters = 0.0;
      Serial.println("[TOTAL] Saved total is from another day; today's total starts at 0 L.");
    }
    preferences.putUInt("datekey", storedDateKey);
    preferences.putDouble("dailyL", state.dailyTotalLiters);
    return;
  }

  if (todayKey != storedDateKey) {
    state.dailyTotalLiters = 0.0;
    storedDateKey = todayKey;
    preferences.putUInt("datekey", storedDateKey);
    preferences.putDouble("dailyL", 0.0);
    Serial.println("[TOTAL] Midnight/date change detected. Daily total reset to 0 L.");
  }
}
