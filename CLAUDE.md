# FlowState: project purpose

This repository is our team's **IoT Mini Project** for the university IoT lab. The title and objective below were submitted in the course form on 29 September 2026. Every change to the project should serve this objective.

## Submitted title

FlowState: IoT Water Leak Detection and Consumption Analytics Using Dual Flow Sensors

## Objective (as submitted)

FlowState detects hidden water leaks and analyses how water is used, so that waste and cost can be reduced.

- **Sense:** an ESP32 reads two flow sensors (tank outlet and tap), a water level sensor and a humidity sensor every second.
- **Ingest:** readings are sent over Wi-Fi to a cloud database every 5 seconds.
- **Process:** the ESP32 converts sensor pulses into litres, compares the two flow sensors to calculate water loss, classifies it as normal, warning or critical, and closes a valve automatically on a critical leak.
- **Store:** readings and alerts are stored in a Supabase (PostgreSQL) database.
- **Analyze:** a web dashboard shows water lost to leaks, hourly and daily usage patterns, cost, unusual usage compared with the learned normal pattern, and night-time flow that points to hidden leaks.

## What the course requires

- The project must clearly demonstrate all five IoT stages: **Sense → Ingest → Process → Store → Analyze**.
- **Analysis comes first.** The course values meaningful insights from the data, not just collecting it. The questions FlowState answers are:
  - Am I losing water, and how much?
  - When do I use the most water?
  - Is today's use unusual?
  - Is water flowing at night?
  - What does it cost?
- The team has 4 members from the same class, including a Team Lead and a Second Lead. The same team works together through all IoT lab sessions.
- The team buys its own components (the university does not provide or reimburse them), so hardware must stay cheap. Estimated total: about ₹2,500–3,500. Ways to spend less:
  - use a DHT11 instead of a DHT22
  - drop the DS3231 clock module
  - leave out the automatic valve

## How to work on this project

- Prefer changes that make a pipeline stage easier to demonstrate, or that make the analysis more meaningful. Avoid features that do not serve the objective.
- Keep it buildable and affordable for a student team, and explainable: every team member must be able to explain their part in the lab.
- The competition-only sections ("Sustainability Impact Lab", "Judges Demo Mode") were removed in 2.0.0; the dashboard now follows the five questions above.
- The current system: firmware in [ESP32_Code/FlowState_ESP32](ESP32_Code/FlowState_ESP32) (from the team's final sketch: HTTPS to Supabase every 10 s plus MQTT every 2 s), database from [supabase/flowstate_setup.sql](supabase/flowstate_setup.sql) only. Never run the migrations in `archive/`: they block the firmware's uploads.
- The marking scheme (UE23CS342AA3) has ten criteria, each worth 5: problem, architecture, hardware, software, IoT protocols (MQTT/CoAP/BLE/LoRa), analytics and visualization, innovation, documentation and presentation, testing and results, and teamwork. Keep evidence for each in the README and [docs/TESTING.md](docs/TESTING.md).
- Setup, testing and upgrade steps are in [README.md](README.md). The security model is in [SECURITY.md](SECURITY.md).
