# FlowState

## Author and Maintainer

[Darshanpawar7](https://github.com/Darshanpawar7)

FlowState is a real-time water monitoring and leak detection system built with an ESP32 firmware layer, a Supabase backend, and a responsive browser dashboard. It tracks flow, tank level, humidity, and leak risk, closes a shut-off valve automatically when a leak is critical, and lets an operator open or close the valve from the dashboard.

Live demo: [https://sustainflow.netlify.app/](https://sustainflow.netlify.app/)

## Overview

The project has four parts:

- ESP32 firmware in [ESP32_Code/water_monitoring/](ESP32_Code/water_monitoring/)
- Supabase migrations in [supabase/migrations/](supabase/migrations/)
- A static web dashboard in [Web_Dashboard/](Web_Dashboard/), deployed on Netlify
- Tests for all of the above in [tests/](tests/), run by [CI](.github/workflows/ci.yml)

The firmware counts pulses from two flow sensors every second and compares them. Water that leaves the tank but never reaches the tap is a leak. Critical leaks close the valve and sound an alarm, without waiting for the network. Every 5 seconds the device uploads a reading to Supabase and collects any valve command sent from the dashboard. The dashboard shows live values, flags a device that has gone quiet, and draws history charts summarised by the database.

## Key Capabilities

- Dual flow verification using two flow sensors on the same line
- Leak classification (Normal, Warning, Critical) over a sliding 60-second window, plus a fast check for sudden large leaks
- Automatic valve shutdown on critical leaks; the valve position survives power cuts
- Night-time watch (2 AM to 5 AM local time) for continuous flow
- A usage baseline that learns normal litres per hour of the day and flags unusual hours
- Remote valve control from the dashboard, protected by an operator key and confirmed by the device
- Device-offline detection: the dashboard says when data stops arriving
- Secure writes: the public key is read-only; the device writes with its own secret key
- HTTPS certificate checking on the device
- History charts for 15 minutes to 24 hours, daily totals, CSV and JSON export
- Automatic clean-up of old data
- Serial console commands for field debugging

## System Architecture

```text
Flow sensors ─┐
Level sensor ─┼─> ESP32 ──HTTPS──> Supabase ──> Dashboard (Netlify)
Humidity ─────┘    │  ▲             │  ▲              │
                   │  └─ valve command in reply ◄─────┘ request_valve_command
                   └─> servo valve + alarm             (operator key)

ESP32 writes through key-checked functions: ingest_reading, log_device_alert
Dashboard reads with the public key: water_readings, alerts, history summaries
```

## Repository Structure

| Path | Purpose |
| ---- | ------- |
| [ESP32_Code/water_monitoring/](ESP32_Code/water_monitoring/) | Arduino sketch: sensing, leak logic, valve, networking |
| [supabase/migrations/](supabase/migrations/) | Database schema, permissions, device API, history and retention |
| [Web_Dashboard/](Web_Dashboard/) | Static HTML, CSS and JavaScript dashboard (no build step) |
| [scripts/netlify-build.mjs](scripts/netlify-build.mjs) | Netlify build step: writes `env.js` and security headers |
| [tests/](tests/) | Database, firmware-logic, dashboard unit and browser tests |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | Runs every test and a firmware compile on each push |

## Hardware

### Recommended Components

| Component | Notes |
| --------- | ----- |
| ESP32 development board | Main controller |
| 2x YF-S201 flow sensors | Sensor 1 near the tank, sensor 2 near the tap |
| Capacitive water level sensor | Analog input |
| DS3231 RTC module | Keeps time when there is no internet |
| DHT22 sensor | Humidity |
| Servo-driven shut-off valve | Open at 0°, closed at 90° (configurable) |
| Buzzer | Leak alarm |
| 5V and 12V power supply | Match the sensor and actuator requirements |

### Pin Map

| Signal | GPIO |
| ------ | ---- |
| Flow sensor 1 (tank side) | 19 |
| Flow sensor 2 (tap side) | 22 |
| Water level sensor | 33 |
| Buzzer | 13 |
| Servo valve | 26 |
| DHT22 | 4 |
| RTC I2C SDA | 18 |
| RTC I2C SCL | 21 |

Pins, calibration and thresholds live in [flowstate_config.h](ESP32_Code/water_monitoring/flowstate_config.h).

## How It Works

**Leak detection.** Each second the firmware turns pulse counts into volumes and compares the two sensors over the last 60 seconds:

- Normal: under 5% of the water goes missing
- Warning: 5% to 15%
- Critical: over 15%, held for 5 seconds in a row

A separate fast check looks at the last 5 seconds and closes the valve within about 5 seconds of a sudden large leak. Both checks wait until enough water has flowed to judge fairly, so the normal one-pulse wobble between two sensors at low flow never closes the valve.

**When a leak is critical** the valve closes, the alarm sounds, and the status stays Critical until someone reopens the valve. If the leak is still there, the valve closes again within seconds. `OVERRIDE_ON` on the serial console turns automatic shut-off off.

**Night watch.** Between 2 AM and 5 AM local time, water flowing for 5 minutes without a break raises an alert; 10 minutes closes the valve. A single toilet flush does not.

**Usage baseline.** Over the first 3 days the device learns typical litres for each hour of the day, and keeps learning afterwards. An hour that uses far more than usual raises an alert. Learning is saved in flash and survives restarts.

**Time.** The RTC holds UTC, internet time (NTP) keeps it correct, and `TIMEZONE` in the config turns it into local time. Database timestamps are always set by the server.

## Quick Start

1. **Database.** In your Supabase project's SQL editor, run every file in [supabase/migrations/](supabase/migrations/) in name order (001 to 008). They are safe to re-run.
2. **Keys.** In the SQL editor, create a key for the device and one for each person who may move the valve. Each key is shown once, so copy it:

   ```sql
   select private.create_access_key('esp32-main', 'device');
   select private.create_access_key('operator-1', 'operator');
   ```

3. **Firmware.** In `ESP32_Code/water_monitoring/`, copy `secrets.example.h` to `secrets.h` and fill in your Wi-Fi details, Supabase URL, public (anon) key and the device key. Check `TIMEZONE` in `flowstate_config.h`.
4. **Flash.** Open `water_monitoring.ino` in the Arduino IDE, select "ESP32 Dev Module", and upload. Open the Serial Monitor at 115200 baud and type `STATUS`.
5. **Dashboard.** Deploy to Netlify (see below), or serve `Web_Dashboard/` locally and enter your Supabase URL and public key under **Settings** at the bottom of the page.
6. **Valve control.** Enter an operator key under **Settings** → *Valve control key*. The Open and Close buttons then send real commands.

## Upgrading an Existing Installation

- **Export any data you want to keep first.** Migration 008 schedules a daily clean-up that deletes readings older than 30 days and alerts older than 180 days. To keep more, change the defaults of `private.purge_old_data` before applying it.
- Your old database let anyone with the public key write rows. Before trusting old data, look through `alerts` and `water_readings` for entries you don't recognise and delete them.
- After migrations 005 to 008, the public key can no longer write. **Firmware older than 1.1.0 stops uploading** until you flash the new firmware with a device key.
- The RTC now holds UTC. The first internet time sync corrects any old local time automatically.
- Rows dated in the future (from the old time-zone bug or forged data) are hidden from the dashboard and deleted by the daily clean-up.
- Browsers that saved connection settings in the old version have them cleared once; re-enter them only if you use a different project.

## ESP32 Firmware Setup

### Board and Libraries

- Board package: **esp32 by Espressif Systems 3.3.0 or newer** (needed for built-in HTTPS certificate checking)
- Libraries (Library Manager): ArduinoJson 7, RTClib, ESP32Servo, DHT sensor library, Adafruit Unified Sensor

### Files

| File | What to change |
| ---- | -------------- |
| `secrets.h` (from `secrets.example.h`) | Wi-Fi, Supabase URL, public key, device key. Ignored by git. |
| `flowstate_config.h` | Pins, calibration, thresholds, `TIMEZONE`, upload interval |
| Other files | Program logic; no settings |

### Calibration

- **Flow sensors.** Run exactly 10 L through the pipe, type `STATUS`, and divide each sensor's pulse count by 10. Put the results in `FLOW_SENSOR_1_PULSES_PER_LITER` and `FLOW_SENSOR_2_PULSES_PER_LITER`. Matching the two sensors matters, because a small calibration difference looks like a small leak.
- **Tank level.** The serial log shows the raw ADC value. Note it with the sensor dry, then fully submerged, and enter them as `WATER_LEVEL_ADC_IN_AIR` and `WATER_LEVEL_ADC_IN_WATER`. If the tank shows full when it is empty, swap the two numbers.
- **Time zone.** Set `TIMEZONE` to your POSIX time zone, for example `IST-5:30` for India.

### Serial Commands

Open the Serial Monitor at 115200 baud and send one command per line (any line-ending setting works):

| Command | Action |
| ------- | ------ |
| STATUS | Print the full system state |
| VALVE_OPEN | Open the valve (clears a leak lockout) |
| VALVE_CLOSE | Close the valve |
| VALVE_TOGGLE | Toggle the valve |
| OVERRIDE_ON | Turn automatic leak shut-off off |
| OVERRIDE_OFF | Turn automatic leak shut-off back on |
| SILENCE | Stop the alarm without moving the valve |
| HELP | List the commands |

## Supabase Setup

### Migrations

| File | Purpose |
| ---- | ------- |
| 001 to 004 | Tables, indexes, Realtime, read policies, humidity column |
| [005_lock_down_direct_writes](supabase/migrations/20260929_005_lock_down_direct_writes.sql) | Makes the public key read-only; adds per-reading volumes |
| [006_access_keys](supabase/migrations/20260929_006_access_keys.sql) | Hashed device and operator keys in a private schema |
| [007_device_api_and_valve_commands](supabase/migrations/20260929_007_device_api_and_valve_commands.sql) | Key-checked write functions and the valve command queue |
| [008_history_and_retention](supabase/migrations/20260929_008_history_and_retention.sql) | Chart history, daily totals and automatic clean-up |

### Data Model

- `water_readings`: one row per upload with flows, loss %, level, humidity, valve state, leak and anomaly status, and the volume each sensor measured since the previous upload (`volume_1_ml`, `volume_2_ml`)
- `alerts`: timestamp, type, message, severity (`low`, `medium`, `high`, `critical`)
- `valve_commands`: dashboard requests and whether the device has collected them

### Managing Keys

```sql
select private.create_access_key('operator-2', 'operator');  -- new key, shown once
select private.revoke_access_key('operator-1');              -- stop a key working
select label, role, created_at, last_used_at, revoked_at from private.access_keys;
```

### Retention

Readings are kept for 30 days, alerts for 180 days and valve commands for 30 days. On Supabase the clean-up runs daily through pg_cron. Check that it is scheduled with:

```sql
select jobname, schedule from cron.job where jobname = 'flowstate-purge-old-data';
```

If that returns nothing (pg_cron is not enabled), enable pg_cron under Database → Extensions and re-run migration 008, or run `select private.purge_old_data();` yourself regularly.

## Dashboard Setup

### Netlify Deployment

[netlify.toml](netlify.toml) publishes `Web_Dashboard/` and runs [scripts/netlify-build.mjs](scripts/netlify-build.mjs), which writes `assets/env.js` and strict security headers (Content-Security-Policy and others). Set these environment variables in Netlify:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (the anon or publishable key; the build refuses a secret key)

A deployed dashboard only connects to that database. Its Settings panel then only holds the valve control key.

Optional, for an external analysis service:

- `API_ADAPTER_MODE` set to `remote`
- `API_BASE_URL` for that service (https)

### Local Development

Serve the folder with any static server, for example `npx serve Web_Dashboard` or `python -m http.server --directory Web_Dashboard`. Then either fill in `Web_Dashboard/assets/env.js` (do not commit real values) or enter your Supabase URL and public key under **Settings**.

## Runtime Behavior

| Metric | Behavior |
| ------ | -------- |
| Sensor sampling | Every second |
| Leak window | Sliding 60 seconds, plus a 5-second fast check |
| Upload interval | Every 5 seconds (`UPLOAD_INTERVAL_MS`) |
| Dashboard updates | Realtime, with polling every 5 seconds as a fallback |
| Device marked delayed / offline | After 15 seconds / 1 minute without data |
| Night watch | 2 AM to 5 AM local time |
| Baseline learning | About 3 days, then continuous |
| Data kept | 30 days of readings |

## Testing

```bash
npm install
npm test                    # dashboard logic (Node's built-in test runner)
npm run test:db             # migrations and permissions (needs PostgreSQL's initdb/pg_ctl/psql, or DATABASE_URL)
npx playwright install chromium
npm run test:e2e            # the real dashboard in a headless browser against a simulated Supabase
g++ -std=c++11 -I ESP32_Code/water_monitoring tests/firmware/flowstate_logic_test.cpp -o logic_test && ./logic_test
```

CI runs all of these on every push, plus a full ESP32 compile.

## Troubleshooting

### The serial log says "rejected (403)"

The device key is wrong or revoked. Create a new one with `private.create_access_key` and update `secrets.h`.

### The serial log says "failed (404)"

Migrations 005 to 008 have not been applied.

### The dashboard says "Device offline"

No reading has arrived for over a minute. Check the device's power, Wi-Fi (2.4 GHz only) and serial log.

### The valve buttons say the key was not accepted

Check the operator key under **Settings**, or create a new one.

### The tank reads backwards

Swap `WATER_LEVEL_ADC_IN_AIR` and `WATER_LEVEL_ADC_IN_WATER`.

### Night-watch alerts arrive at the wrong time

Set `TIMEZONE` in `flowstate_config.h`. `STATUS` shows the device's local time and where it came from.

### No flow readings

Check the sensors' power and the GPIO 19 and 22 wiring, and make sure water is flowing.

## Security Notes

- The public key only reads. Readings and alerts are written through functions that check the device's secret key.
- Keep `secrets.h` out of git (it is ignored by default) and never put the `service_role` key in the firmware or the dashboard.
- Operator keys move the valve: give each person their own and revoke keys that are no longer needed.
- The dashboard's data is readable by anyone with the public key, which is the same as anyone who can open the site.
- See [SECURITY.md](SECURITY.md) for details.

## License

See [LICENSE](LICENSE) for the project license.
