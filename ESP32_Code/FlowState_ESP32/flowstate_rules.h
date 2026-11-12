// FlowState decision rules as plain functions with no Arduino code, so the
// same rules run on the ESP32 and in the PC tests (tests/firmware).
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace flowstate {

enum LeakLevel { LEAK_NORMAL = 0, LEAK_WARNING = 1, LEAK_CRITICAL = 2 };

// Share (0-100 %) of the water that passed sensor 1 but not sensor 2 in one
// window. Below minVolume litres the comparison is meaningless, so it is 0.
inline float lossPercent(float volume1, float volume2, float minVolume) {
  if (!(volume1 >= minVolume)) return 0.0f;
  const float loss = (volume1 - volume2) / volume1 * 100.0f;
  if (!(loss > 0.0f)) return 0.0f;
  return loss > 100.0f ? 100.0f : loss;
}

inline LeakLevel classifyLoss(float lossPct, float normalBelow, float criticalFrom) {
  if (lossPct < normalBelow) return LEAK_NORMAL;
  if (lossPct < criticalFrom) return LEAK_WARNING;
  return LEAK_CRITICAL;
}

inline const char* leakLevelName(LeakLevel level) {
  switch (level) {
    case LEAK_WARNING: return "Warning";
    case LEAK_CRITICAL: return "Critical";
    default: return "Normal";
  }
}

// True when hour (0-23) is inside [start, end). Works across midnight too.
inline bool isNightHour(uint8_t hour, uint8_t start, uint8_t end) {
  if (start == end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// Learned average for one hour: an exact running mean for the first 100
// samples, then a slow moving average (1 % weight per new sample).
inline float updateHourAverage(float average, uint16_t samples, float value) {
  if (samples == 0) return value;
  const float alpha = samples < 100 ? 1.0f / (samples + 1.0f) : 0.01f;
  return (1.0f - alpha) * average + alpha * value;
}

// Use is unusual when the hour normally sees real use (above minExpectedMl)
// and this window is more than factor x the learned amount.
inline bool isUsageAnomaly(float expectedMl, float windowMl, float minExpectedMl, float factor) {
  return expectedMl > minExpectedMl && windowMl > expectedMl * factor;
}

// ---------------------------------------------------------------------------
// Signed valve commands (see mqtt.ino and the dashboard's valve panel)
// ---------------------------------------------------------------------------
enum CommandCheck {
  CMD_OK = 0,
  CMD_BAD_ACTION,
  CMD_BAD_FORMAT,
  CMD_NO_CLOCK,
  CMD_STALE,
  CMD_REPLAY,
  CMD_BAD_SIGNATURE,
  CMD_NO_KEY
};

inline const char* commandCheckText(CommandCheck check) {
  switch (check) {
    case CMD_OK: return "accepted";
    case CMD_BAD_ACTION: return "unknown action";
    case CMD_BAD_FORMAT: return "badly formed command";
    case CMD_NO_CLOCK: return "device clock not set yet";
    case CMD_STALE: return "command too old or device clock wrong";
    case CMD_REPLAY: return "command already used";
    case CMD_BAD_SIGNATURE: return "wrong valve key";
    case CMD_NO_KEY: return "no valve key set on the device";
    default: return "rejected";
  }
}

inline bool isValveAction(const char* action) {
  return action != nullptr &&
         (strcmp(action, "open") == 0 || strcmp(action, "close") == 0 || strcmp(action, "auto") == 0);
}

// A nonce is 8-32 characters of [0-9a-zA-Z].
inline bool isValidNonce(const char* nonce) {
  if (nonce == nullptr) return false;
  const size_t length = strlen(nonce);
  if (length < 8 || length > 32) return false;
  for (size_t i = 0; i < length; i++) {
    const char c = nonce[i];
    const bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    if (!ok) return false;
  }
  return true;
}

// Commands must be recent (within maxSkewSeconds of the device clock) and
// newer than the last accepted one, so a recorded command cannot be replayed.
inline CommandCheck checkCommandTiming(bool clockReady, uint64_t commandMs, uint64_t deviceEpochSeconds,
                                       uint64_t lastAcceptedMs, uint32_t maxSkewSeconds) {
  if (!clockReady) return CMD_NO_CLOCK;
  const int64_t skew = (int64_t)(commandMs / 1000ULL) - (int64_t)deviceEpochSeconds;
  if (skew > (int64_t)maxSkewSeconds || skew < -(int64_t)maxSkewSeconds) return CMD_STALE;
  if (commandMs <= lastAcceptedMs) return CMD_REPLAY;
  return CMD_OK;
}

// Writes value in decimal; returns the number of characters (out needs 21 bytes).
inline size_t formatUnsigned(uint64_t value, char* out) {
  char reversed[21];
  size_t length = 0;
  do {
    reversed[length++] = (char)('0' + (value % 10ULL));
    value /= 10ULL;
  } while (value > 0 && length < sizeof(reversed));
  for (size_t i = 0; i < length; i++) out[i] = reversed[length - 1 - i];
  out[length] = '\0';
  return length;
}

// The exact text that is signed: "<topic root>|<action>|<timestamp ms>|<nonce>".
// Returns false when it does not fit in out.
inline bool commandMessage(char* out, size_t size, const char* root, const char* action,
                           uint64_t timestampMs, const char* nonce) {
  char digits[21];
  formatUnsigned(timestampMs, digits);
  const size_t needed = strlen(root) + 1 + strlen(action) + 1 + strlen(digits) + 1 + strlen(nonce) + 1;
  if (needed > size) return false;
  out[0] = '\0';
  strcat(out, root);
  strcat(out, "|");
  strcat(out, action);
  strcat(out, "|");
  strcat(out, digits);
  strcat(out, "|");
  strcat(out, nonce);
  return true;
}

inline void toHex(const uint8_t* bytes, size_t length, char* out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < length; i++) {
    out[i * 2] = digits[bytes[i] >> 4];
    out[i * 2 + 1] = digits[bytes[i] & 0x0F];
  }
  out[length * 2] = '\0';
}

// Compares two strings without stopping at the first difference, so the time
// taken does not hint at how much of a guessed signature was right.
inline bool constantTimeEquals(const char* a, const char* b) {
  if (a == nullptr || b == nullptr) return false;
  const size_t lengthA = strlen(a);
  const size_t lengthB = strlen(b);
  unsigned char difference = lengthA != lengthB ? 1 : 0;
  const size_t shorter = lengthA < lengthB ? lengthA : lengthB;
  for (size_t i = 0; i < shorter; i++) difference |= (unsigned char)(a[i] ^ b[i]);
  return difference == 0;
}

// The key on the device must be set and not the example placeholder.
inline bool isUsableKey(const char* key) {
  return key != nullptr && strlen(key) >= 16 && strstr(key, "CHANGE_ME") == nullptr;
}

}  // namespace flowstate
