/*
 * General page behaviour: notices, theme, reveal animations, the judges' demo
 * tour, critical-only mobile mode, the Settings panel and file downloads.
 */
(function (FlowState) {
    'use strict';

    const { config } = FlowState;
    const $ = (id) => document.getElementById(id);

    const MOBILE_QUERY = '(max-width: 768px)';
    const DEMO_STEP_MS = 4200;
    const DEMO_STEPS = [
        { selector: '#demoProblemCard', label: 'Problem Understanding (15)' },
        { selector: '#demoInnovationCard', label: 'Innovation (20)' },
        { selector: '#demoTechCard', label: 'Technical Implementation (20)' },
        { selector: '#demoImpactCard', label: 'Sustainability Impact (15)' },
        { selector: '#demoFeasibilityCard', label: 'Feasibility & Scalability (15)' },
        { selector: '#demoPresentationCard', label: 'Presentation & Demo (10)' },
        { selector: '#demoUxCard', label: 'UI/UX' }
    ];

    let darkMode = false;
    let onThemeChange = () => {};
    let criticalOnlyPreferred = false;
    let onCriticalOnlyChange = () => {};
    const demo = { active: false, onePass: false, stepIndex: 0, timer: null };

    // ---------------------------------------------------------------------
    // Notices
    // ---------------------------------------------------------------------
    function toast(message, tone = 'normal') {
        const host = $('toastHost');
        if (!host) return;
        const item = document.createElement('div');
        item.className = `toast ${tone}`;
        item.textContent = message;
        host.appendChild(item);
        window.setTimeout(() => {
            item.classList.add('toast-leaving');
            window.setTimeout(() => item.remove(), 250);
        }, 3600);
    }

    // ---------------------------------------------------------------------
    // Theme
    // ---------------------------------------------------------------------
    function applyTheme(dark) {
        darkMode = dark;
        document.body.classList.toggle('dark-mode', dark);
        const button = $('themeToggle');
        if (button) button.textContent = dark ? 'Switch to Day Mode' : 'Switch to Night Mode';
        onThemeChange(dark);
    }

    function initTheme(handler) {
        onThemeChange = handler || onThemeChange;
        applyTheme(config.local.get('theme') === 'dark');
        const button = $('themeToggle');
        if (button) {
            button.addEventListener('click', () => {
                config.local.set('theme', darkMode ? 'light' : 'dark');
                applyTheme(!darkMode);
            });
        }
    }

    function isDarkMode() {
        return darkMode;
    }

    // ---------------------------------------------------------------------
    // Reveal animations
    // ---------------------------------------------------------------------
    function initRevealAnimations() {
        const targets = document.querySelectorAll('.card, .chart-container');
        if (!targets.length) return;
        if (!('IntersectionObserver' in window)) {
            targets.forEach((element) => element.classList.add('visible'));
            return;
        }
        targets.forEach((element, index) => {
            element.classList.add('card-reveal');
            element.style.transitionDelay = `${Math.min(index * 40, 320)}ms`;
        });
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                const element = entry.target;
                element.classList.add('visible');
                observer.unobserve(element);
                // Drop the stagger once revealed so hover effects respond instantly.
                window.setTimeout(() => {
                    element.style.transitionDelay = '';
                }, 900);
            });
        }, { threshold: 0.1 });
        targets.forEach((element) => observer.observe(element));
    }

    // ---------------------------------------------------------------------
    // Judges' demo tour
    // ---------------------------------------------------------------------
    function demoSteps() {
        return DEMO_STEPS
            .map((step) => ({ ...step, element: document.querySelector(step.selector) }))
            .filter((step) => step.element);
    }

    function showDemoStep(steps, index) {
        steps.forEach((step, stepIndex) => step.element.classList.toggle('demo-focus', stepIndex === index));
        const active = steps[index];
        if (!active) return;
        active.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const status = $('judgesDemoStatus');
        if (status) status.textContent = `Demo: ${active.label}`;
    }

    function renderDemoControls() {
        const button = $('judgesDemoToggle');
        const status = $('judgesDemoStatus');
        if (button) {
            button.classList.toggle('active', demo.active);
            button.textContent = demo.active ? '■ Stop Judges Demo' : '▶ Judges Demo Mode';
        }
        if (!demo.active && status) {
            status.textContent = demo.onePass ? 'Demo: Manual (one pass ready)' : 'Demo: Manual (loop ready)';
        }
    }

    function stopDemo(completed = false) {
        window.clearInterval(demo.timer);
        demo.timer = null;
        demo.active = false;
        demo.stepIndex = 0;
        document.querySelectorAll('.criterion-card.demo-focus').forEach((card) => card.classList.remove('demo-focus'));
        renderDemoControls();
        toast(completed ? 'Judges demo finished its one pass' : 'Judges demo stopped');
    }

    function startDemo() {
        const steps = demoSteps();
        if (!steps.length) {
            toast('Judges demo unavailable: criteria cards not found.', 'warning');
            return;
        }
        demo.active = true;
        demo.stepIndex = 0;
        renderDemoControls();
        showDemoStep(steps, 0);
        demo.timer = window.setInterval(() => {
            if (demo.onePass && demo.stepIndex >= steps.length - 1) {
                stopDemo(true);
                return;
            }
            demo.stepIndex = (demo.stepIndex + 1) % steps.length;
            showDemoStep(steps, demo.stepIndex);
        }, DEMO_STEP_MS);
        toast(demo.onePass ? 'Judges demo started (one pass)' : 'Judges demo started (loop)');
    }

    function initJudgesDemo() {
        const button = $('judgesDemoToggle');
        const onePass = $('judgesDemoOnePass');
        demo.onePass = config.local.get('judgesDemoOnePass') === 'true';
        if (onePass) {
            onePass.checked = demo.onePass;
            onePass.addEventListener('change', () => {
                demo.onePass = onePass.checked;
                config.local.set('judgesDemoOnePass', String(demo.onePass));
                renderDemoControls();
            });
        }
        if (button) button.addEventListener('click', () => (demo.active ? stopDemo() : startDemo()));
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && demo.active) stopDemo();
        });
        renderDemoControls();
    }

    // ---------------------------------------------------------------------
    // Critical-only mode on phones
    // ---------------------------------------------------------------------
    function criticalOnlyActive() {
        return criticalOnlyPreferred && window.matchMedia(MOBILE_QUERY).matches;
    }

    function applyCriticalOnly() {
        const active = criticalOnlyActive();
        document.body.classList.toggle('mobile-critical-mode', active);
        onCriticalOnlyChange(active);
    }

    function initCriticalOnly(handler) {
        onCriticalOnlyChange = handler || onCriticalOnlyChange;
        const toggle = $('mobileCriticalOnly');
        criticalOnlyPreferred = config.local.get('mobileCriticalOnly') === 'true';
        if (toggle) {
            toggle.checked = criticalOnlyPreferred;
            toggle.addEventListener('change', () => {
                criticalOnlyPreferred = toggle.checked;
                config.local.set('mobileCriticalOnly', String(criticalOnlyPreferred));
                applyCriticalOnly();
            });
        }
        const query = window.matchMedia(MOBILE_QUERY);
        if (typeof query.addEventListener === 'function') query.addEventListener('change', applyCriticalOnly);
        else query.addListener(applyCriticalOnly);
        applyCriticalOnly();
    }

    // ---------------------------------------------------------------------
    // Settings panel
    // ---------------------------------------------------------------------
    function describeConnection(connection) {
        if (connection.source === 'deployment') {
            return 'Connected to the database this site was deployed with. Only the valve control key can be set here.';
        }
        if (connection.source === 'browser') return 'Using connection settings saved in this browser.';
        return 'Not connected: enter your Supabase URL and public key, then save.';
    }

    function fillSettings() {
        const connection = config.getConnection();
        ['supabaseUrl', 'supabaseKey'].forEach((id) => {
            $(id).readOnly = connection.locked;
        });
        $('supabaseUrl').value = connection.url;
        $('supabaseKey').value = connection.key;
        $('resetSettingsBtn').hidden = connection.locked;
        $('operatorKey').value = config.getOperatorKey();
        $('connectionSource').textContent = describeConnection(connection);
    }

    function openSettings(focusId) {
        const panel = $('settingsPanel');
        if (!panel) return;
        panel.open = true;
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const field = focusId ? $(focusId) : null;
        if (field) window.setTimeout(() => field.focus(), 350);
    }

    function initSettings(onConnectionChanged) {
        fillSettings();
        $('saveSettingsBtn').addEventListener('click', () => {
            const before = config.getConnection();
            if (!before.locked) {
                const result = config.saveConnection($('supabaseUrl').value, $('supabaseKey').value);
                if (!result.ok) {
                    toast(result.message, 'critical');
                    return;
                }
            }
            config.setOperatorKey($('operatorKey').value);
            const after = config.getConnection();
            fillSettings();
            toast('Settings saved');
            if (before.url !== after.url || before.key !== after.key) onConnectionChanged();
        });
        $('resetSettingsBtn').addEventListener('click', () => {
            config.resetConnection();
            fillSettings();
            toast('Using the deployment settings again');
            onConnectionChanged();
        });
        $('forgetOperatorKeyBtn').addEventListener('click', () => {
            config.setOperatorKey('');
            $('operatorKey').value = '';
            toast('Valve control key removed from this tab');
        });
    }

    // ---------------------------------------------------------------------
    // Downloads
    // ---------------------------------------------------------------------
    function download(content, filename, type) {
        const url = URL.createObjectURL(new Blob([content], { type }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    FlowState.ui = {
        toast,
        initTheme,
        isDarkMode,
        initRevealAnimations,
        initJudgesDemo,
        initCriticalOnly,
        criticalOnlyActive,
        initSettings,
        fillSettings,
        openSettings,
        describeConnection,
        download
    };
})(window.FlowState = window.FlowState || {});
