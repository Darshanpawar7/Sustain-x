// Pure detection logic for FlowState: no Arduino or hardware calls, so it can
// be unit-tested on a PC (see tests/firmware). Written for C++11 so it builds
// on both the 2.x and 3.x ESP32 Arduino cores.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace flowstate {

// ---------------------------------------------------------------------------
// Unit conversions
// ---------------------------------------------------------------------------
inline float pulses_to_ml(uint32_t pulses, float pulses_per_liter) {
  if (pulses_per_liter <= 0.0f) return 0.0f;
  return static_cast<float>(pulses) * 1000.0f / pulses_per_liter;
}

// Average flow in L/min for `pulses` counted over `elapsed_ms`.
inline float pulses_to_lpm(uint32_t pulses, uint32_t elapsed_ms, float pulses_per_liter) {
  if (elapsed_ms == 0 || pulses_per_liter <= 0.0f) return 0.0f;
  return (static_cast<float>(pulses) / pulses_per_liter) * (60000.0f / static_cast<float>(elapsed_ms));
}

// Share of the upstream volume that never reached the downstream sensor, in
// percent. Returns 0 when too little water has flowed to judge fairly.
inline float loss_percent(float upstream_ml, float downstream_ml, float min_upstream_ml) {
  if (!(upstream_ml >= min_upstream_ml) || upstream_ml <= 0.0f) return 0.0f;
  float loss = (upstream_ml - downstream_ml) / upstream_ml * 100.0f;
  if (!(loss > 0.0f)) return 0.0f;  // also rejects NaN
  return loss > 100.0f ? 100.0f : loss;
}

// Maps a raw ADC reading onto 0..tank_height_cm. Works whichever way round the
// sensor reads (higher or lower when wet).
inline float adc_to_level_cm(float adc, float adc_in_air, float adc_in_water, float tank_height_cm) {
  float span = adc_in_water - adc_in_air;
  if (span == 0.0f) return 0.0f;
  float fraction = (adc - adc_in_air) / span;
  if (!(fraction > 0.0f)) fraction = 0.0f;
  if (fraction > 1.0f) fraction = 1.0f;
  return fraction * tank_height_cm;
}

// ---------------------------------------------------------------------------
// Leak classification
// ---------------------------------------------------------------------------
enum class LeakLevel : uint8_t { Normal, Warning, Critical };

inline const char *leak_level_name(LeakLevel level) {
  switch (level) {
    case LeakLevel::Warning: return "Warning";
    case LeakLevel::Critical: return "Critical";
    default: return "Normal";
  }
}

// Normal below warning_from, Warning from warning_from up to critical_above,
// Critical above critical_above.
inline LeakLevel classify_loss(float loss, float warning_from, float critical_above) {
  if (loss > critical_above) return LeakLevel::Critical;
  if (loss >= warning_from) return LeakLevel::Warning;
  return LeakLevel::Normal;
}

// Keeps the last N one-second pulse counts for both flow sensors.
template <size_t N>
class PulseWindow {
 public:
  PulseWindow() : head_(0), count_(0) { clear(); }

  void push(uint32_t sensor1, uint32_t sensor2) {
    sensor1_[head_] = sensor1;
    sensor2_[head_] = sensor2;
    head_ = (head_ + 1) % N;
    if (count_ < N) count_++;
  }

  void clear() {
    for (size_t i = 0; i < N; ++i) {
      sensor1_[i] = 0;
      sensor2_[i] = 0;
    }
    head_ = 0;
    count_ = 0;
  }

  size_t size() const { return count_; }
  uint32_t sum1(size_t seconds) const { return sum(sensor1_, seconds); }
  uint32_t sum2(size_t seconds) const { return sum(sensor2_, seconds); }

 private:
  uint32_t sum(const uint32_t *values, size_t seconds) const {
    if (seconds > count_) seconds = count_;
    uint32_t total = 0;
    for (size_t i = 1; i <= seconds; ++i) total += values[(head_ + N - i) % N];
    return total;
  }

  uint32_t sensor1_[N];
  uint32_t sensor2_[N];
  size_t head_;
  size_t count_;
};

// Becomes active once a condition has held for `required` updates in a row.
class SustainedCondition {
 public:
  explicit SustainedCondition(uint16_t required) : required_(required ? required : 1), streak_(0), active_(false) {}

  // Returns true only on the update where the condition first becomes active.
  bool update(bool condition) {
    if (!condition) {
      streak_ = 0;
      active_ = false;
      return false;
    }
    if (streak_ < 0xFFFF) streak_++;
    if (!active_ && streak_ >= required_) {
      active_ = true;
      return true;
    }
    return false;
  }

  bool active() const { return active_; }
  void reset() {
    streak_ = 0;
    active_ = false;
  }

 private:
  uint16_t required_;
  uint16_t streak_;
  bool active_;
};

struct LeakSettings {
  float pulses_per_liter_1;
  float pulses_per_liter_2;
  float warning_from_percent;
  float critical_above_percent;
  float min_window_ml;           // sensor-1 volume needed in the 60 s window before judging
  float min_fast_ml;             // sensor-1 volume needed in the fast window before judging
  uint16_t fast_window_s;        // length of the fast window (<= 60)
  uint16_t fast_consecutive_s;   // seconds the fast check must hold before acting
  uint16_t window_consecutive_s; // seconds the 60 s check must hold before acting
};

enum class LeakTrigger : uint8_t { None, Window, Fast };

struct LeakAssessment {
  float loss_percent;   // what is reported: 60 s loss, or the fast loss while that is active
  LeakLevel level;
  LeakTrigger trigger;  // set only on the second a critical condition begins
};

// Compares the two sensors every second over a sliding 60 s window, plus a
// short window that reacts to sudden large leaks. Requiring a minimum volume
// and several seconds in a row stops single-pulse jitter from closing the valve.
class LeakDetector {
 public:
  static const size_t kWindowSeconds = 60;

  explicit LeakDetector(const LeakSettings &settings)
      : settings_(settings),
        fast_(settings.fast_consecutive_s),
        sustained_(settings.window_consecutive_s) {}

  LeakAssessment update(uint32_t pulses1, uint32_t pulses2) {
    window_.push(pulses1, pulses2);

    float window_loss = loss_over(kWindowSeconds, settings_.min_window_ml);
    float fast_loss = loss_over(settings_.fast_window_s, settings_.min_fast_ml);
    LeakLevel window_level =
        classify_loss(window_loss, settings_.warning_from_percent, settings_.critical_above_percent);

    bool fast_started = fast_.update(fast_loss > settings_.critical_above_percent);
    bool window_started = sustained_.update(window_level == LeakLevel::Critical);

    LeakAssessment result;
    result.loss_percent = window_loss;
    result.level = window_level;
    result.trigger = LeakTrigger::None;

    if (fast_.active()) {
      result.level = LeakLevel::Critical;
      if (fast_loss > result.loss_percent) result.loss_percent = fast_loss;
    }
    if (fast_started) {
      result.trigger = LeakTrigger::Fast;
    } else if (window_started && !fast_.active()) {
      result.trigger = LeakTrigger::Window;
    }
    return result;
  }

  // Average flow of each sensor over the last `seconds` seconds, in L/min.
  float average_lpm_1(size_t seconds) const {
    return average_lpm(window_.sum1(seconds), seconds, settings_.pulses_per_liter_1);
  }
  float average_lpm_2(size_t seconds) const {
    return average_lpm(window_.sum2(seconds), seconds, settings_.pulses_per_liter_2);
  }

  // Forget history, e.g. after the valve has been closed or reopened.
  void reset() {
    window_.clear();
    fast_.reset();
    sustained_.reset();
  }

 private:
  float loss_over(size_t seconds, float min_upstream_ml) const {
    float upstream = pulses_to_ml(window_.sum1(seconds), settings_.pulses_per_liter_1);
    float downstream = pulses_to_ml(window_.sum2(seconds), settings_.pulses_per_liter_2);
    return loss_percent(upstream, downstream, min_upstream_ml);
  }

  float average_lpm(uint32_t pulses, size_t seconds, float pulses_per_liter) const {
    size_t available = window_.size() < seconds ? window_.size() : seconds;
    return pulses_to_lpm(pulses, static_cast<uint32_t>(available * 1000), pulses_per_liter);
  }

  LeakSettings settings_;
  PulseWindow<kWindowSeconds> window_;
  SustainedCondition fast_;
  SustainedCondition sustained_;
};

// ---------------------------------------------------------------------------
// Night watch: any sustained flow during the night window is suspicious
// ---------------------------------------------------------------------------
struct NightSettings {
  uint8_t start_hour;          // inclusive, local time
  uint8_t end_hour;            // exclusive; may wrap past midnight
  float min_minute_ml;         // minute volume that counts as "flowing"
  uint16_t alert_minutes;      // continuous flow before an alert
  uint16_t critical_minutes;   // continuous flow before the valve is closed
  float excess_volume_liters;  // total volume in one event before an alert
};

enum NightEvent : uint8_t {
  NIGHT_NONE = 0,
  NIGHT_FLOW_STARTED = 1 << 0,
  NIGHT_FLOW_ALERT = 1 << 1,
  NIGHT_FLOW_CRITICAL = 1 << 2,
  NIGHT_EXCESS_VOLUME = 1 << 3,
  NIGHT_FLOW_ENDED = 1 << 4,
};

inline bool hour_in_window(uint8_t hour, uint8_t start_hour, uint8_t end_hour) {
  if (start_hour == end_hour) return false;
  if (start_hour < end_hour) return hour >= start_hour && hour < end_hour;
  return hour >= start_hour || hour < end_hour;
}

// Tracks one continuous night-time flow event, minute by minute. Each alert
// fires once per event, never every minute.
class NightWatch {
 public:
  explicit NightWatch(const NightSettings &settings) : settings_(settings) { clear_event(); }

  // Call once a minute. Returns a bitmask of NightEvent values.
  uint8_t update_minute(bool time_valid, uint8_t local_hour, float minute_ml) {
    uint8_t events = NIGHT_NONE;
    bool in_window = time_valid && hour_in_window(local_hour, settings_.start_hour, settings_.end_hour);
    bool flowing = in_window && minute_ml >= settings_.min_minute_ml;

    if (!flowing) {
      if (active_) {
        events |= NIGHT_FLOW_ENDED;
        ended_minutes_ = minutes_;
        ended_liters_ = liters_;
      }
      clear_event();
      return events;
    }

    if (!active_) {
      active_ = true;
      events |= NIGHT_FLOW_STARTED;
    }
    minutes_++;
    liters_ += minute_ml / 1000.0f;

    if (!alert_sent_ && minutes_ >= settings_.alert_minutes) {
      alert_sent_ = true;
      events |= NIGHT_FLOW_ALERT;
    }
    if (!critical_sent_ && minutes_ >= settings_.critical_minutes) {
      critical_sent_ = true;
      events |= NIGHT_FLOW_CRITICAL;
    }
    if (!excess_sent_ && liters_ > settings_.excess_volume_liters) {
      excess_sent_ = true;
      events |= NIGHT_EXCESS_VOLUME;
    }
    return events;
  }

  bool active() const { return active_; }
  uint16_t minutes() const { return minutes_; }
  float liters() const { return liters_; }
  uint16_t ended_minutes() const { return ended_minutes_; }
  float ended_liters() const { return ended_liters_; }

  const char *status() const {
    if (critical_sent_) return "Critical";
    if (alert_sent_ || excess_sent_) return "Alert";
    return active_ ? "Watching" : "Normal";
  }

 private:
  void clear_event() {
    active_ = false;
    minutes_ = 0;
    liters_ = 0.0f;
    alert_sent_ = false;
    critical_sent_ = false;
    excess_sent_ = false;
  }

  NightSettings settings_;
  bool active_;
  uint16_t minutes_;
  float liters_;
  bool alert_sent_;
  bool critical_sent_;
  bool excess_sent_;
  uint16_t ended_minutes_ = 0;
  float ended_liters_ = 0.0f;
};

// ---------------------------------------------------------------------------
// Usage baseline: learns typical litres per hour of the day
// ---------------------------------------------------------------------------
struct BaselineSettings {
  uint8_t days_required;          // distinct days learned before anomaly checks start
  float alpha;                    // learning rate for normal hours
  float alpha_anomalous;          // slower learning for unusual hours
  float anomaly_ratio;            // flag when usage > expected * ratio ...
  float min_excess_liters;        // ... and > expected + this
  uint8_t min_minutes_observed;   // minutes an hour needs before it counts
};

// Saved to flash so learning survives reboots.
struct BaselineState {
  uint32_t version;
  float hourly_liters[24];
  uint8_t observed[24];
  uint16_t days_learned;
  int32_t last_day_key;
};

const uint32_t kBaselineVersion = 2;

inline void baseline_state_reset(BaselineState &state) {
  state.version = kBaselineVersion;
  for (int i = 0; i < 24; ++i) {
    state.hourly_liters[i] = 0.0f;
    state.observed[i] = 0;
  }
  state.days_learned = 0;
  state.last_day_key = 0;
}

enum class AnomalyStatus : uint8_t { Learning, Normal, Anomaly };

inline const char *anomaly_status_name(AnomalyStatus status) {
  switch (status) {
    case AnomalyStatus::Normal: return "Normal";
    case AnomalyStatus::Anomaly: return "Anomaly Detected";
    default: return "Learning";
  }
}

// Collects each clock hour's usage, compares finished hours with what is
// typical for that hour, then learns from them.
class HourlyBaseline {
 public:
  HourlyBaseline(const BaselineSettings &settings, BaselineState &state)
      : settings_(settings),
        state_(state),
        current_day_(0),
        current_hour_(0xFF),
        current_liters_(0.0f),
        current_minutes_(0),
        status_(AnomalyStatus::Learning),
        new_anomaly_(false),
        last_hour_(0),
        last_hour_liters_(0.0f),
        last_expected_liters_(0.0f) {
    if (state_.version != kBaselineVersion) baseline_state_reset(state_);
    if (learned()) status_ = AnomalyStatus::Normal;
  }

  // Call once a minute with a valid local date (yyyymmdd) and hour. Returns
  // true when an hour has just been completed and the state should be saved.
  bool add_minute(int32_t day_key, uint8_t hour, float minute_liters) {
    bool changed = false;
    if (hour > 23) return false;
    if (day_key != current_day_ || hour != current_hour_) {
      if (current_hour_ <= 23) changed = finish_hour();
      current_day_ = day_key;
      current_hour_ = hour;
      current_liters_ = 0.0f;
      current_minutes_ = 0;
    }
    if (minute_liters > 0.0f) current_liters_ += minute_liters;
    if (current_minutes_ < 0xFF) current_minutes_++;
    return changed;
  }

  bool learned() const { return state_.days_learned >= settings_.days_required; }
  AnomalyStatus status() const { return status_; }

  // True once for each hour that was found to be unusual.
  bool take_new_anomaly() {
    bool value = new_anomaly_;
    new_anomaly_ = false;
    return value;
  }

  uint8_t last_hour() const { return last_hour_; }
  float last_hour_liters() const { return last_hour_liters_; }
  float last_expected_liters() const { return last_expected_liters_; }

 private:
  bool finish_hour() {
    if (current_minutes_ < settings_.min_minutes_observed) return false;

    uint8_t hour = current_hour_;
    float expected = state_.hourly_liters[hour];
    bool can_judge = learned() && state_.observed[hour];
    bool anomalous = false;

    if (can_judge) {
      float by_ratio = expected * settings_.anomaly_ratio;
      float by_margin = expected + settings_.min_excess_liters;
      float threshold = by_ratio > by_margin ? by_ratio : by_margin;
      anomalous = current_liters_ > threshold;
      status_ = anomalous ? AnomalyStatus::Anomaly : AnomalyStatus::Normal;
      if (anomalous) new_anomaly_ = true;
    }

    last_hour_ = hour;
    last_hour_liters_ = current_liters_;
    last_expected_liters_ = expected;

    if (!state_.observed[hour]) {
      state_.hourly_liters[hour] = current_liters_;
      state_.observed[hour] = 1;
    } else {
      float alpha = anomalous ? settings_.alpha_anomalous : settings_.alpha;
      state_.hourly_liters[hour] = alpha * current_liters_ + (1.0f - alpha) * expected;
    }

    if (current_day_ != state_.last_day_key) {
      state_.last_day_key = current_day_;
      if (state_.days_learned < 0xFFFF) state_.days_learned++;
    }
    if (!can_judge && learned()) status_ = AnomalyStatus::Normal;
    return true;
  }

  BaselineSettings settings_;
  BaselineState &state_;
  int32_t current_day_;
  uint8_t current_hour_;
  float current_liters_;
  uint8_t current_minutes_;
  AnomalyStatus status_;
  bool new_anomaly_;
  uint8_t last_hour_;
  float last_hour_liters_;
  float last_expected_liters_;
};

// ---------------------------------------------------------------------------
// Daily totals that reset at local midnight
// ---------------------------------------------------------------------------
class DailyTotals {
 public:
  DailyTotals() : day_key_(0), pulses1_(0), pulses2_(0) {}

  // Returns true when a new day started and the totals were reset.
  bool add(uint32_t pulses1, uint32_t pulses2, bool time_valid, int32_t day_key) {
    bool reset = false;
    if (time_valid && day_key != day_key_) {
      if (day_key_ != 0) {
        pulses1_ = 0;
        pulses2_ = 0;
        reset = true;
      }
      day_key_ = day_key;
    }
    pulses1_ += pulses1;
    pulses2_ += pulses2;
    return reset;
  }

  uint32_t pulses1() const { return pulses1_; }
  uint32_t pulses2() const { return pulses2_; }

 private:
  int32_t day_key_;
  uint32_t pulses1_;
  uint32_t pulses2_;
};

// ---------------------------------------------------------------------------
// Alarm pattern: short, short, long, then a pause (3 s cycle)
// ---------------------------------------------------------------------------
inline bool alarm_pattern_on(uint32_t elapsed_ms) {
  static const uint16_t kSteps[] = {200, 200, 200, 200, 600, 600, 1000};
  static const uint32_t kCycleMs = 3000;
  uint32_t t = elapsed_ms % kCycleMs;
  for (size_t i = 0; i < sizeof(kSteps) / sizeof(kSteps[0]); ++i) {
    if (t < kSteps[i]) return (i % 2 == 0) && i < 6;
    t -= kSteps[i];
  }
  return false;
}

}  // namespace flowstate
