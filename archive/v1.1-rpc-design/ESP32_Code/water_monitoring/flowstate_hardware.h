// Sensors, valve, buzzer and flash storage. Call these from the main loop only.
#pragma once

#include <Arduino.h>

#include "flowstate_logic.h"

// Flash storage (valve position and learned baseline). Call first.
void storage_begin();

// Flow sensors
void flow_sensors_begin();
void flow_take_pulses(uint32_t &sensor1, uint32_t &sensor2);  // pulses since the previous call

// Tank level: smoothed height in cm; raw_adc receives the averaged ADC value.
float water_level_read_cm(int &raw_adc);

// Humidity: false while there is no valid reading from the last minute.
void humidity_begin();
bool humidity_read(uint32_t now_ms, float &percent);

// Valve: restores the saved position at start-up; every move is saved.
void valve_begin();
bool valve_is_open();
void valve_move(bool open);

// Alarm buzzer (short-short-long pattern)
void buzzer_begin();
void buzzer_start(uint32_t now_ms);
void buzzer_stop();
bool buzzer_is_on();
void buzzer_update(uint32_t now_ms);

// Usage baseline kept in flash so learning survives restarts
void baseline_load(flowstate::BaselineState &state);
void baseline_save(const flowstate::BaselineState &state);

// Leak lockout (valve closed by leak protection) kept in flash, so a restart
// does not make a closed valve look like a normal manual close.
bool leak_lockout_load(float &loss_percent);
void leak_lockout_save(bool active, float loss_percent);
