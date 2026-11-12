/*
 * General page behaviour: notices, theme, the Settings panel, file downloads,
 * and the small "this value just changed" highlight.
 */
(function (FlowState) {
    'use strict';

    const { config } = FlowState;
    const $ = (id) => document.getElementById(id);

    let onThemeChange = () => {};

    // ---------------------------------------------------------------------
    // Notices
    // ---------------------------------------------------------------------
    function toast(message, tone = 'normal') {
        const host = $('toastHost');
        if (!host) return;
        const item = document.createElement('div');
        item.className = `toast toast-${tone}`;
        item.textContent = message;
        host.appendChild(item);
        window.setTimeout(() => {
            item.classList.add('toast-leaving');
            window.setTimeout(() => item.remove(), 250);
        }, 4200);
    }

    // ---------------------------------------------------------------------
    // Theme
    // ---------------------------------------------------------------------
    function prefersDark() {
        return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    function isDark() {
        return document.documentElement.dataset.theme === 'dark';
    }

    function applyTheme(dark) {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        const button = $('themeToggle');
        if (button) button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
        onThemeChange(dark);
    }

    function initTheme(handler) {
        onThemeChange = handler || onThemeChange;
        const saved = config.local.get(config.KEYS.theme);
        applyTheme(saved ? saved === 'dark' : prefersDark());
        $('themeToggle').addEventListener('click', () => {
            const dark = !isDark();
            config.local.set(config.KEYS.theme, dark ? 'dark' : 'light');
            applyTheme(dark);
        });
    }

    // ---------------------------------------------------------------------
    // "Just changed" highlight
    // ---------------------------------------------------------------------
    /** Sets the text and briefly highlights the element when the text actually changed. */
    function setLive(id, text) {
        const element = $(id);
        if (!element || element.textContent === text) return;
        element.textContent = text;
        element.classList.remove('just-changed');
        // Reading offsetWidth restarts the CSS animation.
        void element.offsetWidth;
        element.classList.add('just-changed');
    }

    function setText(id, text) {
        const element = $(id);
        if (element) element.textContent = text;
    }

    // ---------------------------------------------------------------------
    // Settings panel
    // ---------------------------------------------------------------------
    function describeConnection(connection) {
        if (connection.source === 'deployment') return 'Connected to the database this site was deployed with.';
        if (connection.source === 'browser') return 'Using the connection saved in this browser.';
        return 'Not connected yet. Enter the Supabase project URL and the public key, then save.';
    }

    function fillSettings() {
        const connection = config.getConnection();
        ['supabaseUrl', 'supabaseKey'].forEach((id) => {
            $(id).readOnly = connection.locked;
        });
        $('supabaseUrl').value = connection.url;
        $('supabaseKey').value = connection.key;
        $('resetSettingsBtn').hidden = connection.locked;
        $('saveSettingsBtn').hidden = connection.locked;
        $('connectionSource').textContent = describeConnection(connection);
    }

    function openSettings() {
        const panel = $('settingsPanel');
        panel.open = true;
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function initSettings(onConnectionChanged) {
        fillSettings();
        $('saveSettingsBtn').addEventListener('click', () => {
            const before = config.getConnection();
            const result = config.saveConnection($('supabaseUrl').value, $('supabaseKey').value);
            if (!result.ok) {
                toast(result.message, 'critical');
                return;
            }
            const after = config.getConnection();
            fillSettings();
            toast(result.message);
            if (before.url !== after.url || before.key !== after.key) onConnectionChanged();
        });
        $('resetSettingsBtn').addEventListener('click', () => {
            config.resetConnection();
            fillSettings();
            toast('Using the deployment settings again');
            onConnectionChanged();
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
        isDark,
        setLive,
        setText,
        initSettings,
        fillSettings,
        openSettings,
        download
    };
})(window.FlowState = window.FlowState || {});
