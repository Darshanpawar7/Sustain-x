/*
 * The five trend charts. Each one shows server-side summaries for its chosen
 * period (15 minutes to 24 hours), so every period shows its real data.
 */
(function (FlowState) {
    'use strict';

    const { lib } = FlowState;

    const RANGES = ['15m', '1h', '6h', '24h'];
    const CHART_KEYS = ['flow', 'volume', 'hourly', 'loss', 'humidity'];
    const CANVAS_IDS = { flow: 'flowChart', volume: 'volumeChart', hourly: 'hourlyChart', loss: 'lossChart', humidity: 'humidityChart' };
    const CHART_TYPES = { flow: 'line', volume: 'bar', hourly: 'bar', loss: 'line', humidity: 'line' };
    const TITLES = {
        flow: 'Flow rate',
        volume: 'Water volume',
        hourly: 'Usage by hour of day',
        loss: 'Loss percentage',
        humidity: 'Humidity'
    };
    const SPARKLINE_FIELDS = {
        flow: 'avg_flow_rate_1',
        volume: 'volume_1_liters',
        hourly: 'volume_1_liters',
        loss: 'avg_percentage_loss',
        humidity: 'avg_humidity'
    };
    const DEFAULT_SPARKLINE = '1,8 8,7 14,6 20,5 25,4';

    const timeframes = { flow: '1h', volume: '1h', hourly: '24h', loss: '1h', humidity: '1h' };
    const charts = {};
    let history = {};
    let onRangeSelected = () => {};

    function palette(dark) {
        if (dark) {
            return {
                text: '#d2e5ef',
                grid: 'rgba(174, 209, 224, 0.14)',
                flow1Line: '#5bb9ff',
                flow1Fill: 'rgba(91, 185, 255, 0.16)',
                flow2Line: '#48d798',
                flow2Fill: 'rgba(72, 215, 152, 0.16)',
                vol1: 'rgba(91, 185, 255, 0.78)',
                vol2: 'rgba(72, 215, 152, 0.78)',
                hourly: 'rgba(245, 173, 63, 0.82)',
                lossLine: '#ff7c73',
                lossFill: 'rgba(255, 124, 115, 0.18)',
                humidityLine: '#54d0f3',
                humidityFill: 'rgba(84, 208, 243, 0.2)'
            };
        }
        return {
            text: '#264252',
            grid: 'rgba(38, 66, 82, 0.12)',
            flow1Line: '#0f87c8',
            flow1Fill: 'rgba(15, 135, 200, 0.14)',
            flow2Line: '#0d9f6b',
            flow2Fill: 'rgba(13, 159, 107, 0.14)',
            vol1: 'rgba(15, 135, 200, 0.72)',
            vol2: 'rgba(13, 159, 107, 0.72)',
            hourly: 'rgba(240, 153, 30, 0.76)',
            lossLine: '#d4534b',
            lossFill: 'rgba(212, 83, 75, 0.16)',
            humidityLine: '#148eb2',
            humidityFill: 'rgba(20, 142, 178, 0.18)'
        };
    }

    function optionsFor(key, theme) {
        const yTicks = { color: theme.text };
        const y = { beginAtZero: true, ticks: yTicks, grid: { color: theme.grid } };
        if (key === 'humidity') {
            y.min = 0;
            y.max = 100;
            yTicks.callback = (value) => `${value}%`;
        }
        if (key === 'loss') {
            y.suggestedMax = 20;
            yTicks.callback = (value) => `${value}%`;
        }
        return {
            responsive: true,
            maintainAspectRatio: false,
            // Charts refresh in the background. With animations on, Chart.js 3
            // skips drawing when an update arrives mid-animation, leaving charts blank.
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: { color: theme.text, boxWidth: 12, usePointStyle: true, pointStyle: 'circle' }
                }
            },
            scales: {
                x: {
                    ticks: { color: theme.text, autoSkip: true, autoSkipPadding: 12, maxRotation: 0, maxTicksLimit: 5 },
                    grid: { color: theme.grid }
                },
                y
            }
        };
    }

    function datasetsFor(key, theme) {
        const line = (label, border, fill) => ({
            label, data: [], borderColor: border, backgroundColor: fill, tension: 0.3, fill: true, pointRadius: 0, spanGaps: false
        });
        switch (key) {
            case 'flow':
                return [line('Sensor 1 (L/min)', theme.flow1Line, theme.flow1Fill), line('Sensor 2 (L/min)', theme.flow2Line, theme.flow2Fill)];
            case 'volume':
                return [
                    { label: 'Sensor 1 (L)', data: [], backgroundColor: theme.vol1 },
                    { label: 'Sensor 2 (L)', data: [], backgroundColor: theme.vol2 }
                ];
            case 'hourly':
                return [{ label: 'Litres through sensor 1', data: new Array(24).fill(0), backgroundColor: theme.hourly }];
            case 'loss':
                return [line('Average loss (%)', theme.lossLine, theme.lossFill)];
            default:
                return [line('Humidity (%)', theme.humidityLine, theme.humidityFill)];
        }
    }

    function colorDatasets(key, chart, theme) {
        const sets = chart.data.datasets;
        if (key === 'flow') {
            Object.assign(sets[0], { borderColor: theme.flow1Line, backgroundColor: theme.flow1Fill });
            Object.assign(sets[1], { borderColor: theme.flow2Line, backgroundColor: theme.flow2Fill });
        } else if (key === 'volume') {
            sets[0].backgroundColor = theme.vol1;
            sets[1].backgroundColor = theme.vol2;
        } else if (key === 'hourly') {
            sets[0].backgroundColor = theme.hourly;
        } else if (key === 'loss') {
            Object.assign(sets[0], { borderColor: theme.lossLine, backgroundColor: theme.lossFill });
        } else {
            Object.assign(sets[0], { borderColor: theme.humidityLine, backgroundColor: theme.humidityFill });
        }
    }

    // Short 24-hour labels ("14:05") so several fit side by side without overlapping.
    function bucketLabel(value, range) {
        const options = range === '15m'
            ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }
            : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        return new Date(value).toLocaleTimeString([], options);
    }

    function rowsFor(range) {
        return (history[range] && history[range].rows) || [];
    }

    function fillChart(key, rows, range) {
        const chart = charts[key];
        const labels = rows.map((row) => bucketLabel(row.bucket_start, range));
        const numbers = (field) => rows.map((row) => lib.toNumber(row[field]));
        const sets = chart.data.datasets;

        if (key === 'hourly') {
            sets[0].data = lib.hourlyUsage(rows);
        } else {
            chart.data.labels = labels;
            if (key === 'flow') {
                sets[0].data = numbers('avg_flow_rate_1');
                sets[1].data = numbers('avg_flow_rate_2');
            } else if (key === 'volume') {
                sets[0].data = numbers('volume_1_liters');
                sets[1].data = numbers('volume_2_liters');
            } else if (key === 'loss') {
                sets[0].data = numbers('avg_percentage_loss');
            } else {
                sets[0].data = rows.map((row) => lib.humidityOrNull(row.avg_humidity));
            }
        }
        chart.update('none');
    }

    function renderEmptyState(key, range, notice) {
        const note = document.querySelector(`[data-chart-empty="${key}"]`);
        if (!note) return;
        const entry = history[range];
        const rows = rowsFor(range);
        let message = '';
        if (notice && !rows.length) message = notice;
        else if (!entry || (entry.loading && !entry.fetchedAt)) message = 'Loading…';
        else if (entry.failed && !rows.length) message = 'Could not load this period. Retrying shortly.';
        else if (!rows.length) message = 'No readings in this period yet.';
        note.textContent = message;
        note.hidden = message === '';
    }

    // Tiny trend line on each timeframe tab.
    function sparklinePoints(values) {
        const numeric = values.filter((value) => Number.isFinite(value));
        if (numeric.length < 2) return DEFAULT_SPARKLINE;
        const stride = (numeric.length - 1) / 5;
        const sampled = Array.from({ length: 6 }, (_, index) => numeric[Math.round(index * stride)]);
        const min = Math.min(...sampled);
        const span = Math.max(Math.max(...sampled) - min, 0.0001);
        return sampled.map((value, index) => {
            const x = Math.round((index / 5) * 24) + 1;
            const y = Math.round((1 - (value - min) / span) * 7) + 1;
            return `${x},${y}`;
        }).join(' ');
    }

    function renderSparklines() {
        document.querySelectorAll('.timeframe-tabs').forEach((group) => {
            const field = SPARKLINE_FIELDS[group.dataset.chart];
            group.querySelectorAll('.timeframe-tab').forEach((tab) => {
                const line = tab.querySelector('.timeframe-sparkline-line');
                if (!line || !field) return;
                const values = rowsFor(tab.dataset.range).map((row) => lib.toNumber(row[field], NaN));
                line.setAttribute('points', sparklinePoints(values));
            });
        });
    }

    function renderTitles() {
        document.querySelectorAll('[data-chart-title]').forEach((title) => {
            const key = title.dataset.chartTitle;
            title.textContent = `${TITLES[key] || 'Trend'} (${timeframes[key] || '1h'})`;
        });
    }

    let notice = '';

    /**
     * @param {object} [nextHistory] history per range, as kept by app.js
     * @param {string} [nextNotice] message shown on empty charts instead of the usual text
     */
    function render(nextHistory, nextNotice) {
        history = nextHistory || history;
        if (nextNotice !== undefined) notice = nextNotice;
        CHART_KEYS.forEach((key) => {
            const range = timeframes[key];
            if (charts[key]) fillChart(key, rowsFor(range), range);
            renderEmptyState(key, range, notice);
        });
        renderSparklines();
    }

    function buildTabs() {
        document.querySelectorAll('.timeframe-tabs').forEach((group) => {
            const key = group.dataset.chart;
            const tabs = group.querySelectorAll('.timeframe-tab');
            tabs.forEach((tab) => {
                if (!tab.querySelector('.timeframe-sparkline')) {
                    const label = document.createElement('span');
                    label.className = 'timeframe-label';
                    label.textContent = tab.textContent.trim();
                    const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    spark.setAttribute('viewBox', '0 0 26 10');
                    spark.setAttribute('aria-hidden', 'true');
                    spark.classList.add('timeframe-sparkline');
                    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
                    polyline.classList.add('timeframe-sparkline-line');
                    polyline.setAttribute('points', DEFAULT_SPARKLINE);
                    spark.appendChild(polyline);
                    tab.replaceChildren(label, spark);
                }
                const selected = tab.dataset.range === timeframes[key];
                tab.classList.toggle('active', selected);
                tab.setAttribute('aria-pressed', String(selected));
                tab.addEventListener('click', () => {
                    const range = tab.dataset.range;
                    if (!RANGES.includes(range)) return;
                    timeframes[key] = range;
                    tabs.forEach((other) => {
                        const isActive = other === tab;
                        other.classList.toggle('active', isActive);
                        other.setAttribute('aria-pressed', String(isActive));
                    });
                    renderTitles();
                    render();
                    onRangeSelected(range);
                });
            });
        });
    }

    function init(dark, handlers = {}) {
        onRangeSelected = handlers.onRangeSelected || onRangeSelected;
        buildTabs();
        renderTitles();
        if (!window.Chart) {
            document.querySelectorAll('[data-chart-empty]').forEach((note) => {
                note.textContent = 'Charts could not load. Check your internet connection.';
                note.hidden = false;
            });
            return;
        }
        const theme = palette(dark);
        CHART_KEYS.forEach((key) => {
            const canvas = document.getElementById(CANVAS_IDS[key]);
            if (!canvas) return;
            charts[key] = new window.Chart(canvas, {
                type: CHART_TYPES[key],
                data: {
                    labels: key === 'hourly' ? Array.from({ length: 24 }, (_, hour) => `${hour}:00`) : [],
                    datasets: datasetsFor(key, theme)
                },
                options: optionsFor(key, theme)
            });
        });
        render();
    }

    function applyTheme(dark) {
        const theme = palette(dark);
        CHART_KEYS.forEach((key) => {
            const chart = charts[key];
            if (!chart) return;
            colorDatasets(key, chart, theme);
            chart.options = optionsFor(key, theme);
            chart.update('none');
        });
    }

    function selectedRanges() {
        return CHART_KEYS.map((key) => timeframes[key]);
    }

    FlowState.charts = { RANGES, init, render, applyTheme, selectedRanges };
})(window.FlowState = window.FlowState || {});
