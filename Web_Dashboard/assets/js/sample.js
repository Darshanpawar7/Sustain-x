/*
 * Sample data: the same functions as api.js, backed by made-up readings in the
 * exact shape the ESP32 sends. Used only when a viewer asks for a preview; the
 * page then shows a "Sample data" banner the whole time.
 */
(function (FlowState) {
    'use strict';

    const { lib, config } = FlowState;

    const EMIT_EVERY_MS = 3000;   // faster than the real 10 s, so the preview visibly moves
    const HOUR_MS = 3600000;
    // Litres used in each hour of a typical day: morning and evening peaks.
    const DAY_SHAPE = [0, 0, 0, 0, 0, 2, 14, 22, 16, 8, 5, 4, 6, 5, 3, 3, 4, 7, 12, 18, 14, 8, 4, 1];

    let timer = null;
    let readings = [];
    let alerts = [];
    let nextId = 1;
    let tap = { open: false, until: 0, rate: 0, loss: 0.03 };
    let tank = 72;

    function seeded(seed) {
        let value = seed % 2147483647 || 1;
        return () => {
            value = (value * 16807) % 2147483647;
            return (value - 1) / 2147483646;
        };
    }

    function hourlyRows(since, timeZone) {
        const random = seeded(20261112);
        const now = Date.now();
        const firstHour = Math.floor(since.getTime() / HOUR_MS) * HOUR_MS;
        const todayKey = lib.zonedParts(now, timeZone).dateKey;
        const rows = [];
        for (let start = firstHour; start <= now; start += HOUR_MS) {
            const { dateKey, hour } = lib.zonedParts(start, timeZone);
            const daysAgo = Math.round((Date.parse(todayKey) - Date.parse(dateKey)) / 86400000);
            const leakDay = daysAgo === 2;
            const nightLeak = daysAgo === 3 && hour === 3;
            let used = DAY_SHAPE[hour] * (0.75 + random() * 0.5);
            if (daysAgo === 0) used *= 1.25;
            if (nightLeak) used = 1.6;
            const lossShare = leakDay && hour >= 9 && hour <= 20 ? 0.11 : 0.025 + random() * 0.01;
            const flowReadings = nightLeak ? 108 : Math.round(used * 4);
            rows.push({
                hour_start: new Date(start).toISOString(),
                readings: start + HOUR_MS > now ? Math.max(1, Math.round(((now - start) / HOUR_MS) * 360)) : 360,
                used_liters: lib.round(used, 3),
                lost_liters: lib.round(used * lossShare, 3),
                flow_readings: Math.min(360, flowReadings),
                max_loss_percent: lib.round(lossShare * 100, 1),
                avg_flow_1: lib.round(used / 60, 2),
                avg_flow_2: lib.round((used / 60) * (1 - lossShare), 2),
                avg_level_cm: 70,
                avg_humidity: 58,
                avg_temperature: 27
            });
        }
        return rows;
    }

    function nextReading(nowMs) {
        const random = Math.random;
        if (nowMs >= tap.until) {
            tap = tap.open
                ? { open: false, until: nowMs + 15000 + random() * 20000, rate: 0, loss: tap.loss }
                : {
                    open: true,
                    until: nowMs + 20000 + random() * 30000,
                    rate: 3 + random() * 3,
                    loss: random() < 0.25 ? 0.08 + random() * 0.04 : 0.02 + random() * 0.02
                };
        }
        const previous = readings[readings.length - 1];
        const flow1 = tap.open ? tap.rate * (0.95 + random() * 0.1) : 0;
        const flow2 = flow1 * (1 - tap.loss);
        const lossPercent = flow1 > 0 ? tap.loss * 100 : 0;
        tank = tank - flow1 * 0.02 < 15 ? 90 : tank - flow1 * 0.02;
        const status = lossPercent < config.device.normalBelowPercent ? 'Normal'
            : lossPercent < config.device.criticalFromPercent ? 'Warning' : 'Critical';
        return {
            id: nextId++,
            timestamp: new Date(nowMs).toISOString(),
            flow_rate_1: lib.round(flow1, 2),
            flow_rate_2: lib.round(flow2, 2),
            percentage_loss: lib.round(lossPercent, 1),
            water_level: lib.round(tank, 2),
            valve_state: 1,
            leak_status: status,
            anomaly_status: 'Normal',
            system_online: 1,
            daily_total_liters: lib.round((previous ? previous.daily_total_liters : 96.4) + flow1 * (EMIT_EVERY_MS / 60000), 3),
            humidity: lib.round(57 + random() * 3, 1),
            temperature: lib.round(27 + random(), 1)
        };
    }

    function makeAlert(type, message, severity, msAgo) {
        return { id: nextId++, timestamp: new Date(Date.now() - msAgo).toISOString(), alert_type: type, message, severity };
    }

    function connect() {
        disconnect();
        nextId = 1;
        tank = 72;
        tap = { open: false, until: 0, rate: 0, loss: 0.03 };
        const now = Date.now();
        readings = [];
        for (let at = now - config.settings.liveWindowMs; at <= now; at += 10000) readings.push(nextReading(at));
        alerts = [
            makeAlert('LEAK_WARNING', 'Flow difference detected. Sensor 1: 4.812 L, Sensor 2: 4.283 L, estimated loss: 11.0%.', 'medium', 2 * 86400000),
            makeAlert('NIGHTTIME_FLOW_START', 'Water flow detected during the 2 AM-5 AM window.', 'medium', 3 * 86400000),
            makeAlert('NIGHTTIME_LEAK_CRITICAL', 'Continuous nighttime flow has lasted at least 10 minutes.', 'high', 3 * 86400000 - 600000),
            makeAlert('VALVE_CLOSED', 'Critical nighttime flow', 'medium', 3 * 86400000 - 601000)
        ];
        return true;
    }

    function disconnect() {
        window.clearInterval(timer);
        timer = null;
    }

    async function fetchLatestReading() {
        return readings[readings.length - 1] || null;
    }

    async function fetchRecentReadings(since) {
        return readings.filter((reading) => Date.parse(reading.timestamp) >= since.getTime());
    }

    async function fetchRecentAlerts(limit) {
        return lib.mergeAlerts(alerts).slice(0, limit);
    }

    async function fetchHourlySummary(since, timeZone) {
        return hourlyRows(since, timeZone);
    }

    async function fetchReadingsSince(since) {
        return fetchRecentReadings(since);
    }

    function subscribe(handlers) {
        handlers.onStatus('readings', 'SUBSCRIBED');
        handlers.onStatus('alerts', 'SUBSCRIBED');
        timer = window.setInterval(() => {
            const reading = nextReading(Date.now());
            readings = lib.trimLiveWindow([...readings, reading], Date.now(), config.settings.liveWindowMs);
            handlers.onReading(reading);
        }, EMIT_EVERY_MS);
    }

    FlowState.sample = {
        EXPORT_COLUMNS: FlowState.api ? FlowState.api.EXPORT_COLUMNS : [],
        connect,
        disconnect,
        fetchLatestReading,
        fetchRecentReadings,
        fetchRecentAlerts,
        fetchHourlySummary,
        fetchReadingsSince,
        subscribe
    };
})(window.FlowState = window.FlowState || {});
