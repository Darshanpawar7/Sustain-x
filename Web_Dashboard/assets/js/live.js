/*
 * Live panels: tank, flows, leak gauge, valve position, humidity, today's
 * totals, and whether the device is actually sending data.
 */
(function (FlowState) {
    'use strict';

    const { lib, config } = FlowState;
    const $ = (id) => document.getElementById(id);

    const GAUGE_LENGTH = 345;
    const GAUGE_FULL_SCALE_PERCENT = 30;
    const HUMIDITY_RING_LENGTH = 339.29;
    const LEAK_BADGES = { Normal: 'NORMAL ✓', Warning: 'WARNING ⚡', Critical: 'CRITICAL ⚠️' };
    const STATUS_TEXT = {
        live: 'Device live',
        delayed: 'Device delayed',
        offline: 'Device offline',
        'no-data': 'No readings yet',
        'db-error': 'Database unreachable',
        'not-configured': 'Not connected',
        connecting: 'Connecting…'
    };

    let previousHumidity = null;

    function setText(id, value) {
        const element = $(id);
        if (element) element.textContent = value;
    }

    function renderTank(levelCm) {
        const level = Math.max(0, lib.toNumber(levelCm));
        const percent = lib.tankPercent(level, config.settings.tankHeightCm);
        const liquid = document.querySelector('.water-tank .liquid');
        if (liquid) liquid.style.top = `${100 - percent}%`;
        const label = $('tankLabel');
        if (label) {
            label.textContent = `${percent.toFixed(0)}%`;
            label.style.bottom = `${Math.min(percent, 92)}%`;
        }
        setText('tankLevel', `${level.toFixed(1)} cm`);
    }

    function renderFlows(reading) {
        const flow1 = Math.max(0, lib.toNumber(reading.flow_rate_1));
        const flow2 = Math.max(0, lib.toNumber(reading.flow_rate_2));
        setText('flow1', `${flow1.toFixed(2)} L/min`);
        setText('flow2', `${flow2.toFixed(2)} L/min`);
        const scale = Math.max(flow1, flow2, 5);
        $('progressFlow1').style.width = `${(flow1 / scale) * 100}%`;
        $('progressFlow2').style.width = `${(flow2 / scale) * 100}%`;
    }

    function renderLeak(reading) {
        const loss = lib.clamp(lib.toNumber(reading.percentage_loss), 0, 100);
        const status = LEAK_BADGES[reading.leak_status] ? reading.leak_status : 'Normal';
        setText('lossPercentage', loss.toFixed(1));

        const progress = $('circleProgress');
        progress.style.strokeDashoffset = String(
            GAUGE_LENGTH * (1 - Math.min(loss, GAUGE_FULL_SCALE_PERCENT) / GAUGE_FULL_SCALE_PERCENT)
        );
        progress.classList.toggle('warning', status === 'Warning');
        progress.classList.toggle('critical', status === 'Critical');

        const badge = $('leakStatus');
        badge.classList.remove('normal', 'warning', 'critical');
        badge.classList.add(status.toLowerCase());
        badge.textContent = LEAK_BADGES[status];
    }

    function renderValve(reading) {
        const open = lib.toNumber(reading.valve_state) === 1;
        $('valveIndicator').classList.toggle('active', open);
        setText('valveState', open ? 'OPEN' : 'CLOSED');
    }

    function humidityState(humidity) {
        if (humidity === null) return { state: 'muted', aura: 'NO DATA', badge: 'NO DATA' };
        if (humidity < 30) return { state: 'dry', aura: 'DRY', badge: 'DRY AIR' };
        if (humidity > 70) return { state: 'wet', aura: 'HUMID', badge: 'VERY HUMID' };
        return { state: 'good', aura: 'COMFORT', badge: 'COMFORT' };
    }

    function renderHumidity(reading) {
        const humidity = lib.humidityOrNull(reading.humidity);
        const look = humidityState(humidity);

        const aura = $('humidityAura');
        aura.classList.remove(
            'humidity-state-dry', 'humidity-state-good', 'humidity-state-wet', 'humidity-state-muted',
            'breathing-calm', 'breathing-alert'
        );
        aura.classList.add(`humidity-state-${look.state}`, look.state === 'dry' || look.state === 'wet' ? 'breathing-alert' : 'breathing-calm');

        setText('humidityValue', humidity === null ? 'N/A' : `${humidity.toFixed(1)}%`);
        setText('humidityAuraLabel', look.aura);
        $('humidityOrbitProgress').style.strokeDashoffset = (HUMIDITY_RING_LENGTH * (1 - (humidity ?? 0) / 100)).toFixed(2);

        const badge = $('humidityComfortBadge');
        badge.textContent = look.badge;
        badge.className = `humidity-comfort humidity-comfort-${look.state}`;

        if (humidity === null) {
            setText('humidityTrend', 'No valid reading from the humidity sensor.');
        } else if (previousHumidity === null) {
            setText('humidityTrend', 'Collecting humidity trend…');
        } else {
            const delta = humidity - previousHumidity;
            const direction = delta > 0.2 ? 'rising' : delta < -0.2 ? 'falling' : 'stable';
            setText('humidityTrend', `Indoor air is ${direction} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`);
        }
        previousHumidity = humidity;
    }

    function renderReading(reading) {
        if (!reading) return;
        renderTank(reading.water_level);
        renderFlows(reading);
        renderLeak(reading);
        renderValve(reading);
        renderHumidity(reading);
        setText('anomalyStatus', reading.anomaly_status || 'Learning');
    }

    function renderUsage(summary) {
        if (!summary) {
            setText('dailyTotal', '-- L');
            setText('estimatedLoss', '-- L');
            setText('estimatedCost', '$--');
            return;
        }
        const total = Math.max(0, lib.toNumber(summary.total_1_liters));
        const loss = Math.max(0, lib.toNumber(summary.loss_liters));
        setText('dailyTotal', `${total.toFixed(2)} L`);
        setText('estimatedLoss', `${loss.toFixed(2)} L`);
        setText('estimatedCost', `$${(total * config.settings.costPerLiter).toFixed(2)}`);
    }

    function bannerMessage(status, freshness, readingTime) {
        const since = readingTime === null ? '' : new Date(readingTime).toLocaleString();
        switch (status) {
            case 'offline':
                return `No data from the device for ${lib.formatAge(freshness.ageMs).replace(' ago', '')}. `
                    + `The values below are from ${since} and may be out of date.`;
            case 'db-error':
                return 'The database cannot be reached right now. Showing the last values received.';
            case 'not-configured':
                return 'The dashboard is not connected. Open Settings at the bottom of the page to add your Supabase URL and public key.';
            case 'no-data':
                return 'Connected, but no readings have arrived yet. Check that the device is powered and its secrets.h is filled in.';
            default:
                return '';
        }
    }

    /**
     * @param {string} status one of the STATUS_TEXT keys
     * @param {{state: string, ageMs: number|null}} freshness
     */
    function renderStatus(status, freshness, latestReading) {
        const badge = $('systemStatus');
        const dot = document.createElement('span');
        dot.className = `status-dot ${status}`;
        badge.replaceChildren(dot, document.createTextNode(STATUS_TEXT[status] || status));

        const readingTime = latestReading ? lib.toTime(latestReading.timestamp) : null;
        setText('lastUpdate', readingTime === null
            ? 'Last reading: none yet'
            : `Last reading: ${new Date(readingTime).toLocaleTimeString()} (${lib.formatAge(freshness.ageMs)})`);

        const message = bannerMessage(status, freshness, readingTime);
        const banner = $('staleBanner');
        banner.textContent = message;
        banner.hidden = message === '';
        banner.classList.toggle('critical', status === 'offline' || status === 'db-error');
        document.body.classList.toggle('readings-stale', status === 'offline' || status === 'db-error');
    }

    function renderSyncMode(realtimeConnected, connected) {
        let text = 'Not connected';
        if (connected) text = realtimeConnected ? 'Realtime' : `Polling every ${config.settings.latestReadingPollMs / 1000} s`;
        setText('syncMode', text);
    }

    function init() {
        setText('tankCapacity', `${config.settings.tankHeightCm.toFixed(1)} cm`);
        setText('costPerLiterLabel', `$${config.settings.costPerLiter.toFixed(2)}`);
        renderUsage(null);
    }

    FlowState.live = { init, renderReading, renderUsage, renderStatus, renderSyncMode };
})(window.FlowState = window.FlowState || {});
