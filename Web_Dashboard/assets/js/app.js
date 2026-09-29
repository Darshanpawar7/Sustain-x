/*
 * Starts the dashboard and keeps it in sync: realtime updates when available,
 * polling when not, and periodic refreshes of chart history and today's totals.
 */
(function (FlowState) {
    'use strict';

    const { lib, config, api, ui, charts, alerts, live, valve, insights } = FlowState;
    const $ = (id) => document.getElementById(id);

    const TICK_MS = 1000;
    const EXPORT_RANGES_MS = { '1h': 3600000, '6h': 21600000, '24h': 86400000 };

    let generation = 0;
    let state = freshState();

    function freshState() {
        return {
            connected: false,
            latestReading: null,
            databaseError: false,
            realtime: { readings: false, alerts: false },
            history: {},
            usageToday: null,
            dayStartMs: 0,
            lastUsageFetchMs: 0,
            lastReadingPollMs: 0,
            lastAlertsPollMs: 0
        };
    }

    // Runs a database call; results from an older connection are discarded.
    async function guarded(task) {
        const started = generation;
        try {
            const result = await task();
            if (started !== generation) return undefined;
            state.databaseError = false;
            return result;
        } catch (error) {
            if (started !== generation) return undefined;
            state.databaseError = true;
            console.warn('[FlowState]', error && error.message ? error.message : error);
            return undefined;
        }
    }

    function todayLiters() {
        return state.usageToday ? lib.toNumber(state.usageToday.total_1_liters) : 0;
    }

    function renderStatus() {
        const freshness = lib.classifyFreshness(
            state.latestReading && state.latestReading.timestamp,
            Date.now(),
            config.settings.deviceUploadIntervalMs
        );
        let status = freshness.state;
        if (!state.connected) status = 'not-configured';
        else if (state.databaseError) status = 'db-error';
        live.renderStatus(status, freshness, state.latestReading);
        live.renderSyncMode(state.realtime.readings, state.connected);
    }

    function renderExportStats() {
        const history24h = state.history['24h'];
        const readings = history24h ? lib.sumField(history24h.rows, 'samples') : 0;
        $('exportRecordCount').textContent = String(readings);
        $('exportAlertCount').textContent = String(alerts.deviceAlertList().length);
    }

    // Keeps "today" current between summary refreshes using each reading's volume.
    function addToToday(reading) {
        const summary = state.usageToday;
        if (!summary) return;
        const readingAt = lib.toTime(reading.timestamp);
        const lastAt = lib.toTime(summary.last_reading_at);
        if (readingAt === null || readingAt < state.dayStartMs || (lastAt !== null && readingAt <= lastAt)) return;
        const total1 = lib.toNumber(summary.total_1_liters) + lib.toNumber(reading.volume_1_ml) / 1000;
        const total2 = lib.toNumber(summary.total_2_liters) + lib.toNumber(reading.volume_2_ml) / 1000;
        state.usageToday = {
            ...summary,
            total_1_liters: total1,
            total_2_liters: total2,
            loss_liters: Math.max(0, total1 - total2),
            last_reading_at: reading.timestamp
        };
        live.renderUsage(state.usageToday);
    }

    function applyReading(reading) {
        const next = lib.newerReading(state.latestReading, reading, Date.now());
        if (!next || next === state.latestReading) return;
        state.latestReading = next;
        live.renderReading(next);
        valve.setLatestReading(next);
        insights.update(next, { todayLiters: todayLiters() });
        renderStatus();
    }

    // ---------------------------------------------------------------------
    // Loading
    // ---------------------------------------------------------------------
    async function loadLatestReading() {
        const reading = await guarded(api.fetchLatestReading);
        if (reading) applyReading(reading);
    }

    async function loadAlerts() {
        const list = await guarded(() => api.fetchRecentAlerts(config.settings.maxAlerts));
        if (list) alerts.setDeviceAlerts(list);
        renderExportStats();
    }

    async function loadUsage() {
        const dayStart = lib.startOfLocalDay(Date.now());
        state.dayStartMs = dayStart.getTime();
        state.lastUsageFetchMs = Date.now();
        const summary = await guarded(() => api.fetchUsageSummary(dayStart));
        if (summary === undefined) return;
        state.usageToday = summary;
        live.renderUsage(summary);
    }

    async function loadHistory(range, force) {
        const entry = state.history[range];
        if (entry && entry.loading) return;
        if (!force && entry && Date.now() - entry.fetchedAt < config.settings.historyTtlMs[range]) return;

        const history = state.history;
        history[range] = { rows: entry ? entry.rows : [], fetchedAt: entry ? entry.fetchedAt : 0, loading: true, failed: false };
        const rows = await guarded(() => api.fetchHistory(range));
        if (history !== state.history) return;
        history[range] = {
            rows: rows || history[range].rows,
            fetchedAt: Date.now(),
            loading: false,
            failed: rows === undefined
        };
        charts.render(state.history);
        if (range === '24h') {
            insights.renderSustainability(state.history['24h']);
            renderExportStats();
        }
    }

    // ---------------------------------------------------------------------
    // Realtime
    // ---------------------------------------------------------------------
    function onRealtimeReading(row, connectionGeneration) {
        if (connectionGeneration !== generation || !row) return;
        addToToday(row);
        applyReading(row);
    }

    function onRealtimeAlert(row, connectionGeneration) {
        if (connectionGeneration !== generation || !row || lib.isFutureReading(row.timestamp, Date.now())) return;
        if (alerts.addDeviceAlert(row) && lib.severityGroup(row.severity) === 'critical') {
            ui.toast(`New critical alert: ${String(row.alert_type || '').replace(/_/g, ' ').toLowerCase()}`, 'critical');
        }
        renderExportStats();
    }

    function onRealtimeStatus(name, status, connectionGeneration) {
        if (connectionGeneration !== generation) return;
        const subscribed = status === 'SUBSCRIBED';
        const wasSubscribed = state.realtime[name];
        state.realtime[name] = subscribed;
        // Catch up on anything missed while the channel was down.
        if (subscribed && !wasSubscribed) {
            if (name === 'readings') loadLatestReading();
            else loadAlerts();
        }
        renderStatus();
    }

    // ---------------------------------------------------------------------
    // Connection
    // ---------------------------------------------------------------------
    function connect() {
        generation += 1;
        const connectionGeneration = generation;
        api.disconnect();
        state = freshState();
        valve.reset();
        alerts.setDeviceAlerts([]);
        live.renderUsage(null);

        const connection = config.getConnection();
        if (!api.libraryLoaded()) {
            ui.toast('The Supabase library could not load. Check your internet connection.', 'critical');
        }
        if (!connection.url || !connection.key || !api.connect(connection)) {
            charts.render(state.history, 'Not connected. Open Settings at the bottom of the page.');
            renderStatus();
            return;
        }

        state.connected = true;
        charts.render(state.history, '');
        renderStatus();
        loadLatestReading();
        loadAlerts();
        loadUsage();
        charts.RANGES.forEach((range) => loadHistory(range, true));
        api.subscribe({
            onReading: (row) => onRealtimeReading(row, connectionGeneration),
            onAlert: (row) => onRealtimeAlert(row, connectionGeneration),
            onStatus: (name, status) => onRealtimeStatus(name, status, connectionGeneration)
        });
    }

    function tick() {
        const now = Date.now();
        if (state.connected) {
            if (!state.realtime.readings && now - state.lastReadingPollMs >= config.settings.latestReadingPollMs) {
                state.lastReadingPollMs = now;
                loadLatestReading();
            }
            if (!state.realtime.alerts && now - state.lastAlertsPollMs >= config.settings.alertsPollMs) {
                state.lastAlertsPollMs = now;
                loadAlerts();
            }
            const newDay = lib.startOfLocalDay(now).getTime() !== state.dayStartMs;
            if (newDay || now - state.lastUsageFetchMs >= config.settings.usageRefreshMs) loadUsage();
            charts.RANGES.forEach((range) => loadHistory(range, false));
        }
        valve.refresh();
        renderStatus();
    }

    // ---------------------------------------------------------------------
    // Export
    // ---------------------------------------------------------------------
    async function exportData(format) {
        if (!state.connected) {
            ui.toast('Connect to the database first (Settings).', 'warning');
            return;
        }
        const range = EXPORT_RANGES_MS[$('exportRange').value] ? $('exportRange').value : '1h';
        ui.toast('Preparing export…');
        let rows;
        try {
            rows = await api.fetchReadingsSince(new Date(Date.now() - EXPORT_RANGES_MS[range]));
        } catch (error) {
            ui.toast(`Export failed: ${error && error.message ? error.message : 'unknown error'}`, 'critical');
            return;
        }
        if (!rows.length) {
            ui.toast('No readings in that period.', 'warning');
            return;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        if (format === 'csv') {
            ui.download(lib.toCsv(rows, api.EXPORT_COLUMNS), `flowstate_${range}_${stamp}.csv`, 'text/csv;charset=utf-8');
        } else {
            const deviceAlerts = alerts.deviceAlertList().map(({ source, ...alert }) => alert);
            const content = JSON.stringify({ exported_at: new Date().toISOString(), period: range, readings: rows, alerts: deviceAlerts }, null, 2);
            ui.download(content, `flowstate_${range}_${stamp}.json`, 'application/json');
        }
        ui.toast(`Exported ${rows.length} readings as ${format.toUpperCase()}`);
    }

    function start() {
        const clearedLegacySettings = config.migrateLegacySettings();
        ui.initTheme((dark) => charts.applyTheme(dark));
        ui.initRevealAnimations();
        ui.initJudgesDemo();
        alerts.init();
        ui.initCriticalOnly((active) => alerts.setCriticalOnly(active));
        ui.initSettings(connect);
        live.init();
        valve.init();
        insights.init();
        charts.init(ui.isDarkMode(), { onRangeSelected: (range) => loadHistory(range, false) });
        $('exportCsvBtn').addEventListener('click', () => exportData('csv'));
        $('exportJsonBtn').addEventListener('click', () => exportData('json'));

        if (clearedLegacySettings) {
            ui.toast('Connection settings saved by an older version were cleared. Re-enter them in Settings if you use a different project.', 'warning');
        }
        connect();
        window.setInterval(tick, TICK_MS);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(window.FlowState = window.FlowState || {});
