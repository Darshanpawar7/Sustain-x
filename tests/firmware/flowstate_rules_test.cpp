// PC tests for ESP32_Code/FlowState_ESP32/flowstate_rules.h: the rules the
// ESP32 uses for leaks, night flow, learning and signed valve commands.
// Build and run with any C++11 compiler, from the repository root:
//   g++ -std=c++11 -Wall -Wextra -Werror -I ESP32_Code/FlowState_ESP32 tests/firmware/flowstate_rules_test.cpp -o rules_test
//   ./rules_test

#include <cmath>
#include <cstdio>
#include <cstring>

#include "flowstate_rules.h"

using namespace flowstate;

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(condition)                                                  \
  do {                                                                    \
    g_checks++;                                                           \
    if (!(condition)) {                                                   \
      g_failures++;                                                       \
      std::printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition); \
    }                                                                     \
  } while (0)

#define CHECK_NEAR(actual, expected, tolerance) CHECK(std::fabs((actual) - (expected)) <= (tolerance))

static void test_loss_percent() {
  CHECK_NEAR(lossPercent(1.0f, 0.9f, 0.01f), 10.0f, 0.001f);
  CHECK_NEAR(lossPercent(2.0f, 2.0f, 0.01f), 0.0f, 0.0001f);
  CHECK_NEAR(lossPercent(1.0f, 1.2f, 0.01f), 0.0f, 0.0001f);   // sensor 2 reads more: no negative loss
  CHECK_NEAR(lossPercent(1.0f, 0.0f, 0.01f), 100.0f, 0.0001f);
  CHECK_NEAR(lossPercent(0.005f, 0.0f, 0.01f), 0.0f, 0.0001f); // too little water to compare
  CHECK_NEAR(lossPercent(NAN, 0.0f, 0.01f), 0.0f, 0.0001f);
}

static void test_classify_loss() {
  CHECK(classifyLoss(0.0f, 5.0f, 15.0f) == LEAK_NORMAL);
  CHECK(classifyLoss(4.99f, 5.0f, 15.0f) == LEAK_NORMAL);
  CHECK(classifyLoss(5.0f, 5.0f, 15.0f) == LEAK_WARNING);
  CHECK(classifyLoss(14.99f, 5.0f, 15.0f) == LEAK_WARNING);
  CHECK(classifyLoss(15.0f, 5.0f, 15.0f) == LEAK_CRITICAL);
  CHECK(std::strcmp(leakLevelName(LEAK_NORMAL), "Normal") == 0);
  CHECK(std::strcmp(leakLevelName(LEAK_WARNING), "Warning") == 0);
  CHECK(std::strcmp(leakLevelName(LEAK_CRITICAL), "Critical") == 0);
}

static void test_night_hours() {
  CHECK(!isNightHour(1, 2, 5));
  CHECK(isNightHour(2, 2, 5));
  CHECK(isNightHour(4, 2, 5));
  CHECK(!isNightHour(5, 2, 5));
  CHECK(isNightHour(23, 22, 5));  // a window across midnight
  CHECK(isNightHour(0, 22, 5));
  CHECK(!isNightHour(12, 22, 5));
  CHECK(!isNightHour(3, 4, 4));   // empty window
}

static void test_learning_and_anomaly() {
  CHECK_NEAR(updateHourAverage(500.0f, 0, 120.0f), 120.0f, 0.001f);  // first sample replaces the default
  float average = 120.0f;
  average = updateHourAverage(average, 1, 180.0f);                    // exact mean of 120 and 180
  CHECK_NEAR(average, 150.0f, 0.001f);
  CHECK_NEAR(updateHourAverage(100.0f, 100, 200.0f), 101.0f, 0.001f); // slow 1 % updates after 100 samples
  CHECK(isUsageAnomaly(400.0f, 601.0f, 100.0f, 1.5f));
  CHECK(!isUsageAnomaly(400.0f, 600.0f, 100.0f, 1.5f));
  CHECK(!isUsageAnomaly(50.0f, 5000.0f, 100.0f, 1.5f));               // an hour with almost no normal use
}

static void test_command_checks() {
  CHECK(isValveAction("open"));
  CHECK(isValveAction("close"));
  CHECK(isValveAction("auto"));
  CHECK(!isValveAction("OPEN"));
  CHECK(!isValveAction(""));
  CHECK(!isValveAction(nullptr));

  CHECK(isValidNonce("n0nce1234"));
  CHECK(!isValidNonce("short"));
  CHECK(!isValidNonce("has space!"));
  CHECK(!isValidNonce("0123456789012345678901234567890123"));  // 34 characters

  const uint64_t now = 1762930000ULL;
  const uint64_t commandMs = now * 1000ULL + 123ULL;
  CHECK(checkCommandTiming(true, commandMs, now, 0, 300) == CMD_OK);
  CHECK(checkCommandTiming(false, commandMs, now, 0, 300) == CMD_NO_CLOCK);
  CHECK(checkCommandTiming(true, commandMs, now + 301, 0, 300) == CMD_STALE);  // too old
  CHECK(checkCommandTiming(true, commandMs, now - 301, 0, 300) == CMD_STALE);  // from the future
  CHECK(checkCommandTiming(true, commandMs, now, commandMs, 300) == CMD_REPLAY);
  CHECK(checkCommandTiming(true, commandMs, now, commandMs + 1, 300) == CMD_REPLAY);
  CHECK(checkCommandTiming(true, commandMs + 1, now, commandMs, 300) == CMD_OK);
  CHECK(std::strcmp(commandCheckText(CMD_BAD_SIGNATURE), "wrong valve key") == 0);
}

static void test_signed_text_matches_the_dashboard() {
  char digits[21];
  CHECK(formatUnsigned(0, digits) == 1 && std::strcmp(digits, "0") == 0);
  CHECK(formatUnsigned(1762930000123ULL, digits) == 13 && std::strcmp(digits, "1762930000123") == 0);
  CHECK(formatUnsigned(18446744073709551615ULL, digits) == 20 && std::strcmp(digits, "18446744073709551615") == 0);

  // tests/dashboard/lib.test.mjs signs exactly this text in the browser code.
  char text[160];
  CHECK(commandMessage(text, sizeof(text), "flowstate/team10-test", "close", 1762930000123ULL, "n0nce1234"));
  CHECK(std::strcmp(text, "flowstate/team10-test|close|1762930000123|n0nce1234") == 0);
  char tiny[10];
  CHECK(!commandMessage(tiny, sizeof(tiny), "flowstate/team10-test", "close", 1ULL, "n0nce1234"));
}

static void test_hex_and_comparison() {
  const uint8_t bytes[] = {0x00, 0x0f, 0xa5, 0xff};
  char hex[9];
  toHex(bytes, sizeof(bytes), hex);
  CHECK(std::strcmp(hex, "000fa5ff") == 0);

  CHECK(constantTimeEquals("abcdef", "abcdef"));
  CHECK(!constantTimeEquals("abcdef", "abcdeg"));
  CHECK(!constantTimeEquals("abcdef", "abcde"));
  CHECK(!constantTimeEquals("abc", nullptr));

  CHECK(isUsableKey("b7c30438d95aa5a1"));
  CHECK(!isUsableKey("CHANGE_ME_TO_A_RANDOM_KEY"));
  CHECK(!isUsableKey("short"));
  CHECK(!isUsableKey(nullptr));
}

int main() {
  test_loss_percent();
  test_classify_loss();
  test_night_hours();
  test_learning_and_anomaly();
  test_command_checks();
  test_signed_text_matches_the_dashboard();
  test_hex_and_comparison();
  std::printf("%d checks, %d failed\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
