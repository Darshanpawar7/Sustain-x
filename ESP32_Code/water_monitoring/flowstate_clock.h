// Time keeping. The DS3231 RTC holds UTC; internet time (NTP) corrects it, and
// TIMEZONE in flowstate_config.h turns it into local time. Main loop only.
#pragma once

#include <Arduino.h>
#include <time.h>

void clock_begin();                          // sets the time zone and starts the clock from the RTC
bool clock_is_valid();                       // true once the time can be trusted
bool clock_local_time(struct tm &out);       // false while the time is unknown
int32_t clock_day_key(const struct tm &t);   // yyyymmdd, e.g. 20260929
void clock_update();                         // saves fresh internet time into the RTC
const char *clock_source();                  // "internet", "RTC" or "unknown"
