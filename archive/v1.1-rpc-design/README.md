# Archive: the v1.1 design (not used by the final system)

This folder keeps an earlier version of FlowState for reference. **The final
system does not use anything in here.**

In v1.1 the ESP32 wrote through key-checked database functions (`ingest_reading`)
and the dashboard sent valve commands through a `valve_commands` table. The team's
final firmware instead posts readings straight into the tables over HTTPS and uses
MQTT for live data and valve commands, so the current system is:

| Part | Where |
| --- | --- |
| Firmware | [`ESP32_Code/FlowState_ESP32`](../../ESP32_Code/FlowState_ESP32) |
| Database | [`supabase/flowstate_setup.sql`](../../supabase/flowstate_setup.sql) |
| Dashboard | [`Web_Dashboard`](../../Web_Dashboard) |
| Tests | [`tests`](../../tests) |

Do not run these migrations on the live project: `20260929_005` blocks the direct
inserts the final firmware makes, and its uploads would stop.
