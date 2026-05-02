# Contributing to Water Leak Detection System

First off, thank you for considering a contribution to this project! It's people like you that make the Water Leak Detection System such a great tool.

---

## 📋 Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## ❓ How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the [issue list](../../issues) as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

* **Use a clear and descriptive title**
* **Describe the exact steps which reproduce the problem**
* **Provide specific examples to demonstrate the steps**
* **Describe the behavior you observed after following the steps**
* **Explain which behavior you expected to see instead and why**
* **Include screenshots if possible**

#### Bug Report Template

```markdown
**Describe the bug:**
A clear description of what the bug is.

**To Reproduce:**
1. Step 1
2. Step 2
3. Expected behavior

**Actual Behavior:**
What actually happened

**Environment:**
- Arduino IDE Version: [e.g., 2.0.3]
- ESP32 Board Version: [e.g., 2.0.4]
- Browser: [e.g., Chrome 96.0]
- OS: [e.g., Windows 11, macOS 12]

**Additional context:**
Add screenshots, logs, or serial output here
```

---

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

* **Use a clear and descriptive title**
* **Provide a step-by-step description of the suggested enhancement**
* **Provide specific examples to demonstrate the steps**
* **Describe the current behavior and expected behavior**
* **Explain why this enhancement would be useful**

#### Enhancement Template

```markdown
**Is your feature request related to a problem?**
Description of the problem

**Describe the solution you'd like:**
Clear description of what you want to happen

**Describe alternatives you've considered:**
Any alternative solutions or features

**Additional context:**
Any other context or screenshots
```

---

## 🔧 Pull Requests

* Fill in the required template
* Follow the code style guidelines
* Include appropriate test cases
* End all files with a newline
* Avoid platform-specific code

### PR Checklist

- [ ] My code follows the style guidelines
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have tested the changes locally
- [ ] My change doesn't break any existing functionality

---

## 📝 Style Guidelines

### C++ (ESP32 Firmware)

```cpp
// Use descriptive variable names
const int FLOW_SENSOR_1_PIN = 19;

// Add comments for complex logic
// Calculate flow rate: Hz / 7.5 = L/min
float flow_rate = pulse_frequency / 7.5;

// Use meaningful function names
void send_data_to_supabase() { }
void calculate_leak_percentage() { }

// Format: Two spaces for indentation
if (condition) {
  // Do something
}

// Use UPPERCASE for constants
const float NORMAL_LOSS_THRESHOLD = 5.0;
const int MAX_RETRIES = 3;
```

### JavaScript (Web Dashboard)

```javascript
// Use camelCase for variables and functions
let supabaseClient;
function fetchLatestReadings() { }

// Use const by default, let if reassignment needed
const CONFIG = { ... };
let isOnline = true;

// Meaningful variable names
const waterLevelPercentage = (sensorValue / maxValue) * 100;

// Arrow functions for callbacks
data.forEach(reading => {
  console.log(reading.timestamp);
});

// Comment complex logic
// Calculate loss: ((Flow1 - Flow2) / Flow1) * 100
const percentageLoss = ((flow1 - flow2) / flow1) * 100;
```

### HTML/CSS

```html
<!-- Use semantic HTML tags -->
<button class="btn btn-primary">Open Valve</button>
<section class="dashboard-section">
  <!-- Use meaningful class names -->
  <div class="tank-level-indicator"></div>
</section>

<!-- CSS: Use relevant selectors -->
.valve-control {
  /* ... */
}

.alert-critical {
  background-color: #dc3545;
}
```

---

## 🧪 Testing

Before submitting:

1. **Test on actual hardware** - Upload to ESP32 and verify Serial output
2. **Test dashboard** - Open in multiple browsers (Chrome, Firefox, Safari)
3. **Test database** - Verify data appears in Supabase
4. **Test edge cases**:
   - Low flow rates
   - No internet connection
   - Sensor disconnection
   - Power loss scenarios

### Serial Monitor Verification

```
[WiFi] Connected successfully
[SUPABASE] HTTP 200 OK - Ready to send data
[SENSOR] Flow1: X.XX L/min | Flow2: X.XX L/min
[SUPABASE] Data uploaded successfully
```

---

## 📚 Documentation

If you're adding new features:

1. Update the relevant section in README.md
2. Add inline code comments
3. Include before/after screenshots for UI changes
4. Add example usage in documentation

---

## 🚀 Development Setup

### For ESP32 Firmware

1. Install Arduino IDE
2. Add ESP32 board support
3. Install required libraries (ArduinoJson, RTClib)
4. Clone this repository
5. Configure WiFi & Supabase credentials in code
6. Build and upload

### For Web Dashboard

1. Clone this repository
2. Make changes to HTML/CSS/JS in Web_Dashboard/
3. Test locally by opening index.html in browser
4. Test with actual ESP32 sending data
5. Verify in Supabase dashboard

---

## 🔄 Pull Request Process

1. **Fork the repository**
2. **Create a feature branch** (`git checkout -b feature/description`)
3. **Make your changes**
4. **Add/update documentation**
5. **Test thoroughly**
6. **Commit with clear messages** (`git commit -m "Add feature: clear description"`)
7. **Push to your fork** (`git push origin feature/description`)
8. **Create Pull Request** with detailed description
9. **Respond to code review feedback**

### Commit Message Guidelines

```
[Type] Brief description (50 chars max)

Longer explanation with more details if needed.
Explain what the change does and why.

- Bullet point 1
- Bullet point 2

Fixes #123
```

**Types**: `[Feature]`, `[Bug]`, `[Fix]`, `[Docs]`, `[Style]`, `[Refactor]`, `[Test]`

---

## 🐛 Bug Fix Process

1. Report the bug with detailed reproduction steps
2. Discuss the approach in the issue
3. Fork, create feature branch
4. Add test/reproduction case if possible
5. Fix the issue
6. Add comments explaining the fix
7. Test thoroughly
8. Submit PR with reference to issue

---

## ✨ Feature Development

**Before starting significant work:**
1. Open an issue first to discuss the feature
2. Wait for maintainer feedback
3. Get approval before heavy development
4. Reference the issue in your PR

---

## 📋 Code Review Checklist

When reviewing code:

- [ ] Code follows style guidelines
- [ ] Documentation is updated
- [ ] No unnecessary comments (code should be self-documenting)
- [ ] Changes are tested
- [ ] No breaking changes without discussion
- [ ] Error handling is present
- [ ] Performance implications considered
- [ ] Security implications considered

---

## 💡 Tips for Contributing

1. **Start small** - Fix a typo, improve documentation, add a comment
2. **Read existing code** - Understand the architecture before major changes
3. **Ask questions** - Open an issue to discuss approach
4. **Keep focused** - One feature per PR
5. **Test thoroughly** - Especially on hardware
6. **Write clearly** - Both code and comments

---

## 🆘 Need Help?

* **Questions?** Open a discussion or GitHub issue
* **Documentation unclear?** Let us know and we'll improve it
* **Stuck?** Ask for help in the issue tracker

---

## 📞 Attribution

Contributors will be added to:
- CONTRIBUTORS.md
- GitHub contributors page
- Project documentation

---

## 📜 License

By contributing, you agree that your contributions will be licensed under its MIT License.

---

## 🎓 Resources

- [ESP32 Documentation](https://docs.espressif.com/projects/esp-idf/en/latest/)
- [Arduino Reference](https://www.arduino.cc/reference/en/)
- [Supabase Docs](https://supabase.com/docs)
- [Git Basics](https://git-scm.com/book/en/v2)

---

Thank you for contributing! 🙌

**Last Updated**: February 2026
