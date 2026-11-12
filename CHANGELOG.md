# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - 2026-11-12

Team 10's IoT Mini Project release: the repository now matches the team's final firmware and the course's
Sense → Ingest → Process → Store → Analyze pipeline.

### Added

- **Firmware v2** (`ESP32_Code/FlowState_ESP32`), built on the team's final sketch with the same pins, thresholds and
  behaviour, one tab per pipeline stage. New: MQTT over TLS (telemetry every 2 s with sequence numbers, a retained
  online status with a Last Will, instant alerts, ping/pong), HMAC-SHA256-signed valve commands that expire after
  5 minutes and cannot be replayed, NTP correction of the DS3231 (or time without one), a kept-alive HTTPS connection
  with one retry, connectivity health in every reading, and `KEY_CHECK` / `HELP` on the Serial Monitor.
- **One-step database setup** (`supabase/flowstate_setup.sql`) and `get_hourly_summary()` for the analysis.
- **Dashboard** for the course: Team 10, the five pipeline stages lit live, live readings over MQTT, the five
  questions (loss, busiest hours, unusual use, night flow, cost), valve control, a connectivity and performance
  panel, an architecture diagram, cited real-world context, and a clearly labelled sample-data preview.
- Tests: firmware rules on a PC (61 checks), database (42), dashboard unit (26) and browser (12), plus an ESP32
  build with and without MQTT in CI. `docs/TESTING.md` with the measured results and the hardware test sheets.

### Changed

- The public (anon) key may add rows again, because the final firmware posts straight into the tables. In place of
  v1.1's device keys: every value is range-checked, rows can never be changed or deleted, a wrong device clock is
  corrected, and inserts are flood-limited. Valve commands no longer go through the database: they are signed MQTT
  messages that only the holder of the valve key can make.
- The v1.1 firmware and migrations moved to `archive/v1.1-rpc-design` (migration 005 would block the final firmware).

### Removed

- The competition-only "Sustainability Impact Lab" scoring cards, the "Impact Intelligence Studio" and Judges Demo Mode.

## [1.1.0] - 2026-09-29

### Security
- The public (anon) key can no longer write to the database. Before this, anyone could insert fake readings and alerts, and an alert containing HTML ran as code in every dashboard (stored XSS).
- The device now writes through key-checked database functions (`ingest_reading`, `log_device_alert`) using its own secret key. Keys are stored only as hashes (`private.create_access_key`, `private.revoke_access_key`).
- The dashboard inserts all database text as plain text, loads its libraries with integrity hashes, and is served with a strict Content-Security-Policy.
- The firmware checks Supabase's HTTPS certificate (it used to accept any certificate). Wi-Fi and Supabase credentials moved to a git-ignored `secrets.h`.
- The Netlify build refuses a secret (`service_role`) key. The committed `env.js` no longer contains real project values.
- A deployed dashboard is fixed to its own database (the Settings panel can no longer point it elsewhere).
- Flood limits: at most 30 readings and 20 alerts a minute are accepted, so a copied device key cannot fill the database. Alert messages are stored without `<` and `>`. The public key can see a valve command's progress but not which key sent it.

### Fixed
- The dashboard's Open/Close valve buttons only changed text on screen. They now queue a real command (operator key required) that the device collects and confirms.
- At power-on the device reported the valve as closed while it was open, which also disabled two automatic shut-offs. The valve position is now saved and restored correctly.
- One-pulse differences between the two sensors at low flow could close the valve. Leak checks now need enough water and several seconds in a row before acting.
- Water volumes were undercounted whenever a loop took longer than a second, and the "daily" total never reset. Volumes now come straight from pulse counts; the daily total resets at local midnight; the database sums per-reading volumes.
- Timestamps were stored as UTC while holding local time (5.5 hours off in India). The database now sets every timestamp; the device uses internet time and a configurable time zone.
- The dashboard said "Online" even when the device had stopped sending data. It now shows device live, delayed or offline, with a banner and faded values when data is stale.
- Charts only ever showed the last 10 minutes, and "Accumulated Volume" and "Hourly Usage" were not volumes. Charts now use server-side summaries for 15 minutes to 24 hours and real litres.
- "Est. Loss" showed a flow rate labelled as litres. The tank level was inverted twice. Critical alerts were stored with medium severity and hidden in critical-only mobile mode.
- Wi-Fi outages paused the sensing loop for about 10 seconds at a time. Networking now runs in its own task.
- Night-watch and anomaly alerts repeated every minute; each now fires once per event. Night watch no longer runs on "hours since power-on" when the clock is unknown, and a single toilet flush no longer triggers it.
- The usage baseline froze after learning, stored per-minute values as "hourly", and was lost on restart. It now learns hourly totals continuously and saves them to flash.
- The dashboard raised a fake "Medium Leak Risk" alert every second once cumulative usage grew large. Dashboard estimates are now raised only when risk climbs, at most once per 10 minutes, and are labelled as estimates.
- Saving settings (or pressing Ctrl+S) pinned connection values into the browser forever. Threshold fields changed nothing. The Settings panel was hidden by CSS.
- Dark mode showed some headings and readouts dark on dark. Alert severity colours were a 1px line.

### Added
- Remote valve control with delivery tracking, a 2-minute expiry and a rate limit. Only one command can wait for the device at a time, so a stale command can never run after a newer one.
- The leak lockout survives restarts: after an automatic shut-off and a power cut, the valve stays closed and the status stays Critical.
- Turning manual override off immediately closes the valve if a leak is still critical.
- Database retention: 30 days of readings, 180 days of alerts, cleaned up daily through pg_cron.
- `SILENCE` and `HELP` serial commands. The `STATUS` command now reports time source, upload health and totals.
- Tests: database migrations and permissions, firmware logic (host C++), dashboard logic (Node) and end-to-end browser tests (Playwright), plus a GitHub Actions workflow that also compiles the firmware.

### Changed
- Uploads every 5 seconds instead of every second (about 17,000 rows a day instead of 86,000).
- The sketch lives in `ESP32_Code/water_monitoring/` so the Arduino IDE opens it directly, and is split into small files. The dashboard script is split into modules under `Web_Dashboard/assets/js/`.
- Supabase JS 2.117.2 (was 2.5.0). The unused MQTT library was removed.
- The bundled Windows `arduino-cli.zip` is no longer tracked.

### Upgrade notes
- Apply migrations 005 to 008, create a device key, and flash the new firmware. **Older firmware can no longer upload after the migrations.**
- See "Upgrading an Existing Installation" in the README.

---

## [1.0.0] - 2026-02-21

> Correction added in 1.1.0: the 1.0.0 notes below describe a solenoid relay on GPIO32 and uploads every 10 seconds. The released firmware actually drove a servo valve on GPIO26 and uploaded every second.

### Added
- **ESP32 Firmware** (900+ lines)
  - Dual YF-S201 flow sensor support with hardware interrupts (GPIO19, GPIO22)
  - Fixed flow calibration formula (Hz / 7.5 = L/min)
  - Water level sensor integration (GPIO33 ADC)
  - DS3231 RTC module for accurate timestamping
  - Solenoid valve relay control (GPIO32)
  - WiFi connectivity with HTTPS support
  
- **Leak Detection System**
  - Volume-based leak calculation with dual-sensor verification
  - 3-day adaptive baseline learning for anomaly detection
  - Pattern-based usage analysis for theft detection
  - Automatic valve closure on critical leaks (>15% loss)
  - Real-time alert generation and logging

- **Web Dashboard**
  - Real-time monitoring interface with responsive design
  - Live tank level visualization
  - Flow rate comparison (Sensor 1 vs Sensor 2)
  - Loss percentage gauge indicator
  - 4 analytical charts (flow trends, volume, hourly patterns, loss trends)
  - Manual valve control buttons
  - Configuration panel for Supabase integration
  - Alert history with timestamp logging
  - Daily statistics including consumption and cost calculation

- **Backend Integration**
  - Supabase PostgreSQL database support
  - `water_readings` table for sensor data storage
  - `alerts` table for event logging
  - REST API endpoints for data retrieval
  - WebSocket real-time subscriptions
  - Row Level Security (RLS) policy templates

- **Documentation**
  - Comprehensive README with quick start guide
  - Hardware setup instructions with wiring diagrams
  - Sensor calibration procedures
  - API reference with database schema
  - Troubleshooting guide with 10+ common issues
  - Code comments throughout firmware and dashboard
  - Configuration templates for easy setup

### Features
✅ Real-time water monitoring (5-second dashboard refresh)  
✅ Dual-sensor redundancy for accurate detection  
✅ Adaptive learning system (baseline after 3 days)  
✅ Automatic critical leak response  
✅ Cloud database integration  
✅ Professional responsive UI  
✅ Historical analytics and trending  
✅ Production-ready codebase  

### Performance
- Data upload: Every 10 seconds
- Dashboard refresh: Every 5 seconds
- Detection window: 60 seconds
- Memory usage: ~80KB on ESP32
- WiFi power consumption: ~200mW (active)
- Leak detection accuracy: ±0.5% for flows >1L/min
- Critical alert response: <2 minutes

### Hardware Support
- ESP32 (30-pin dev board)
- YF-S201 flow sensors (×2)
- Capacitive water level sensors
- DS3231 RTC modules
- 2-channel 5V relay modules
- 10-12V DC solenoid valves

---

## Planned Features (v1.1+)

### Upcoming
- [ ] Mobile app version (iOS/Android)
- [ ] Machine learning-based predictions
- [ ] SMS/Email alerts
- [ ] Multi-language dashboard support
- [ ] Advanced user authentication
- [ ] Data export to cloud storage
- [ ] Integration with smart home platforms (Home Assistant, etc.)
- [ ] Temperature monitoring
- [ ] Extended baseline learning (weekly/monthly patterns)
- [ ] Cost per area analysis (per room/apartment)

---

## Known Issues

### v1.0.0
- ESP32 only supports 2.4GHz WiFi networks
- Water level calibration values may vary by sensor type (requires manual adjustment)
- Dashboard configuration stored in browser localStorage (not synced across devices)
- Baseline learning requires consistent water usage patterns

---

## Version History

| Version | Date       | Status                               | Download |
| ------- | ---------- | ------------------------------------ | -------- |
| 1.1.0   | 2026-09-29 | Stable                               | Latest   |
| 1.0.0   | 2026-02-21 | Superseded (security fixes in 1.1.0) | -        |

---

## Deprecation Policy

We maintain support for:
- Current and previous ESP32 board versions
- Last 2 versions of Arduino IDE
- Last 2 versions of browser standards (ES6+)
- PostgreSQL 12+

End of life (EOL) for previous major versions announced 12 months in advance.

---

## Migration Guides

### From Development to Production
See README.md "Deployment Options" section for setup instructions.

### Updating Firmware
1. Backup current configuration
2. Update WiFi and Supabase credentials if needed
3. Re-upload to ESP32
4. Verify sensor calibration still correct
5. Monitor first data points for anomalies

---

## Contributors & Acknowledgments

Thanks to:
- **Supabase** for real-time database capabilities
- **Arduino community** for ESP32 support
- **Chart.js** for interactive visualizations

---

## Support & Feedback

- **Bug Reports**: Check existing issues, then create new issue with reproduction steps
- **Feature Requests**: Open discussion for community feedback
- **Security Issues**: See SECURITY.md

---

## Release Process

1. Update CHANGELOG.md with all changes
2. Bump version number (MAJOR.MINOR.PATCH)
3. Create Git tag: `vX.Y.Z`
4. Push changes to main branch
5. Create GitHub release with changelog

---

**Last Updated**: September 2026
