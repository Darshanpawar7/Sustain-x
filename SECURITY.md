# Security Policy

## Supported Versions

| Version | Status | Security Updates |
|---------|--------|------------------|
| 1.1.x | Current | ✅ Supported |
| 1.0.x | Superseded | ❌ Not supported: upgrade to 1.1 (the public key could write data) |

---

## Reporting a Vulnerability

**Please do NOT publicly disclose security vulnerabilities.** Instead:

1. **Open a private security advisory** through GitHub
   - Go to Security → Advisories
   - Click "Report a vulnerability"
   - Provide detailed information

2. **Or email the maintainers** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if available)

3. **Response timeline**
   - Initial response: Within 48 hours
   - Patch release: Within 2 weeks (critical)
   - Public disclosure: After patch release

---

## Access Model

| Who | Credential | Can do |
|-----|------------|--------|
| Anyone who opens the dashboard | Public key (anon or publishable) | Read readings, alerts and valve-command status. Cannot write anything directly. |
| The ESP32 | Public key + its **device key** | Store readings and alerts through `ingest_reading` and `log_device_alert`, and collect valve commands |
| An operator | Public key + an **operator key** | Queue valve open/close commands through `request_valve_command` (rate-limited) |
| The project owner | Supabase dashboard / SQL editor | Create and revoke keys, run migrations |

- Device and operator keys are random 48-character values. The database stores only their SHA-256 hashes, in a `private` schema that the API does not expose.
- All database timestamps are set by the server, so a client cannot backdate or future-date data.
- The `service_role` key must never be used in the firmware or the dashboard. The Netlify build and the dashboard's Settings panel both refuse it.

### Managing keys

```sql
select private.create_access_key('operator-1', 'operator');  -- shown once
select private.revoke_access_key('operator-1');              -- stops working immediately
select label, role, created_at, last_used_at, revoked_at from private.access_keys;
```

To rotate the device key: create a new one, update `secrets.h`, flash the device, then revoke the old key.

---

## Security Considerations

### Hardware
- Credentials live in `ESP32_Code/water_monitoring/secrets.h`, which git ignores. Only `secrets.example.h` is committed.
- The firmware checks Supabase's HTTPS certificate against the ESP32 core's built-in list of trusted certificate authorities.
- Anyone with physical access can read the device's flash. Treat a lost device's key as exposed and revoke it.

### Software
- The dashboard inserts all database text as plain text, never as HTML.
- On Netlify the dashboard is served with a strict Content-Security-Policy (no inline scripts, and connections only to your Supabase project), plus `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`.
- Third-party scripts are pinned to exact versions and loaded with Subresource Integrity hashes.
- The valve control key is kept in the browser tab's session storage and is cleared when the tab closes.
- A deployed dashboard only connects to the database it was deployed with; its Settings panel cannot redirect it.

### Data Security
- Water usage data can reveal when a home is occupied. The dashboard's data is readable by anyone who can open the site; if that is not acceptable, put the site behind authentication and tighten the read policies.
- Supabase provides encryption at rest and in transit.
- Readings are kept for 30 days and alerts for 180 days (see `private.purge_old_data`).
- Regular backups are recommended.

### Network Security
- The ESP32 connects over Wi-Fi only (2.4 GHz). Use WPA2 or WPA3.
- Put IoT devices on a separate network from personal computers where possible.

---

## Security Best Practices

### For Development

```
✅ DO:
- Keep secrets in secrets.h (firmware) and Netlify environment variables (dashboard)
- Use the anon/publishable key in the browser and on the device
- Run the tests before pushing (npm test, npm run test:db, npm run test:e2e)
- Update libraries regularly and review what changed

❌ DON'T:
- Commit real Wi-Fi passwords, device keys or operator keys
- Put the service_role key anywhere outside the Supabase dashboard
- Render database text with innerHTML
- Turn off HTTPS certificate checking on the device
```

### For Deployment

```
✅ DO:
- Give each operator their own key and revoke keys that are no longer needed
- Keep RLS enabled on every table
- Check Supabase logs for repeated rejected keys
- Keep firmware updated

❌ DON'T:
- Share one operator key widely
- Grant write permissions to anon or authenticated roles
- Leave the serial console connected on an unattended device
```

---

## Known Security Limitations

### Hardware
- No secure element: keys in flash can be read by someone with physical access.
- The serial console can open and close the valve and disable automatic shut-off (`OVERRIDE_ON`). Such actions are logged as alerts.

### Software
- Operator keys are shared secrets, not user accounts. There is no per-person login or multi-factor authentication.
- Anyone with the public key can call the key-checked functions with wrong keys. Each attempt costs one hash and one indexed lookup. There is no per-client rate limit on the API itself; for a public deployment under attack, put a rate-limiting proxy in front of Supabase.
- With a valid key, the database accepts at most 30 readings and 20 alerts a minute, and 6 valve commands a minute.
- Readings are not cryptographically signed by the device.

### Recommendations
- Use Supabase Auth with an allow-list if you need per-person accounts for valve control.
- Monitor `private.access_keys.last_used_at` for unexpected use.

---

## Dependency Security

### Current Dependencies
- **Firmware:** ArduinoJson 7, RTClib, ESP32Servo, DHT sensor library, Adafruit Unified Sensor, esp32 core 3.3+
- **Dashboard:** Supabase JS 2.117.2 and Chart.js 3.9.1 from jsDelivr, pinned with integrity hashes
- **Tests only:** Playwright

### Checking for Vulnerabilities

```bash
# JavaScript test tooling
npm audit

# Arduino libraries: check versions in the Library Manager
```

When upgrading a CDN library, update both the version in `Web_Dashboard/index.html` and its `integrity` hash, and the matching `devDependencies` version in `package.json` (the browser tests verify they agree).

---

## Secure Configuration Example

### ESP32 Firmware (`secrets.h`, not committed)
```cpp
constexpr const char *WIFI_SSID = "your-network";
constexpr const char *WIFI_PASSWORD = "your-password";
constexpr const char *SUPABASE_URL = "https://your-project.supabase.co";
constexpr const char *SUPABASE_ANON_KEY = "your-anon-or-publishable-key";
constexpr const char *DEVICE_KEY = "key from private.create_access_key";
```

### Dashboard (Netlify environment variables)
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-or-publishable-key
```

---

## Security Incident Response

If a security vulnerability is discovered:

1. **Immediate action**: Apply temporary mitigation if possible (for example, revoke exposed keys)
2. **Notification**: Maintainers investigate within 24 hours
3. **Development**: Security patch developed in private
4. **Testing**: Thoroughly tested before release
5. **Release**: Version bump and security advisory issued
6. **Communication**: Public disclosure 48 hours after patch

---

## Security Roadmap

### Future
- [ ] Per-user accounts for valve control (Supabase Auth)
- [ ] Signed readings from the device
- [ ] Enhanced audit logging

---

## Third-Party Security

### Supabase Security
- SOC 2 Type II compliant
- Encryption at rest and in transit
- See: https://supabase.com/docs/guides/security

### Arduino/ESP32 Security
- See: https://github.com/espressif/arduino-esp32/releases

---

## Compliance

This project aims to be compatible with:
- **GDPR** - For European users (data privacy)
- **CCPA** - For California users
- **General IoT Security Best Practices**

---

## Security Contact

For security issues, contact maintainers through GitHub security advisory.

**Please do not**:
- Report security issues in public issues
- Post exploits or proof-of-concept code publicly
- Demonstrate vulnerabilities on production systems without permission

---

## Resources

- [OWASP IoT Security](https://owasp.org/www-project-internet-of-things/)
- [Supabase Security](https://supabase.com/docs/guides/security)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Secure Coding Practices](https://cheatsheetseries.owasp.org/)

---

**Last Updated**: September 2026

Thank you for helping keep this project secure!
