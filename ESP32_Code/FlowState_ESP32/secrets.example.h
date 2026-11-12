// Copy this file to secrets.h (in the same folder) and fill in your values.
// secrets.h is ignored by git, so passwords and keys are never published.
#pragma once

// Wi-Fi: a 2.4 GHz network (the ESP32 cannot join 5 GHz networks).
const char* const WIFI_SSID = "YOUR_WIFI_NAME";
const char* const WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Supabase: Project Settings -> API. Use the anon (public) key, NEVER the service_role key.
const char* const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const char* const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

// Valve key: a random secret of 16+ characters. Type the same key into the
// dashboard (Valve control) to open or close the valve from the browser.
// Make one with:  node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
const char* const VALVE_COMMAND_KEY = "CHANGE_ME_TO_A_RANDOM_KEY";
