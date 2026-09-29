// Networking runs in its own FreeRTOS task, so Wi-Fi drop-outs and slow
// uploads never delay leak detection or valve control in the main loop.
#pragma once

#include <Arduino.h>

enum class AlertSeverity : uint8_t { Low, Medium, High, Critical };

// Latest values handed to the network task every second.
struct ReadingSnapshot {
  float flow_rate_1_lpm;
  float flow_rate_2_lpm;
  float percentage_loss;
  float water_level_cm;
  float humidity_percent;
  bool humidity_valid;
  bool valve_open;
  const char *leak_status;     // must point to a string literal
  const char *anomaly_status;  // must point to a string literal
  float daily_total_liters;
  uint32_t total_pulses_1;     // since start-up; the network task turns these into volumes
  uint32_t total_pulses_2;
};

struct ValveCommand {
  int32_t id;
  bool open;
};

struct CloudStatus {
  bool configured;
  bool wifi_connected;
  int last_http_code;
  uint32_t last_upload_ok_ms;  // millis() of the last successful upload, 0 if none yet
  uint32_t alerts_waiting;
  uint32_t alerts_dropped;
  uint32_t stack_free_bytes;   // least free stack the network task has had; 0 before it starts
};

void cloud_begin();
void cloud_publish(const ReadingSnapshot &snapshot);
void cloud_alert(const char *type, AlertSeverity severity, const char *format, ...)
    __attribute__((format(printf, 3, 4)));
bool cloud_next_command(ValveCommand &command);
CloudStatus cloud_status();
