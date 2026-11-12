# FlowState · Team 10 · Testing and results

This page covers three things:

- what is tested automatically
- what was measured on the real cloud services
- the hardware tests the team runs in the lab

Fill in every empty result cell with your own measurements. Never copy numbers from somewhere else.

## 1. Test strategy

| Level | What it proves | Where |
| --- | --- | --- |
| Unit (PC) | The firmware's decision rules: leak levels, night window, learning, command checks | `tests/firmware/flowstate_rules_test.cpp` |
| Unit (Node) | The dashboard's analysis and protocol code: the five answers, MQTT parsing, signing | `tests/dashboard/lib.test.mjs` |
| Database | The Supabase setup: permissions, value checks, clock correction, flood limit, hourly analysis | `tests/db/setup_assertions.sql` |
| Browser (end to end) | The real page under the production security policy, with a simulated Supabase and MQTT broker | `tests/e2e/dashboard.test.mjs` |
| Build | The firmware compiles for the ESP32 with and without MQTT | CI (`.github/workflows/ci.yml`) |
| Live services | The real broker and the real database behave as the code expects | Section 3 below |
| Hardware | Sensors, actuators and the whole pipeline on the bench | Section 4 below |

Run everything except the hardware tests with:

```text
npm install
npm test                 # dashboard unit tests
npx playwright install chromium
npm run test:e2e         # browser tests
npm run test:db          # needs PostgreSQL (initdb/pg_ctl on PATH, or DATABASE_URL)
g++ -std=c++11 -Wall -Wextra -Werror -I ESP32_Code/FlowState_ESP32 tests/firmware/flowstate_rules_test.cpp -o rules_test && ./rules_test
```

## 2. Automated test results

Recorded on 12 November 2026.

| Suite | Result | What it covers |
| --- | --- | --- |
| Dashboard unit tests | **26 / 26 pass** | Time in India time; litres and rupees; freshness; the five answers (loss, busiest hour, today vs normal, night flow, cost); alert names and grouping; MQTT telemetry parsing and junk rejection; lost-message counting from sequence numbers; HMAC-SHA256 against the RFC 4231 test vector; the exact signed command text; CSV formula neutralising; secret-key refusal |
| Browser tests | **12 / 12 pass** | Strict CSP; live MQTT readings and pipeline; the five answers from stored data; charts actually painted; alert text never runs as code; signed valve commands with the right and the wrong key; offline warning; future-dated readings ignored; deployment locked to its database; secret key refused; CSV export; sample data labelled; no sideways scrolling on a phone |
| Database | **42 / 42 checks pass** | The sketch's exact upload accepted; firmware v2 health fields; values out of range refused; edits and deletes refused; a wrong device clock corrected; flood limit (61st reading, 31st alert refused); hourly usage, loss, night flow and health averages; India time zone |
| Firmware rules | **61 / 61 checks pass** (GitHub Actions, g++ on Ubuntu) | Loss and levels, night window across midnight, learning average, anomaly rule, command checks (stale, replay, clock), signed text identical to the dashboard's, constant-time comparison |
| Firmware build | **pass**, no warnings from the sketch | With MQTT: 1,114,895 bytes of flash (85 %), 52,212 bytes of RAM (15 %). Without MQTT: 1,098,063 bytes (83 %). ESP32 core 3.3.12 |

## 3. Checks on the live services

**Database (Supabase, PostgreSQL 17).**

- The setup script and all 42 checks ran on the real project inside one transaction that was then rolled back.
- The tests ran with the real permissions, and the project was left empty afterwards.
- The setup was then applied for real.

**MQTT (HiveMQ public broker).**

- A stand-in device ran on a PC, using the same topics and payloads as `mqtt.ino` over TLS on port 8883.
- The real dashboard ran in Chrome under the production security policy.

| Measurement | Result |
| --- | --- |
| Live readings reach the page | Yes, status *Live* |
| MQTT round trip, page → broker → device → broker → page | 310 ms median (306–314 ms) |
| Messages delivered (from sequence numbers) | 100 % |
| Size of one telemetry message | 219–220 bytes |
| Valve key fingerprint, browser vs device | Identical |
| Signed *Close* command, click to confirmation | 1.24 s |
| Browser errors | None |

These numbers come from a PC. Repeat them with the ESP32 and record the results in test H10.

## 4. Hardware tests (fill in during the lab)

Use the Serial Monitor (115200 baud, *Newline*) and the dashboard together. Type `STATUS` at any time.

### H1. Flow sensor calibration (bucket test)

Run water through both sensors into a measuring jug. Compare with the rise in *total today* on the Serial Monitor.

| Run | Water in the jug (L) | Sensor 1 reading (L) | Error 1 (%) | Sensor 2 reading (L) | Error 2 (%) |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |

Error = (reading − jug) ÷ jug × 100. If a sensor is consistently off, change `FLOW_PULSES_PER_LITER` to pulses counted ÷ litres in the jug.

### H2. Sensors agree when there is no leak

Open the tap fully, with no leak between the sensors. Note the `[DETECTION]` line every 60 s.

| Window | Sensor 1 (L) | Sensor 2 (L) | Loss (%) | Status |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |

Pass when the loss stays under 5 % (*Normal*).

### H3. Leak simulation

Fit a T-piece with a small valve between the two sensors. With the tap open, open the side valve a little, then more.

| Side valve | Loss shown (%) | Status | Valve closed? | Buzzer? | Alert on the dashboard? | Time from opening to valve closed (s) |
| --- | --- | --- | --- | --- | --- | --- |
| Slightly open | | | | | | |
| Half open | | | | | | |

Pass when the status is *Warning* at 5–15 % and *Critical* at 15 % or more. A *Critical* must close the valve and sound the buzzer within one 60 s window, and the alert must appear on the dashboard.

### H4. Night watch

For the test, set `NIGHT_START_HOUR` and `NIGHT_END_HOUR` around the current hour, then upload. Let a trickle run.

| Check | Expected | Seen |
| --- | --- | --- |
| Flow starts | `NIGHTTIME_FLOW_START` alert | |
| 5 minutes of flow (or 0.5 L) | `NIGHTTIME_LEAK_ALERT` / `NIGHTTIME_EXCESSIVE_VOLUME` | |
| 10 minutes of flow | `NIGHTTIME_LEAK_CRITICAL`; the valve closes | |
| Dashboard Q4 | Shows the night's flow minutes | |

Restore the real hours (2 and 5) afterwards.

### H5. Tank level

| Tank | ADC value (Serial) | Level shown (%) |
| --- | --- | --- |
| Empty | | |
| Half | | |
| Full | | |

If needed, set `WATER_LEVEL_IN_AIR` and `WATER_LEVEL_IN_WATER` to the empty and full ADC values.

### H6. Valve control from the dashboard

| Check | Expected | Seen |
| --- | --- | --- |
| `KEY_CHECK` fingerprint vs the dashboard's *Key check* | Identical | |
| Wrong key → Close | "The ESP32 refused it: wrong valve key" | |
| Right key → Close | Servo turns; tile shows *Closed* | |
| Time from click to *Closed* on the tile (s) | Under 3 s | |
| Auto | *Automatic protection: on* | |

### H7. Losing the network

Switch off the Wi-Fi router or hotspot for 2 minutes, then switch it back on.

| Check | Expected | Seen |
| --- | --- | --- |
| Dashboard after about 45 s | *ESP32 offline (Last Will)* | |
| Leak detection while offline | Still works (edge processing) | |
| After Wi-Fi returns | Reconnects by itself; *Live* again | |
| Reliability chart | Shows the gap | |

### H8. Power cut

Note *total today*, unplug the ESP32 for 1 minute, plug it back in.

| Total before (L) | Total after restart (L) | Difference (L) |
| --- | --- | --- |
| | | |

The total is saved every 60 s, so at most a minute of flow can be missed.

### H9. Clock

| Check | Expected | Seen |
| --- | --- | --- |
| DS3231 fitted, Wi-Fi up | `[NTP] Internet time matches the DS3231` (or it is corrected) | |
| DS3231 removed | `[NTP] Clock set from internet time`; uploads continue | |

### H10. Performance with the real ESP32 (1 hour)

Read these from the dashboard's *Connectivity and performance* panel.

| Metric | Value |
| --- | --- |
| MQTT round trip (median, min–max) | |
| MQTT messages delivered (%) | |
| MQTT message size (bytes) and messages per minute | |
| Readings stored over HTTPS, last 15 min (%) | |
| HTTPS upload time (median, ms) | |
| HTTPS failures since boot | |
| Wi-Fi signal (dBm) | |
| Free memory (KB) | |

## 5. Data logs for the report

- **Readings:** dashboard → *Download the readings* → *Last 24 hours* → CSV. Each row is one reading (every 10 s) with its connectivity health.
- **Serial log:** copy the Serial Monitor output from the leak test (H3) and the network test (H7).
- **Screenshots:** the pipeline lighting up, a leak alert, the five answers, and the performance panel.
