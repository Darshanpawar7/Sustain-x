// ================================================================
// PROCESS: leak check, night watch, usage learning, valve and buzzer
// ================================================================
// Edge processing: the ESP32 decides on its own, without the cloud, so a
// critical leak closes the valve even when Wi-Fi is down.

// ---------------- WINDOW-BASED LEAK DETECTION ----------------
// Every 60 s: loss = (litres through sensor 1 - litres through sensor 2) / sensor 1.
void processDetectionWindow() {
  const float volume1 = windowVolume1Liters;
  const float volume2 = windowVolume2Liters;
  const float volume1Ml = volume1 * 1000.0f;

  state.percentageLoss = flowstate::lossPercent(volume1, volume2, MIN_WINDOW_VOLUME_LITERS);

  const String previousStatus = state.leakStatus;
  const flowstate::LeakLevel level = flowstate::classifyLoss(
      state.percentageLoss, NORMAL_LOSS_THRESHOLD_PERCENT, WARNING_LOSS_THRESHOLD_PERCENT);
  state.leakStatus = flowstate::leakLevelName(level);

  Serial.printf("[DETECTION] 60s volume S1: %.3f L | S2: %.3f L | loss: %.1f%% | status: %s\n",
                volume1, volume2, state.percentageLoss, state.leakStatus.c_str());

  // Only alert on a status transition, not every minute while the same condition persists.
  if (state.leakStatus != previousStatus && level != flowstate::LEAK_NORMAL) {
    logAlert(level == flowstate::LEAK_CRITICAL ? "CRITICAL_LEAK" : "LEAK_WARNING",
             "Flow difference detected. Sensor 1: " + String(volume1, 3) +
             " L, Sensor 2: " + String(volume2, 3) +
             " L, estimated loss: " + String(state.percentageLoss, 1) + "%.");
  }

  if (level == flowstate::LEAK_CRITICAL && AUTO_CLOSE_ON_CRITICAL_LEAK &&
      !manualValveOverride && state.valveState == 1) {
    closeValve("Critical flow difference detected");
  }

  if (clockReady()) {
    const DateTime now = localNow();
    checkAnomaly(now.hour(), volume1Ml);
    if (!baselineInitialized) updateBaseline(now.hour(), volume1Ml);
  }

  // Begin a fresh one-minute comparison window.
  windowVolume1Liters = 0.0f;
  windowVolume2Liters = 0.0f;
}

// ---------------- NIGHTTIME LEAK MONITORING (2 AM - 5 AM) ----------------
// Nobody should be using water at this time, so steady flow points to a hidden leak.
void updateNighttimeMonitoring(float newVolumeLiters) {
  if (!clockReady()) return;

  const DateTime now = localNow();
  const bool inNightWindow = flowstate::isNightHour(now.hour(), NIGHT_START_HOUR, NIGHT_END_HOUR);
  if (!inNightWindow) {
    if (state.nighttimeFlowActive) {
      Serial.printf("[NIGHT] Flow event ended. Duration: %lu seconds | Volume: %.3f L\n",
                    (millis() - state.nighttimeFlowStartMs) / 1000UL,
                    state.nighttimeVolumeLiters);
    }
    state.nighttimeFlowActive = false;
    state.nighttimeVolumeLiters = 0.0f;
    state.nighttimeLeakStatus = "Normal";
    nightAlertSent = false;
    nightCriticalSent = false;
    nightVolumeAlertSent = false;
    return;
  }

  const unsigned long nowMs = millis();
  const bool flowDetected = (state.flowRate1Lpm >= MIN_FLOW_FOR_DETECTION_LPM);

  if (flowDetected) {
    if (!state.nighttimeFlowActive) {
      state.nighttimeFlowActive = true;
      state.nighttimeFlowStartMs = nowMs;
      state.nighttimeVolumeLiters = 0.0f;
      state.nighttimeLeakStatus = "Alert";
      nightAlertSent = false;
      nightCriticalSent = false;
      nightVolumeAlertSent = false;
      Serial.println("[NIGHT] Water flow started during the 2 AM-5 AM monitoring window.");
      logAlert("NIGHTTIME_FLOW_START", "Water flow detected during the 2 AM-5 AM window.");
    }

    state.nighttimeLastFlowMs = nowMs;
    state.nighttimeVolumeLiters += newVolumeLiters;
  }

  if (!state.nighttimeFlowActive) return;

  // Allow short gaps between pulses; declare the flow event ended after 5 seconds.
  if (!flowDetected && nowMs - state.nighttimeLastFlowMs > NIGHT_FLOW_GAP_TOLERANCE_MS) {
    Serial.printf("[NIGHT] Flow stopped. Duration: %lu seconds | Volume: %.3f L\n",
                  (nowMs - state.nighttimeFlowStartMs) / 1000UL,
                  state.nighttimeVolumeLiters);
    if (state.nighttimeVolumeLiters > 0.1f) {
      logAlert("NIGHTTIME_FLOW_ENDED",
               "Nighttime flow event ended. Volume: " + String(state.nighttimeVolumeLiters, 3) + " L.");
    }
    state.nighttimeFlowActive = false;
    state.nighttimeLeakStatus = "Normal";
    return;
  }

  const unsigned long durationMs = nowMs - state.nighttimeFlowStartMs;
  if (durationMs >= NIGHT_ALERT_DURATION_MS && !nightAlertSent) {
    nightAlertSent = true;
    state.nighttimeLeakStatus = "Alert";
    logAlert("NIGHTTIME_LEAK_ALERT", "Continuous nighttime flow has lasted at least 5 minutes.");
    Serial.println("[NIGHT] ALERT: continuous flow for 5 minutes.");
  }

  if (durationMs >= NIGHT_CRITICAL_DURATION_MS && !nightCriticalSent) {
    nightCriticalSent = true;
    state.nighttimeLeakStatus = "Critical";
    logAlert("NIGHTTIME_LEAK_CRITICAL", "Continuous nighttime flow has lasted at least 10 minutes.");
    Serial.println("[NIGHT] CRITICAL: continuous flow for 10 minutes.");
    if (!manualValveOverride && state.valveState == 1) {
      closeValve("Critical nighttime flow");
    }
  }

  if (state.nighttimeVolumeLiters >= NIGHT_VOLUME_ALERT_LITERS && !nightVolumeAlertSent) {
    nightVolumeAlertSent = true;
    if (state.nighttimeLeakStatus != "Critical") state.nighttimeLeakStatus = "Alert";
    logAlert("NIGHTTIME_EXCESSIVE_VOLUME",
             "Nighttime water volume exceeded 0.5 L. Measured: " +
             String(state.nighttimeVolumeLiters, 3) + " L.");
    Serial.println("[NIGHT] ALERT: nighttime volume exceeded 0.5 L.");
  }
}

// ---------------- ANOMALY BASELINE (LIGHTWEIGHT, RAM-BASED LEARNING) ----------------
void initializeBaseline() {
  for (uint8_t h = 0; h < 24; h++) {
    hourlyBaseline[h].averageWindowMl = 500.0f;
    hourlyBaseline[h].sampleCount = 0;
  }
  baselineDaysSeen = 0;
  baselineInitialized = false;
}

void updateBaseline(uint8_t hour, float windowMl) {
  if (hour >= 24 || baselineInitialized) return;
  HourBaseline &b = hourlyBaseline[hour];
  b.averageWindowMl = flowstate::updateHourAverage(b.averageWindowMl, b.sampleCount, windowMl);
  if (b.sampleCount < 100) b.sampleCount++;

  const uint32_t dateKey = makeDateKey(localNow());
  if (dateKey != lastBaselineDateKey) {
    lastBaselineDateKey = dateKey;
    if (baselineDaysSeen < 255) baselineDaysSeen++;
    if (baselineDaysSeen >= BASELINE_DAYS_REQUIRED) {
      baselineInitialized = true;
      state.anomalyStatus = "Normal";
      Serial.println("[BASELINE] Three dates observed. Basic anomaly checks are now active.");
    }
  }
}

void checkAnomaly(uint8_t hour, float windowMl) {
  if (!baselineInitialized || hour >= 24) {
    state.anomalyStatus = "Learning";
    return;
  }

  const float expectedMl = hourlyBaseline[hour].averageWindowMl;
  const bool anomaly = flowstate::isUsageAnomaly(expectedMl, windowMl, 100.0f, 1.5f);
  state.anomalyStatus = anomaly ? "Anomaly Detected" : "Normal";

  if (anomaly && (!anomalyAlertSentThisHour || lastAnomalyAlertHour != hour)) {
    anomalyAlertSentThisHour = true;
    lastAnomalyAlertHour = hour;
    logAlert("USAGE_ANOMALY", "Water usage exceeded the learned baseline for hour " + String(hour) + ".");
  }
  if (!anomaly) anomalyAlertSentThisHour = false;
}

// ---------------- VALVE + BUZZER (ACTUATORS) ----------------
void openValve() {
  valveServo.write(SERVO_OPEN_ANGLE);
  state.valveState = 1;
  Serial.println("[VALVE] OPEN command sent to servo.");
  stopBuzzer();
  logAlert("VALVE_OPENED", "Valve opened manually/by command.");
}

void closeValve(const String& reason) {
  valveServo.write(SERVO_CLOSED_ANGLE);
  state.valveState = 0;
  Serial.println("[VALVE] CLOSED command sent to servo. Reason: " + reason);
  soundBuzzer();
  logAlert("VALVE_CLOSED", reason);
}

void soundBuzzer() {
  buzzerActive = true;
  buzzerStage = 1;
  buzzerStageStartedMs = millis();
  digitalWrite(BUZZER_PIN, HIGH);
  Serial.println("[BUZZER] Alarm pattern started (short-short-long).");
}

void stopBuzzer() {
  buzzerActive = false;
  buzzerStage = 0;
  digitalWrite(BUZZER_PIN, LOW);
}

void updateBuzzer() {
  if (!buzzerActive) return;
  const unsigned long nowMs = millis();
  const unsigned long elapsed = nowMs - buzzerStageStartedMs;

  switch (buzzerStage) {
    case 1: // short beep ON
      if (elapsed >= BUZZER_SHORT_MS) {
        digitalWrite(BUZZER_PIN, LOW);
        buzzerStage = 2;
        buzzerStageStartedMs = nowMs;
      }
      break;
    case 2: // short gap
      if (elapsed >= BUZZER_GAP_MS) {
        digitalWrite(BUZZER_PIN, HIGH);
        buzzerStage = 3;
        buzzerStageStartedMs = nowMs;
      }
      break;
    case 3: // second short beep ON
      if (elapsed >= BUZZER_SHORT_MS) {
        digitalWrite(BUZZER_PIN, LOW);
        buzzerStage = 4;
        buzzerStageStartedMs = nowMs;
      }
      break;
    case 4: // gap before long beep
      if (elapsed >= BUZZER_GAP_MS) {
        digitalWrite(BUZZER_PIN, HIGH);
        buzzerStage = 5;
        buzzerStageStartedMs = nowMs;
      }
      break;
    case 5: // long beep ON
      if (elapsed >= BUZZER_LONG_MS) {
        digitalWrite(BUZZER_PIN, LOW);
        buzzerStage = 6;
        buzzerStageStartedMs = nowMs;
      }
      break;
    case 6: // cycle pause
      if (elapsed >= BUZZER_CYCLE_PAUSE_MS) {
        digitalWrite(BUZZER_PIN, HIGH);
        buzzerStage = 1;
        buzzerStageStartedMs = nowMs;
      }
      break;
    default:
      stopBuzzer();
      break;
  }
}
