// Host-side unit tests for ESP32_Code/water_monitoring/flowstate_logic.h.
// Build and run with any C++11 compiler, for example:
//   g++ -std=c++11 -Wall -Wextra -I ESP32_Code/water_monitoring tests/firmware/flowstate_logic_test.cpp -o logic_test && ./logic_test

#include <cmath>
#include <cstdio>
#include <cstring>

#include "flowstate_logic.h"

using namespace flowstate;

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(condition)                                                     \
  do {                                                                       \
    g_checks++;                                                              \
    if (!(condition)) {                                                      \
      g_failures++;                                                          \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition);    \
    }                                                                        \
  } while (0)

#define CHECK_NEAR(actual, expected, tolerance) CHECK(std::fabs((actual) - (expected)) <= (tolerance))

static LeakSettings default_leak_settings() {
  LeakSettings settings = {450.0f, 450.0f, 5.0f, 15.0f, 200.0f, 60.0f, 5, 3, 5};
  return settings;
}

static NightSettings default_night_settings() {
  NightSettings settings = {2, 5, 50.0f, 5, 10, 10.0f};
  return settings;
}

static BaselineSettings default_baseline_settings() {
  BaselineSettings settings = {3, 0.3f, 0.1f, 1.5f, 5.0f, 50};
  return settings;
}

static void test_unit_conversions() {
  std::puts("unit conversions");
  CHECK_NEAR(pulses_to_ml(450, 450.0f), 1000.0f, 0.001f);
  CHECK_NEAR(pulses_to_ml(1, 450.0f), 2.2222f, 0.001f);
  CHECK_NEAR(pulses_to_lpm(75, 10000, 450.0f), 1.0f, 0.001f);
  CHECK(pulses_to_lpm(10, 0, 450.0f) == 0.0f);
  CHECK(pulses_to_ml(10, 0.0f) == 0.0f);
}

static void test_loss_percent() {
  std::puts("loss percent");
  CHECK_NEAR(loss_percent(1000.0f, 900.0f, 200.0f), 10.0f, 0.001f);
  CHECK(loss_percent(150.0f, 0.0f, 200.0f) == 0.0f);   // too little flow to judge
  CHECK(loss_percent(1000.0f, 1100.0f, 200.0f) == 0.0f);  // downstream reads more: not a leak
  CHECK(loss_percent(NAN, 10.0f, 200.0f) == 0.0f);
  CHECK(loss_percent(1000.0f, -50.0f, 200.0f) == 100.0f);
}

static void test_classification() {
  std::puts("classification");
  CHECK(classify_loss(4.99f, 5.0f, 15.0f) == LeakLevel::Normal);
  CHECK(classify_loss(5.0f, 5.0f, 15.0f) == LeakLevel::Warning);
  CHECK(classify_loss(15.0f, 5.0f, 15.0f) == LeakLevel::Warning);
  CHECK(classify_loss(15.01f, 5.0f, 15.0f) == LeakLevel::Critical);
  CHECK(std::strcmp(leak_level_name(LeakLevel::Critical), "Critical") == 0);
}

static void test_water_level() {
  std::puts("water level");
  CHECK_NEAR(adc_to_level_cm(4095, 4095, 1000, 100), 0.0f, 0.001f);    // dry sensor = empty tank
  CHECK_NEAR(adc_to_level_cm(1000, 4095, 1000, 100), 100.0f, 0.001f);  // submerged = full tank
  CHECK_NEAR(adc_to_level_cm(2547.5f, 4095, 1000, 100), 50.0f, 0.01f);
  CHECK_NEAR(adc_to_level_cm(4095, 1000, 4095, 100), 100.0f, 0.001f);  // sensor that reads higher when wet
  CHECK_NEAR(adc_to_level_cm(500, 4095, 1000, 100), 100.0f, 0.001f);   // clamped
  CHECK(adc_to_level_cm(100, 100, 100, 100) == 0.0f);                  // bad calibration does not divide by zero
}

static void test_sustained_condition() {
  std::puts("sustained condition");
  SustainedCondition condition(3);
  CHECK(!condition.update(true));
  CHECK(!condition.update(true));
  CHECK(condition.update(true));   // fires on the third in a row
  CHECK(!condition.update(true));  // only once
  CHECK(condition.active());
  CHECK(!condition.update(false));
  CHECK(!condition.active());
  CHECK(!condition.update(true));  // streak starts again
}

// The old firmware closed the valve when one second showed >15 % loss above
// 0.5 L/min. At that flow a one-pulse difference is already 25 %.
static void test_single_pulse_jitter_does_not_trigger() {
  std::puts("one-pulse jitter never closes the valve");
  LeakDetector low_flow(default_leak_settings());
  for (int second = 0; second < 180; ++second) {
    uint32_t sensor2 = (second % 2 == 0) ? 3 : 5;  // sensor 1 counts 4; sensor 2 wobbles by one pulse
    LeakAssessment result = low_flow.update(4, sensor2);
    CHECK(result.trigger == LeakTrigger::None);
    CHECK(result.level != LeakLevel::Critical);
  }

  LeakDetector medium_flow(default_leak_settings());
  for (int second = 0; second < 180; ++second) {
    uint32_t sensor2 = (second % 2 == 0) ? 9 : 11;
    LeakAssessment result = medium_flow.update(10, sensor2);
    CHECK(result.trigger == LeakTrigger::None);
    CHECK(result.level == LeakLevel::Normal);
  }
}

static void test_sudden_leak_triggers_fast() {
  std::puts("a sudden 30 % leak closes the valve within seconds");
  LeakDetector detector(default_leak_settings());
  int triggered_at = -1;
  for (int second = 1; second <= 20; ++second) {
    LeakAssessment result = detector.update(10, 7);
    if (result.trigger != LeakTrigger::None) {
      CHECK(result.trigger == LeakTrigger::Fast);
      CHECK(result.level == LeakLevel::Critical);
      CHECK(result.loss_percent > 25.0f);
      if (triggered_at < 0) triggered_at = second;
      else CHECK(false);  // must fire only once
    }
  }
  CHECK(triggered_at > 0 && triggered_at <= 6);
}

static void test_slow_leak_triggers_window() {
  std::puts("a slow 50 % leak is caught by the 60 s window");
  LeakDetector detector(default_leak_settings());
  int triggered_at = -1;
  LeakTrigger trigger = LeakTrigger::None;
  for (int second = 1; second <= 90; ++second) {
    LeakAssessment result = detector.update(2, 1);  // about 0.27 L/min, too slow for the fast check
    if (result.trigger != LeakTrigger::None && triggered_at < 0) {
      triggered_at = second;
      trigger = result.trigger;
    }
  }
  CHECK(trigger == LeakTrigger::Window);
  CHECK(triggered_at > 40 && triggered_at <= 60);
}

static void test_moderate_loss_is_warning() {
  std::puts("a 10 % loss is a warning, not critical");
  LeakDetector detector(default_leak_settings());
  LeakAssessment result = {0.0f, LeakLevel::Normal, LeakTrigger::None};
  for (int second = 0; second < 60; ++second) {
    result = detector.update(10, 9);
    CHECK(result.trigger == LeakTrigger::None);
  }
  CHECK(result.level == LeakLevel::Warning);
  CHECK_NEAR(result.loss_percent, 10.0f, 0.01f);
  CHECK_NEAR(detector.average_lpm_1(5), 1.3333f, 0.001f);
}

static void test_detector_reset() {
  std::puts("reset forgets old leak data");
  LeakDetector detector(default_leak_settings());
  for (int second = 0; second < 10; ++second) detector.update(10, 5);
  detector.reset();
  LeakAssessment result = detector.update(0, 0);
  CHECK(result.level == LeakLevel::Normal);
  CHECK(result.loss_percent == 0.0f);
  CHECK(detector.average_lpm_1(5) == 0.0f);
}

static void test_night_watch() {
  std::puts("night watch");
  NightSettings settings = default_night_settings();

  NightWatch daytime(settings);
  CHECK(daytime.update_minute(true, 14, 5000.0f) == NIGHT_NONE);

  NightWatch unknown_time(settings);
  CHECK(unknown_time.update_minute(false, 3, 5000.0f) == NIGHT_NONE);

  NightWatch flush(settings);  // one toilet flush at 3 AM is not a leak
  CHECK(flush.update_minute(true, 3, 6000.0f) == NIGHT_FLOW_STARTED);
  CHECK(flush.update_minute(true, 3, 0.0f) == NIGHT_FLOW_ENDED);

  NightWatch leak(settings);
  int alerts = 0;
  int criticals = 0;
  for (int minute = 1; minute <= 12; ++minute) {
    uint8_t events = leak.update_minute(true, 3, 300.0f);
    if (minute == 1) CHECK(events & NIGHT_FLOW_STARTED);
    if (events & NIGHT_FLOW_ALERT) {
      alerts++;
      CHECK(minute == 5);
    }
    if (events & NIGHT_FLOW_CRITICAL) {
      criticals++;
      CHECK(minute == 10);
    }
    CHECK(!(events & NIGHT_EXCESS_VOLUME));
  }
  CHECK(alerts == 1);
  CHECK(criticals == 1);
  CHECK(std::strcmp(leak.status(), "Critical") == 0);
  CHECK(leak.update_minute(true, 3, 0.0f) & NIGHT_FLOW_ENDED);
  CHECK(leak.ended_minutes() == 12);
  CHECK_NEAR(leak.ended_liters(), 3.6f, 0.001f);
  CHECK(std::strcmp(leak.status(), "Normal") == 0);

  NightWatch heavy(settings);
  heavy.update_minute(true, 2, 4000.0f);
  heavy.update_minute(true, 2, 4000.0f);
  CHECK(heavy.update_minute(true, 2, 4000.0f) & NIGHT_EXCESS_VOLUME);
  CHECK(!(heavy.update_minute(true, 2, 4000.0f) & NIGHT_EXCESS_VOLUME));  // once per event

  CHECK(hour_in_window(23, 23, 5));
  CHECK(hour_in_window(2, 23, 5));
  CHECK(!hour_in_window(12, 23, 5));
  CHECK(!hour_in_window(5, 2, 5));
}

static void feed_hour(HourlyBaseline &baseline, int32_t day, uint8_t hour, float liters_per_minute, int minutes) {
  for (int minute = 0; minute < minutes; ++minute) baseline.add_minute(day, hour, liters_per_minute);
}

static void test_baseline() {
  std::puts("usage baseline");
  BaselineSettings settings = default_baseline_settings();
  BaselineState state;
  baseline_state_reset(state);
  HourlyBaseline baseline(settings, state);

  CHECK(baseline.status() == AnomalyStatus::Learning);
  int32_t days[] = {20260101, 20260102, 20260103};
  for (int d = 0; d < 3; ++d) {
    for (uint8_t hour = 0; hour < 24; ++hour) feed_hour(baseline, days[d], hour, 0.1f, 60);
  }
  feed_hour(baseline, 20260104, 0, 0.1f, 60);  // finishes the last hour of day 3
  CHECK(baseline.learned());
  CHECK(state.days_learned >= 3);
  CHECK_NEAR(state.hourly_liters[5], 6.0f, 0.01f);
  CHECK(!baseline.take_new_anomaly());

  // Hour 1 of day 4 uses 20 L, far above the usual 6 L.
  feed_hour(baseline, 20260104, 1, 20.0f / 60.0f, 60);
  feed_hour(baseline, 20260104, 2, 0.1f, 1);  // starting hour 2 finishes hour 1
  CHECK(baseline.status() == AnomalyStatus::Anomaly);
  CHECK(baseline.take_new_anomaly());
  CHECK(!baseline.take_new_anomaly());  // reported once
  CHECK(baseline.last_hour() == 1);
  CHECK_NEAR(baseline.last_hour_liters(), 20.0f, 0.05f);
  CHECK(state.hourly_liters[1] < 8.0f);  // learns slowly from unusual hours

  feed_hour(baseline, 20260104, 2, 0.1f, 59);
  feed_hour(baseline, 20260104, 3, 0.1f, 1);
  CHECK(baseline.status() == AnomalyStatus::Normal);

  // A partial hour (device restarted) is ignored.
  float before = state.hourly_liters[4];
  feed_hour(baseline, 20260104, 4, 5.0f, 10);
  feed_hour(baseline, 20260104, 5, 0.1f, 1);
  CHECK(state.hourly_liters[4] == before);

  BaselineState old_format = state;
  old_format.version = 1;
  HourlyBaseline migrated(settings, old_format);
  CHECK(!migrated.learned());
  CHECK(old_format.version == kBaselineVersion);
}

static void test_daily_totals() {
  std::puts("daily totals reset at midnight");
  DailyTotals totals;
  CHECK(!totals.add(10, 9, false, 0));         // time unknown: keep counting
  CHECK(!totals.add(10, 9, true, 20260105));   // first valid day: no reset
  CHECK(totals.pulses1() == 20);
  CHECK(totals.add(5, 5, true, 20260106));     // new day
  CHECK(totals.pulses1() == 5);
  CHECK(totals.pulses2() == 5);
}

static void test_alarm_pattern() {
  std::puts("alarm pattern");
  CHECK(alarm_pattern_on(0));
  CHECK(!alarm_pattern_on(250));
  CHECK(alarm_pattern_on(450));
  CHECK(!alarm_pattern_on(700));
  CHECK(alarm_pattern_on(1000));
  CHECK(!alarm_pattern_on(1500));
  CHECK(!alarm_pattern_on(2500));
  CHECK(alarm_pattern_on(3000));
}

int main() {
  test_unit_conversions();
  test_loss_percent();
  test_classification();
  test_water_level();
  test_sustained_condition();
  test_single_pulse_jitter_does_not_trigger();
  test_sudden_leak_triggers_fast();
  test_slow_leak_triggers_window();
  test_moderate_loss_is_warning();
  test_detector_reset();
  test_night_watch();
  test_baseline();
  test_daily_totals();
  test_alarm_pattern();

  std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
