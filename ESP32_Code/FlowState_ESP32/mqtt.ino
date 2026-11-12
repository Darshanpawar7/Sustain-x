// ================================================================
// INGEST (live): MQTT telemetry, online status and signed valve commands
// ================================================================
// MQTT is a publish/subscribe protocol: the ESP32 keeps ONE connection open to
// a broker and publishes small messages to "topics"; the dashboard subscribes
// to the same topics over WebSockets. Topics (root = MQTT_TOPIC_ROOT):
//   <root>/telemetry  ESP32 -> every 2 s, live readings (QoS 0)
//   <root>/status     ESP32 -> "online" (retained); the broker publishes the
//                     Last Will "offline" if the ESP32 drops off without saying goodbye
//   <root>/alert      ESP32 -> alerts the moment they happen
//   <root>/cmd        dashboard -> ESP32, signed valve commands (QoS 1)
//   <root>/ack        ESP32 -> result of each command
//   <root>/ping       dashboard -> ESP32;  <root>/pong  ESP32 -> dashboard (round-trip time)
//
// Signed commands: the public broker lets anyone publish, so a command only
// counts if it carries an HMAC-SHA256 signature made with VALVE_COMMAND_KEY over
// "<root>|<action>|<timestamp ms>|<nonce>". The device also rejects commands
// more than 5 minutes old and any command not newer than the last one (replays).

#if ENABLE_MQTT

// HMAC-SHA256 of message with key, as 64 lowercase hex characters.
bool hmacSha256Hex(const char* key, const char* message, char* outHex) {
  uint8_t mac[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  if (mbedtls_md_hmac(info, (const unsigned char*)key, strlen(key),
                      (const unsigned char*)message, strlen(message), mac) != 0) {
    return false;
  }
  flowstate::toHex(mac, sizeof(mac), outHex);
  return true;
}

void publishStatus() {
  StaticJsonDocument<256> doc;
  doc["state"] = "online";
  doc["fw"] = FIRMWARE_VERSION;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["since"] = epochNow();
  doc["reconnects"] = mqttReconnects;
  char buffer[256];
  serializeJson(doc, buffer, sizeof(buffer));
  mqtt.publish(topicStatus.c_str(), buffer, true);  // retained: new viewers see it at once
}

void publishAck(const char* nonce, const char* action, bool ok, const char* text) {
  StaticJsonDocument<256> doc;
  doc["nonce"] = nonce;
  doc["action"] = action;
  doc["ok"] = ok;
  doc["msg"] = text;
  doc["valve"] = state.valveState;
  doc["auto"] = manualValveOverride ? 0 : 1;
  char buffer[256];
  serializeJson(doc, buffer, sizeof(buffer));
  mqtt.publish(topicAck.c_str(), buffer);
}

void rejectCommand(const char* nonce, const char* action, flowstate::CommandCheck check) {
  const char* reason = flowstate::commandCheckText(check);
  Serial.printf("[MQTT] Valve command rejected: %s\n", reason);
  publishAck(nonce, action, false, reason);
}

// Checks a command. Valid ones are run from mqttService(), outside the callback.
void handleCommandMessage(const char* message) {
  StaticJsonDocument<384> doc;
  if (deserializeJson(doc, message)) {
    rejectCommand("", "", flowstate::CMD_BAD_FORMAT);
    return;
  }
  const char* action = doc["action"] | "";
  const char* nonce = doc["nonce"] | "";
  const char* signature = doc["sig"] | "";
  const uint64_t timestampMs = doc["ts"] | (uint64_t)0;

  if (!flowstate::isUsableKey(VALVE_COMMAND_KEY)) return rejectCommand(nonce, action, flowstate::CMD_NO_KEY);
  if (!flowstate::isValveAction(action)) return rejectCommand(nonce, action, flowstate::CMD_BAD_ACTION);
  if (!flowstate::isValidNonce(nonce) || strlen(signature) != 64 || timestampMs == 0) {
    return rejectCommand(nonce, action, flowstate::CMD_BAD_FORMAT);
  }

  char signedText[160];
  char expected[65];
  if (!flowstate::commandMessage(signedText, sizeof(signedText), MQTT_TOPIC_ROOT, action, timestampMs, nonce) ||
      !hmacSha256Hex(VALVE_COMMAND_KEY, signedText, expected)) {
    return rejectCommand(nonce, action, flowstate::CMD_BAD_FORMAT);
  }
  if (!flowstate::constantTimeEquals(expected, signature)) {
    return rejectCommand(nonce, action, flowstate::CMD_BAD_SIGNATURE);
  }

  const flowstate::CommandCheck timing = flowstate::checkCommandTiming(
      clockReady(), timestampMs, epochNow(), lastCommandTimestampMs, COMMAND_MAX_CLOCK_SKEW_S);
  if (timing != flowstate::CMD_OK) return rejectCommand(nonce, action, timing);

  lastCommandTimestampMs = timestampMs;
  strncpy(pendingAction, action, sizeof(pendingAction) - 1);
  pendingAction[sizeof(pendingAction) - 1] = '\0';
  strncpy(pendingNonce, nonce, sizeof(pendingNonce) - 1);
  pendingNonce[sizeof(pendingNonce) - 1] = '\0';
  commandPending = true;
}

// PubSubClient reuses its buffer, so the message is copied before anything else is sent.
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char message[320];
  if (length >= sizeof(message)) {
    Serial.println("[MQTT] Message too long; ignored.");
    return;
  }
  memcpy(message, payload, length);
  message[length] = '\0';

  if (topicPing == topic) {
    StaticJsonDocument<96> doc;
    if (!deserializeJson(doc, message)) {
      pendingPongId = doc["id"] | 0L;
      pongPending = true;
    }
  } else if (topicCommand == topic) {
    handleCommandMessage(message);
  }
}

void mqttSetup() {
  const String root = String(MQTT_TOPIC_ROOT);
  topicTelemetry = root + "/telemetry";
  topicStatus = root + "/status";
  topicAlert = root + "/alert";
  topicCommand = root + "/cmd";
  topicAck = root + "/ack";
  topicPing = root + "/ping";
  topicPong = root + "/pong";
#if MQTT_USE_TLS
  mqttNet.setInsecure();          // encrypted, but the broker certificate is not checked (prototype)
  mqttNet.setHandshakeTimeout(10);  // seconds
#endif
  // A blocked port must not freeze the sensor loop: the library waits 30 s by default.
  mqttNet.setConnectionTimeout(5000);  // milliseconds
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(5);
}

bool mqttIsConnected() {
  return mqtt.connected();
}

void mqttConnectIfNeeded() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  const unsigned long nowMs = millis();
  if (lastMqttAttemptMs != 0 && nowMs - lastMqttAttemptMs < mqttRetryDelayMs) return;
  lastMqttAttemptMs = nowMs;

  // The whole 48-bit MAC, so two boards on the same public broker never share an ID.
  char clientId[32];
  const uint64_t mac = ESP.getEfuseMac();
  snprintf(clientId, sizeof(clientId), "flowstate-%04x%08lx",
           (unsigned)((mac >> 32) & 0xFFFFU), (unsigned long)(mac & 0xFFFFFFFFUL));
  const char* user = strlen(MQTT_USERNAME) > 0 ? MQTT_USERNAME : nullptr;
  const char* pass = strlen(MQTT_PASSWORD) > 0 ? MQTT_PASSWORD : nullptr;

  Serial.printf("[MQTT] Connecting to %s:%u ...\n", MQTT_HOST, MQTT_PORT);
  const unsigned long startedMs = millis();
  // Last Will: if this connection dies, the broker itself tells everyone we are offline.
  if (!mqtt.connect(clientId, user, pass, topicStatus.c_str(), 1, true, "{\"state\":\"offline\"}")) {
    Serial.printf("[MQTT] Failed (state %d) after %lu ms. Next try in %lu s. HTTPS uploads continue.\n",
                  mqtt.state(), millis() - startedMs, mqttRetryDelayMs / 1000UL);
    // Back off (5 s, 10 s, ... up to 2 min) so a blocked port does not keep stalling the loop.
    mqttRetryDelayMs = mqttRetryDelayMs >= 60000UL ? 120000UL : mqttRetryDelayMs * 2;
    return;
  }
  mqttRetryDelayMs = 5000;
  mqttReconnects++;
  Serial.printf("[MQTT] Connected in %lu ms as %s\n", millis() - startedMs, clientId);
  publishStatus();
  mqtt.subscribe(topicCommand.c_str(), 1);
  mqtt.subscribe(topicPing.c_str(), 0);
}

void publishTelemetry() {
  StaticJsonDocument<512> doc;
  doc["seq"] = ++telemetrySeq;          // lets the dashboard count lost messages
  doc["ts"] = epochNow();
  doc["f1"] = roundf(state.flowRate1Lpm * 100.0f) / 100.0f;
  doc["f2"] = roundf(state.flowRate2Lpm * 100.0f) / 100.0f;
  doc["loss"] = roundf(state.percentageLoss * 10.0f) / 10.0f;
  doc["lvl"] = roundf(state.waterLevelCm * 10.0f) / 10.0f;
  doc["valve"] = state.valveState;
  doc["auto"] = manualValveOverride ? 0 : 1;
  doc["leak"] = state.leakStatus;
  doc["anom"] = state.anomalyStatus;
  doc["night"] = state.nighttimeLeakStatus;
  doc["total"] = roundf((float)state.dailyTotalLiters * 1000.0f) / 1000.0f;
  if (!isnan(state.humidityPercent)) doc["hum"] = roundf(state.humidityPercent * 10.0f) / 10.0f;
  if (!isnan(state.temperatureC)) doc["temp"] = roundf(state.temperatureC * 10.0f) / 10.0f;
  doc["rssi"] = WiFi.RSSI();
  doc["up"] = millis() / 1000UL;
  doc["heap"] = ESP.getFreeHeap();
  doc["upms"] = lastUploadDurationMs;
  doc["hfail"] = httpFailures;

  char buffer[448];
  const size_t length = serializeJson(doc, buffer, sizeof(buffer));
  if (length == 0 || length >= sizeof(buffer) - 1) return;
  mqtt.publish(topicTelemetry.c_str(), buffer);
}

void mqttPublishAlert(const String& alertType, const String& message, const char* severity) {
  if (!mqtt.connected()) return;
  StaticJsonDocument<448> doc;
  doc["alert_type"] = alertType;
  doc["message"] = message;
  doc["severity"] = severity;
  doc["ts"] = epochNow();
  char buffer[448];
  const size_t length = serializeJson(doc, buffer, sizeof(buffer));
  if (length > 0 && length < sizeof(buffer) - 1) mqtt.publish(topicAlert.c_str(), buffer);
}

void executePendingCommand() {
  if (!commandPending) return;
  commandPending = false;
  const char* text;
  if (strcmp(pendingAction, "open") == 0) {
    manualValveOverride = true;
    openValve();
    text = "Valve opened. Automatic closing is paused until you choose Auto.";
  } else if (strcmp(pendingAction, "close") == 0) {
    manualValveOverride = true;
    closeValve("Closed from the dashboard (signed MQTT command)");
    text = "Valve closed.";
  } else {
    manualValveOverride = false;
    text = "Automatic protection is on again.";
    Serial.println("[CONTROL] Automatic valve control re-enabled from the dashboard.");
  }
  Serial.printf("[MQTT] Valve command '%s' done.\n", pendingAction);
  publishAck(pendingNonce, pendingAction, true, text);
}

void mqttService() {
  if (!wifiConfigured) return;
  mqttConnectIfNeeded();
  if (!mqtt.connected()) return;
  mqtt.loop();

  if (pongPending) {
    pongPending = false;
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "{\"id\":%ld,\"up\":%lu}", pendingPongId, millis() / 1000UL);
    mqtt.publish(topicPong.c_str(), buffer);
  }
  executePendingCommand();

  const unsigned long nowMs = millis();
  if (nowMs - lastTelemetryMs >= MQTT_TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = nowMs;
    publishTelemetry();
  }
}

#else  // MQTT switched off: these do nothing, and HTTPS works exactly as before.

void mqttSetup() {}
void mqttService() {}
bool mqttIsConnected() { return false; }
void mqttPublishAlert(const String& alertType, const String& message, const char* severity) {
  (void)alertType;
  (void)message;
  (void)severity;
}

#endif
