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
// POSTs JSON to a Supabase table. The TLS connection is kept open between
// uploads; if the server has closed it in the meantime, sending fails at once,
// and then the upload is tried once more on a fresh connection. Anything else
// (a read timeout, a slow network) is not retried: the row may already be stored.
int postJson(const char* table, const String& payload) {
  const String url = String(SUPABASE_URL) + "/rest/v1/" + table;
  int code = HTTPC_ERROR_CONNECTION_REFUSED;
  for (uint8_t attempt = 0; attempt < 2; attempt++) {
    const unsigned long startedMs = millis();
    HTTPClient http;
    http.setReuse(true);
    if (!http.begin(secureClient, url)) {
      code = HTTPC_ERROR_CONNECTION_REFUSED;
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
    secureClient.stop();  // never reuse a connection that just failed
    const bool sendFailed = code == HTTPC_ERROR_SEND_HEADER_FAILED || code == HTTPC_ERROR_SEND_PAYLOAD_FAILED ||
                            code == HTTPC_ERROR_NOT_CONNECTED || code == HTTPC_ERROR_CONNECTION_LOST;
    if (!sendFailed || millis() - startedMs > 3000UL) break;
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
  if (code >= 200 && code < 300) {
    consecutiveUploadFailures = 0;
  } else {
    httpFailures++;
    if (consecutiveUploadFailures < 255) consecutiveUploadFailures++;
    if (consecutiveUploadFailures == 3) {
      Serial.println("[Supabase] Three uploads failed in a row; trying once a minute until one works.");
    }
  }
  Serial.printf("[Supabase] water_readings HTTP %d in %lu ms (%u bytes)\n",
                code, (unsigned long)lastUploadDurationMs, (unsigned)payload.length());
}

// Sends the alert over MQTT at once and queues its HTTPS upload, so nothing
// here waits for the network: callers can close the valve straight after.
void logAlert(const String& alertType, const String& message) {
  const char* severity = (alertType.indexOf("CRITICAL") >= 0) ? "high" : "medium";
  mqttPublishAlert(alertType, message, severity);  // instant, when MQTT is connected
  if (!wifiConfigured) {
    Serial.println("[Alert] Not uploaded (Wi-Fi not configured): " + alertType);
    return;
  }
  if (alertQueueCount == ALERT_QUEUE_SIZE) {
    Serial.println("[Alert] Upload queue full; dropping the oldest: " + alertQueue[alertQueueStart].type);
    alertQueueStart = (alertQueueStart + 1) % ALERT_QUEUE_SIZE;
    alertQueueCount--;
  }
  QueuedAlert& slot = alertQueue[(alertQueueStart + alertQueueCount) % ALERT_QUEUE_SIZE];
  slot.type = alertType;
  slot.message = message;
  slot.severity = severity;
  slot.timestamp = currentTimestamp();  // empty while the clock is not set; filled in when sent
  alertQueueCount++;
}

// Uploads at most one waiting alert per loop pass. After a network failure it
// waits 15 s before trying again; an alert the database refuses (4xx) is dropped.
void flushAlertQueue() {
  if (alertQueueCount == 0 || WiFi.status() != WL_CONNECTED || !clockReady()) return;
  if (millis() - alertWaitStartMs < alertWaitMs) return;

  QueuedAlert& alert = alertQueue[alertQueueStart];
  StaticJsonDocument<512> doc;
  doc["timestamp"] = alert.timestamp.length() > 0 ? alert.timestamp : currentTimestamp();
  doc["alert_type"] = alert.type;
  doc["message"] = alert.message;
  doc["severity"] = alert.severity;

  String payload;
  serializeJson(doc, payload);
  const int code = postJson(SUPABASE_ALERTS_TABLE, payload);
  Serial.printf("[Alert] %s | HTTP %d\n", alert.type.c_str(), code);
  if (code > 0 && code < 500) {
    alertQueueStart = (alertQueueStart + 1) % ALERT_QUEUE_SIZE;
    alertQueueCount--;
    alertWaitMs = 0;
  } else {
    alertWaitStartMs = millis();
    alertWaitMs = 15000UL;
  }
}

// ---------------- PERSISTENT DAILY TOTAL ----------------
// Saves the total under the date it belongs to. Only checkForNewDay() moves
// that date on, so a save at midnight cannot skip the reset.
void saveDailyTotal() {
  if (!preferencesReady) return;
  preferences.putDouble("dailyL", state.dailyTotalLiters);
  if (storedDateKey != 0) preferences.putUInt("datekey", storedDateKey);
}

void checkForNewDay() {
  if (!clockReady()) return;
  const uint32_t todayKey = makeDateKey(localNow());

  if (storedDateKey == 0) {
    // No DS3231: the date is known only now that internet time has arrived.
    storedDateKey = todayKey;
    if (savedDateKeyAtBoot != todayKey) {
      state.dailyTotalLiters = 0.0;
      Serial.println("[TOTAL] Saved total is from another day; today's total starts at 0 L.");
    }
    if (preferencesReady) {
      preferences.putUInt("datekey", storedDateKey);
      preferences.putDouble("dailyL", state.dailyTotalLiters);
    }
    return;
  }

  if (todayKey != storedDateKey) {
    state.dailyTotalLiters = 0.0;
    storedDateKey = todayKey;
    if (preferencesReady) {
      preferences.putUInt("datekey", storedDateKey);
      preferences.putDouble("dailyL", 0.0);
    }
    Serial.println("[TOTAL] Midnight/date change detected. Daily total reset to 0 L.");
  }
}
