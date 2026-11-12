/*
 * FlowState dashboard helpers: pure functions with no DOM or network access.
 * Loaded by the page as window.FlowState.lib and by the Node unit tests
 * (tests/dashboard) through module.exports.
 */
(function (root, factory) {
    const lib = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = lib;
    } else {
        root.FlowState = root.FlowState || {};
        root.FlowState.lib = lib;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------------------------------------------------------------------
    // Small utilities
    // ---------------------------------------------------------------------
    function toNumber(value, fallback = 0) {
        if (value === null || value === undefined || value === '') return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function round(value, digits = 2) {
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }

    /** @returns {number|null} milliseconds since 1970, or null for missing/invalid input */
    function toTime(value) {
        if (value === null || value === undefined || value === '') return null;
        const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
        return Number.isFinite(time) ? time : null;
    }

    function sum(values) {
        return values.reduce((total, value) => total + value, 0);
    }

    // ---------------------------------------------------------------------
    // Time in the device's home time zone
    // ---------------------------------------------------------------------
    const formatters = new Map();

    function zonedFormatter(timeZone) {
        if (!formatters.has(timeZone)) {
            formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
                timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hourCycle: 'h23'
            }));
        }
        return formatters.get(timeZone);
    }

    /** @returns {{dateKey: string, hour: number, minute: number, second: number}} wall-clock time in timeZone */
    function zonedParts(ms, timeZone) {
        const parts = {};
        zonedFormatter(timeZone).formatToParts(new Date(ms)).forEach((part) => {
            parts[part.type] = part.value;
        });
        return {
            dateKey: `${parts.year}-${parts.month}-${parts.day}`,
            hour: Number(parts.hour) % 24,
            minute: Number(parts.minute),
            second: Number(parts.second)
        };
    }

    /** "2026-11-12" plus n days. */
    function addDays(dateKey, days) {
        const [year, month, day] = dateKey.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
    }

    /** The n date keys ending with lastKey, oldest first. */
    function lastDays(lastKey, count) {
        return Array.from({ length: count }, (_, index) => addDays(lastKey, index - count + 1));
    }

    /** Midnight in timeZone, as milliseconds. Exact for zones without daylight saving (India). */
    function startOfZonedDay(nowMs, timeZone) {
        const parts = zonedParts(nowMs, timeZone);
        return nowMs - ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 - (nowMs % 1000);
    }

    /** 7 -> "7–8 AM", 11 -> "11 AM–12 PM", 23 -> "11 PM–12 AM" */
    function hourRange(hour) {
        const label = (value) => {
            const h = value % 24;
            return { number: h % 12 === 0 ? 12 : h % 12, half: h < 12 ? 'AM' : 'PM' };
        };
        const from = label(hour);
        const to = label(hour + 1);
        return from.half === to.half
            ? `${from.number}–${to.number} ${to.half}`
            : `${from.number} ${from.half}–${to.number} ${to.half}`;
    }

    /** "2026-11-12" -> "Thu 12 Nov" */
    function shortDay(dateKey) {
        const [year, month, day] = dateKey.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
            weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
        });
    }

    // ---------------------------------------------------------------------
    // Number formatting
    // ---------------------------------------------------------------------
    function formatLiters(value) {
        const liters = Math.max(0, toNumber(value));
        const digits = liters < 10 ? 2 : liters < 100 ? 1 : 0;
        return liters.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    function formatRupees(value) {
        const rupees = Math.max(0, toNumber(value));
        return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    // ---------------------------------------------------------------------
    // Readings
    // ---------------------------------------------------------------------
    /** Readings dated more than `toleranceMs` ahead of now are ignored (clock bugs, bad data). */
    function isFutureReading(timestamp, nowMs, toleranceMs = 60000) {
        const time = toTime(timestamp);
        return time !== null && time > nowMs + toleranceMs;
    }

    /** Returns whichever reading is newer, ignoring future-dated ones. */
    function newerReading(current, incoming, nowMs) {
        if (!incoming || isFutureReading(incoming.timestamp, nowMs)) return current;
        if (!current) return incoming;
        const currentTime = toTime(current.timestamp) ?? -Infinity;
        const incomingTime = toTime(incoming.timestamp) ?? -Infinity;
        return incomingTime >= currentTime ? incoming : current;
    }

    /** Optional sensor values: null/undefined means "not sent". */
    function optionalNumber(value, min, max) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? clamp(parsed, min, max) : null;
    }

    function tankPercent(levelCm, tankHeightCm) {
        const height = toNumber(tankHeightCm);
        if (height <= 0) return 0;
        return clamp((toNumber(levelCm) / height) * 100, 0, 100);
    }

    /**
     * Where the loss sits on the leak scale, as a share of the scale (0-1).
     * The scale runs 0-30%; anything above is pinned to the end.
     */
    function lossScalePosition(lossPercent, fullScale = 30) {
        return clamp(toNumber(lossPercent) / fullScale, 0, 1);
    }

    /**
     * How fresh the latest reading is.
     * live: within 3 upload intervals; delayed: up to 12 intervals (at least a minute); offline: older.
     */
    function classifyFreshness(lastReadingAt, nowMs, uploadIntervalMs) {
        const time = toTime(lastReadingAt);
        if (time === null) return { state: 'no-data', ageMs: null };
        const ageMs = Math.max(0, nowMs - time);
        const interval = Math.max(1000, toNumber(uploadIntervalMs, 10000));
        if (ageMs <= interval * 3) return { state: 'live', ageMs };
        if (ageMs <= Math.max(60000, interval * 12)) return { state: 'delayed', ageMs };
        return { state: 'offline', ageMs };
    }

    function formatAge(ageMs) {
        if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return 'never';
        const seconds = Math.round(ageMs / 1000);
        if (seconds < 5) return 'just now';
        if (seconds < 60) return `${seconds} s ago`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 48) return `${hours} h ago`;
        return `${Math.round(hours / 24)} days ago`;
    }

    /** Keeps readings from the last windowMs, oldest first, one per id. */
    function trimLiveWindow(readings, nowMs, windowMs) {
        const seen = new Set();
        return readings
            .filter((reading) => {
                const time = toTime(reading && reading.timestamp);
                if (time === null || time < nowMs - windowMs || isFutureReading(reading.timestamp, nowMs)) return false;
                const key = reading.id ?? reading.timestamp;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => toTime(a.timestamp) - toTime(b.timestamp));
    }

    /**
     * Whether to re-read the newest stored reading now. Without live updates the
     * page checks every latestReadingPollMs; with them it still checks every
     * realtimeSafetyPollMs, because a live update can be missed (for example, a
     * reading saved while the page was still connecting).
     * @param {number} nowMs
     * @param {number} lastPollMs when the last check ran (0 = never)
     * @param {boolean} hasLiveUpdates
     * @param {{latestReadingPollMs: number, realtimeSafetyPollMs: number}} settings
     * @returns {boolean}
     */
    function readingPollDue(nowMs, lastPollMs, hasLiveUpdates, settings) {
        const everyMs = hasLiveUpdates ? settings.realtimeSafetyPollMs : settings.latestReadingPollMs;
        return nowMs - lastPollMs >= everyMs;
    }

    // ---------------------------------------------------------------------
    // Alerts
    // ---------------------------------------------------------------------
    const ALERT_NAMES = Object.freeze({
        CRITICAL_LEAK: 'Critical leak',
        LEAK_WARNING: 'Leak warning',
        NIGHTTIME_FLOW_START: 'Night-time flow started',
        NIGHTTIME_FLOW_ENDED: 'Night-time flow ended',
        NIGHTTIME_LEAK_ALERT: 'Night-time flow for 5 minutes',
        NIGHTTIME_LEAK_CRITICAL: 'Night-time flow for 10 minutes',
        NIGHTTIME_EXCESSIVE_VOLUME: 'Over 0.5 L used at night',
        USAGE_ANOMALY: 'Unusual usage',
        VALVE_OPENED: 'Valve opened',
        VALVE_CLOSED: 'Valve closed'
    });
    const INFO_ALERTS = new Set(['VALVE_OPENED', 'NIGHTTIME_FLOW_ENDED']);

    /** "NIGHTTIME_LEAK_ALERT" -> "Night-time flow for 5 minutes"; unknown types are made readable. */
    function alertName(type) {
        const key = String(type || '');
        if (ALERT_NAMES[key]) return ALERT_NAMES[key];
        const words = key.replace(/_/g, ' ').toLowerCase().trim() || 'alert';
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    /** Which tab an alert belongs to: critical, warning or info. */
    function alertGroup(alert) {
        const severity = String((alert && alert.severity) || '').toLowerCase();
        if (severity === 'critical' || severity === 'high') return 'critical';
        if (INFO_ALERTS.has(alert && alert.alert_type) || severity === 'low' || severity === 'info') return 'info';
        return 'warning';
    }

    function alertKey(alert) {
        if (alert && alert.id !== undefined && alert.id !== null) return `id:${alert.id}`;
        return `${alert?.timestamp || 'na'}|${alert?.alert_type || 'alert'}|${alert?.message || ''}`;
    }

    /** The same alert received over MQTT and later read from the database is one event. */
    function sameAlertEvent(a, b) {
        if (!a || !b || a.alert_type !== b.alert_type || (a.message || '') !== (b.message || '')) return false;
        const first = toTime(a.timestamp);
        const second = toTime(b.timestamp);
        return first !== null && second !== null && Math.abs(first - second) <= 300000;
    }

    /** Newest first, one entry per key; an MQTT copy is dropped once the stored alert is there. */
    function mergeAlerts(...lists) {
        const seen = new Set();
        const merged = [];
        lists.flat().forEach((alert) => {
            if (!alert) return;
            const key = alertKey(alert);
            if (seen.has(key)) return;
            seen.add(key);
            merged.push(alert);
        });
        const stored = merged.filter((alert) => alert.source !== 'mqtt');
        return merged
            .filter((alert) => alert.source !== 'mqtt' || !stored.some((other) => sameAlertEvent(alert, other)))
            .sort((a, b) => (toTime(b.timestamp) ?? 0) - (toTime(a.timestamp) ?? 0));
    }

    /** @param {{group: string, search: string}} filters */
    function filterAlerts(alerts, filters) {
        const search = String(filters.search || '').trim().toLowerCase();
        return alerts.filter((alert) => {
            if (filters.group && filters.group !== 'all' && alertGroup(alert) !== filters.group) return false;
            if (!search) return true;
            const haystack = `${alertName(alert.alert_type)} ${alert.alert_type || ''} ${alert.message || ''}`.toLowerCase();
            return haystack.includes(search);
        });
    }

    function countAlerts(alerts) {
        const counts = { all: alerts.length, critical: 0, warning: 0, info: 0 };
        alerts.forEach((alert) => {
            counts[alertGroup(alert)] += 1;
        });
        return counts;
    }

    // ---------------------------------------------------------------------
    // Analysis (rows from the get_hourly_summary database function)
    // ---------------------------------------------------------------------
    function emptyHour() {
        return { used: 0, lost: 0, readings: 0, flowReadings: 0 };
    }

    function emptyDay() {
        return { used: 0, lost: 0, readings: 0, flowReadings: 0, hours: Array.from({ length: 24 }, emptyHour) };
    }

    /** Groups hourly summary rows by day in timeZone: { "2026-11-12": {used, lost, readings, flowReadings, hours[24]} } */
    function groupByDay(rows, timeZone) {
        const days = {};
        (rows || []).forEach((row) => {
            const time = toTime(row && row.hour_start);
            if (time === null) return;
            const { dateKey, hour } = zonedParts(time, timeZone);
            if (!days[dateKey]) days[dateKey] = emptyDay();
            const day = days[dateKey];
            const slot = day.hours[hour];
            const used = Math.max(0, toNumber(row.used_liters));
            const lost = clamp(toNumber(row.lost_liters), 0, used);
            const readings = Math.max(0, Math.round(toNumber(row.readings)));
            const flowReadings = Math.max(0, Math.round(toNumber(row.flow_readings)));
            day.used += used;
            day.lost += lost;
            day.readings += readings;
            day.flowReadings += flowReadings;
            slot.used += used;
            slot.lost += lost;
            slot.readings += readings;
            slot.flowReadings += flowReadings;
        });
        return days;
    }

    function dayOrEmpty(days, dateKey) {
        return days[dateKey] || emptyDay();
    }

    /** Q1: Am I losing water, and how much? */
    function answerLoss(days, todayKey, dayCount = 7) {
        const perDay = lastDays(todayKey, dayCount).map((dateKey) => {
            const day = dayOrEmpty(days, dateKey);
            return { dateKey, used: day.used, lost: day.lost, readings: day.readings };
        });
        const today = perDay[perDay.length - 1];
        const weekUsed = sum(perDay.map((day) => day.used));
        const weekLost = sum(perDay.map((day) => day.lost));
        return {
            perDay,
            todayUsed: today.used,
            todayLost: today.lost,
            weekUsed,
            weekLost,
            daysWithData: perDay.filter((day) => day.readings > 0).length,
            sharePercent: weekUsed > 0 ? (weekLost / weekUsed) * 100 : null
        };
    }

    /** Q2: When do I use the most water? Average litres per hour of day over the days with data. */
    function answerPeak(days, todayKey, dayCount = 7) {
        const keys = lastDays(todayKey, dayCount);
        const previous = keys.slice(0, -1).filter((dateKey) => dayOrEmpty(days, dateKey).readings > 0);
        // Until there is a full previous day, today's pattern is the best available.
        const basis = previous.length ? previous : [todayKey].filter((dateKey) => dayOrEmpty(days, dateKey).readings > 0);
        const averageByHour = Array.from({ length: 24 }, (_, hour) =>
            basis.length ? sum(basis.map((dateKey) => days[dateKey].hours[hour].used)) / basis.length : 0);
        const todayByHour = dayOrEmpty(days, todayKey).hours.map((slot) => slot.used);
        const peakLiters = Math.max(...averageByHour);
        const peakHour = peakLiters > 0 ? averageByHour.indexOf(peakLiters) : null;
        const busiest = keys
            .map((dateKey) => ({ dateKey, used: dayOrEmpty(days, dateKey).used }))
            .reduce((best, day) => (day.used > best.used ? day : best), { dateKey: null, used: 0 });
        return {
            averageByHour,
            todayByHour,
            peakHour,
            peakLiters,
            daysAveraged: basis.length,
            basedOnToday: !previous.length && basis.length > 0,
            busiestDay: busiest.dateKey ? busiest : null
        };
    }

    /** Litres used on a day from midnight up to hour:minute. */
    function usedBefore(day, hour, minute) {
        const fullHours = sum(day.hours.slice(0, hour).map((slot) => slot.used));
        return fullHours + day.hours[hour].used * (minute / 60);
    }

    /**
     * Q3: Is today's use unusual? Compares today so far with the average of the
     * previous days up to the same time of day, like the ESP32's own 1.5x rule.
     */
    function answerUnusual(days, todayKey, now, options = {}) {
        const minDays = options.minDays ?? 3;
        const ratioLimit = options.ratio ?? 1.5;
        const dayCount = options.dayCount ?? 7;
        const today = dayOrEmpty(days, todayKey);
        const todaySoFar = today.used;
        const baseline = lastDays(todayKey, dayCount)
            .slice(0, -1)
            .map((dateKey) => dayOrEmpty(days, dateKey))
            .filter((day) => sum(day.hours.slice(0, now.hour + 1).map((slot) => slot.readings)) > 0);

        const usedThrough = (day, hour) => sum(day.hours.slice(0, hour + 1).map((slot) => slot.used));
        const normalCumulative = Array.from({ length: 24 }, (_, hour) =>
            baseline.length ? sum(baseline.map((day) => usedThrough(day, hour))) / baseline.length : 0);
        const todayCumulative = today.hours.slice(0, now.hour + 1).reduce((running, slot) => {
            running.push((running.length ? running[running.length - 1] : 0) + slot.used);
            return running;
        }, []);

        const result = { todaySoFar, normalSoFar: null, ratio: null, baselineDays: baseline.length, normalCumulative, todayCumulative };
        if (baseline.length < minDays) return { ...result, state: 'learning' };

        const normalSoFar = sum(baseline.map((day) => usedBefore(day, now.hour, now.minute))) / baseline.length;
        if (normalSoFar < 1) {
            return { ...result, normalSoFar, state: todaySoFar >= 5 ? 'high' : 'normal' };
        }
        const ratio = todaySoFar / normalSoFar;
        let state = 'normal';
        if (ratio >= ratioLimit) state = 'high';
        else if (ratio <= 1 / ratioLimit) state = 'low';
        return { ...result, normalSoFar, ratio, state };
    }

    /**
     * Q4: Is water flowing at night? One entry per night (2-5 AM by default),
     * newest last. Each flowing reading stands for one upload interval of flow.
     */
    function answerNight(days, todayKey, now, options = {}) {
        const start = options.startHour ?? 2;
        const end = options.endHour ?? 5;
        const intervalSeconds = options.uploadIntervalSeconds ?? 10;
        const dayCount = options.dayCount ?? 7;
        const keys = lastDays(todayKey, dayCount).filter((dateKey) => dateKey !== todayKey || now.hour >= start);
        const nights = keys.map((dateKey) => {
            const slots = dayOrEmpty(days, dateKey).hours.slice(start, end);
            const readings = sum(slots.map((slot) => slot.readings));
            const flowReadings = sum(slots.map((slot) => slot.flowReadings));
            const minutes = (flowReadings * intervalSeconds) / 60;
            const used = sum(slots.map((slot) => slot.used));
            let state = 'dry';
            if (readings === 0) state = 'no-data';
            else if (minutes >= 10) state = 'critical';
            else if (minutes >= 5 || used >= 0.5) state = 'alert';
            else if (flowReadings > 0) state = 'flow';
            return { dateKey, readings, flowReadings, minutes, used, state, inProgress: dateKey === todayKey && now.hour < end };
        });
        const withData = nights.filter((night) => night.state !== 'no-data');
        return {
            nights,
            lastNight: nights.length ? nights[nights.length - 1] : null,
            nightsWithData: withData.length,
            nightsWithFlow: withData.filter((night) => night.state !== 'dry').length
        };
    }

    /** Q5: What does it cost? */
    function answerCost(loss, tariffPerKiloliter) {
        const perLiter = Math.max(0, toNumber(tariffPerKiloliter)) / 1000;
        const fullDays = loss.perDay.slice(0, -1).filter((day) => day.readings > 0);
        const basis = fullDays.length ? fullDays : loss.perDay.slice(-1).filter((day) => day.readings > 0);
        const dailyUsed = basis.length ? sum(basis.map((day) => day.used)) / basis.length : 0;
        const dailyLost = basis.length ? sum(basis.map((day) => day.lost)) / basis.length : 0;
        return {
            perLiter,
            todayCost: loss.todayUsed * perLiter,
            todayLeakCost: loss.todayLost * perLiter,
            monthCost: dailyUsed * 30 * perLiter,
            monthLeakCost: dailyLost * 30 * perLiter,
            dailyUsed,
            basisDays: basis.length
        };
    }

    // ---------------------------------------------------------------------
    // MQTT (live telemetry, status, signed commands)
    // ---------------------------------------------------------------------
    const LEAK_LEVELS = new Set(['Normal', 'Warning', 'Critical']);

    function finiteOrNull(value, min, max) {
        const parsed = typeof value === 'number' ? value : NaN;
        return Number.isFinite(parsed) ? clamp(parsed, min, max) : null;
    }

    function shortText(value, fallback, maxLength = 40) {
        return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : fallback;
    }

    /**
     * Turns a compact MQTT telemetry message from the ESP32 into the same shape
     * as a water_readings row. The arrival time is used as the timestamp, so a
     * wrong device clock cannot hide live data. Returns null for junk.
     */
    function telemetryToReading(message, receivedAtMs) {
        if (!message || typeof message !== 'object') return null;
        const flow1 = finiteOrNull(message.f1, 0, 100);
        const flow2 = finiteOrNull(message.f2, 0, 100);
        if (flow1 === null || flow2 === null) return null;
        const seq = Number.isInteger(message.seq) && message.seq > 0 ? message.seq : null;
        return {
            id: `mqtt:${seq ?? receivedAtMs}`,
            source: 'mqtt',
            seq,
            timestamp: new Date(receivedAtMs).toISOString(),
            flow_rate_1: flow1,
            flow_rate_2: flow2,
            percentage_loss: finiteOrNull(message.loss, 0, 100) ?? 0,
            water_level: finiteOrNull(message.lvl, 0, 1000) ?? 0,
            valve_state: message.valve === 1 ? 1 : 0,
            auto_protection: message.auto === 0 ? 0 : 1,
            leak_status: LEAK_LEVELS.has(message.leak) ? message.leak : 'Normal',
            anomaly_status: shortText(message.anom, 'Learning'),
            night_status: shortText(message.night, 'Normal'),
            daily_total_liters: finiteOrNull(message.total, 0, 100000) ?? 0,
            humidity: finiteOrNull(message.hum, 0, 100),
            temperature: finiteOrNull(message.temp, -40, 85),
            wifi_rssi: finiteOrNull(message.rssi, -127, 0),
            uptime_s: finiteOrNull(message.up, 0, 1e10),
            free_heap: finiteOrNull(message.heap, 0, 1e8),
            upload_ms: finiteOrNull(message.upms, 0, 600000),
            http_failures: finiteOrNull(message.hfail, 0, 1e9)
        };
    }

    /**
     * Counts MQTT messages received and missed from their sequence numbers.
     * A number that goes backwards means the ESP32 restarted.
     */
    function nextSequenceStats(stats, seq) {
        const current = stats || { lastSeq: null, received: 0, missed: 0, restarts: 0 };
        if (!Number.isInteger(seq) || seq <= 0) return current;
        if (current.lastSeq === null) return { ...current, lastSeq: seq, received: current.received + 1 };
        if (seq === current.lastSeq) return current;
        if (seq < current.lastSeq) {
            return { ...current, lastSeq: seq, received: current.received + 1, restarts: current.restarts + 1 };
        }
        return { ...current, lastSeq: seq, received: current.received + 1, missed: current.missed + (seq - current.lastSeq - 1) };
    }

    function deliveryPercent(received, missed) {
        const total = received + missed;
        return total > 0 ? (received / total) * 100 : null;
    }

    function median(values) {
        const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
        if (!sorted.length) return null;
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    /** The exact text the ESP32 checks the signature of (see flowstate_rules.h). */
    function commandMessage(topicRoot, action, timestampMs, nonce) {
        return `${topicRoot}|${action}|${timestampMs}|${nonce}`;
    }

    function toHex(buffer) {
        return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    /** HMAC-SHA256 as lowercase hex, using the browser's (or Node's) Web Crypto. */
    async function hmacHex(key, message) {
        const subtle = globalThis.crypto && globalThis.crypto.subtle;
        if (!subtle) throw new Error('This browser cannot sign commands (Web Crypto needs https).');
        const encoder = new TextEncoder();
        const cryptoKey = await subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return toHex(await subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
    }

    /** First 8 hex characters of HMAC(key, "flowstate-key-check"): the ESP32's KEY_CHECK prints the same. */
    async function keyFingerprint(key) {
        return (await hmacHex(key, 'flowstate-key-check')).slice(0, 8);
    }

    /** Builds a signed valve command for the ESP32. */
    async function signedCommand(key, topicRoot, action, timestampMs, nonce) {
        const sig = await hmacHex(key, commandMessage(topicRoot, action, timestampMs, nonce));
        return { action, ts: timestampMs, nonce, sig };
    }

    /** Readings received in the last windowMs as a share of what the upload interval promises. */
    function storageDelivery(readings, nowMs, windowMs, intervalMs) {
        const inWindow = readings.filter((reading) => {
            const time = toTime(reading && reading.timestamp);
            return time !== null && time >= nowMs - windowMs && time <= nowMs + 60000;
        });
        const expected = Math.max(1, Math.floor(windowMs / intervalMs));
        return { received: inWindow.length, expected, percent: Math.min(100, (inWindow.length / expected) * 100) };
    }

    /** Wi-Fi signal in words. */
    function signalQuality(rssi) {
        if (rssi === null || rssi === undefined || !Number.isFinite(Number(rssi))) return '';
        const value = Number(rssi);
        if (value >= -55) return 'excellent';
        if (value >= -67) return 'good';
        if (value >= -75) return 'fair';
        return 'weak';
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Math.floor(toNumber(seconds)));
        const days = Math.floor(total / 86400);
        const hours = Math.floor((total % 86400) / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        if (days > 0) return `${days} d ${hours} h`;
        if (hours > 0) return `${hours} h ${minutes} min`;
        if (minutes > 0) return `${minutes} min`;
        return `${total} s`;
    }

    // ---------------------------------------------------------------------
    // Export
    // ---------------------------------------------------------------------
    const FORMULA_START = /^[=+\-@\t\r]/;

    /** One CSV cell. Text that a spreadsheet would run as a formula is prefixed with '. */
    function csvCell(value) {
        if (value === null || value === undefined) return '';
        let text = String(value);
        if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
        if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
        return text;
    }

    function toCsv(rows, columns) {
        const lines = [columns.map(csvCell).join(',')];
        rows.forEach((row) => lines.push(columns.map((column) => csvCell(row[column])).join(',')));
        return lines.join('\r\n');
    }

    // ---------------------------------------------------------------------
    // Connection settings
    // ---------------------------------------------------------------------
    function cleanUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    function isValidSupabaseUrl(value) {
        const url = cleanUrl(value);
        if (!url) return false;
        try {
            const parsed = new URL(url);
            if (parsed.protocol === 'https:') return true;
            return parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
        } catch (_) {
            return false;
        }
    }

    function decodeJwtRole(key) {
        const parts = String(key).split('.');
        if (parts.length !== 3) return null;
        try {
            const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
            const json = typeof atob === 'function'
                ? atob(padded)
                : Buffer.from(padded, 'base64').toString('utf8');
            return JSON.parse(json).role || null;
        } catch (_) {
            return null;
        }
    }

    /** Classifies a Supabase key so secret keys are never used in a browser. */
    function keyKind(key) {
        const value = String(key || '').trim();
        if (!value) return 'missing';
        if (value.startsWith('sb_secret_')) return 'secret';
        if (value.startsWith('sb_publishable_')) return 'public';
        const role = decodeJwtRole(value);
        if (role === 'service_role') return 'secret';
        if (role === 'anon') return 'public';
        return 'unknown';
    }

    /**
     * A deployment that names its database is locked to it: its security policy
     * only allows connections there. Browser-saved values are used only when the
     * deployment leaves the database unset (local use).
     */
    function resolveConnection(env, saved) {
        const envUrl = cleanUrl(env && env.SUPABASE_URL);
        const envKey = String((env && env.SUPABASE_KEY) || '').trim();
        if (envUrl) return { url: envUrl, key: envKey, source: 'deployment', locked: true };
        const savedUrl = cleanUrl(saved && saved.url);
        const savedKey = String((saved && saved.key) || '').trim();
        if (savedUrl || savedKey) return { url: savedUrl, key: savedKey || envKey, source: 'browser', locked: false };
        return { url: '', key: envKey, source: 'none', locked: false };
    }

    /** A value is only saved when it differs from the deployment value. */
    function overrideToSave(value, deploymentValue) {
        const cleaned = String(value || '').trim();
        if (!cleaned || cleaned === String(deploymentValue || '').trim()) return null;
        return cleaned;
    }

    return {
        toNumber,
        clamp,
        round,
        toTime,
        zonedParts,
        addDays,
        lastDays,
        startOfZonedDay,
        hourRange,
        shortDay,
        formatLiters,
        formatRupees,
        isFutureReading,
        newerReading,
        optionalNumber,
        tankPercent,
        lossScalePosition,
        classifyFreshness,
        formatAge,
        trimLiveWindow,
        readingPollDue,
        alertName,
        alertGroup,
        alertKey,
        mergeAlerts,
        filterAlerts,
        countAlerts,
        groupByDay,
        answerLoss,
        answerPeak,
        answerUnusual,
        answerNight,
        answerCost,
        telemetryToReading,
        nextSequenceStats,
        deliveryPercent,
        median,
        commandMessage,
        hmacHex,
        keyFingerprint,
        signedCommand,
        storageDelivery,
        signalQuality,
        formatDuration,
        csvCell,
        toCsv,
        cleanUrl,
        isValidSupabaseUrl,
        keyKind,
        resolveConnection,
        overrideToSave
    };
});
