// ================================================================
// SERIAL MONITOR COMMANDS AND STATUS (115200 baud, "Newline" line ending)
// ================================================================

void printHelp() {
  Serial.println("Commands:");
  Serial.println("  STATUS         readings, valve, clock, Wi-Fi, MQTT and upload health");
  Serial.println("  VALVE_OPEN     open the valve (pauses automatic closing)");
  Serial.println("  VALVE_CLOSE    close the valve");
  Serial.println("  VALVE_TOGGLE   switch the valve");
  Serial.println("  OVERRIDE_ON    pause automatic closing");
  Serial.println("  OVERRIDE_OFF   turn automatic closing back on");
  Serial.println("  BUZZER_ON / BUZZER_OFF");
  Serial.println("  RESET_TOTAL    set today's total to 0 L");
  Serial.println("  KEY_CHECK      fingerprint of the valve key, to compare with the dashboard");
}

void printKeyFingerprint() {
#if ENABLE_MQTT
  if (!flowstate::isUsableKey(VALVE_COMMAND_KEY)) {
    Serial.println("[KEY] No valve key set: put a random key of 16+ characters in secrets.h.");
    return;
  }
  char hex[65];
  if (hmacSha256Hex(VALVE_COMMAND_KEY, "flowstate-key-check", hex)) {
    hex[8] = '\0';
    Serial.printf("[KEY] Valve key fingerprint: %s (the dashboard shows the same 8 characters for the right key)\n", hex);
  }
#else
  Serial.println("[KEY] MQTT is switched off (ENABLE_MQTT 0), so valve commands from the dashboard are off too.");
#endif
}

void handleSerialCommands() {
  if (!Serial.available()) return;
  String command = Serial.readStringUntil('\n');
  command.trim();
  command.toUpperCase();

  if (command == "STATUS") {
    printStatus();
  } else if (command == "HELP") {
    printHelp();
  } else if (command == "VALVE_OPEN") {
    manualValveOverride = true;
    openValve();
  } else if (command == "VALVE_CLOSE") {
    manualValveOverride = true;
    closeValve("Manual serial command");
  } else if (command == "VALVE_TOGGLE") {
    manualValveOverride = true;
    if (state.valveState) closeValve("Manual toggle command");
    else openValve();
  } else if (command == "OVERRIDE_ON") {
    manualValveOverride = true;
    Serial.println("[CONTROL] Manual override ON. Automatic valve closure is disabled.");
  } else if (command == "OVERRIDE_OFF") {
    manualValveOverride = false;
    Serial.println("[CONTROL] Manual override OFF. Automatic valve control is enabled.");
  } else if (command == "BUZZER_ON") {
    soundBuzzer();
  } else if (command == "BUZZER_OFF") {
    stopBuzzer();
    Serial.println("[BUZZER] Off.");
  } else if (command == "RESET_TOTAL") {
    state.dailyTotalLiters = 0.0;
    saveDailyTotal();
    Serial.println("[TOTAL] Daily total reset to 0 L.");
  } else if (command == "KEY_CHECK") {
    printKeyFingerprint();
  } else if (command.length() > 0) {
    Serial.println("[COMMAND] Unknown command. Type HELP for the list.");
  }
}

void printStatus() {
  Serial.println();
  Serial.println("=============== FLOWSTATE STATUS ===============");
  Serial.printf("Firmware:            v%s (Team 10)\n", FIRMWARE_VERSION);
  Serial.printf("Sensor 1 flow:       %.3f L/min\n", state.flowRate1Lpm);
  Serial.printf("Sensor 2 flow:       %.3f L/min\n", state.flowRate2Lpm);
  Serial.printf("60s flow loss:       %.1f%%\n", state.percentageLoss);
  Serial.printf("Leak status:         %s\n", state.leakStatus.c_str());
  Serial.printf("Anomaly status:      %s\n", state.anomalyStatus.c_str());
  Serial.printf("Water level:         %.1f cm (%d%%)\n", state.waterLevelCm, state.waterLevelPercent);
  if (!isnan(state.temperatureC)) Serial.printf("Temperature:         %.1f C\n", state.temperatureC);
  if (!isnan(state.humidityPercent)) Serial.printf("Humidity:            %.1f%%\n", state.humidityPercent);
  Serial.printf("Daily total (S1):    %.3f L\n", state.dailyTotalLiters);
  Serial.printf("Valve:               %s\n", state.valveState ? "OPEN" : "CLOSED");
  Serial.printf("Manual override:     %s\n", manualValveOverride ? "ON" : "OFF");
  Serial.printf("Night leak status:   %s\n", state.nighttimeLeakStatus.c_str());
  Serial.printf("Clock:               %s%s\n", rtcAvailable ? "DS3231" : "no DS3231",
                ntpSynced ? " + internet time" : (clockReady() ? "" : " (NOT SET)"));
  if (clockReady()) Serial.printf("Time now:            %s\n", currentTimestamp().c_str());
  Serial.printf("Wi-Fi:               %s", WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED");
  if (WiFi.status() == WL_CONNECTED) Serial.printf(" (%d dBm)", WiFi.RSSI());
  Serial.println();
  Serial.printf("Supabase uploads:    %lu sent, %lu failed, last took %lu ms\n",
                (unsigned long)uploadsSent, (unsigned long)httpFailures, (unsigned long)lastUploadDurationMs);
#if ENABLE_MQTT
  Serial.printf("MQTT:                %s to %s:%u, %lu messages, %lu connections\n",
                mqtt.connected() ? "CONNECTED" : "DISCONNECTED", MQTT_HOST, MQTT_PORT,
                (unsigned long)telemetrySeq, (unsigned long)mqttReconnects);
  Serial.printf("MQTT topics:         %s/...\n", MQTT_TOPIC_ROOT);
#else
  Serial.println("MQTT:                switched off (ENABLE_MQTT 0)");
#endif
  Serial.printf("Free memory:         %lu bytes\n", (unsigned long)ESP.getFreeHeap());
  Serial.println("Type HELP for commands.");
  Serial.println("=================================================");
}
