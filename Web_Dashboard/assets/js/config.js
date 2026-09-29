/*
 * Dashboard settings: fixed values, deployment settings from env.js, and what
 * the user saved in this browser.
 */
(function (FlowState) {
    'use strict';

    const lib = FlowState.lib;

    // Keep the first four in step with flowstate_config.h in the firmware.
    const settings = Object.freeze({
        tankHeightCm: 100,
        deviceUploadIntervalMs: 5000,
        warningFromPercent: 5,
        criticalAbovePercent: 15,
        costPerLiter: 0.05,
        co2KgPerLiter: 0.00034,
        litersPerPersonPerDay: 50,
        latestReadingPollMs: 5000,
        alertsPollMs: 30000,
        usageRefreshMs: 60000,
        commandPollMs: 2000,
        commandTimeoutMs: 90000,
        maxAlerts: 50,
        historyTtlMs: Object.freeze({ '15m': 15000, '1h': 60000, '6h': 180000, '24h': 300000 })
    });

    const KEYS = Object.freeze({
        url: 'flowstate.supabaseUrl',
        key: 'flowstate.supabaseKey',
        operatorKey: 'flowstate.operatorKey',
        acknowledged: 'flowstate.acknowledgedAlerts'
    });

    function storageArea(name) {
        try {
            return window[name] || null;
        } catch (_) {
            return null;
        }
    }

    function read(areaName, key) {
        const area = storageArea(areaName);
        if (!area) return null;
        try {
            return area.getItem(key);
        } catch (_) {
            return null;
        }
    }

    function write(areaName, key, value) {
        const area = storageArea(areaName);
        if (!area) return;
        try {
            if (value === null || value === undefined) area.removeItem(key);
            else area.setItem(key, value);
        } catch (_) {
            // Storage can be full or blocked; the dashboard still works without it.
        }
    }

    const local = { get: (key) => read('localStorage', key), set: (key, value) => write('localStorage', key, value) };
    const session = { get: (key) => read('sessionStorage', key), set: (key, value) => write('sessionStorage', key, value) };

    function env() {
        return window.__ENV__ || {};
    }

    /**
     * Older versions saved connection values under generic keys, sometimes just
     * by pressing Ctrl+S. Those values could also have been planted through the
     * old alert injection hole, so they are cleared rather than trusted.
     * @returns {boolean} true when custom values were cleared
     */
    function migrateLegacySettings() {
        const legacyUrl = local.get('supabaseUrl');
        const legacyKey = local.get('supabaseKey');
        const hadCustomValues = Boolean(
            lib.overrideToSave(legacyUrl, env().SUPABASE_URL) || lib.overrideToSave(legacyKey, env().SUPABASE_KEY)
        );

        const legacyAcks = local.get('acknowledgedAlerts');
        if (legacyAcks !== null && local.get(KEYS.acknowledged) === null) {
            try {
                const migrated = JSON.parse(legacyAcks)
                    .filter((key) => /^id:\d+$/.test(key))
                    .map((key) => `db:${key.slice(3)}`);
                local.set(KEYS.acknowledged, JSON.stringify(migrated));
            } catch (_) {
                // Unreadable old data is simply dropped.
            }
        }

        ['supabaseUrl', 'supabaseKey', 'normalThreshold', 'warningThreshold', 'apiBaseUrl', 'acknowledgedAlerts']
            .forEach((key) => local.set(key, null));
        return hadCustomValues;
    }

    function getConnection() {
        return lib.resolveConnection(env(), { url: local.get(KEYS.url), key: local.get(KEYS.key) });
    }

    /** @returns {{ok: boolean, message: string}} */
    function saveConnection(url, key) {
        if (getConnection().locked) {
            return { ok: false, message: 'This site is fixed to the database it was deployed with.' };
        }
        const cleanedUrl = lib.cleanUrl(url);
        const cleanedKey = String(key || '').trim();
        if (cleanedUrl && !lib.isValidSupabaseUrl(cleanedUrl)) {
            return { ok: false, message: 'The Supabase URL must start with https://' };
        }
        if (cleanedKey && lib.keyKind(cleanedKey) === 'secret') {
            return {
                ok: false,
                message: 'That is a secret (service_role) key. Never use it in a browser: use the anon or publishable key.'
            };
        }
        local.set(KEYS.url, lib.overrideToSave(cleanedUrl, lib.cleanUrl(env().SUPABASE_URL)));
        local.set(KEYS.key, lib.overrideToSave(cleanedKey, env().SUPABASE_KEY));
        return { ok: true, message: 'Connection settings saved' };
    }

    function resetConnection() {
        local.set(KEYS.url, null);
        local.set(KEYS.key, null);
    }

    // The valve control key is kept only for this browser tab.
    function getOperatorKey() {
        return session.get(KEYS.operatorKey) || '';
    }

    function setOperatorKey(value) {
        const cleaned = String(value || '').trim();
        session.set(KEYS.operatorKey, cleaned || null);
    }

    function getAdapterConfig() {
        const mode = String(env().API_ADAPTER_MODE || 'local').toLowerCase();
        const baseUrl = lib.cleanUrl(env().API_BASE_URL);
        if (mode === 'remote' && lib.isValidSupabaseUrl(baseUrl)) return { mode: 'remote', baseUrl };
        return { mode: 'local', baseUrl: '' };
    }

    FlowState.config = {
        settings,
        KEYS,
        local,
        session,
        migrateLegacySettings,
        getConnection,
        saveConnection,
        resetConnection,
        getOperatorKey,
        setOperatorKey,
        getAdapterConfig
    };
})(window.FlowState = window.FlowState || {});
