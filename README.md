# FlowState

## Author and Maintainer

[Darshanpawar7](https://github.com/Darshanpawar7)

FlowState is a real-time water monitoring and leak detection system built with an ESP32 firmware layer, a Supabase backend, and a responsive browser dashboard. It tracks flow, tank level, humidity, and leak risk, then surfaces the data in a live operations view designed for demos, pilots, and production prototypes.

Live demo: [https://sustainflow.netlify.app/](https://sustainflow.netlify.app/)

## Overview

The project combines three parts:

- ESP32 firmware in [ESP32_Code/water_monitoring.ino](ESP32_Code/water_monitoring.ino)
- Supabase migrations in [supabase/migrations/](supabase/migrations/)
- Web dashboard in [Web_Dashboard/](Web_Dashboard/)

The firmware reads sensors every second, uploads measurements to Supabase, evaluates leak status in rolling windows, and triggers alerts when thresholds are exceeded. The dashboard consumes the live data, shows historical charts, and provides manual valve control plus operational summaries.

## Key Capabilities

- Dual flow verification using two flow sensors on separate lines
- Real-time leak classification with Normal, Warning, and Critical states
- Baseline learning for anomaly detection over the first few days of operation
- Nighttime leak monitoring between 2 AM and 5 AM
- Automatic valve shutdown on critical conditions
- Supabase-backed data storage with row-level security
- Live dashboard with charts, status cards, alerts, and export tools
- Manual override and serial command control for field debugging
- Humidity tracking alongside flow and tank level telemetry

## System Architecture

```text
Water source -> Sensors -> ESP32 -> Supabase -> Dashboard
                   |          |          |
                   |          |          +-> alerts table
                   |          +-> water_readings table
                   +-> flow, level, humidity, valve control
```

## Repository Structure

| Path                                                               | Purpose                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [ESP32_Code/water_monitoring.ino](ESP32_Code/water_monitoring.ino) | Firmware for sensor capture, leak logic, uploads, and valve control |
| [Web_Dashboard/](Web_Dashboard/)                                   | Static HTML, CSS, and JavaScript dashboard                          |
| [supabase/migrations/](supabase/migrations/)                       | Database schema, indexes, RLS, and grants                           |
| [netlify.toml](netlify.toml)                                       | Netlify build config for dashboard environment injection            |

## Hardware

### Recommended Components

| Component                     | Notes                                      |
| ----------------------------- | ------------------------------------------ |
| ESP32 development board       | Main controller                            |
| 2x flow sensors               | GPIO 19 and 22 in the current firmware     |
| Capacitive water level sensor | Analog input on GPIO 33                    |
| DS3231 RTC module             | Timekeeping for baseline and timestamping  |
| DHT22 sensor                  | Humidity input on GPIO 4                   |
| Servo-driven shutoff valve    | Controlled on GPIO 26                      |
| Buzzer                        | Alarm output on GPIO 13                    |
| 5V and 12V power supply       | Match the sensor and actuator requirements |

### Current Pin Map

| Signal             | GPIO |
| ------------------ | ---- |
| Flow sensor 1      | 19   |
| Flow sensor 2      | 22   |
| Water level sensor | 33   |
| Buzzer             | 13   |
| Servo valve        | 26   |
| DHT22              | 4    |
| RTC I2C SDA        | 18   |
| RTC I2C SCL        | 21   |

## How It Works

The firmware computes leak percentage as the loss between the upstream and downstream flow sensors. The current logic classifies readings as follows:

- Normal: below 5 percent loss
- Warning: 5 to 15 percent loss
- Critical: above 15 percent loss

The system also maintains a rolling baseline for anomaly detection. After the baseline is established, unexpected usage spikes are flagged and recorded in Supabase as alerts.

## Prerequisites

- Arduino IDE or compatible ESP32 toolchain
- ESP32 board support installed in the IDE
- A Supabase project
- A static web host for the dashboard, or local file serving for development
- The hardware listed above

## Quick Start

1. Create or open a Supabase project.
2. Apply the SQL files in [supabase/migrations/](supabase/migrations/) in order.
3. Open [ESP32_Code/water_monitoring.ino](ESP32_Code/water_monitoring.ino) and replace the WiFi and Supabase placeholders with your own values.
4. Build and upload the firmware to the ESP32.
5. Open [Web_Dashboard/index.html](Web_Dashboard/index.html) through a static host or local server.
6. Configure the dashboard with the same Supabase URL and anon key.
7. Verify readings appear in the dashboard and in the Supabase tables.

## ESP32 Firmware Setup

### Arduino Libraries

Install the libraries used by the firmware:

- ArduinoJson
- RTClib
- ESP32Servo
- DHT sensor library
- ESP32 board package

### Configuration Values

The firmware is designed to be customized for your environment. Update the following values in the sketch before flashing:

```cpp
const char *SSID = "YOUR_WIFI_SSID";
const char *PASSWORD = "YOUR_WIFI_PASSWORD";
const char *SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const char *SUPABASE_KEY = "YOUR_SUPABASE_ANON_KEY";
```

Calibration values are also set in the firmware:

```cpp
const float FLOW_SENSOR_CALIBRATION = 7.5;
const int WATER_LEVEL_IN_AIR = 4095;
const int WATER_LEVEL_IN_WATER = 1000;
const float TANK_HEIGHT_CM = 100.0;
```

### Upload Checklist

- Select the ESP32 board and COM port
- Upload the sketch
- Open Serial Monitor at 115200 baud
- Confirm WiFi connection
- Confirm Supabase connectivity
- Confirm readings are being posted every second

## Supabase Setup

The repository includes database migrations for the full schema:

- [20260410_001_create_water_tables.sql](supabase/migrations/20260410_001_create_water_tables.sql)
- [20260410_002_indexes_realtime.sql](supabase/migrations/20260410_002_indexes_realtime.sql)
- [20260410_003_rls_and_grants.sql](supabase/migrations/20260410_003_rls_and_grants.sql)
- [20260412_004_add_humidity_to_water_readings.sql](supabase/migrations/20260412_004_add_humidity_to_water_readings.sql)

If you prefer manual setup, the core tables are:

- `water_readings` for telemetry
- `alerts` for events and incidents

### Data Model Summary

`water_readings` currently stores:

- timestamp
- flow_rate_1
- flow_rate_2
- percentage_loss
- water_level
- humidity
- valve_state
- leak_status
- anomaly_status
- system_online
- daily_total_liters

`alerts` stores:

- timestamp
- alert_type
- message
- severity

## Dashboard Setup

The dashboard is a static site with a built-in local simulator fallback and remote API mode.

### Local Development

Serve the `Web_Dashboard/` directory with any static server, then open the dashboard in a browser.

### Netlify Deployment

The provided [netlify.toml](netlify.toml) publishes the `Web_Dashboard/` directory and generates [Web_Dashboard/assets/env.js](Web_Dashboard/assets/env.js) from Netlify environment variables.

Set these variables in Netlify:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Optional dashboard adapter variables:

- `API_ADAPTER_MODE` set to `local` or `remote`
- `API_BASE_URL` for the remote adapter backend

## Runtime Behavior

- Sensor readings are sampled every second
- Leak detection runs on a 60 second window
- Data is uploaded to Supabase every second in the current firmware
- Baseline learning completes after roughly 3 days of usage history
- Nighttime leak detection runs from 2 AM to 5 AM
- Critical leaks can trigger automatic valve closure
- The dashboard subscribes to realtime updates and falls back to polling when needed

## Serial Commands

Open the Serial Monitor at 115200 baud and send one command per line:

| Command      | Action                     |
| ------------ | -------------------------- |
| STATUS       | Print current system state |
| VALVE_OPEN   | Open the valve             |
| VALVE_CLOSE  | Close the valve            |
| VALVE_TOGGLE | Toggle valve state         |
| OVERRIDE_ON  | Enable manual override     |
| OVERRIDE_OFF | Disable manual override    |

## Dashboard Features

- Live tank level visualization
- Dual flow rate cards
- Leak status gauge
- Ambient humidity panel
- Recent alerts with filtering and acknowledgement state
- Timeframe controls for charts
- Daily statistics and estimated loss figures
- CSV and JSON export
- Manual valve controls
- Theme toggle and demo mode helpers

## Troubleshooting

### ESP32 does not connect to WiFi

- Verify the SSID and password
- Use a 2.4 GHz network
- Check signal strength and router access

### No flow readings

- Confirm both sensors have power
- Check GPIO 19 and 22 wiring
- Make sure water is actually flowing through the sensors

### Water level is unstable

- Recheck the sensor power and analog wiring
- Recalibrate the air and submerged values
- Inspect for loose connections or noisy ADC input

### Dashboard shows no data

- Confirm the Supabase URL and anon key match the firmware
- Verify the database migrations were applied
- Check the browser console for fetch or auth errors
- Confirm the ESP32 serial log shows successful uploads

### Valve does not move

- Verify the actuator wiring and power supply
- Confirm GPIO 26 is connected to the servo control line
- Test manual commands from the Serial Monitor

## Performance Notes

| Metric               | Current Behavior |
| -------------------- | ---------------- |
| Sensor sampling      | 1 second         |
| Leak window          | 60 seconds       |
| Upload interval      | 1 second         |
| Baseline period      | About 3 days     |
| Nighttime leak watch | 2 AM to 5 AM     |

## Security Notes

- Do not commit real WiFi or Supabase credentials
- Use the Supabase anon key, not the service role key, in the browser
- Keep RLS enabled on the database tables
- Treat water-usage telemetry as potentially sensitive operational data

## License

See [LICENSE](LICENSE) for the project license.
