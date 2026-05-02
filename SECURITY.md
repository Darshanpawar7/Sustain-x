# Security Policy

## Supported Versions

| Version | Status | Security Updates |
|---------|--------|------------------|
| 1.0.x | Current | ✅ Supported |
| < 1.0 | Deprecated | ❌ Not Supported |

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

## Security Considerations

### Hardware Security
- **Never hardcode credentials** in firmware
- Use environment variables for WiFi/Supabase keys
- Consider hardware encryption for production
- Validate all sensor inputs for anomalies

### Software Security
- All data transmitted via HTTPS (Supabase)
- Never commit credentials to Git
- Use `.env` files for local development
- Rotate API keys regularly
- Update dependencies regularly

### Data Security
- Water usage data classified as potentially sensitive
- Supabase provides encryption at rest and in transit
- Implement RLS policies for authentication
- Regular backups recommended
- GDPR/privacy considerations for residential setups

### Network Security
- ESP32 connects to WiFi only (no hardwired network)
- Firewall input on Supabase if possible
- Use WPA3 if available on router
- Disable unnecessary exposed endpoints

---

## Security Best Practices

### For Development

```
✅ DO:
- Use .gitignore to exclude .env files
- Store secrets in environment variables
- Use HTTPS for all connections
- Update libraries regularly
- Review dependencies for vulnerabilities
- Use strong WiFi passwords
- Implement input validation
- Add error handling without exposing details

❌ DON'T:
- Commit API keys to Git
- Use weak passwords
- Hardcode secrets in code
- Use deprecated libraries
- Skip security warnings
- Trust all sensor inputs
- Leave debugging enabled in production
```

### For Deployment

```
✅ DO:
- Rotate API keys annually
- Use Row Level Security (RLS) policies
- Enable database backups
- Monitor for suspicious activity
- Keep firmware updated
- Use secure WiFi protocols
- Implement access controls
- Log all important events

❌ DON'T:
- Use default credentials anywhere
- Grant unnecessary permissions
- Expose admin dashboards publicly
- Skip security patches
- Trust unverified sensor data
- Leave debug endpoints active
- Ignore security warnings
```

---

## Known Security Limitations

### Hardware
- ESP32 memory constraints limit encryption options
- No hardware security module on standard devboards
- WiFi limited to 2.4GHz (less secure than 5GHz + WPA3)
- Serial debug interface accessible when connected

### Software
- Sensor readings not cryptographically verified
- Dashboard stored in browser localStorage
- No built-in multi-factor authentication
- API keys stored unencrypted in browser

### Recommendations
- Disable Serial debug in production
- Use strong WiFi WPA3 if available
- Implement network-level security (firewall/VPN)
- Monitor Supabase logs regularly
- Use read-only API keys when possible

---

## Dependency Security

### Current Dependencies
- **ArduinoJson** - Monitor releases for security updates
- **RTClib** - Maintained by Adafruit (good track record)
- **Supabase SDK** - Enterprise-grade security
- **Chart.js** - Popular, well-maintained library

### Checking for Vulnerabilities

```bash
# For Python/npm dependencies
npm audit
pip audit

# For Arduino libraries
# Check manually via Arduino IDE library manager
```

---

## Secure Configuration Example

### ESP32 Firmware (.ino)
```cpp
// ✅ GOOD - Use environment variables
const char* SSID = getenv("WIFI_SSID");
const char* PASSWORD = getenv("WIFI_PASSWORD");
const char* SUPABASE_KEY = getenv("SUPABASE_KEY");

// ❌ BAD - Hardcoded
// const char* SSID = "myWiFi";
// const char* PASSWORD = "password123";
```

### Dashboard (.env.local)
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_KEY=your_anon_key_here
# Don't commit this file!
```

---

## Security Incident Response

If a security vulnerability is discovered:

1. **Immediate action**: Apply temporary mitigation if possible
2. **Notification**: Maintainers investigate within 24 hours
3. **Development**: Security patch developed in private
4. **Testing**: Thoroughly tested before release
5. **Release**: Version bump and security advisory issued
6. **Communication**: Public disclosure 48 hours after patch

---

## Security Roadmap

### v1.1 (Future)
- [ ] Hardware encryption support
- [ ] Two-factor authentication
- [ ] JWT token support
- [ ] End-to-end encryption option
- [ ] Enhanced audit logging

### v1.2+ (Planned)
- [ ] Hardware security module integration
- [ ] Advanced threat detection
- [ ] Compliance features (GDPR, etc.)
- [ ] Penetration testing program

---

## Third-Party Security

### Supabase Security
- SOC 2 Type II compliant
- Encryption at rest and in transit
- DDoS protection
- Regular security audits
- See: https://supabase.com/docs/guides/security

### Arduino/ESP32 Security
- Regular firmware updates
- Community-driven security
- Known CVE tracking
- See: https://github.com/espressif/ESP-IDF/releases

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
- [ESP32 Security](https://esp32.com/wiki/index.php/Security)
- [Arduino Security Guidelines](https://www.arduino.cc/en/Guide/Troubleshooting)
- [Supabase Security](https://supabase.com/docs/guides/security)
- [Secure Coding Practices](https://cheatsheetseries.owasp.org/)

---

**Last Updated**: February 2026  
**Status**: Active ✅

Thank you for helping keep this project secure!
