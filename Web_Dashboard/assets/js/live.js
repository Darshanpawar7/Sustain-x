/*
 * Live panels: flows, leak check, tank, valve, today's total, the ESP32's own
 * usage-pattern verdict, the air sensor, the pipeline stages and the
 * connection status.
 */
(function (FlowState) {
    'use strict';

    const { lib, config, ui } = FlowState;
    const $ = (id) => document.getElementById(id);

    const LEAK_TEXT = {
        Normal: 'Normal',
        Warning: 'Warning: water is going missing',
        Critical: 'Critical: valve closes automatically'
    };
    const STATUS_TEXT = {
        live: 'Live',
        delayed: 'Delayed',
        offline: 'ESP32 offline',
        'no-data': 'Waiting for the ESP32',
        'db-error': 'Database unreachable',
        'not-configured': 'Not connected',
        sample: 'Sample data',
        connecting: 'Connecting…'
    };

    function fixed(value, digits) {
        return Math.max(0, lib.toNumber(value)).toFixed(digits);
    }

    function renderFlows(reading) {
        const flow1 = Math.max(0, lib.toNumber(reading.flow_rate_1));
        const flow2 = Math.max(0, lib.toNumber(reading.flow_rate_2));
        ui.setLive('flow1', flow1.toFixed(2));
        ui.setLive('flow2', flow2.toFixed(2));
        ui.setLive('flowGap', Math.max(0, flow1 - flow2).toFixed(2));
    }

    function renderLeak(reading) {
        const loss = lib.clamp(lib.toNumber(reading.percentage_loss), 0, 100);
        const status = LEAK_TEXT[reading.leak_status] ? reading.leak_status : 'Normal';
        ui.setLive('lossPercentage', loss.toFixed(1));
        ui.setText('leakStatus', LEAK_TEXT[status]);
        $('leakTile').dataset.status = status.toLowerCase();
        $('lossMarker').style.left = `${(lib.lossScalePosition(loss) * 100).toFixed(1)}%`;
    }

    function renderTank(reading) {
        const level = Math.max(0, lib.toNumber(reading.water_level));
        const percent = lib.tankPercent(level, config.device.tankHeightCm);
        $('tankFill').style.transform = `scaleY(${(percent / 100).toFixed(3)})`;
        ui.setLive('tankLabel', percent.toFixed(0));
        ui.setText('tankLevel', level.toFixed(1));
        return percent;
    }

    function renderValve(reading) {
        const open = lib.toNumber(reading.valve_state) === 1;
        $('valveTile').dataset.open = open ? 'open' : 'closed';
        ui.setLive('valveState', open ? 'Open' : 'Closed');
    }

    function renderToday(reading) {
        const liters = Math.max(0, lib.toNumber(reading.daily_total_liters));
        ui.setLive('dailyTotal', lib.formatLiters(liters));
        ui.setText('todayCost', lib.formatRupees((liters * config.getTariff()) / 1000));
    }

    function renderPattern(reading) {
        const value = String(reading.anomaly_status || 'Learning');
        const element = $('anomalyStatus');
        element.dataset.state = /anomaly/i.test(value) ? 'anomaly' : /learn/i.test(value) ? 'learning' : 'normal';
        ui.setLive('anomalyStatus', /learn/i.test(value) ? 'Learning (first 3 days)' : value);
    }

    function renderAir(reading) {
        const humidity = lib.optionalNumber(reading.humidity, 0, 100);
        const temperature = lib.optionalNumber(reading.temperature, -40, 85);
        ui.setLive('humidityValue', humidity === null ? '--' : `${humidity.toFixed(1)}% RH`);
        ui.setLive('temperatureValue', temperature === null ? '--' : `${temperature.toFixed(1)} °C`);
        ui.setText('airNote', humidity === null && temperature === null
            ? 'The DHT22 is read on the ESP32 (see the Serial Monitor), but the current sketch does not upload it.'
            : 'High humidity near the pipes can point to a slow, hidden leak.');
    }

    function renderStages(reading, tankPercent) {
        const loss = lib.clamp(lib.toNumber(reading.percentage_loss), 0, 100);
        ui.setLive('stageSense',
            `S1 ${fixed(reading.flow_rate_1, 2)} · S2 ${fixed(reading.flow_rate_2, 2)} L/min · tank ${tankPercent.toFixed(0)}%`);
        ui.setLive('stageProcess',
            `Loss ${loss.toFixed(1)}% → ${reading.leak_status || 'Normal'} · valve ${lib.toNumber(reading.valve_state) === 1 ? 'open' : 'closed'}`);
    }

    function pulsePipeline() {
        const stages = $('pipelineStages');
        stages.classList.remove('lit');
        void stages.offsetWidth;
        stages.classList.add('lit');
    }

    /** @param {object} reading a water_readings row */
    function renderReading(reading, options = {}) {
        if (!reading) return;
        renderFlows(reading);
        renderLeak(reading);
        const tankPercent = renderTank(reading);
        renderValve(reading);
        renderToday(reading);
        renderPattern(reading);
        renderAir(reading);
        renderStages(reading, tankPercent);
        if (options.arrived) pulsePipeline();
    }

    function bannerMessage(status, freshness, readingTime, mode) {
        if (mode.dbState === 'not-configured') {
            return mode.mqttLive
                ? 'Live readings are arriving over MQTT, but this page is not connected to the database, so nothing is stored or analysed here. Add the database under Settings at the bottom.'
                : 'This page is not connected to a database yet. Add it under Settings at the bottom, or preview the dashboard with sample data.';
        }
        if (mode.dbState === 'error') {
            return 'The database cannot be reached right now. Live MQTT readings still show; stored history and analysis will catch up.';
        }
        switch (status) {
            case 'no-data':
                return 'Connected, but no readings have arrived yet. Power the ESP32 and check its Wi-Fi name, password and keys in secrets.h. The Serial Monitor shows each upload and MQTT result.';
            case 'offline':
                return `No reading from the ESP32 for ${lib.formatAge(freshness.ageMs).replace(' ago', '')}. `
                    + `The values below are from ${new Date(readingTime).toLocaleString('en-IN')}.`;
            default:
                return '';
        }
    }

    function deliveryText(mode) {
        if (mode.sample) return 'sample data, every 3 s';
        const mqtt = mode.mqttLive ? 'MQTT live every 2 s' : mode.mqttConnected ? 'MQTT connected' : 'MQTT connecting';
        const store = mode.dbState !== 'ok' ? 'database not connected'
            : mode.realtime ? 'stored readings pushed live' : `database checked every ${config.settings.latestReadingPollMs / 1000} s`;
        return `${mqtt} · ${store}`;
    }

    /**
     * @param {string} status one of the STATUS_TEXT keys
     * @param {{state: string, ageMs: number|null}} freshness
     * @param {object|null} latestReading
     * @param {{realtime: boolean, sample: boolean, dbState: string, mqttConnected: boolean, mqttLive: boolean}} mode
     */
    function renderStatus(status, freshness, latestReading, mode) {
        const pill = $('systemStatus');
        pill.dataset.state = status;
        pill.querySelector('.status-text').textContent = STATUS_TEXT[status] || status;

        const readingTime = latestReading ? lib.toTime(latestReading.timestamp) : null;
        ui.setText('lastUpdate', readingTime === null
            ? 'Last reading: none yet'
            : `Last reading ${new Date(readingTime).toLocaleTimeString('en-IN')} (${lib.formatAge(freshness.ageMs)})`);

        ui.setText('stageIngest', `${readingTime === null ? 'No reading yet' : lib.formatAge(freshness.ageMs)} · ${deliveryText(mode)}`);
        ui.setText('liveSubtitle', mode.sample
            ? 'Sample data: a new made-up reading every 3 seconds.'
            : 'Live over MQTT every 2 s (stored over HTTPS every 10 s). Values change the moment a reading arrives.');

        const message = mode.sample ? '' : bannerMessage(status, freshness, readingTime, mode);
        const banner = $('statusBanner');
        ui.setText('statusBannerText', message);
        banner.hidden = message === '';
        banner.dataset.tone = status === 'offline' || mode.dbState === 'error' ? 'critical' : 'info';
        $('sampleStartBtn').hidden = mode.sample || !(mode.dbState === 'not-configured' || status === 'no-data');
        $('sampleBanner').hidden = !mode.sample;
        document.body.classList.toggle('readings-stale', status === 'offline');
    }

    function init() {
        ui.setText('tankCapacity', String(config.device.tankHeightCm));
    }

    FlowState.live = { init, renderReading, renderStatus };
})(window.FlowState = window.FlowState || {});
