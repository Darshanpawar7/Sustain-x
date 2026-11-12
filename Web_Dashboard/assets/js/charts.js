/*
 * The four charts: live flow (last 15 minutes), water lost per day (Q1),
 * use by hour of day (Q2) and today against a normal day (Q3).
 * Colours come from the CSS custom properties, so both themes match the page.
 */
(function (FlowState) {
    'use strict';

    const { lib } = FlowState;

    const charts = {};
    const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => {
        const h = hour % 12 === 0 ? 12 : hour % 12;
        return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
    });

    function token(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function theme() {
        return {
            ink: token('--ink-2'),
            grid: token('--rule'),
            s1: token('--s1'),
            s1Soft: token('--s1-soft'),
            s2: token('--s2'),
            lost: token('--critical'),
            normal: token('--ink-3')
        };
    }

    function baseOptions(colors, extra = {}) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            // With animations on, Chart.js 3 can skip drawing when updates arrive quickly.
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    align: 'start',
                    labels: { color: colors.ink, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded' }
                },
                tooltip: { titleFont: { family: 'IBM Plex Sans' }, bodyFont: { family: 'IBM Plex Mono' } }
            },
            scales: {
                x: {
                    stacked: Boolean(extra.stacked),
                    ticks: { color: colors.ink, maxRotation: 0, autoSkip: true, autoSkipPadding: 14, maxTicksLimit: extra.maxTicks || 8 },
                    grid: { display: false }
                },
                y: {
                    stacked: Boolean(extra.stacked),
                    beginAtZero: true,
                    ticks: { color: colors.ink, maxTicksLimit: 5 },
                    grid: { color: colors.grid },
                    title: { display: Boolean(extra.yTitle), text: extra.yTitle || '', color: colors.ink }
                }
            }
        };
    }

    function line(label, color, options = {}) {
        return {
            label,
            data: [],
            borderColor: color,
            backgroundColor: color,
            borderWidth: options.width || 2,
            borderDash: options.dash || [],
            pointRadius: 0,
            tension: 0.25,
            fill: false,
            spanGaps: true,
            type: 'line'
        };
    }

    function bar(label, color) {
        return { label, data: [], backgroundColor: color, borderRadius: 3, maxBarThickness: 34, type: 'bar' };
    }

    const SPECS = {
        live: {
            canvas: 'liveChart',
            build: (c) => ({
                type: 'line',
                data: { labels: [], datasets: [line('Sensor 1 · tank outlet', c.s1), line('Sensor 2 · tap', c.s2)] },
                options: baseOptions(c, { yTitle: 'L/min', maxTicks: 5 })
            })
        },
        loss: {
            canvas: 'lossChart',
            build: (c) => ({
                type: 'bar',
                data: { labels: [], datasets: [bar('Reached the tap (L)', c.s2), bar('Lost (L)', c.lost)] },
                options: baseOptions(c, { stacked: true, yTitle: 'litres' })
            })
        },
        hour: {
            canvas: 'hourChart',
            build: (c) => ({
                type: 'bar',
                data: { labels: HOUR_LABELS, datasets: [bar('Average day (L)', c.s1Soft), line('Today (L)', c.s1, { width: 2.5 })] },
                options: baseOptions(c, { yTitle: 'litres per hour', maxTicks: 8 })
            })
        },
        today: {
            canvas: 'todayChart',
            build: (c) => ({
                type: 'line',
                data: { labels: HOUR_LABELS, datasets: [line('Normal day (L)', c.normal, { dash: [5, 4] }), line('Today (L)', c.s1, { width: 2.5 })] },
                options: baseOptions(c, { yTitle: 'litres since midnight', maxTicks: 8 })
            })
        },
        reliability: {
            canvas: 'reliabilityChart',
            build: (c) => {
                const options = baseOptions(c, { yTitle: '% of readings stored', maxTicks: 8 });
                options.scales.y.max = 100;
                options.scales.y1 = {
                    position: 'right',
                    beginAtZero: true,
                    ticks: { color: c.ink, maxTicksLimit: 5 },
                    grid: { display: false },
                    title: { display: true, text: 'upload time (ms)', color: c.ink }
                };
                const uploads = { ...line('Average HTTPS upload (ms)', c.s1, { width: 2 }), yAxisID: 'y1' };
                return {
                    type: 'bar',
                    data: { labels: [], datasets: [bar('Readings stored (%)', c.s2), uploads] },
                    options
                };
            }
        }
    };

    function showEmpty(key, message) {
        const note = document.querySelector(`[data-chart-empty="${key}"]`);
        if (!note) return;
        note.textContent = message || '';
        note.hidden = !message;
    }

    function init() {
        if (!window.Chart) {
            document.querySelectorAll('[data-chart-empty]').forEach((note) => {
                note.textContent = 'Charts could not load. Check the internet connection.';
                note.hidden = false;
            });
            return;
        }
        window.Chart.defaults.font.family = "'IBM Plex Sans', system-ui, sans-serif";
        const colors = theme();
        Object.entries(SPECS).forEach(([key, spec]) => {
            const canvas = document.getElementById(spec.canvas);
            if (canvas) charts[key] = new window.Chart(canvas, spec.build(colors));
        });
    }

    function applyTheme() {
        if (!window.Chart) return;
        const colors = theme();
        Object.entries(SPECS).forEach(([key, spec]) => {
            const chart = charts[key];
            if (!chart) return;
            const fresh = spec.build(colors);
            chart.data.datasets.forEach((dataset, index) => {
                const look = fresh.data.datasets[index];
                dataset.borderColor = look.borderColor;
                dataset.backgroundColor = look.backgroundColor;
            });
            chart.options = fresh.options;
            chart.update('none');
        });
    }

    function timeLabel(timestamp) {
        return new Date(timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }

    /** @param {object[]} readings oldest first */
    function renderLive(readings, emptyMessage) {
        showEmpty('live', readings.length ? '' : emptyMessage);
        const chart = charts.live;
        if (!chart) return;
        chart.data.labels = readings.map((reading) => timeLabel(reading.timestamp));
        chart.data.datasets[0].data = readings.map((reading) => Math.max(0, lib.toNumber(reading.flow_rate_1)));
        chart.data.datasets[1].data = readings.map((reading) => Math.max(0, lib.toNumber(reading.flow_rate_2)));
        chart.update('none');
    }

    function renderLoss(loss, emptyMessage) {
        showEmpty('loss', loss && loss.weekUsed > 0 ? '' : emptyMessage);
        const chart = charts.loss;
        if (!chart || !loss) return;
        chart.data.labels = loss.perDay.map((day) => lib.shortDay(day.dateKey).replace(/ \w+$/, ''));
        chart.data.datasets[0].data = loss.perDay.map((day) => lib.round(Math.max(0, day.used - day.lost), 2));
        chart.data.datasets[1].data = loss.perDay.map((day) => lib.round(day.lost, 2));
        chart.update('none');
    }

    function renderHours(peak, emptyMessage) {
        showEmpty('hour', peak && peak.peakHour !== null ? '' : emptyMessage);
        const chart = charts.hour;
        if (!chart || !peak) return;
        chart.data.datasets[0].label = peak.basedOnToday ? 'Today so far (L)' : `Average of ${peak.daysAveraged} day${peak.daysAveraged === 1 ? '' : 's'} (L)`;
        chart.data.datasets[0].data = peak.averageByHour.map((value) => lib.round(value, 2));
        chart.data.datasets[1].data = peak.basedOnToday ? [] : peak.todayByHour.map((value) => lib.round(value, 2));
        chart.update('none');
    }

    function renderToday(unusual, emptyMessage) {
        const hasData = unusual && (unusual.todaySoFar > 0 || unusual.baselineDays > 0);
        showEmpty('today', hasData ? '' : emptyMessage);
        const chart = charts.today;
        if (!chart || !unusual) return;
        chart.data.datasets[0].data = unusual.baselineDays ? unusual.normalCumulative.map((value) => lib.round(value, 2)) : [];
        chart.data.datasets[1].data = unusual.todayCumulative.map((value) => lib.round(value, 2));
        chart.update('none');
    }

    /**
     * Last 24 hours: share of the 360 readings an hour that were stored, and the
     * average time the ESP32 took to upload one.
     */
    function renderReliability(rows, nowMs, emptyMessage) {
        const hourMs = 3600000;
        const timeZone = FlowState.config.device.timeZone;
        // Hours start on the device's clock (India time is UTC+05:30, so not on UTC hours).
        const parts = lib.zonedParts(nowMs, timeZone);
        const currentHour = nowMs - (parts.minute * 60 + parts.second) * 1000 - (nowMs % 1000);
        const byHour = new Map();
        (rows || []).forEach((row) => {
            const time = lib.toTime(row.hour_start);
            if (time !== null) byHour.set(time, row);
        });
        const hours = Array.from({ length: 24 }, (_, index) => currentHour - (23 - index) * hourMs);
        const hasData = hours.some((hour) => byHour.has(hour));
        showEmpty('reliability', hasData ? '' : emptyMessage);
        const chart = charts.reliability;
        if (!chart) return;
        chart.data.labels = hours.map((hour) => `${String(lib.zonedParts(hour, timeZone).hour).padStart(2, '0')}:00`);
        chart.data.datasets[0].data = hours.map((hour) => {
            const row = byHour.get(hour);
            if (!row) return 0;
            // The current hour is only partly over, so compare with what was possible so far.
            const elapsed = hour === currentHour ? Math.max(1, (nowMs - hour) / 10000) : 360;
            return lib.round(Math.min(100, (lib.toNumber(row.readings) / elapsed) * 100), 1);
        });
        chart.data.datasets[1].data = hours.map((hour) => {
            const row = byHour.get(hour);
            const value = row ? lib.toNumber(row.avg_upload_ms, NaN) : NaN;
            return Number.isFinite(value) ? value : null;
        });
        chart.update('none');
    }

    FlowState.charts = { init, applyTheme, renderLive, renderLoss, renderHours, renderToday, renderReliability };
})(window.FlowState = window.FlowState || {});
