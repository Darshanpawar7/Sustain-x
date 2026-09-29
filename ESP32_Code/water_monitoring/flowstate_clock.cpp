#include "flowstate_clock.h"

#include <RTClib.h>
#include <Wire.h>
#include <esp_sntp.h>
#include <sys/time.h>

#include "flowstate_config.h"

namespace {

const time_t kEarliestValidTime = 1704067200;  // 2024-01-01 00:00 UTC
const uint32_t kRtcWriteIntervalMs = 3600000;   // save internet time to the RTC at most hourly

RTC_DS3231 rtc;
bool rtc_present = false;
bool set_from_rtc = false;
bool set_from_internet = false;
bool rtc_written = false;
uint32_t last_rtc_write_ms = 0;

}  // namespace

void clock_begin() {
  setenv("TZ", TIMEZONE, 1);
  tzset();

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  rtc_present = rtc.begin(&Wire);
  if (!rtc_present) {
    Serial.println("[TIME] DS3231 not found; waiting for internet time");
    return;
  }
  if (rtc.lostPower()) {
    Serial.println("[TIME] RTC lost power; waiting for internet time");
    return;
  }

  DateTime now = rtc.now();
  if (now.year() < 2024 || now.year() > 2099) {
    Serial.println("[TIME] RTC time looks wrong; waiting for internet time");
    return;
  }

  timeval tv;
  tv.tv_sec = static_cast<time_t>(now.unixtime());
  tv.tv_usec = 0;
  settimeofday(&tv, nullptr);
  set_from_rtc = true;
  Serial.println("[TIME] Clock started from the RTC");
}

bool clock_is_valid() { return time(nullptr) > kEarliestValidTime; }

bool clock_local_time(struct tm &out) {
  if (!clock_is_valid()) return false;
  time_t now = time(nullptr);
  localtime_r(&now, &out);
  return true;
}

int32_t clock_day_key(const struct tm &t) {
  return (t.tm_year + 1900) * 10000 + (t.tm_mon + 1) * 100 + t.tm_mday;
}

void clock_update() {
  // Reports "completed" once after each internet time sync (about hourly).
  if (sntp_get_sync_status() != SNTP_SYNC_STATUS_COMPLETED) return;

  time_t now = time(nullptr);
  if (now <= kEarliestValidTime) return;
  if (!set_from_internet) Serial.println("[TIME] Internet time received");
  set_from_internet = true;

  // Guard against writing on every call, whatever the SNTP status does.
  if (!rtc_present) return;
  if (rtc_written && millis() - last_rtc_write_ms < kRtcWriteIntervalMs) return;
  rtc.adjust(DateTime(static_cast<uint32_t>(now)));
  rtc_written = true;
  last_rtc_write_ms = millis();
}

const char *clock_source() {
  if (set_from_internet) return "internet";
  if (set_from_rtc) return "RTC";
  return "unknown";
}
