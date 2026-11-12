// ================================================================
// SENSE: flow-sensor interrupts, water level and the DHT22
// ================================================================
// Each YF-S201 gives about 450 pulses per litre. Every falling edge runs an
// interrupt that counts one pulse; once a second the main loop takes the counts
// and turns them into litres and litres per minute.

void IRAM_ATTR flowSensor1ISR() {
  const uint32_t nowUs = micros();
  portENTER_CRITICAL_ISR(&flowMux);
  if ((uint32_t)(nowUs - lastPulseMicros1) >= FLOW_DEBOUNCE_US) {
    flowPulseCount1 = flowPulseCount1 + 1;
    lastPulseMicros1 = nowUs;
  }
  portEXIT_CRITICAL_ISR(&flowMux);
}

void IRAM_ATTR flowSensor2ISR() {
  const uint32_t nowUs = micros();
  portENTER_CRITICAL_ISR(&flowMux);
  if ((uint32_t)(nowUs - lastPulseMicros2) >= FLOW_DEBOUNCE_US) {
    flowPulseCount2 = flowPulseCount2 + 1;
    lastPulseMicros2 = nowUs;
  }
  portEXIT_CRITICAL_ISR(&flowMux);
}

void readFlowAndLevelSensors(unsigned long elapsedMs) {
  uint32_t pulses1 = 0;
  uint32_t pulses2 = 0;

  // Take a consistent snapshot and reset counters atomically.
  portENTER_CRITICAL(&flowMux);
  pulses1 = flowPulseCount1;
  pulses2 = flowPulseCount2;
  flowPulseCount1 = 0;
  flowPulseCount2 = 0;
  portEXIT_CRITICAL(&flowMux);

  if (elapsedMs == 0) elapsedMs = 1;

  // Exact pulse-based volume: 450 accepted pulses = approximately 1 litre.
  const float litres1 = pulses1 / FLOW_PULSES_PER_LITER;
  const float litres2 = pulses2 / FLOW_PULSES_PER_LITER;
  latestIntervalVolume1Liters = litres1;

  // L/min = litres during this interval * 60,000 / interval milliseconds.
  state.flowRate1Lpm = litres1 * 60000.0f / elapsedMs;
  state.flowRate2Lpm = litres2 * 60000.0f / elapsedMs;

  // Accumulate actual pulse-derived volume, not rounded flow-rate estimates.
  windowVolume1Liters += litres1;
  windowVolume2Liters += litres2;
  state.dailyTotalLiters += litres1; // daily total uses Sensor 1 (tank-side)

  const int adcValue = analogRead(WATER_LEVEL_PIN);
  const long mappedPercent = map(adcValue, WATER_LEVEL_IN_AIR, WATER_LEVEL_IN_WATER, 0, 100);
  const long mappedCm = map(adcValue, WATER_LEVEL_IN_AIR, WATER_LEVEL_IN_WATER, 0, (long)TANK_HEIGHT_CM);
  state.waterLevelPercent = constrain((int)mappedPercent, 0, 100);
  state.waterLevelCm = constrain((float)mappedCm, 0.0f, TANK_HEIGHT_CM);
  state.systemOnline = true;

  Serial.printf("[FLOW] S1: %lu pulses, %.2f L/min, total today %.3f L | ",
                (unsigned long)pulses1, state.flowRate1Lpm, state.dailyTotalLiters);
  Serial.printf("S2: %lu pulses, %.2f L/min | ",
                (unsigned long)pulses2, state.flowRate2Lpm);
  Serial.printf("[LEVEL] ADC %d, %d%%, %.1f cm | Valve: %s\n",
                adcValue, state.waterLevelPercent, state.waterLevelCm,
                state.valveState ? "OPEN" : "CLOSED");

  if (state.flowRate1Lpm > 30.0f || state.flowRate2Lpm > 30.0f) {
    Serial.println("[FLOW WARNING] Reading exceeds the YF-S201 nominal 30 L/min range. Check wiring/noise and verify with a measured-volume test.");
  }
}

void readDHTIfDue() {
  const unsigned long nowMs = millis();
  if (nowMs - lastDhtReadMs < 2000) return; // the DHT needs at least ~2 seconds between reads
  lastDhtReadMs = nowMs;

  const float humidity = dht.readHumidity();
  const float temperature = dht.readTemperature();
  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("[DHT] Read failed. Check VCC, GND and data wire on GPIO 4.");
    return;
  }

  state.humidityPercent = humidity;
  state.temperatureC = temperature;
  Serial.printf("[DHT] Temperature: %.1f C | Humidity: %.1f%%\n",
                state.temperatureC, state.humidityPercent);
}
