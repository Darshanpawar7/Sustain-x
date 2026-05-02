// ============== CONFIGURATION ==============
// Netlify injects values into window.__ENV__ at deploy time.
const SUPABASE_CONFIG = {
    // Prefer user-saved credentials so firmware/dashboard can be pointed to the same Supabase project.
    url: localStorage.getItem('supabaseUrl') || window.__ENV__?.SUPABASE_URL || '',
    key: localStorage.getItem('supabaseKey') || window.__ENV__?.SUPABASE_KEY || ''
};

const CONFIG = {
    normalThreshold: 5,
    warningThreshold: 15,
    costPerLiter: 0.05,
    chartPointsLimit: 60, // Last 60 data points
    maxReadingsFetch: 600,
    fastPollMs: 1000
};

const API_ADAPTER_CONFIG = {
    mode: (window.__ENV__?.API_ADAPTER_MODE || 'local').toLowerCase(),
    baseUrl: window.__ENV__?.API_BASE_URL || localStorage.getItem('apiBaseUrl') || 'http://localhost:8000'
};



let supabaseClient = null;
let isConfigured = false;
let readingsSubscription = null;
let alertsSubscription = null;
let realtimeConnected = false;
let fastPollingTimer = null;
let isDarkMode = false;
let latestReadingSnapshot = null;
let localAdapterState = {
    alerts: [],
    simulations: new Map(),
    lastDetectKey: null
};
let alertFilterSeverity = 'all';
let alertSearchTerm = '';
let alertAckFilter = 'open';
let mobileCriticalOnly = false;
let judgesDemoOnePass = localStorage.getItem('judgesDemoOnePass') === 'true';
let judgesDemoTimer = null;
let judgesDemoActive = false;
let judgesDemoStepIndex = 0;
let adapterHealthTimer = null;
let adapterHealthState = {
    status: 'checking',
    label: 'Checking...',
    latencyMs: null
};
const chartTimeframes = {
    flow: '1h',
    volume: '1h',
    hourly: '1h',
    loss: '1h',
    humidity: '1h'
};
const acknowledgedAlertKeys = new Set(JSON.parse(localStorage.getItem('acknowledgedAlerts') || '[]'));

// Data storage
const dataStore = {
    readings: [],
    alerts: [],
    hourlyUsage: {}
};

// Chart instances
let flowChart = null;
let volumeChart = null;
let hourlyChart = null;
let lossChart = null;
let humidityChart = null;

const JUDGES_DEMO_STEPS = [
    { selector: '#demoProblemCard', label: 'Problem Understanding (15)' },
    { selector: '#demoInnovationCard', label: 'Innovation (20)' },
    { selector: '#demoTechCard', label: 'Technical Implementation (20)' },
    { selector: '#demoImpactCard', label: 'Sustainability Impact (15)' },
    { selector: '#demoFeasibilityCard', label: 'Feasibility & Scalability (15)' },
    { selector: '#demoPresentationCard', label: 'Presentation & Demo (10)' },
    { selector: '#demoUxCard', label: 'UI/UX' }
];

const localApiAdapter = {
    async detect(request) {
        const reading = Array.isArray(request?.readings) ? request.readings[request.readings.length - 1] : null;
        if (!reading) {
            return { status: 'error', error_message: 'No readings provided' };
        }

        const normalizedReading = {
            timestamp: reading.timestamp || new Date().toISOString(),
            flow_rate_1: Number(reading.flow_rate_1 ?? reading.flow_rate ?? 0),
            flow_rate_2: Number(reading.flow_rate_2 ?? Math.max(0, Number(reading.flow_rate ?? 0) - Number(reading.leak_rate ?? 0))),
            percentage_loss: Number(reading.percentage_loss ?? 0),
            daily_total_liters: Number(reading.daily_total_liters ?? 0),
            humidity: Number(reading.humidity ?? 0)
        };

        const risk = computePriorityProfile(normalizedReading);
        const isAlertWorthy = risk.priorityScore >= 25 || risk.leakRateLpm > 0.2;
        if (!isAlertWorthy) {
            return { status: 'success', data: { alerts_created: 0, alerts: [] } };
        }

        const alert = {
            id: `loc-${Date.now()}`,
            alert_id: `loc-${Date.now()}`,
            timestamp: normalizedReading.timestamp,
            severity: risk.priorityLevel.toLowerCase(),
            priority_level: risk.priorityLevel,
            priority_score: risk.priorityScore,
            failure_probability: Number(risk.failureProbability.toFixed(3)),
            immediate_action_required: risk.immediateAction,
            alert_type: `${risk.priorityLevel} Leak Risk`,
            message: risk.narrative,
            leak_rate: Number(risk.leakRateLpm.toFixed(3)),
            source: 'local-adapter'
        };

        return { status: 'success', data: { alerts_created: 1, alerts: [alert] } };
    },

    async whatif(payload) {
        const leakRateLpm = Math.max(0, Number(payload?.leak_rate || 0));
        const horizonDays = Math.max(1, Math.min(365, Number(payload?.time_horizon_days || 30)));
        const repairCost = Math.max(1, Number(payload?.repair_cost || 1));

        const ignoreLoss = leakRateLpm * 60 * 24 * horizonDays;
        const ignoreCost = (ignoreLoss * CONFIG.costPerLiter) + ((ignoreLoss / 90000) * 120);
        const preventedLoss = ignoreLoss * 0.92;
        const savings = ignoreCost - repairCost;
        const recommended = savings > 0 ? 'Repair immediately' : 'Monitor and schedule maintenance';
        const simulationId = `sim-${Date.now()}`;

        const result = {
            simulation_id: simulationId,
            alert_id: payload?.alert_id || 'esp32-live',
            ignore_scenario: {
                total_water_loss_liters: Number(ignoreLoss.toFixed(2)),
                financial_cost_usd: Number(ignoreCost.toFixed(2)),
                infrastructure_damage_score: Number(Math.min(10, (ignoreLoss / 90000) + 1.2).toFixed(2))
            },
            repair_scenario: {
                repair_cost_usd: Number(repairCost.toFixed(2)),
                water_loss_prevented_liters: Number(preventedLoss.toFixed(2))
            },
            savings_usd: Number(savings.toFixed(2)),
            recommended_action: recommended
        };

        localAdapterState.simulations.set(simulationId, result);
        return { status: 'success', data: result };
    },

    async explain(payload) {
        const risk = computePriorityProfile(payload?.reading || latestReadingSnapshot || {});
        const simulation = payload?.simulation_result || localAdapterState.simulations.get(payload?.simulation_id);
        const savings = Number(simulation?.savings_usd || 0);
        const repairCost = Number(simulation?.repair_scenario?.repair_cost_usd || payload?.repair_cost || risk.inferredRepairCost || 0);

        const urgency = risk.immediateAction
            ? `Urgent: priority ${risk.priorityScore}/100 and ${(risk.failureProbability * 100).toFixed(1)}% failure probability require immediate repair.`
            : `Moderate risk: maintain close monitoring while planning cost-optimized intervention.`;

        const recommendation = {
            recommended_action: savings > 0 || risk.immediateAction ? 'Repair immediately' : 'Monitor and schedule maintenance',
            savings_usd: Number(savings.toFixed(2)),
            repair_cost_usd: Number(repairCost.toFixed(2)),
            urgency_rationale: urgency,
            ai_text: `${urgency} Projected net savings: $${Math.max(0, savings).toFixed(2)}.`
        };

        return { status: 'success', data: recommendation };
    }
};

function normalizeApiAlert(alert) {
    const priority = String(alert?.priority_level || '').toLowerCase();
    const severity = alert?.severity || (
        priority === 'critical' ? 'critical' :
        priority === 'high' ? 'high' :
        priority === 'medium' ? 'warning' :
        'warning'
    );

    return {
        ...alert,
        alert_id: alert?.alert_id || alert?.id || `api-${Date.now()}`,
        timestamp: alert?.timestamp || new Date().toISOString(),
        severity,
        alert_type: alert?.alert_type || `${(alert?.priority_level || 'Alert')} Alert`,
        message: alert?.message || alert?.urgency_rationale || 'No message provided'
    };
}

async function apiRequest(path, payload) {
    const base = API_ADAPTER_CONFIG.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    let parsed = null;
    try {
        parsed = await response.json();
    } catch (_) {
        parsed = null;
    }

    if (!response.ok) {
        const message = parsed?.error_message || parsed?.detail || `HTTP ${response.status}`;
        return { status: 'error', error_message: message };
    }

    if (parsed && typeof parsed === 'object' && 'status' in parsed) {
        return parsed;
    }

    return { status: 'success', data: parsed };
}

const remoteApiAdapter = {
    async detect(request) {
        const response = await apiRequest('/detect', request);
        if (response?.status !== 'success') {
            return response;
        }

        const alerts = Array.isArray(response?.data?.alerts)
            ? response.data.alerts.map(normalizeApiAlert)
            : [];

        return {
            status: 'success',
            data: {
                alerts_created: Number(response?.data?.alerts_created || alerts.length),
                alerts
            }
        };
    },

    async whatif(payload) {
        return apiRequest('/whatif', payload);
    },

    async explain(payload) {
        return apiRequest('/explain', payload);
    }
};

function getActiveApiAdapter() {
    return API_ADAPTER_CONFIG.mode === 'remote' ? remoteApiAdapter : localApiAdapter;
}

async function pingAdapterHealth() {
    if (API_ADAPTER_CONFIG.mode !== 'remote') {
        return {
            status: 'online',
            label: 'Local simulator',
            latencyMs: 0
        };
    }

    const base = API_ADAPTER_CONFIG.baseUrl.replace(/\/$/, '');
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 3000);
    const startedAt = performance.now();

    try {
        const response = await fetch(`${base}/health`, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal
        });
        window.clearTimeout(timeoutId);

        const latency = Math.max(1, Math.round(performance.now() - startedAt));
        if (!response.ok) {
            return {
                status: 'offline',
                label: `HTTP ${response.status}`,
                latencyMs: latency
            };
        }

        return {
            status: 'online',
            label: 'Healthy',
            latencyMs: latency
        };
    } catch (_) {
        window.clearTimeout(timeoutId);
        return {
            status: 'offline',
            label: 'Unreachable',
            latencyMs: null
        };
    }
}

function renderAdapterStatusBadge() {
    const modeEl = document.getElementById('adapterModeLabel');
    const dotEl = document.getElementById('adapterHealthDot');
    const healthEl = document.getElementById('adapterHealthLabel');
    const urlEl = document.getElementById('adapterUrlLabel');
    if (!modeEl || !dotEl || !healthEl || !urlEl) return;

    modeEl.textContent = API_ADAPTER_CONFIG.mode === 'remote' ? 'REMOTE' : 'LOCAL';
    urlEl.textContent = API_ADAPTER_CONFIG.mode === 'remote'
        ? API_ADAPTER_CONFIG.baseUrl
        : 'local://browser';

    dotEl.classList.remove('adapter-health-online', 'adapter-health-offline', 'adapter-health-checking');
    dotEl.classList.add(
        adapterHealthState.status === 'online'
            ? 'adapter-health-online'
            : adapterHealthState.status === 'offline'
                ? 'adapter-health-offline'
                : 'adapter-health-checking'
    );

    const suffix = API_ADAPTER_CONFIG.mode === 'remote' && adapterHealthState.latencyMs !== null
        ? ` (${adapterHealthState.latencyMs}ms)`
        : '';
    healthEl.textContent = `${adapterHealthState.label}${suffix}`;
}

async function refreshAdapterHealth() {
    adapterHealthState = {
        status: 'checking',
        label: 'Checking...',
        latencyMs: null
    };
    renderAdapterStatusBadge();
    adapterHealthState = await pingAdapterHealth();
    renderAdapterStatusBadge();
}

function setupAdapterStatusBadge() {
    renderAdapterStatusBadge();
    refreshAdapterHealth();

    if (adapterHealthTimer) {
        window.clearInterval(adapterHealthTimer);
    }
    adapterHealthTimer = window.setInterval(refreshAdapterHealth, 12000);
}

// ============== INITIALIZATION ==============
document.addEventListener('DOMContentLoaded', function() {
    console.log('Dashboard initialized');
    initializeRevealAnimations();
    setupAlertsUI();
    setupAlertAcknowledgementUI();
    setupChartTimeframeControls();
    setupTimeframeSparklineUI();
    loadTheme();
    setupThemeToggle();
    setupAdapterStatusBadge();
    setupIntelligenceStudio();
    setupJudgesDemoMode();
    setupMobileCriticalMode();
    loadConfiguration();
    initSupabase(SUPABASE_CONFIG.url, SUPABASE_CONFIG.key);
    initializeCharts();
    refreshChartTitles();
    startMonitoring();
});

function timeframeToMs(range) {
    const mapping = {
        '15m': 15 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000
    };
    return mapping[range] || mapping['1h'];
}

function getPointsLimitForRange(range) {
    const mapping = {
        '15m': 45,
        '1h': 90,
        '6h': 180,
        '24h': 280
    };
    return mapping[range] || 90;
}

function getFilteredReadings(range) {
    const readings = Array.isArray(dataStore.readings) ? dataStore.readings : [];
    if (readings.length === 0) return [];

    const now = Date.now();
    const threshold = now - timeframeToMs(range);
    const withinRange = readings.filter(r => new Date(r.timestamp).getTime() >= threshold);
    const source = withinRange.length > 0 ? withinRange : readings;
    const pointLimit = getPointsLimitForRange(range);

    if (source.length <= pointLimit) {
        return source;
    }

    const sampled = [];
    const stride = Math.ceil(source.length / pointLimit);
    for (let index = 0; index < source.length; index += stride) {
        sampled.push(source[index]);
    }

    if (sampled[sampled.length - 1] !== source[source.length - 1]) {
        sampled.push(source[source.length - 1]);
    }

    return sampled;
}

function setupChartTimeframeControls() {
    const controls = document.querySelectorAll('.timeframe-tabs');
    controls.forEach(group => {
        const chartKey = group.dataset.chart;
        const buttons = group.querySelectorAll('.timeframe-tab');

        buttons.forEach(button => {
            button.addEventListener('click', () => {
                const selectedRange = button.dataset.range || '1h';
                chartTimeframes[chartKey] = selectedRange;
                buttons.forEach(btn => btn.classList.toggle('active', btn === button));
                refreshChartTitles();
                updateCharts();
            });
        });
    });
}

function refreshChartTitles() {
    const chartTitles = document.querySelectorAll('[data-chart-title]');
    chartTitles.forEach(title => {
        const chartKey = title.dataset.chartTitle;
        const selectedRange = chartTimeframes[chartKey] || '1h';
        const map = {
            flow: 'Flow Rate Trend',
            volume: 'Accumulated Volume',
            hourly: 'Hourly Usage Pattern',
            loss: 'Loss Percentage Trend',
            humidity: 'Humidity Trend'
        };
        title.textContent = `${map[chartKey] || 'Trend'} (${selectedRange})`;
    });
}

function getAlertKey(alert) {
    if (alert?.id !== undefined && alert?.id !== null) {
        return `id:${alert.id}`;
    }
    return `${alert?.timestamp || 'na'}|${alert?.alert_type || 'alert'}|${alert?.message || ''}`;
}

function saveAcknowledgedAlerts() {
    localStorage.setItem('acknowledgedAlerts', JSON.stringify(Array.from(acknowledgedAlertKeys)));
}

function setupAlertAcknowledgementUI() {
    const container = document.getElementById('alertsContainer');
    if (!container) return;

    container.addEventListener('click', (event) => {
        const button = event.target.closest('.ack-btn');
        if (!button) return;

        const alertKey = button.dataset.alertKey;
        if (!alertKey) return;

        if (acknowledgedAlertKeys.has(alertKey)) {
            acknowledgedAlertKeys.delete(alertKey);
            showAlert('Alert moved back to open', 'warning');
        } else {
            acknowledgedAlertKeys.add(alertKey);
            showAlert('Alert acknowledged', 'normal');
        }

        saveAcknowledgedAlerts();
        updateAlerts(dataStore.alerts || []);
    });
}

function setupMobileCriticalMode() {
    const switchInput = document.getElementById('mobileCriticalOnly');
    if (!switchInput) return;

    mobileCriticalOnly = localStorage.getItem('mobileCriticalOnly') === 'true';
    switchInput.checked = mobileCriticalOnly;
    applyMobileCriticalMode();

    switchInput.addEventListener('change', () => {
        mobileCriticalOnly = switchInput.checked;
        localStorage.setItem('mobileCriticalOnly', String(mobileCriticalOnly));
        applyMobileCriticalMode();
        updateAlerts(dataStore.alerts || []);
    });
}

function applyMobileCriticalMode() {
    const shouldApply = mobileCriticalOnly && window.matchMedia('(max-width: 768px)').matches;
    document.body.classList.toggle('mobile-critical-mode', shouldApply);
}

function setupJudgesDemoMode() {
    const button = document.getElementById('judgesDemoToggle');
    const onePassToggle = document.getElementById('judgesDemoOnePass');
    if (!button) return;

    if (onePassToggle) {
        onePassToggle.checked = judgesDemoOnePass;
        onePassToggle.addEventListener('change', () => {
            judgesDemoOnePass = onePassToggle.checked;
            localStorage.setItem('judgesDemoOnePass', String(judgesDemoOnePass));
            applyJudgesDemoUIState();
        });
    }

    button.addEventListener('click', () => {
        if (judgesDemoActive) {
            stopJudgesDemoMode();
        } else {
            startJudgesDemoMode();
        }
    });
}

function startJudgesDemoMode() {
    const validSteps = JUDGES_DEMO_STEPS
        .map(step => ({ ...step, element: document.querySelector(step.selector) }))
        .filter(step => step.element);

    if (!validSteps.length) {
        showAlert('Judges Demo Mode unavailable: criteria cards not found.', 'warning');
        return;
    }

    judgesDemoActive = true;
    judgesDemoStepIndex = 0;
    applyJudgesDemoUIState();

    // Align with scoring criteria order and move focus every few seconds.
    runJudgesDemoStep(validSteps, judgesDemoStepIndex);
    judgesDemoTimer = window.setInterval(() => {
        if (judgesDemoOnePass && judgesDemoStepIndex >= validSteps.length - 1) {
            stopJudgesDemoMode(true);
            return;
        }

        judgesDemoStepIndex = (judgesDemoStepIndex + 1) % validSteps.length;
        runJudgesDemoStep(validSteps, judgesDemoStepIndex);
    }, 4200);

    showAlert(judgesDemoOnePass ? 'Judges Demo Mode started (one-pass)' : 'Judges Demo Mode started (loop)', 'normal');
}

function stopJudgesDemoMode(completedOnePass = false) {
    if (judgesDemoTimer) {
        window.clearInterval(judgesDemoTimer);
        judgesDemoTimer = null;
    }

    judgesDemoActive = false;
    judgesDemoStepIndex = 0;
    document.querySelectorAll('.criterion-card.demo-focus').forEach(card => card.classList.remove('demo-focus'));
    applyJudgesDemoUIState();
    if (completedOnePass) {
        showAlert('Judges Demo Mode completed one-pass sequence', 'normal');
    } else {
        showAlert('Judges Demo Mode stopped', 'normal');
    }
}

function runJudgesDemoStep(steps, activeIndex) {
    steps.forEach((step, index) => {
        step.element.classList.toggle('demo-focus', index === activeIndex);
    });

    const activeStep = steps[activeIndex];
    if (!activeStep || !activeStep.element) return;

    activeStep.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const status = document.getElementById('judgesDemoStatus');
    if (status) {
        status.textContent = `Demo: ${activeStep.label}`;
    }
}

function applyJudgesDemoUIState() {
    const button = document.getElementById('judgesDemoToggle');
    const status = document.getElementById('judgesDemoStatus');

    if (button) {
        button.classList.toggle('active', judgesDemoActive);
        button.textContent = judgesDemoActive ? '■ Stop Judges Demo' : '▶ Judges Demo Mode';
    }

    if (!judgesDemoActive && status) {
        status.textContent = judgesDemoOnePass ? 'Demo: Manual (One-pass ready)' : 'Demo: Manual (Loop ready)';
    }
}

function getChartTheme() {
    if (isDarkMode) {
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

function createChartOptions(theme) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: true,
                position: 'top',
                labels: {
                    color: theme.text,
                    boxWidth: 12,
                    usePointStyle: true,
                    pointStyle: 'circle'
                }
            }
        },
        scales: {
            x: {
                ticks: { color: theme.text },
                grid: { color: theme.grid }
            },
            y: {
                beginAtZero: true,
                ticks: { color: theme.text },
                grid: { color: theme.grid }
            }
        }
    };
}

function applyChartTheme() {
    const theme = getChartTheme();
    const chartOptions = createChartOptions(theme);

    if (flowChart) {
        flowChart.data.datasets[0].borderColor = theme.flow1Line;
        flowChart.data.datasets[0].backgroundColor = theme.flow1Fill;
        flowChart.data.datasets[1].borderColor = theme.flow2Line;
        flowChart.data.datasets[1].backgroundColor = theme.flow2Fill;
        flowChart.options = { ...chartOptions };
        flowChart.update('none');
    }

    if (volumeChart) {
        volumeChart.data.datasets[0].backgroundColor = theme.vol1;
        volumeChart.data.datasets[1].backgroundColor = theme.vol2;
        volumeChart.options = { ...chartOptions };
        volumeChart.update('none');
    }

    if (hourlyChart) {
        hourlyChart.data.datasets[0].backgroundColor = theme.hourly;
        hourlyChart.options = { ...chartOptions };
        hourlyChart.update('none');
    }

    if (lossChart) {
        lossChart.data.datasets[0].borderColor = theme.lossLine;
        lossChart.data.datasets[0].backgroundColor = theme.lossFill;
        lossChart.options = { ...chartOptions };
        lossChart.update('none');
    }

    if (humidityChart) {
        humidityChart.data.datasets[0].borderColor = theme.humidityLine;
        humidityChart.data.datasets[0].backgroundColor = theme.humidityFill;
        humidityChart.options = {
            ...chartOptions,
            scales: {
                ...chartOptions.scales,
                y: {
                    ...chartOptions.scales.y,
                    min: 0,
                    max: 100,
                    ticks: {
                        ...chartOptions.scales.y.ticks,
                        callback: value => `${value}%`
                    }
                }
            }
        };
        humidityChart.update('none');
    }
}

function setupAlertsUI() {
    const tabs = document.querySelectorAll('.alerts-tab');
    const ackTabs = document.querySelectorAll('.alerts-ack-tab');
    const searchInput = document.getElementById('alertSearch');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            alertFilterSeverity = tab.dataset.severity || 'all';
            tabs.forEach(btn => btn.classList.toggle('active', btn === tab));
            updateAlerts(dataStore.alerts || []);
        });
    });

    if (searchInput) {
        searchInput.addEventListener('input', (event) => {
            alertSearchTerm = (event.target.value || '').trim().toLowerCase();
            updateAlerts(dataStore.alerts || []);
        });
    }

    ackTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            alertAckFilter = tab.dataset.ack || 'open';
            ackTabs.forEach(btn => btn.classList.toggle('active', btn === tab));
            updateAlerts(dataStore.alerts || []);
        });
    });
}

function setupTimeframeSparklineUI() {
    const tabs = document.querySelectorAll('.timeframe-tab');
    tabs.forEach(tab => {
        if (tab.querySelector('.timeframe-sparkline')) return;

        const label = tab.textContent.trim();
        tab.textContent = '';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'timeframe-label';
        labelSpan.textContent = label;

        const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        spark.setAttribute('viewBox', '0 0 26 10');
        spark.setAttribute('aria-hidden', 'true');
        spark.classList.add('timeframe-sparkline');

        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.classList.add('timeframe-sparkline-line');
        polyline.setAttribute('points', '1,8 8,7 14,6 20,5 25,4');
        spark.appendChild(polyline);

        tab.appendChild(labelSpan);
        tab.appendChild(spark);
    });
}

function getChartMetricValue(chartKey, reading) {
    switch (chartKey) {
        case 'flow':
            return Number(reading.flow_rate_1 || 0) + Number(reading.flow_rate_2 || 0);
        case 'volume':
            return Number(reading.flow_rate_1 || 0) * 0.1;
        case 'hourly':
            return Number(reading.flow_rate_1 || 0);
        case 'loss':
            return Number(reading.percentage_loss || 0);
        case 'humidity': {
            const humidity = Number(reading.humidity);
            return Number.isFinite(humidity) ? humidity : 0;
        }
        default:
            return 0;
    }
}

function sampleValues(values, targetCount = 6) {
    if (values.length <= targetCount) return values;
    const sampled = [];
    const stride = (values.length - 1) / (targetCount - 1);
    for (let index = 0; index < targetCount; index++) {
        sampled.push(values[Math.round(index * stride)]);
    }
    return sampled;
}

function valuesToSparklinePoints(values) {
    if (!values.length) return '1,8 8,7 14,6 20,5 25,4';

    const sampled = sampleValues(values, 6);
    const min = Math.min(...sampled);
    const max = Math.max(...sampled);
    const span = Math.max(max - min, 0.0001);

    return sampled.map((value, index) => {
        const x = Math.round((index / Math.max(sampled.length - 1, 1)) * 24) + 1;
        const normalized = (value - min) / span;
        const y = Math.round((1 - normalized) * 7) + 1;
        return `${x},${y}`;
    }).join(' ');
}

function updateTimeframeSparklines() {
    const groups = document.querySelectorAll('.timeframe-tabs');
    groups.forEach(group => {
        const chartKey = group.dataset.chart;
        const tabs = group.querySelectorAll('.timeframe-tab');

        tabs.forEach(tab => {
            const range = tab.dataset.range || '1h';
            const readings = getFilteredReadings(range);
            const values = readings.map(reading => getChartMetricValue(chartKey, reading));
            const points = valuesToSparklinePoints(values);
            const line = tab.querySelector('.timeframe-sparkline-line');

            if (line) {
                line.setAttribute('points', points);
            }
        });
    });
}

function initializeRevealAnimations() {
    const revealTargets = document.querySelectorAll('.card, .chart-container');
    if (revealTargets.length === 0) return;

    revealTargets.forEach((el, index) => {
        el.classList.add('card-reveal');
        el.style.transition = `opacity 420ms ease ${Math.min(index * 40, 320)}ms, transform 420ms ease ${Math.min(index * 40, 320)}ms`;
    });

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    revealTargets.forEach(el => observer.observe(el));
}

// ============== THEME MANAGEMENT ==============
function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    isDarkMode = savedTheme === 'dark';
    applyTheme(isDarkMode);
}

function setupThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
}

function toggleTheme() {
    isDarkMode = !isDarkMode;
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    applyTheme(isDarkMode);
    updateThemeButtonDisplay();
}

function applyTheme(dark) {
    if (dark) {
        document.body.classList.add('dark-mode');
        document.documentElement.style.setProperty('--bg-color', '#0d1117');
        document.documentElement.style.setProperty('--text-color', '#e6edf3');
        document.documentElement.style.setProperty('--card-bg', 'rgba(13, 17, 23, 0.7)');
    } else {
        document.body.classList.remove('dark-mode');
        document.documentElement.style.setProperty('--bg-color', '#F0F4F8');
        document.documentElement.style.setProperty('--text-color', '#0D1B2A');
        document.documentElement.style.setProperty('--card-bg', 'rgba(255, 255, 255, 0.7)');
    }
    updateThemeButtonDisplay();
    applyChartTheme();
}

function updateThemeButtonDisplay() {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.textContent = isDarkMode ? 'Switch to Day Mode' : 'Switch to Night Mode';
    }
}

// ============== CONFIGURATION MANAGEMENT ==============
// Credentials are set in SUPABASE_CONFIG at the top of this file
// To change credentials, edit the SUPABASE_CONFIG object above

function initSupabase(url, key) {
    try {
        supabaseClient = window.supabase.createClient(url, key);
        isConfigured = true;
        console.log('Supabase client initialized');
        console.log('URL:', url);
        updateSystemStatus(true);
        
        // Diagnostic: list all tables
        diagnoseSupabase();
    } catch (error) {
        console.error('Failed to initialize Supabase:', error);
        isConfigured = false;
        updateSystemStatus(false);
        showAlert('Failed to connect to Supabase', 'critical');
    }
}

async function diagnoseSupabase() {
    try {
        console.log('=== Supabase Diagnostic ===');
        
        // Try to fetch from water_readings
        const { data: wr, error: wr_error, status: wr_status } = await supabaseClient
            .from('water_readings')
            .select('count', { count: 'exact', head: true });
        
        if (wr_error) {
            console.error('❌ water_readings error:', wr_error.message, 'Code:', wr_error.code);
        } else {
            console.log('✓ water_readings table exists');
        }
        
        // Try to fetch from alerts
        const { data: alerts, error: alerts_error, status: alerts_status } = await supabaseClient
            .from('alerts')
            .select('count', { count: 'exact', head: true });
        
        if (alerts_error) {
            console.error('❌ alerts error:', alerts_error.message, 'Code:', alerts_error.code);
        } else {
            console.log('✓ alerts table exists');
        }
        
        // Try to fetch any data
        const { data: data_test, error: data_error } = await supabaseClient
            .from('water_readings')
            .select('*')
            .limit(1);
        
        if (data_error) {
            console.error('❌ Cannot read water_readings:', data_error.message);
        } else {
            console.log('✓ Can read water_readings, records found:', data_test?.length || 0);
            if (data_test && data_test.length > 0) {
                console.log('Sample record:', data_test[0]);
            }
        }
    } catch (error) {
        console.error('Diagnostic error:', error);
    }
}

function resetData() {
    if (confirm('Are you sure? This will clear all local data.')) {
        dataStore.readings = [];
        dataStore.alerts = [];
        dataStore.hourlyUsage = {};
        updateCharts();
        showAlert('All data cleared', 'normal');
    }
}

function saveConfiguration() {
    const url = document.getElementById('supabaseUrl')?.value || SUPABASE_CONFIG.url;
    const key = document.getElementById('supabaseKey')?.value || SUPABASE_CONFIG.key;
    const normalThreshold = parseFloat(document.getElementById('normalThreshold')?.value || CONFIG.normalThreshold);
    const warningThreshold = parseFloat(document.getElementById('warningThreshold')?.value || CONFIG.warningThreshold);

    // Save to localStorage
    localStorage.setItem('supabaseUrl', url);
    localStorage.setItem('supabaseKey', key);
    localStorage.setItem('normalThreshold', normalThreshold);
    localStorage.setItem('warningThreshold', warningThreshold);

    // Update CONFIG
    CONFIG.normalThreshold = normalThreshold;
    CONFIG.warningThreshold = warningThreshold;

    // Reinitialize Supabase if credentials changed
    initSupabase(url, key);
    
    showAlert('Configuration saved successfully', 'normal');
    console.log('Configuration saved');
}

function loadConfiguration() {
    const savedUrl = localStorage.getItem('supabaseUrl');
    const savedKey = localStorage.getItem('supabaseKey');
    const savedNormalThreshold = localStorage.getItem('normalThreshold');
    const savedWarningThreshold = localStorage.getItem('warningThreshold');

    if (savedUrl) document.getElementById('supabaseUrl').value = savedUrl;
    if (savedKey) document.getElementById('supabaseKey').value = savedKey;
    if (savedNormalThreshold) document.getElementById('normalThreshold').value = savedNormalThreshold;
    if (savedWarningThreshold) document.getElementById('warningThreshold').value = savedWarningThreshold;
}



// ============== MONITORING ==============
function startMonitoring() {
    // Initial fetch
    fetchLatestData();
    // Subscribe to realtime updates
    subscribeToRealtimeUpdates();
    // Keep a low-latency fallback path if realtime channel is delayed/unavailable.
    startFastPollingFallback();
}

function startFastPollingFallback() {
    if (fastPollingTimer) return;

    fastPollingTimer = window.setInterval(async () => {
        if (realtimeConnected) return;
        await fetchLatestReadingOnly();
    }, CONFIG.fastPollMs);
}

async function fetchLatestReadingOnly() {
    if (!isConfigured || !supabaseClient) return;

    try {
        const { data, error } = await supabaseClient
            .from('water_readings')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(1);

        if (error) {
            console.warn('Fast polling read failed:', error.message);
            return;
        }

        if (data && data.length > 0) {
            const latest = normalizeReading(data[0]);
            if (!latest) return;

            const current = dataStore.readings[dataStore.readings.length - 1];
            if (!current || current.timestamp !== latest.timestamp) {
                applyIncomingReading(latest);
            }
        }
    } catch (error) {
        console.warn('Fast polling exception:', error);
    }
}

function normalizeReading(reading) {
    if (!reading || typeof reading !== 'object') return null;

    const toNumber = (value, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    return {
        ...reading,
        flow_rate_1: toNumber(reading.flow_rate_1, 0),
        flow_rate_2: toNumber(reading.flow_rate_2, 0),
        percentage_loss: toNumber(reading.percentage_loss, 0),
        water_level: toNumber(reading.water_level, 0),
        humidity: toNumber(reading.humidity, 0),
        valve_state: toNumber(reading.valve_state, 0),
        system_online: toNumber(reading.system_online, 0),
        daily_total_liters: toNumber(reading.daily_total_liters, 0)
    };
}

function applyIncomingReading(reading) {
    const normalized = normalizeReading(reading);
    if (!normalized) return;

    dataStore.readings.push(normalized);
    if (dataStore.readings.length > CONFIG.maxReadingsFetch) {
        dataStore.readings = dataStore.readings.slice(-CONFIG.maxReadingsFetch);
    }

    updateSystemStatus(true);
    updateDashboard(normalized);
    updateCharts();
    updateLastUpdate();
}

function subscribeToRealtimeUpdates() {
    if (!isConfigured || !supabaseClient) {
        setTimeout(subscribeToRealtimeUpdates, 5000); // Retry in 5 seconds
        return;
    }

    try {
        // Subscribe to water_readings changes using new Supabase v2+ API
        readingsSubscription = supabaseClient
            .channel('public:water_readings')
            .on('postgres_changes', 
                { event: '*', schema: 'public', table: 'water_readings' },
                payload => {
                    console.log('Realtime reading update:', payload);
                    if (payload?.eventType === 'INSERT' || payload?.eventType === 'UPDATE') {
                        applyIncomingReading(payload.new);
                    } else {
                        fetchLatestData();
                    }
                }
            )
            .subscribe((status) => {
                realtimeConnected = (status === 'SUBSCRIBED');
                if (status === 'SUBSCRIBED') {
                    console.log('Realtime readings channel subscribed');
                }
            });

        // Subscribe to alerts changes using new Supabase v2+ API
        alertsSubscription = supabaseClient
            .channel('public:alerts')
            .on('postgres_changes',
                { event: '*', schema: 'public', table: 'alerts' },
                payload => {
                    console.log('Realtime alert update:', payload);
                    fetchLatestData();
                }
            )
            .subscribe();

        console.log('Realtime subscriptions established');
    } catch (error) {
        console.error('Error setting up realtime subscriptions:', error);
        // Fallback to polling if realtime fails
        realtimeConnected = false;
        setInterval(fetchLatestReadingOnly, CONFIG.fastPollMs);
    }
}

async function fetchLatestData() {
    if (!isConfigured || !supabaseClient) {
        console.warn('Supabase not configured or client missing');
        updateSystemStatus(false);
        return;
    }

    try {
        console.log('Fetching latest data from Supabase...');
        
        // Fetch latest reading
        const { data: readings, error: readingsError } = await supabaseClient
            .from('water_readings')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(CONFIG.maxReadingsFetch);

        if (readingsError) {
            console.error('Error fetching readings:', readingsError);
            throw readingsError;
        }

        console.log('Readings fetched:', readings?.length || 0, 'records');
        if (readings && readings.length > 0) {
            dataStore.readings = readings.map(normalizeReading).filter(Boolean).reverse(); // Chronological order
            updateSystemStatus(true);
            const latestReading = dataStore.readings[dataStore.readings.length - 1];
            console.log('Latest reading:', latestReading);
            updateDashboard(latestReading); // Latest reading
        } else {
            console.warn('No readings found in water_readings table');
        }

        // Fetch recent alerts
        const { data: alerts, error: alertsError } = await supabaseClient
            .from('alerts')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(10);

        if (alertsError) {
            console.warn('Alerts fetch error:', alertsError.message);
            // Don't throw - alerts table is optional
        } else {
            console.log('Alerts fetched:', alerts?.length || 0, 'records');
            if (alerts && alerts.length > 0) {
                console.log('First alert:', alerts[0]);
                dataStore.alerts = alerts.reverse(); // Reverse for chronological order
                updateAlerts(dataStore.alerts);
            } else {
                console.warn('No alerts in table');
                updateAlerts([]);
            }
        }

        // Update charts with all readings
        updateCharts();
        updateLastUpdate();
        updateExportStats(); // Update export stats after data is fetched

    } catch (error) {
        console.error('Error fetching data:', error);
        updateSystemStatus(false);
    }
}

// ============== DASHBOARD UPDATES ==============
function updateDashboard(latestReading) {
    const safeReading = normalizeReading(latestReading);
    if (!safeReading) return;

    latestReadingSnapshot = safeReading;

    // Update tank level
    const waterLevel = safeReading.water_level || 0;
    updateTankLevel(waterLevel);

    // Update flow rates
    document.getElementById('flow1').textContent = (safeReading.flow_rate_1 || 0).toFixed(2) + ' L/min';
    document.getElementById('flow2').textContent = (safeReading.flow_rate_2 || 0).toFixed(2) + ' L/min';

    // Update progress bars
    const maxFlow = Math.max(safeReading.flow_rate_1 || 0, safeReading.flow_rate_2 || 0, 5);
    document.getElementById('progressFlow1').style.width = ((safeReading.flow_rate_1 || 0) / maxFlow * 100) + '%';
    document.getElementById('progressFlow2').style.width = ((safeReading.flow_rate_2 || 0) / maxFlow * 100) + '%';

    // Update leak detection
    const percentageLoss = safeReading.percentage_loss || 0;
    updateLeakDetection(percentageLoss, safeReading.leak_status);

    // Update system controls
    const valveState = safeReading.valve_state === 1 ? 'OPEN' : 'CLOSED';
    
    const valveIndicator = document.getElementById('valveIndicator');
    valveIndicator.classList.toggle('active', safeReading.valve_state === 1);
    document.getElementById('valveState').textContent = valveState;

    // Update anomaly status
    const anomalyStatusElement = document.getElementById('anomalyStatus');
    if (anomalyStatusElement) {
        anomalyStatusElement.textContent = safeReading.anomaly_status || 'Learning';
    }

    // Update humidity panel
    updateHumidityDisplay(safeReading);

    // Update statistics
    const dailyTotal = (safeReading.daily_total_liters || 0).toFixed(2);
    document.getElementById('dailyTotal').textContent = dailyTotal + ' L';

    // Calculate estimated loss
    const volume1 = safeReading.flow_rate_1 || 0;
    const volume2 = safeReading.flow_rate_2 || 0;
    const estimatedLoss = (volume1 - volume2).toFixed(2);
    const minimumLoss = Math.max(0, estimatedLoss);
    document.getElementById('estimatedLoss').textContent = minimumLoss + ' L';

    // Calculate cost
    const cost = (dailyTotal * CONFIG.costPerLiter).toFixed(2);
    document.getElementById('estimatedCost').textContent = '$' + cost;

    // Update sustainability impact section
    updateSustainabilityPanel(safeReading);

    // Update AquaMind-inspired intelligence section
    updateIntelligenceStudio(safeReading);

    // Update export stats
    updateExportStats();
}

function setupIntelligenceStudio() {
    const runButton = document.getElementById('runImpactSimulationBtn');
    const horizonInput = document.getElementById('impactHorizonDays');
    const repairCostInput = document.getElementById('impactRepairCost');

    if (runButton) {
        runButton.addEventListener('click', async () => {
            if (!latestReadingSnapshot) {
                showAlert('No live reading available yet for simulation.', 'warning');
                return;
            }
            try {
                await runImpactSimulation(latestReadingSnapshot);
                showAlert('Impact simulation updated', 'normal');
            } catch (error) {
                showAlert(`Impact simulation failed: ${error?.message || 'unknown error'}`, 'warning');
            }
        });
    }

    const rerun = () => {
        if (latestReadingSnapshot) {
            runImpactSimulation(latestReadingSnapshot).catch(() => {});
        }
    };

    if (horizonInput) {
        horizonInput.addEventListener('change', rerun);
    }
    if (repairCostInput) {
        repairCostInput.addEventListener('change', rerun);
    }
}

function updateIntelligenceStudio(latestReading) {
    const risk = computePriorityProfile(latestReading);

    syncApiDetect(latestReading, risk).catch(() => {});

    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };

    const badge = document.getElementById('aiPriorityLevel');
    if (badge) {
        badge.textContent = risk.priorityLevel.toUpperCase();
        badge.className = `intel-badge intel-badge-${risk.priorityLevel.toLowerCase()}`;
    }

    setText('aiPriorityScore', `${risk.priorityScore} / 100`);
    setText('aiFailureProbability', `${(risk.failureProbability * 100).toFixed(1)}%`);
    setText('aiImmediateAction', risk.immediateAction ? 'Yes' : 'No');
    setText('aiRiskNarrative', risk.narrative);

    const engineStatus = document.getElementById('intelEngineStatus');
    if (engineStatus) {
        engineStatus.textContent = `Engine: ${risk.priorityLevel} risk • score ${risk.priorityScore}`;
    }

    runImpactSimulation(latestReading, risk, true).catch(() => {});
}

async function syncApiDetect(latestReading, risk) {
    const detectKey = `${latestReading?.timestamp || 'na'}|${risk.priorityScore}|${risk.priorityLevel}`;
    if (localAdapterState.lastDetectKey === detectKey) return;
    localAdapterState.lastDetectKey = detectKey;

    const response = await getActiveApiAdapter().detect({
        readings: [
            {
                pipe_id: 'esp32_pipe_live_01',
                timestamp: latestReading?.timestamp || new Date().toISOString(),
                flow_rate: Number(latestReading?.flow_rate_1 || 0),
                pressure: Number(latestReading?.water_level || 0),
                anomaly_label: risk.priorityScore >= 50 ? 'anomaly' : 'normal',
                flow_rate_1: Number(latestReading?.flow_rate_1 || 0),
                flow_rate_2: Number(latestReading?.flow_rate_2 || 0),
                percentage_loss: Number(latestReading?.percentage_loss || 0),
                humidity: Number(latestReading?.humidity || 0),
                daily_total_liters: Number(latestReading?.daily_total_liters || 0)
            }
        ]
    });

    if (response?.status === 'success' && Array.isArray(response?.data?.alerts) && response.data.alerts.length) {
        const maxStoredAlerts = 20;
        localAdapterState.alerts = [...response.data.alerts, ...localAdapterState.alerts]
            .slice(0, maxStoredAlerts);
        refreshAlertFeedWithAdapter();
    }
}

function refreshAlertFeedWithAdapter() {
    const remoteAlerts = Array.isArray(dataStore.alerts) ? dataStore.alerts : [];
    const localAlerts = Array.isArray(localAdapterState.alerts) ? localAdapterState.alerts : [];
    const seen = new Set();
    const merged = [...localAlerts, ...remoteAlerts].filter(alert => {
        const key = getAlertKey(alert);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    updateAlerts(merged);
}

function computePriorityProfile(latestReading) {
    const flow1 = Number(latestReading?.flow_rate_1 || 0);
    const flow2 = Number(latestReading?.flow_rate_2 || 0);
    const percentageLoss = Math.max(0, Number(latestReading?.percentage_loss || 0));
    const dailyTotal = Math.max(0, Number(latestReading?.daily_total_liters || 0));
    const humidity = Number(latestReading?.humidity);

    const leakRateLpm = Math.max(0, flow1 - flow2);
    const imbalance = flow1 > 0 ? leakRateLpm / Math.max(flow1, 0.001) : 0;
    const anomalyScore = Math.min(1, Math.max(0, (imbalance * 0.7) + ((percentageLoss / 100) * 0.3)));
    const populationFactor = Math.min(1, dailyTotal / 6000);
    const inferredRepairCost = 300 + (leakRateLpm * 95) + (percentageLoss * 8);
    const repairCostFactor = Math.min(1, inferredRepairCost / 2000);

    const priorityScoreRaw = (anomalyScore * 0.5) + (populationFactor * 0.3) + (repairCostFactor * 0.2);
    const priorityScore = Math.max(1, Math.min(100, Math.round(priorityScoreRaw * 100)));

    let humidityStress = 0;
    if (Number.isFinite(humidity)) {
        if (humidity < 30) humidityStress = Math.min(0.25, (30 - humidity) / 100);
        if (humidity > 70) humidityStress = Math.min(0.25, (humidity - 70) / 100);
    }

    const failureProbability = Math.min(1, Math.max(0, (anomalyScore * 0.68) + (priorityScoreRaw * 0.22) + humidityStress));

    let priorityLevel = 'Low';
    if (priorityScore >= 75) priorityLevel = 'Critical';
    else if (priorityScore >= 50) priorityLevel = 'High';
    else if (priorityScore >= 25) priorityLevel = 'Medium';

    const immediateAction = priorityScore >= 75 || failureProbability >= 0.75;

    const narrative = immediateAction
        ? `Rapid intervention advised. Leak rate ${leakRateLpm.toFixed(2)} L/min can escalate infrastructure stress.`
        : `System currently stable. Monitor imbalance at ${leakRateLpm.toFixed(2)} L/min and trend progression.`;

    return {
        leakRateLpm,
        inferredRepairCost,
        priorityScore,
        priorityLevel,
        failureProbability,
        immediateAction,
        narrative
    };
}

async function runImpactSimulation(latestReading, riskProfile = null, silent = false) {
    const risk = riskProfile || computePriorityProfile(latestReading);
    const horizonInput = document.getElementById('impactHorizonDays');
    const repairCostInput = document.getElementById('impactRepairCost');

    const horizonDays = Math.max(1, Math.min(365, Number(horizonInput?.value || 30)));
    const repairCost = Math.max(1, Number(repairCostInput?.value || risk.inferredRepairCost));

    if (repairCostInput && (!repairCostInput.value || Number(repairCostInput.value) <= 0)) {
        repairCostInput.value = risk.inferredRepairCost.toFixed(0);
    }

    const whatIfResponse = await getActiveApiAdapter().whatif({
        alert_id: localAdapterState.alerts[0]?.alert_id || 'esp32-live',
        leak_rate: Math.max(0, risk.leakRateLpm),
        population_affected: Math.max(1, Math.round(Number(latestReading?.daily_total_liters || 0) / 50)),
        repair_cost: repairCost,
        time_horizon_days: horizonDays
    });

    if (whatIfResponse?.status !== 'success' || !whatIfResponse?.data) {
        if (!silent) showAlert(`Impact simulation failed (${API_ADAPTER_CONFIG.mode} mode)`, 'warning');
        return;
    }

    const sim = whatIfResponse.data;
    const ignoreLossLiters = Number(sim.ignore_scenario?.total_water_loss_liters || 0);
    const ignoreFinancialCost = Number(sim.ignore_scenario?.financial_cost_usd || 0);
    const repairPreventedLiters = Number(sim.repair_scenario?.water_loss_prevented_liters || 0);
    const savingsUsd = Number(sim.savings_usd || 0);

    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };

    setText('simIgnoreLoss', `${ignoreLossLiters.toFixed(0)} L`);
    setText('simIgnoreCost', `$${ignoreFinancialCost.toFixed(2)}`);
    setText('simRepairPrevented', `${repairPreventedLiters.toFixed(0)} L`);
    setText('simSavings', `$${savingsUsd.toFixed(2)}`);

    const explainResponse = await getActiveApiAdapter().explain({
        alert_id: sim.alert_id,
        simulation_id: sim.simulation_id,
        pipe_id: 'esp32_pipe_live_01',
        loss_rate: Math.max(0, risk.leakRateLpm),
        population_affected: Math.max(1, Math.round(Number(latestReading?.daily_total_liters || 0) / 50)),
        repair_cost: repairCost,
        time_horizon_days: horizonDays,
        simulation_result: sim,
        reading: latestReading
    });

    const recommendation = buildRecommendationText(risk, savingsUsd, ignoreLossLiters, horizonDays, repairCost, explainResponse?.data);
    setText('aiRecommendationText', recommendation.primary);

    const insightsList = document.getElementById('aiInsightsList');
    if (insightsList) {
        insightsList.innerHTML = '';
        recommendation.insights.forEach(insight => {
            const item = document.createElement('li');
            item.textContent = insight;
            insightsList.appendChild(item);
        });
    }

    if (!silent && repairCostInput) {
        repairCostInput.value = repairCost.toFixed(0);
    }
}

function buildRecommendationText(risk, savingsUsd, ignoreLossLiters, horizonDays, repairCost, explainData = null) {
    const shouldRepair = savingsUsd > 0 || risk.immediateAction;
    const action = explainData?.recommended_action || (shouldRepair ? 'Repair immediately' : 'Monitor and schedule maintenance');

    const primary = shouldRepair
        ? `${action}: estimated avoidable loss is ${ignoreLossLiters.toFixed(0)} L over ${horizonDays} days, with net savings around $${Math.max(0, savingsUsd).toFixed(2)}.`
        : `${action}: projected financial impact remains below repair cost ($${repairCost.toFixed(2)}), but continue close monitoring.`;

    const insights = [
        `Priority ${risk.priorityLevel} (${risk.priorityScore}/100) with ${(risk.failureProbability * 100).toFixed(1)}% failure probability estimate.`,
        `Current leak imbalance is ${risk.leakRateLpm.toFixed(2)} L/min between inlet and outlet flow.`,
        explainData?.urgency_rationale || 'Local recommendation engine generated this advisory without requiring cloud AI services.',
        shouldRepair
            ? 'Recommendation engine flags immediate intervention as the sustainable option.'
            : 'Recommendation engine suggests staged maintenance and trend watch to avoid over-spend.'
    ];

    return { primary, insights };
}

function updateSustainabilityPanel(latestReading) {
    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    };

    const readings = Array.isArray(dataStore.readings) ? dataStore.readings : [];
    const flow1 = Number(latestReading?.flow_rate_1 || 0);
    const flow2 = Number(latestReading?.flow_rate_2 || 0);
    const dailyTotal = Number(latestReading?.daily_total_liters || 0);
    const currentLossPercent = Math.max(0, Number(latestReading?.percentage_loss || 0));

    const validLossValues = readings
        .slice(-180)
        .map(reading => Number(reading.percentage_loss))
        .filter(value => Number.isFinite(value) && value >= 0);

    const averageLossPercent = validLossValues.length
        ? validLossValues.reduce((total, value) => total + value, 0) / validLossValues.length
        : currentLossPercent;

    const baselineLossPercent = Number(CONFIG.normalThreshold || 5);
    const excessLossPercent = Math.max(0, averageLossPercent - baselineLossPercent);

    // Opportunity metrics are framed as preventable loss if leak imbalance is removed.
    const opportunityLitersPerDay = Math.max(0, (dailyTotal * excessLossPercent) / 100);
    const projectedMonthlySavings = opportunityLitersPerDay * 30;
    const estimatedCo2KgPerMonth = projectedMonthlySavings * 0.00034;
    const peopleEquivalentPerDay = opportunityLitersPerDay / 50;

    setText('impactOpportunityLiters', `${opportunityLitersPerDay.toFixed(1)} L/day`);
    setText('impactMonthlySavings', `${projectedMonthlySavings.toFixed(1)} L/month`);
    setText('impactCo2Saved', `${estimatedCo2KgPerMonth.toFixed(2)} kg/month`);
    setText('impactPeopleSupported', `${peopleEquivalentPerDay.toFixed(1)} people/day`);

    const criterionTechStatus = document.getElementById('criterionTechStatus');
    const criterionImpactStatus = document.getElementById('criterionImpactStatus');
    const criterionFeasibilityStatus = document.getElementById('criterionFeasibilityStatus');
    const impactReadiness = document.getElementById('impactReadiness');

    if (criterionTechStatus) {
        if (readings.length >= 120) {
            criterionTechStatus.textContent = 'Strong evidence: stable live stream, historical trend depth, and responsive controls confirmed.';
        } else if (readings.length >= 20) {
            criterionTechStatus.textContent = 'Prototype evidence active: live readings and control loop are working with early trend data.';
        } else {
            criterionTechStatus.textContent = 'Core pipeline connected. Keep collecting more readings to strengthen technical proof.';
        }
    }

    if (criterionImpactStatus) {
        if (opportunityLitersPerDay >= 100) {
            criterionImpactStatus.textContent = 'High measurable impact potential detected. Current leak pattern indicates significant daily water recovery opportunity.';
        } else if (opportunityLitersPerDay >= 20) {
            criterionImpactStatus.textContent = 'Moderate measurable impact potential. Dashboard now quantifies savings and emissions impact from real data.';
        } else {
            criterionImpactStatus.textContent = 'Low immediate loss opportunity, which indicates efficient operation. Continue monitoring to validate long-term savings.';
        }
    }

    if (criterionFeasibilityStatus) {
        const liveLossRate = Math.max(0, flow1 - flow2);
        if (liveLossRate > 1.5) {
            criterionFeasibilityStatus.textContent = 'System is actionable now: detected imbalance supports pilot interventions and real-time valve control experiments.';
        } else {
            criterionFeasibilityStatus.textContent = 'System architecture is deployment-ready: low-cost sensors, cloud telemetry, and modular dashboard support scaling.';
        }
    }

    if (impactReadiness) {
        if (readings.length >= 120) {
            impactReadiness.textContent = 'Readiness: Pilot-grade evidence available';
        } else if (readings.length >= 20) {
            impactReadiness.textContent = 'Readiness: Functional prototype validated';
        } else {
            impactReadiness.textContent = 'Readiness: Gathering baseline data';
        }
    }
}

function updateHumidityDisplay(latestReading) {
    const humidityRaw = latestReading?.humidity;
    const hasHumidity = humidityRaw !== null && humidityRaw !== undefined && Number.isFinite(Number(humidityRaw));
    const humidity = hasHumidity ? Math.max(0, Math.min(100, Number(humidityRaw))) : null;

    const humidityValue = document.getElementById('humidityValue');
    const humidityAura = document.getElementById('humidityAura');
    const humidityAuraLabel = document.getElementById('humidityAuraLabel');
    const humidityOrbitProgress = document.getElementById('humidityOrbitProgress');
    const humidityComfortBadge = document.getElementById('humidityComfortBadge');
    const humidityTrend = document.getElementById('humidityTrend');

    const ringLength = 339.29;

    const applyHumidityAuraState = (state) => {
        if (humidityAura) {
            humidityAura.classList.remove('humidity-state-dry', 'humidity-state-good', 'humidity-state-wet', 'humidity-state-muted');
            humidityAura.classList.remove('breathing-calm', 'breathing-alert');
            humidityAura.classList.add(`humidity-state-${state}`);

            if (state === 'good') {
                humidityAura.classList.add('breathing-calm');
            } else if (state === 'dry' || state === 'wet') {
                humidityAura.classList.add('breathing-alert');
            } else {
                humidityAura.classList.add('breathing-calm');
            }
        }
    };

    if (!humidityValue || !humidityComfortBadge || !humidityTrend) {
        return;
    }

    if (humidity === null) {
        applyHumidityAuraState('muted');
        humidityValue.textContent = 'N/A';
        if (humidityAuraLabel) {
            humidityAuraLabel.textContent = 'NO DATA';
        }
        if (humidityOrbitProgress) {
            humidityOrbitProgress.style.strokeDashoffset = String(ringLength);
        }
        humidityComfortBadge.textContent = 'NO DATA';
        humidityComfortBadge.className = 'humidity-comfort humidity-comfort-muted';
        humidityTrend.textContent = 'Humidity column missing in latest row.';
        return;
    }

    humidityValue.textContent = `${humidity.toFixed(1)}%`;
    if (humidityAuraLabel) {
        if (humidity < 30) {
            humidityAuraLabel.textContent = 'DRY';
        } else if (humidity > 70) {
            humidityAuraLabel.textContent = 'HUMID';
        } else {
            humidityAuraLabel.textContent = 'COMFORT';
        }
    }
    if (humidityOrbitProgress) {
        const offset = ringLength * (1 - humidity / 100);
        humidityOrbitProgress.style.strokeDashoffset = offset.toFixed(2);
    }

    let comfortText = 'COMFORT';
    let comfortClass = 'humidity-comfort-good';
    let humidityState = 'good';

    if (humidity < 30) {
        comfortText = 'DRY AIR';
        comfortClass = 'humidity-comfort-dry';
        humidityState = 'dry';
    } else if (humidity > 70) {
        comfortText = 'VERY HUMID';
        comfortClass = 'humidity-comfort-wet';
        humidityState = 'wet';
    }

    applyHumidityAuraState(humidityState);

    humidityComfortBadge.textContent = comfortText;
    humidityComfortBadge.className = `humidity-comfort ${comfortClass}`;

    const recentWithHumidity = dataStore.readings
        .slice(-2)
        .filter(r => r.humidity !== null && r.humidity !== undefined && Number.isFinite(Number(r.humidity)));

    if (recentWithHumidity.length >= 2) {
        const previous = Number(recentWithHumidity[0].humidity);
        const delta = humidity - previous;
        const arrow = delta > 0.2 ? 'rising' : delta < -0.2 ? 'falling' : 'stable';
        humidityTrend.textContent = `Indoor air is ${arrow} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`;
    } else {
        humidityTrend.textContent = 'Collecting humidity trend...';
    }
}

function updateTankLevel(waterLevel) {
    const maxLevel = 100;
    // Invert level: 100 - waterLevel (so full tank = highest value)
    const displayLevel = maxLevel - waterLevel;
    const percentage = Math.min(100, Math.max(0, (displayLevel / maxLevel) * 100));
    
    // Update liquid level: top position controls water height
    const liquid = document.querySelector('.water-tank .liquid');
    const label = document.getElementById('tankLabel');
    
    if (liquid) {
        liquid.style.top = `calc(100% - ${percentage}%)`;
    }
    
    // Update label with percentage
    if (label) {
        label.textContent = percentage.toFixed(0) + '%';
        label.style.bottom = percentage + '%';
    }
    
    // Update text display (show inverted level: 100 - waterLevel)
    document.getElementById('tankLevel').textContent = displayLevel.toFixed(1) + ' cm';
}

function updateLeakDetection(percentageLoss, leakStatus) {
    // Cap percentage at 100% max (prevent display issues with malformed data)
    const validPercentage = Math.min(100, Math.max(0, percentageLoss));
    
    // Debug: log if percentage is suspiciously high
    if (percentageLoss > 100) {
        console.warn('Unusual percentage detected:', percentageLoss, 'capped to', validPercentage);
    }
    
    document.getElementById('lossPercentage').textContent = validPercentage.toFixed(1);

    // Update circle progress
    const progress = document.getElementById('circleProgress');
    const maxPercentage = 30;
    const dashOffset = 345 * (1 - Math.min(validPercentage, maxPercentage) / maxPercentage);
    progress.style.strokeDashoffset = dashOffset;

    // Update color based on status
    progress.classList.remove('warning', 'critical');
    
    const badgeElement = document.getElementById('leakStatus');
    badgeElement.classList.remove('normal', 'warning', 'critical');

    if (leakStatus === 'Critical') {
        progress.classList.add('critical');
        badgeElement.classList.add('critical');
        badgeElement.textContent = 'CRITICAL ⚠️';
    } else if (leakStatus === 'Warning') {
        progress.classList.add('warning');
        badgeElement.classList.add('warning');
        badgeElement.textContent = 'WARNING ⚡';
    } else {
        badgeElement.classList.add('normal');
        badgeElement.textContent = 'NORMAL ✓';
    }
}

function updateAlerts(alerts) {
    const container = document.getElementById('alertsContainer');
    
    if (!container) {
        console.warn('Alert container not found');
        return;
    }
    
    const alertList = Array.isArray(alerts) ? alerts : [];
    console.log('Updating alerts display with', alertList.length, 'alerts');

    const criticalCount = alertList.filter(a => (a.severity === 'critical' || a.severity === 'high')).length;
    const warningCount = alertList.filter(a => (a.severity || '').toLowerCase() === 'warning' || (a.severity || '').toLowerCase() === 'medium').length;
    const allCountElement = document.getElementById('countAll');
    const criticalCountElement = document.getElementById('countCritical');
    const warningCountElement = document.getElementById('countWarning');

    if (allCountElement) allCountElement.textContent = String(alertList.length);
    if (criticalCountElement) criticalCountElement.textContent = String(criticalCount);
    if (warningCountElement) warningCountElement.textContent = String(warningCount);

    const filteredAlerts = alertList.filter(alert => {
        const normalizedSeverity = (alert.severity || '').toLowerCase();
        const mappedSeverity = (normalizedSeverity === 'critical' || normalizedSeverity === 'high') ? 'critical' : 'warning';
        const isAcknowledged = acknowledgedAlertKeys.has(getAlertKey(alert));

        if (alertAckFilter === 'open' && isAcknowledged) {
            return false;
        }

        if (alertAckFilter === 'acknowledged' && !isAcknowledged) {
            return false;
        }

        if (mobileCriticalOnly && window.matchMedia('(max-width: 768px)').matches && mappedSeverity !== 'critical') {
            return false;
        }

        if (alertFilterSeverity !== 'all' && mappedSeverity !== alertFilterSeverity) {
            return false;
        }

        if (!alertSearchTerm) return true;

        const haystack = `${alert.alert_type || ''} ${alert.message || ''} ${alert.severity || ''}`.toLowerCase();
        return haystack.includes(alertSearchTerm);
    });
    
    if (filteredAlerts.length === 0) {
        container.innerHTML = '<div class="alert-item" style="color: #666;">No alerts yet</div>';
        const ackSummary = document.getElementById('ackSummary');
        if (ackSummary) ackSummary.textContent = '0 unacknowledged';
        return;
    }

    const unacknowledgedCount = filteredAlerts.filter(alert => !acknowledgedAlertKeys.has(getAlertKey(alert))).length;
    const acknowledgedCount = filteredAlerts.length - unacknowledgedCount;
    const ackSummary = document.getElementById('ackSummary');
    if (ackSummary) {
        ackSummary.textContent = `${unacknowledgedCount} open • ${acknowledgedCount} acknowledged`;
    }

    container.innerHTML = '';
    filteredAlerts.slice(0, 20).forEach(alert => {
        const alertDiv = document.createElement('div');
        
        // Determine severity class
        const severityClass = (alert.severity === 'critical' || alert.severity === 'high') ? 'critical' : 'warning';
        const alertKey = getAlertKey(alert);
        const isAcknowledged = acknowledgedAlertKeys.has(alertKey);
        alertDiv.className = `alert-item ${severityClass}${isAcknowledged ? ' acknowledged' : ''}`;
        
        const timestamp = new Date(alert.timestamp).toLocaleString();
        alertDiv.innerHTML = `
            <strong>${alert.alert_type || 'Alert'}</strong>
            <div>${alert.message}</div>
            <div class="alert-timestamp">${timestamp}</div>
            <button class="ack-btn" data-alert-key="${alertKey}">
                ${isAcknowledged ? 'Unacknowledge' : 'Acknowledge'}
            </button>
        `;
        container.appendChild(alertDiv);
    });
}

function updateSystemStatus(online) {
    const badge = document.getElementById('systemStatus');
    if (!badge) return; // Element doesn't exist, skip update
    
    const dot = badge.querySelector('.status-dot');
    
    if (online) {
        if (dot) dot.classList.remove('offline');
        if (dot) dot.classList.add('online');
        badge.innerHTML = '<span class="status-dot online"></span>Online';
    } else {
        if (dot) dot.classList.remove('online');
        if (dot) dot.classList.add('offline');
        badge.innerHTML = '<span class="status-dot offline"></span>Offline';
    }
}

function updateLastUpdate() {
    const now = new Date();
    document.getElementById('lastUpdate').textContent = 'Last Update: ' + now.toLocaleTimeString();
}

// ============== CONTROL FUNCTIONS ==============
function openValve() {
    console.log('Opening valve');
    const valveIndicator = document.getElementById('valveIndicator');
    const valveState = document.getElementById('valveState');
    
    // Update UI
    if (valveIndicator) {
        valveIndicator.classList.add('active');
        valveIndicator.style.color = '#4CAF50';
    }
    if (valveState) {
        valveState.textContent = 'OPEN';
    }
    
    showAlert('Valve opened', 'normal');
}

function closeValve() {
    console.log('Closing valve');
    const valveIndicator = document.getElementById('valveIndicator');
    const valveState = document.getElementById('valveState');
    
    // Update UI
    if (valveIndicator) {
        valveIndicator.classList.remove('active');
        valveIndicator.style.color = '#f44336';
    }
    if (valveState) {
        valveState.textContent = 'CLOSED';
    }
    
    showAlert('Valve closed', 'normal');
}



// ============== CHARTS ==============
function initializeCharts() {
    const chartTheme = getChartTheme();
    const chartOptions = createChartOptions(chartTheme);

    // Flow Rate Chart
    const flowCtx = document.getElementById('flowChart');
    if (flowCtx) {
        flowChart = new Chart(flowCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Flow Rate 1 (L/min)',
                        data: [],
                        borderColor: chartTheme.flow1Line,
                        backgroundColor: chartTheme.flow1Fill,
                        tension: 0.3,
                        fill: true
                    },
                    {
                        label: 'Flow Rate 2 (L/min)',
                        data: [],
                        borderColor: chartTheme.flow2Line,
                        backgroundColor: chartTheme.flow2Fill,
                        tension: 0.3,
                        fill: true
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Volume Chart
    const volumeCtx = document.getElementById('volumeChart');
    if (volumeCtx) {
        volumeChart = new Chart(volumeCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Volume 1 (L)',
                        data: [],
                        backgroundColor: chartTheme.vol1
                    },
                    {
                        label: 'Volume 2 (L)',
                        data: [],
                        backgroundColor: chartTheme.vol2
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Hourly Usage Chart
    const hourlyCtx = document.getElementById('hourlyChart');
    if (hourlyCtx) {
        hourlyChart = new Chart(hourlyCtx, {
            type: 'bar',
            data: {
                labels: Array.from({length: 24}, (_, i) => i + ':00'),
                datasets: [
                    {
                        label: 'Hourly Usage (L)',
                        data: Array(24).fill(0),
                        backgroundColor: chartTheme.hourly
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Loss Percentage Chart
    const lossCtx = document.getElementById('lossChart');
    if (lossCtx) {
        lossChart = new Chart(lossCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Loss %',
                        data: [],
                        borderColor: chartTheme.lossLine,
                        backgroundColor: chartTheme.lossFill,
                        tension: 0.3,
                        fill: true
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Humidity Chart
    const humidityCtx = document.getElementById('humidityChart');
    if (humidityCtx) {
        humidityChart = new Chart(humidityCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Humidity (%)',
                        data: [],
                        borderColor: chartTheme.humidityLine,
                        backgroundColor: chartTheme.humidityFill,
                        tension: 0.35,
                        fill: true
                    }
                ]
            },
            options: {
                ...chartOptions,
                scales: {
                    y: {
                        beginAtZero: true,
                        min: 0,
                        max: 100,
                        ticks: {
                            callback: value => `${value}%`
                        }
                    }
                }
            }
        });
    }

    applyChartTheme();
}

function updateCharts() {
    if (dataStore.readings.length === 0) return;

    const flowReadings = getFilteredReadings(chartTimeframes.flow);
    const volumeReadings = getFilteredReadings(chartTimeframes.volume);
    const lossReadings = getFilteredReadings(chartTimeframes.loss);
    const humidityReadings = getFilteredReadings(chartTimeframes.humidity);
    const hourlyReadings = getFilteredReadings(chartTimeframes.hourly);

    // Update Flow Chart
    if (flowChart) {
        flowChart.data.labels = flowReadings.map(r => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        flowChart.data.datasets[0].data = flowReadings.map(r => r.flow_rate_1 || 0);
        flowChart.data.datasets[1].data = flowReadings.map(r => r.flow_rate_2 || 0);
        flowChart.update();
    }

    // Update Volume Chart (accumulated)
    if (volumeChart) {
        volumeChart.data.labels = volumeReadings.map(r => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        volumeChart.data.datasets[0].data = volumeReadings.map(r => {
            return (r.flow_rate_1 || 0) * 0.1; // Approximate volume
        });
        volumeChart.data.datasets[1].data = volumeReadings.map(r => {
            return (r.flow_rate_2 || 0) * 0.1;
        });
        volumeChart.update();
    }

    // Update Loss Percentage Chart
    if (lossChart) {
        lossChart.data.labels = lossReadings.map(r => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        lossChart.data.datasets[0].data = lossReadings.map(r => r.percentage_loss || 0);
        lossChart.update();
    }

    // Update Humidity Chart
    if (humidityChart) {
        humidityChart.data.labels = humidityReadings.map(r => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        humidityChart.data.datasets[0].data = humidityReadings.map(r => {
            const humidity = Number(r.humidity);
            return Number.isFinite(humidity) ? humidity : null;
        });
        humidityChart.update();
    }

    // Update Hourly Chart (aggregate by hour)
    if (hourlyChart) {
        const hourlyData = Array(24).fill(0);
        const hourlyCount = Array(24).fill(0);

        hourlyReadings.forEach(r => {
            const date = new Date(r.timestamp);
            const hour = date.getHours();
            hourlyData[hour] += (r.flow_rate_1 || 0) * 0.1;
            hourlyCount[hour]++;
        });

        // Average by hour
        for (let i = 0; i < 24; i++) {
            if (hourlyCount[i] > 0) {
                hourlyData[i] = hourlyData[i] / hourlyCount[i];
            }
        }

        hourlyChart.data.datasets[0].data = hourlyData;
        hourlyChart.update();
    }

    updateTimeframeSparklines();
}

// ============== UTILITY FUNCTIONS ==============
function showAlert(message, type = 'normal') {
    console.log(`[${type.toUpperCase()}] ${message}`);

    const host = document.getElementById('toastHost');
    if (!host) {
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    host.appendChild(toast);

    window.setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        window.setTimeout(() => toast.remove(), 200);
    }, 2800);
}

// ============== EXPORT & DOWNLOAD ==============
function exportData(format = 'json') {
    if (!dataStore.readings || dataStore.readings.length === 0) {
        showAlert('No data to export', 'warning');
        return;
    }

    let content, filename, type;

    if (format === 'csv') {
        content = convertToCSV(dataStore.readings);
        filename = `water_monitoring_${new Date().toISOString().split('T')[0]}.csv`;
        type = 'text/csv';
    } else if (format === 'json') {
        content = JSON.stringify(dataStore, null, 2);
        filename = `water_monitoring_${new Date().toISOString().split('T')[0]}.json`;
        type = 'application/json';
    }

    const dataBlob = new Blob([content], { type: type });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    showAlert(`Data exported as ${format.toUpperCase()} successfully`, 'normal');
}

function convertToCSV(readings) {
    if (!readings || readings.length === 0) return '';

    const headers = Object.keys(readings[0]);
    const csv = [headers.join(',')];

    readings.forEach(row => {
        const values = headers.map(header => {
            const value = row[header];
            // Escape values containing commas or quotes
            if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
                return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        });
        csv.push(values.join(','));
    });

    return csv.join('\n');
}

function updateExportStats() {
    const recordCount = dataStore.readings ? dataStore.readings.length : 0;
    const alertCount = dataStore.alerts ? dataStore.alerts.length : 0;
    
    console.log('updateExportStats() - Records:', recordCount, 'Alerts:', alertCount, 'dataStore.alerts:', dataStore.alerts);
    
    const recordElement = document.getElementById('exportRecordCount');
    const alertElement = document.getElementById('exportAlertCount');
    
    if (recordElement) {
        recordElement.textContent = recordCount;
    }
    if (alertElement) {
        alertElement.textContent = alertCount;
    }
}

// ============== RESPONSIVE UPDATES ==============
window.addEventListener('resize', function() {
    applyMobileCriticalMode();
    if (flowChart) flowChart.resize();
    if (volumeChart) volumeChart.resize();
    if (hourlyChart) hourlyChart.resize();
    if (lossChart) lossChart.resize();
    if (humidityChart) humidityChart.resize();
});

// ============== KEYBOARD SHORTCUTS ==============
document.addEventListener('keydown', function(event) {
    if (event.ctrlKey && event.key === 's') {
        event.preventDefault();
        saveConfiguration();
    }
    if (event.key === 'r' && event.ctrlKey) {
        event.preventDefault();
        location.reload();
    }
    if (event.key === 'Escape' && judgesDemoActive) {
        stopJudgesDemoMode();
    }
});

console.log('Script loaded successfully');
