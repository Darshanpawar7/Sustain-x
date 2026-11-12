/*
 * Starts the dashboard and keeps it in sync with two data paths:
 *   MQTT (mqttlink.js)  live telemetry every 2 s, alerts, ESP32 status, valve commands
 *   Supabase (api.js)   stored readings and alerts: live inserts (Realtime), or
 *                       checked every 10 s when Realtime is unavailable; a fresh
 *                       analysis every 30 s
 * On request, sample.js replaces both with made-up data (clearly labelled).
 */
(function (FlowState) {
    'use strict';

    const { lib, config, api, sample, mqttLink, ui, charts, live, analysis, alerts, valve, perf } = FlowState;
    const $ = (id) => document.getElementById(id);

    const TICK_MS = 1000;
    const EXPORT_RANGES_MS = { '1h': 3600000, '24h': 86400000, '7d': 7 * 86400000 };

    let generation = 0;
    let source = api;
    let state = freshState(false);

    function freshState(sampleMode) {
        return {
            sample: sampleMode,
            connected: false,          // database (or sample source) connected
            databaseError: false,
            realtime: { readings: false, alerts: false },
            latestReading: null,       // newest reading from either path
            latestStored: null,        // newest reading from the database
            liveReadings: [],          // live chart (both paths, last 15 min)
            dbReadings: [],            // stored readings, last 15 min (performance)
            summaryRows: null,
            mqtt: mqttLink.snapshot(),
            lastSummaryMs: 0,
            lastReadingPollMs: 0,
            lastAlertsPollMs: 0
        };
    }

    // Runs a database call; results that belong to an older connection are dropped.
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

    function dbState() {
        if (state.sample) return 'ok';
        if (!state.connected) return 'not-configured';
        return state.databaseError ? 'error' : 'ok';
    }

    function mqttLive() {
        return state.mqtt.connected && state.mqtt.lastMessageAgeMs !== null && state.mqtt.lastMessageAgeMs < 10000;
    }

    function renderStatus() {
        const freshness = lib.classifyFreshness(
            state.latestReading && state.latestReading.timestamp, Date.now(), config.device.uploadIntervalMs);
        let status = freshness.state;
        if (state.sample) status = 'sample';
        else if (status === 'no-data' && !state.connected && !state.mqtt.connected) status = 'not-configured';
        live.renderStatus(status, freshness, state.latestReading, {
            realtime: state.realtime.readings,
            sample: state.sample,
            dbState: dbState(),
            mqttConnected: state.mqtt.connected,
            mqttLive: mqttLive()
        });
    }

    function renderPerformance() {
        perf.render({
            mqtt: state.mqtt,
            dbReadings: state.dbReadings,
            latest: state.latestReading,
            latestStored: state.latestStored,
            summaryRows: state.summaryRows,
            sample: state.sample,
            dbConnected: state.connected && !state.sample,
            nowMs: Date.now()
        });
    }

    function renderLiveChart() {
        state.liveReadings = lib.trimLiveWindow(state.liveReadings, Date.now(), config.settings.liveWindowMs);
        charts.renderLive(state.liveReadings, state.connected || state.mqtt.connected
            ? 'No readings in the last 15 minutes.'
            : 'Not connected yet.');
    }

    function renderAnalysis() {
        if (!state.summaryRows) return;
        analysis.render(state.summaryRows, {
            nowMs: Date.now(),
            deviceStatus: state.latestReading ? state.latestReading.anomaly_status : ''
        });
    }

    /** @param {boolean} arrived true when the reading has just come in (not loaded from history) */
    function applyReading(reading, arrived) {
        const next = lib.newerReading(state.latestReading, reading, Date.now());
        state.liveReadings = [...state.liveReadings, reading];
        if (next && next !== state.latestReading) {
            state.latestReading = next;
            live.renderReading(next, { arrived });
            valve.renderReading(next);
        }
        renderLiveChart();
        renderStatus();
    }

    function applyStoredReading(row, arrived) {
        if (!row || lib.isFutureReading(row.timestamp, Date.now())) return;
        state.latestStored = lib.newerReading(state.latestStored, row, Date.now());
        state.dbReadings = lib.trimLiveWindow([...state.dbReadings, row], Date.now(), config.settings.liveWindowMs);
        applyReading(row, arrived);
    }

    // ---------------------------------------------------------------------
    // Loading from the database (or the sample source)
    // ---------------------------------------------------------------------
    async function loadLatestReading(arrived) {
        const reading = await guarded(source.fetchLatestReading);
        if (reading) applyStoredReading(reading, arrived);
    }

    async function loadLiveWindow() {
        const rows = await guarded(() => source.fetchRecentReadings(new Date(Date.now() - config.settings.liveWindowMs)));
        if (!rows) return;
        state.dbReadings = lib.trimLiveWindow([...rows, ...state.dbReadings], Date.now(), config.settings.liveWindowMs);
        state.liveReadings = lib.trimLiveWindow([...rows, ...state.liveReadings], Date.now(), config.settings.liveWindowMs);
        renderLiveChart();
    }

    async function loadAlerts() {
        const list = await guarded(() => source.fetchRecentAlerts(config.settings.maxAlerts));
        if (list) alerts.setAlerts([...list.filter((alert) => !lib.isFutureReading(alert.timestamp, Date.now())), ...alerts.list()]);
    }

    async function loadSummary() {
        state.lastSummaryMs = Date.now();
        const dayStart = lib.startOfZonedDay(Date.now(), config.device.timeZone);
        const since = new Date(dayStart - (config.settings.analysisDays - 1) * 86400000);
        const rows = await guarded(() => source.fetchHourlySummary(since, config.device.timeZone));
        if (rows === undefined) {
            if (!state.summaryRows) analysis.renderUnavailable('Could not load the stored readings. Retrying shortly.');
            return;
        }
        state.summaryRows = rows;
        renderAnalysis();
    }

    function onAlert(row) {
        if (!row || lib.isFutureReading(row.timestamp, Date.now())) return;
        if (alerts.addAlert(row) && lib.alertGroup(row) === 'critical') {
            ui.toast(`Critical alert: ${lib.alertName(row.alert_type)}`, 'critical');
        }
    }

    function subscribe(connectionGeneration) {
        source.subscribe({
            onReading: (row) => {
                if (connectionGeneration !== generation || !row) return;
                if (state.sample) applyReading(row, true);
                else applyStoredReading(row, true);
            },
            onAlert: (row) => {
                if (connectionGeneration === generation) onAlert(row);
            },
            onStatus: (name, status) => {
                if (connectionGeneration !== generation) return;
                const subscribed = status === 'SUBSCRIBED';
                const wasSubscribed = state.realtime[name];
                state.realtime[name] = subscribed;
                // Catch up on anything missed while the channel was down.
                if (subscribed && !wasSubscribed && !state.sample) {
                    if (name === 'readings') loadLatestReading(true);
                    else loadAlerts();
                }
                renderStatus();
            }
        });
    }

    // ---------------------------------------------------------------------
    // MQTT
    // ---------------------------------------------------------------------
    function startMqtt(connectionGeneration) {
        mqttLink.connect({
            onReading: (reading) => {
                if (connectionGeneration === generation) applyReading(reading, true);
            },
            onAlert: (alert) => {
                if (connectionGeneration === generation) onAlert(alert);
            },
            onChange: (snapshot) => {
                if (connectionGeneration !== generation) return;
                state.mqtt = snapshot;
                valve.setLink(snapshot);
            }
        });
    }

    // ---------------------------------------------------------------------
    // Connection
    // ---------------------------------------------------------------------
    function connect(sampleMode) {
        generation += 1;
        const connectionGeneration = generation;
        api.disconnect();
        sample.disconnect();
        mqttLink.disconnect();
        state = freshState(sampleMode);
        alerts.setAlerts([]);
        valve.setSampleMode(sampleMode);
        $('sampleToggleBtn').textContent = sampleMode ? 'Show real data' : 'Preview with sample data';

        if (sampleMode) {
            source = sample;
            sample.connect();
        } else {
            source = api;
            startMqtt(connectionGeneration);
            const connection = config.getConnection();
            if (!api.libraryLoaded()) {
                ui.toast('The Supabase library could not load. Check the internet connection.', 'critical');
            }
            if (!connection.url || !connection.key || !api.connect(connection)) {
                renderLiveChart();
                analysis.renderUnavailable('Not connected to the database');
                renderStatus();
                renderPerformance();
                return;
            }
        }

        state.connected = true;
        renderLiveChart();
        renderStatus();
        renderPerformance();
        loadLiveWindow().then(() => loadLatestReading(false));
        loadAlerts();
        loadSummary();
        subscribe(connectionGeneration);
    }

    function tick() {
        const now = Date.now();
        if (state.connected && !state.sample) {
            if (!state.realtime.readings && now - state.lastReadingPollMs >= config.settings.latestReadingPollMs) {
                state.lastReadingPollMs = now;
                loadLatestReading(true);
            }
            if (!state.realtime.alerts && now - state.lastAlertsPollMs >= config.settings.alertsPollMs) {
                state.lastAlertsPollMs = now;
                loadAlerts();
            }
        }
        if (state.connected && now - state.lastSummaryMs >= config.settings.summaryRefreshMs) loadSummary();
        if (!state.sample) state.mqtt = mqttLink.snapshot();
        renderStatus();
        renderPerformance();
    }

    // ---------------------------------------------------------------------
    // Export
    // ---------------------------------------------------------------------
    async function exportData(format) {
        if (!state.connected) {
            ui.toast('Connect to the database first (Settings).', 'warning');
            return;
        }
        const range = EXPORT_RANGES_MS[$('exportRange').value] ? $('exportRange').value : '24h';
        ui.toast('Preparing the download…');
        let rows;
        try {
            rows = await source.fetchReadingsSince(new Date(Date.now() - EXPORT_RANGES_MS[range]));
        } catch (error) {
            ui.toast(`Download failed: ${error && error.message ? error.message : 'unknown error'}`, 'critical');
            return;
        }
        if (!rows.length) {
            ui.toast('No readings in that period.', 'warning');
            return;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const prefix = state.sample ? 'flowstate_SAMPLE' : 'flowstate_team10';
        if (format === 'csv') {
            ui.download(lib.toCsv(rows, api.EXPORT_COLUMNS), `${prefix}_${range}_${stamp}.csv`, 'text/csv;charset=utf-8');
        } else {
            const content = JSON.stringify({
                project: `FlowState · ${config.project.team}`,
                sample_data: state.sample,
                exported_at: new Date().toISOString(),
                period: range,
                readings: rows,
                alerts: alerts.list()
            }, null, 2);
            ui.download(content, `${prefix}_${range}_${stamp}.json`, 'application/json');
        }
        ui.toast(`Downloaded ${rows.length.toLocaleString('en-IN')} readings as ${format.toUpperCase()}`);
    }

    // ---------------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------------
    function showProject() {
        const { team, members } = config.project;
        ['teamBadge', 'teamKicker'].forEach((id) => ui.setText(id, team));
        ui.setText('footerTeam', `FlowState · ${team}`);
        ui.setText('mqttSettingsNote', `Live data: MQTT topic ${config.mqtt.topicRoot}/… on ${config.mqtt.url}.`);
        const named = members.filter((member) => member && member.name);
        if (!named.length) return;
        const items = named.map((member) => {
            const item = document.createElement('li');
            item.className = 'team-member';
            const name = document.createElement('strong');
            name.textContent = member.name;
            const role = document.createElement('span');
            role.className = 'team-role';
            role.textContent = member.role || '';
            const part = document.createElement('p');
            part.textContent = member.part || '';
            item.append(name, role, part);
            return item;
        });
        $('teamGrid').replaceChildren(...items);
        $('team').hidden = false;
        $('teamMembers').textContent = named.map((member) => member.name).join(' · ');
        $('teamMembers').hidden = false;
    }

    function start() {
        showProject();
        ui.initTheme(() => charts.applyTheme());
        charts.init();
        live.init();
        alerts.init();
        valve.init();
        ui.initSettings(() => connect(false));
        analysis.initTariff(() => {
            renderAnalysis();
            if (state.latestReading) live.renderReading(state.latestReading);
        });

        $('sampleStartBtn').addEventListener('click', () => connect(true));
        $('sampleStopBtn').addEventListener('click', () => connect(false));
        $('sampleToggleBtn').addEventListener('click', () => connect(!state.sample));
        $('exportCsvBtn').addEventListener('click', () => exportData('csv'));
        $('exportJsonBtn').addEventListener('click', () => exportData('json'));

        connect(new URLSearchParams(window.location.search).has('sample'));
        window.setInterval(tick, TICK_MS);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(window.FlowState = window.FlowState || {});
