// Copy this file to secrets.h (in the same folder) and fill in your values.
// secrets.h is ignored by git, so your credentials are never committed.
#pragma once

constexpr const char *WIFI_SSID = "YOUR_WIFI_SSID";  // 2.4 GHz network
constexpr const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Supabase project URL and its public key (anon or publishable key, never the service_role key).
constexpr const char *SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
constexpr const char *SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

// This device's own secret key. Create it in the Supabase SQL editor with:
//   select private.create_access_key('esp32-main', 'device');
constexpr const char *DEVICE_KEY = "PASTE_THE_DEVICE_KEY_HERE";
