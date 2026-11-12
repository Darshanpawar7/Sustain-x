/*
 * Dashboard settings: the project, values copied from the final ESP32 sketch,
 * deployment settings from env.js, and what the viewer saved in this browser.
 */
(function (FlowState) {
    'use strict';

    const lib = FlowState.lib;

    const project = Object.freeze({
        team: 'Team 10',
        // Fill in the four members to show the "Team 10" section and the footer names, e.g.
        // { name: 'A. Student', role: 'Team Lead', part: 'Process: leak rules, valve and night watch on the ESP32' }
        members: Object.freeze([]),
        title: 'IoT Water Leak Detection and Consumption Analytics Using Dual Flow Sensors'
    });

    // Keep these in step with FlowState_ESP32_Final.ino.
    const device = Object.freeze({
        timeZone: 'Asia/Kolkata',          // the DS3231 keeps India time
        uploadIntervalMs: 10000,           // SUPABASE_UPLOAD_INTERVAL_MS
        detectionWindowSeconds: 60,        // DETECTION_WINDOW_MS
        normalBelowPercent: 5,             // NORMAL_LOSS_THRESHOLD_PERCENT
        criticalFromPercent: 15,           // WARNING_LOSS_THRESHOLD_PERCENT
        tankHeightCm: 100,                 // TANK_HEIGHT_CM
        nightStartHour: 2,                 // NIGHT_START_HOUR
        nightEndHour: 5,                   // NIGHT_END_HOUR
        baselineDays: 3,                   // BASELINE_DAYS_REQUIRED
        unusualRatio: 1.5                  // checkAnomaly(): 1.5x the learned hour
    });

    // MQTT: the ESP32 publishes live telemetry here; the page subscribes over
    // secure WebSockets. Keep topicRoot in step with MQTT_TOPIC_ROOT in the sketch.
    const environment = window.__ENV__ || {};
    const mqtt = Object.freeze({
        url: String(environment.MQTT_URL || 'wss://broker.hivemq.com:8884/mqtt'),
        topicRoot: String(environment.MQTT_TOPIC_ROOT || 'flowstate/team10-d76014'),
        brokerName: String(environment.MQTT_BROKER_NAME || 'HiveMQ public broker'),
        pingEveryMs: 10000,
        commandTimeoutMs: 10000
    });

    const settings = Object.freeze({
        analysisDays: 7,
        liveWindowMs: 15 * 60000,
        defaultTariffPerKiloliter: 20,     // rupees per 1,000 L; each viewer can change it
        latestReadingPollMs: 10000,        // only when live updates are unavailable
        realtimeSafetyPollMs: 30000,       // live updates can miss an insert (e.g. one made as they connect)
        alertsPollMs: 30000,
        summaryRefreshMs: 30000,
        maxAlerts: 50
    });

    const KEYS = Object.freeze({
        url: 'flowstate.supabaseUrl',
        key: 'flowstate.supabaseKey',
        tariff: 'flowstate.tariffPerKl',
        theme: 'flowstate.theme',
        valveKey: 'flowstate.valveKey'
    });

    function read(key) {
        try {
            return window.localStorage ? window.localStorage.getItem(key) : null;
        } catch (_) {
            return null;
        }
    }

    function write(key, value) {
        try {
            if (!window.localStorage) return;
            if (value === null || value === undefined) window.localStorage.removeItem(key);
            else window.localStorage.setItem(key, value);
        } catch (_) {
            // Storage can be full or blocked; the dashboard still works without it.
        }
    }

    const local = { get: read, set: write };

    function env() {
        return window.__ENV__ || {};
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
        return { ok: true, message: 'Connection saved' };
    }

    function resetConnection() {
        local.set(KEYS.url, null);
        local.set(KEYS.key, null);
    }

    function getTariff() {
        const saved = lib.toNumber(local.get(KEYS.tariff), NaN);
        return Number.isFinite(saved) && saved >= 0 && saved <= 10000 ? saved : settings.defaultTariffPerKiloliter;
    }

    function setTariff(value) {
        const parsed = lib.toNumber(value, NaN);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10000) return false;
        local.set(KEYS.tariff, String(parsed));
        return true;
    }

    // The valve key lives only in this tab (sessionStorage) and is never sent anywhere:
    // it is only used to sign commands in the browser.
    function getValveKey() {
        try {
            return window.sessionStorage ? window.sessionStorage.getItem(KEYS.valveKey) || '' : '';
        } catch (_) {
            return '';
        }
    }

    function setValveKey(value) {
        try {
            if (!window.sessionStorage) return;
            const cleaned = String(value || '').trim();
            if (cleaned) window.sessionStorage.setItem(KEYS.valveKey, cleaned);
            else window.sessionStorage.removeItem(KEYS.valveKey);
        } catch (_) {
            // Blocked storage: the key is simply not remembered.
        }
    }

    FlowState.config = {
        project,
        device,
        mqtt,
        settings,
        getValveKey,
        setValveKey,
        KEYS,
        local,
        getConnection,
        saveConnection,
        resetConnection,
        getTariff,
        setTariff
    };
})(window.FlowState = window.FlowState || {});
