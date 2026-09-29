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

    // ---------------------------------------------------------------------
    // Readings
    // ---------------------------------------------------------------------
    /** Readings dated more than `toleranceMs` ahead of now are ignored (old clock bugs, bad data). */
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

    /** Humidity is optional: null/undefined means "no valid sensor reading". */
    function humidityOrNull(value) {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null;
    }

    function tankPercent(levelCm, tankHeightCm) {
        const height = toNumber(tankHeightCm);
        if (height <= 0) return 0;
        return clamp((toNumber(levelCm) / height) * 100, 0, 100);
    }

    /**
     * How fresh the latest reading is.
     * live: within 3 upload intervals; delayed: up to a minute; offline: older.
     */
    function classifyFreshness(lastReadingAt, nowMs, uploadIntervalMs) {
        const time = toTime(lastReadingAt);
        if (time === null) return { state: 'no-data', ageMs: null };
        const ageMs = Math.max(0, nowMs - time);
        const interval = Math.max(1000, toNumber(uploadIntervalMs, 5000));
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

    function startOfLocalDay(nowMs) {
        const now = new Date(nowMs);
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    // ---------------------------------------------------------------------
    // Alerts
    // ---------------------------------------------------------------------
    /** Maps a stored severity onto the three alert tabs. Unknown values count as warnings. */
    function severityGroup(severity) {
        const value = String(severity || '').toLowerCase();
        if (value === 'critical' || value === 'high') return 'critical';
        if (value === 'low' || value === 'info') return 'info';
        return 'warning';
    }

    function alertKey(alert) {
        const source = alert && alert.source ? alert.source : 'db';
        if (alert && alert.id !== undefined && alert.id !== null) return `${source}:${alert.id}`;
        return `${source}:${alert?.timestamp || 'na'}|${alert?.alert_type || 'alert'}|${alert?.message || ''}`;
    }

    /** Newest first, one entry per key. */
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
        return merged.sort((a, b) => (toTime(b.timestamp) ?? 0) - (toTime(a.timestamp) ?? 0));
    }

    /**
     * @param {object[]} alerts
     * @param {{severity: string, ack: string, search: string, criticalOnly: boolean,
     *          isAcknowledged: (key: string) => boolean}} filters
     */
    function filterAlerts(alerts, filters) {
        const search = String(filters.search || '').trim().toLowerCase();
        return alerts.filter((alert) => {
            const group = severityGroup(alert.severity);
            const acknowledged = filters.isAcknowledged(alertKey(alert));
            if (filters.ack === 'open' && acknowledged) return false;
            if (filters.ack === 'acknowledged' && !acknowledged) return false;
            if (filters.criticalOnly && group !== 'critical') return false;
            if (filters.severity && filters.severity !== 'all' && group !== filters.severity) return false;
            if (!search) return true;
            const haystack = `${alert.alert_type || ''} ${alert.message || ''} ${alert.severity || ''}`.toLowerCase();
            return haystack.includes(search);
        });
    }

    function countBySeverity(alerts) {
        const counts = { all: alerts.length, critical: 0, warning: 0, info: 0 };
        alerts.forEach((alert) => {
            counts[severityGroup(alert.severity)] += 1;
        });
        return counts;
    }

    // ---------------------------------------------------------------------
    // Chart history (rows from the get_reading_history database function)
    // ---------------------------------------------------------------------
    function sumField(rows, field) {
        return rows.reduce((total, row) => total + toNumber(row[field]), 0);
    }

    /** Litres drawn through sensor 1, grouped by local hour of day. */
    function hourlyUsage(rows) {
        const totals = new Array(24).fill(0);
        rows.forEach((row) => {
            const time = toTime(row.bucket_start);
            if (time === null) return;
            totals[new Date(time).getHours()] += toNumber(row.volume_1_liters);
        });
        return totals.map((value) => round(value, 3));
    }

    /** Water lost between the sensors over the rows, never below zero. */
    function lossLiters(rows) {
        return Math.max(0, sumField(rows, 'volume_1_liters') - sumField(rows, 'volume_2_liters'));
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

    // ---------------------------------------------------------------------
    // Valve commands
    // ---------------------------------------------------------------------
    /**
     * State of a dashboard valve command.
     * done: a reading taken after delivery shows the requested position.
     * @param {{action: string, status: string, delivered_at?: string, sentAtMs: number}|null} command
     */
    function valveCommandState(command, latestReading, nowMs, timeoutMs = 90000) {
        if (!command) return 'idle';
        const wantOpen = command.action === 'open';
        const deliveredAt = toTime(command.delivered_at);
        const readingAt = toTime(latestReading && latestReading.timestamp);
        const readingMatches = latestReading && (toNumber(latestReading.valve_state) === 1) === wantOpen;
        if (command.status === 'delivered' && deliveredAt !== null && readingAt !== null
            && readingAt >= deliveredAt && readingMatches) {
            return 'done';
        }
        if (command.status === 'expired') return 'expired';
        if (nowMs - command.sentAtMs > timeoutMs) return 'timeout';
        if (command.status === 'delivered') return 'delivered';
        return 'waiting';
    }

    // ---------------------------------------------------------------------
    // Rule-based estimates (not a trained model)
    // ---------------------------------------------------------------------
    /**
     * Priority and risk estimate from one reading. Usage and repair cost only
     * add weight when there is a real imbalance, so heavy but normal use can
     * never raise the priority on its own.
     */
    function computeRiskProfile(reading, options = {}) {
        const flow1 = Math.max(0, toNumber(reading && reading.flow_rate_1));
        const flow2 = Math.max(0, toNumber(reading && reading.flow_rate_2));
        const lossPercent = clamp(toNumber(reading && reading.percentage_loss), 0, 100);
        const humidity = humidityOrNull(reading && reading.humidity);
        const todayLiters = Math.max(0, toNumber(options.todayLiters));
        const noiseFloorLpm = toNumber(options.noiseFloorLpm, 0.2);

        const imbalanceLpm = Math.max(0, flow1 - flow2);
        const leakRateLpm = imbalanceLpm > noiseFloorLpm ? imbalanceLpm : 0;
        const imbalance = flow1 > 0 ? leakRateLpm / flow1 : 0;
        const anomalyScore = clamp(imbalance * 0.7 + (lossPercent / 100) * 0.3, 0, 1);
        const leakSignal = clamp(anomalyScore * 4, 0, 1);
        const usageFactor = clamp(todayLiters / 6000, 0, 1);
        const inferredRepairCost = 300 + leakRateLpm * 95 + lossPercent * 8;
        const repairCostFactor = clamp(inferredRepairCost / 2000, 0, 1);

        const priorityRaw = anomalyScore * 0.5 + leakSignal * (usageFactor * 0.3 + repairCostFactor * 0.2);
        const priorityScore = clamp(Math.round(priorityRaw * 100), 0, 100);

        let humidityStress = 0;
        if (humidity !== null && humidity < 30) humidityStress = Math.min(0.25, (30 - humidity) / 100);
        if (humidity !== null && humidity > 70) humidityStress = Math.min(0.25, (humidity - 70) / 100);
        const failureRisk = clamp(anomalyScore * 0.68 + priorityRaw * 0.22 + humidityStress * leakSignal, 0, 1);

        let priorityLevel = 'Low';
        if (priorityScore >= 75) priorityLevel = 'Critical';
        else if (priorityScore >= 50) priorityLevel = 'High';
        else if (priorityScore >= 25) priorityLevel = 'Medium';

        const immediateAction = priorityScore >= 75 || failureRisk >= 0.75;
        const narrative = immediateAction
            ? `Rapid intervention advised: ${leakRateLpm.toFixed(2)} L/min is going missing between the sensors.`
            : `Stable: ${leakRateLpm.toFixed(2)} L/min imbalance between the sensors. Keep watching the trend.`;

        return {
            leakRateLpm,
            inferredRepairCost,
            priorityScore,
            priorityLevel,
            failureRisk,
            immediateAction,
            narrative
        };
    }

    const LEVEL_RANK = { Low: 0, Medium: 1, High: 2, Critical: 3 };

    /** Raise a dashboard insight only when risk climbs to High or Critical, at most once per cooldown. */
    function shouldRaiseInsight(previousLevel, newLevel, lastRaisedAtMs, nowMs, cooldownMs = 600000) {
        const rank = LEVEL_RANK[newLevel] ?? 0;
        if (rank < LEVEL_RANK.High) return false;
        const escalated = rank > (LEVEL_RANK[previousLevel] ?? 0);
        const cooledDown = lastRaisedAtMs === null || nowMs - lastRaisedAtMs >= cooldownMs;
        return escalated && cooledDown;
    }

    function simulateWhatIf({ leakRateLpm, horizonDays, repairCost, costPerLiter }) {
        const rate = Math.max(0, toNumber(leakRateLpm));
        const days = clamp(Math.round(toNumber(horizonDays, 30)), 1, 365);
        const repair = Math.max(1, toNumber(repairCost, 1));
        const ignoreLossLiters = rate * 60 * 24 * days;
        const ignoreCostUsd = ignoreLossLiters * toNumber(costPerLiter) + (ignoreLossLiters / 90000) * 120;
        const savingsUsd = ignoreCostUsd - repair;
        return {
            horizonDays: days,
            repairCostUsd: round(repair, 2),
            ignoreLossLiters: round(ignoreLossLiters, 2),
            ignoreCostUsd: round(ignoreCostUsd, 2),
            preventedLiters: round(ignoreLossLiters * 0.92, 2),
            savingsUsd: round(savingsUsd, 2),
            recommendedAction: savingsUsd > 0 ? 'Repair immediately' : 'Monitor and schedule maintenance'
        };
    }

    /** Preventable loss = measured loss beyond the normal allowance, over the last 24 hours. */
    function sustainabilityImpact({ loss24hLiters, total24hLiters, allowancePercent, co2KgPerLiter, litersPerPersonPerDay }) {
        const allowance = Math.max(0, toNumber(total24hLiters)) * (toNumber(allowancePercent) / 100);
        const preventablePerDay = Math.max(0, toNumber(loss24hLiters) - allowance);
        const monthlyLiters = preventablePerDay * 30;
        return {
            preventablePerDay,
            monthlyLiters,
            co2KgPerMonth: monthlyLiters * toNumber(co2KgPerLiter),
            peopleEquivalent: preventablePerDay / Math.max(1, toNumber(litersPerPersonPerDay, 50))
        };
    }

    return {
        toNumber,
        clamp,
        round,
        toTime,
        isFutureReading,
        newerReading,
        humidityOrNull,
        tankPercent,
        classifyFreshness,
        formatAge,
        startOfLocalDay,
        severityGroup,
        alertKey,
        mergeAlerts,
        filterAlerts,
        countBySeverity,
        sumField,
        hourlyUsage,
        lossLiters,
        csvCell,
        toCsv,
        cleanUrl,
        isValidSupabaseUrl,
        keyKind,
        resolveConnection,
        overrideToSave,
        valveCommandState,
        computeRiskProfile,
        shouldRaiseInsight,
        simulateWhatIf,
        sustainabilityImpact
    };
});
