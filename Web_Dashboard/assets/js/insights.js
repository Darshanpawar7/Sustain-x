/*
 * Impact Intelligence Studio and Sustainability Impact Lab.
 * Everything here is a rule-based estimate from live readings, not a trained
 * model. An optional remote service (API_ADAPTER_MODE=remote) can supply its
 * own detections and simulations.
 */
(function (FlowState) {
    'use strict';

    const { lib, config, alerts, ui } = FlowState;
    const $ = (id) => document.getElementById(id);

    const REMOTE_MIN_INTERVAL_MS = 15000;
    const REMOTE_TIMEOUT_MS = 5000;
    const HEALTH_CHECK_MS = 30000;
    const PIPE_ID = 'esp32_pipe_live_01';

    const adapter = config.getAdapterConfig();
    let latestReading = null;
    let todayLiters = 0;
    let previousLevel = 'Low';
    let lastInsightAtMs = null;
    let lastRemoteCallMs = 0;
    let remoteBusy = false;

    function setText(id, value) {
        const element = $(id);
        if (element) element.textContent = value;
    }

    // ---------------------------------------------------------------------
    // Optional remote service
    // ---------------------------------------------------------------------
    async function remoteRequest(path, options = {}) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
        try {
            const response = await fetch(`${adapter.baseUrl}${path}`, {
                method: options.body ? 'POST' : 'GET',
                headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
                body: options.body ? JSON.stringify(options.body) : undefined,
                cache: 'no-store',
                signal: controller.signal
            });
            const parsed = await response.json().catch(() => null);
            if (!response.ok) throw new Error(parsed?.error_message || parsed?.detail || `HTTP ${response.status}`);
            return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
        } finally {
            window.clearTimeout(timer);
        }
    }

    function normalizeRemoteAlert(alert) {
        return {
            id: String(alert.alert_id || alert.id || `remote-${Date.now()}`),
            timestamp: alert.timestamp || new Date().toISOString(),
            severity: String(alert.severity || alert.priority_level || 'medium').toLowerCase(),
            alert_type: String(alert.alert_type || `${alert.priority_level || 'Leak'} risk`),
            message: String(alert.message || alert.urgency_rationale || ''),
            origin: 'AI service'
        };
    }

    async function renderAdapterHealth() {
        const dot = $('adapterHealthDot');
        const label = $('adapterHealthLabel');
        setText('adapterModeLabel', adapter.mode === 'remote' ? 'REMOTE' : 'LOCAL');
        setText('adapterUrlLabel', adapter.mode === 'remote' ? adapter.baseUrl : 'Rule-based estimates in this browser');
        const show = (state, text) => {
            dot.classList.remove('adapter-health-online', 'adapter-health-offline', 'adapter-health-checking');
            dot.classList.add(`adapter-health-${state}`);
            label.textContent = text;
        };
        if (adapter.mode !== 'remote') {
            show('online', 'Local estimates');
            return;
        }
        show('checking', 'Checking…');
        const started = performance.now();
        try {
            await remoteRequest('/health');
            show('online', `Healthy (${Math.round(performance.now() - started)} ms)`);
        } catch (error) {
            show('offline', error.name === 'AbortError' ? 'Timed out' : 'Unreachable');
        }
    }

    // ---------------------------------------------------------------------
    // Risk, simulation and recommendation
    // ---------------------------------------------------------------------
    function renderRisk(risk) {
        const badge = $('aiPriorityLevel');
        badge.textContent = risk.priorityLevel.toUpperCase();
        badge.className = `intel-badge intel-badge-${risk.priorityLevel.toLowerCase()}`;
        setText('aiPriorityScore', `${risk.priorityScore} / 100`);
        setText('aiFailureProbability', `${(risk.failureRisk * 100).toFixed(1)}%`);
        setText('aiImmediateAction', risk.immediateAction ? 'Yes' : 'No');
        setText('aiRiskNarrative', risk.narrative);
        setText('intelEngineStatus', `Rule-based estimate: ${risk.priorityLevel} risk, score ${risk.priorityScore}`);
    }

    function maybeRaiseInsight(risk) {
        const now = Date.now();
        if (lib.shouldRaiseInsight(previousLevel, risk.priorityLevel, lastInsightAtMs, now)) {
            lastInsightAtMs = now;
            alerts.addInsight({
                id: `insight-${now}`,
                timestamp: new Date(now).toISOString(),
                severity: risk.priorityLevel === 'Critical' ? 'critical' : 'high',
                alert_type: `${risk.priorityLevel.toUpperCase()}_LEAK_RISK`,
                message: risk.narrative,
                origin: 'Dashboard estimate'
            });
        }
        previousLevel = risk.priorityLevel;
    }

    function simulationInputs(risk) {
        const horizonInput = $('impactHorizonDays');
        const repairInput = $('impactRepairCost');
        const horizonDays = lib.clamp(Math.round(lib.toNumber(horizonInput.value, 30)), 1, 365);
        if (!repairInput.value || lib.toNumber(repairInput.value) <= 0) repairInput.value = risk.inferredRepairCost.toFixed(0);
        return { horizonDays, repairCost: Math.max(1, lib.toNumber(repairInput.value, risk.inferredRepairCost)) };
    }

    function renderSimulation(sim) {
        setText('simIgnoreLoss', `${sim.ignoreLossLiters.toFixed(0)} L`);
        setText('simIgnoreCost', `$${sim.ignoreCostUsd.toFixed(2)}`);
        setText('simRepairPrevented', `${sim.preventedLiters.toFixed(0)} L`);
        setText('simSavings', `$${sim.savingsUsd.toFixed(2)}`);
    }

    function renderRecommendation(risk, sim, rationale) {
        const shouldRepair = sim.savingsUsd > 0 || risk.immediateAction;
        const action = shouldRepair ? 'Repair immediately' : 'Monitor and schedule maintenance';
        setText('aiRecommendationText', shouldRepair
            ? `${action}: about ${sim.ignoreLossLiters.toFixed(0)} L could be lost over ${sim.horizonDays} days; repairing saves about $${Math.max(0, sim.savingsUsd).toFixed(2)}.`
            : `${action}: the projected cost stays below the repair cost ($${sim.repairCostUsd.toFixed(2)}). Keep watching the trend.`);

        const insights = [
            `Priority ${risk.priorityLevel} (${risk.priorityScore}/100), estimated failure risk ${(risk.failureRisk * 100).toFixed(1)}%.`,
            `Current imbalance between the sensors: ${risk.leakRateLpm.toFixed(2)} L/min.`,
            rationale || 'These figures come from fixed rules applied to live readings, not from a trained model.'
        ];
        const list = $('aiInsightsList');
        list.replaceChildren(...insights.map((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            return item;
        }));
    }

    function runLocalSimulation(risk) {
        const inputs = simulationInputs(risk);
        const sim = lib.simulateWhatIf({ leakRateLpm: risk.leakRateLpm, costPerLiter: config.settings.costPerLiter, ...inputs });
        renderSimulation(sim);
        renderRecommendation(risk, sim, null);
    }

    async function runRemoteAnalysis(risk, reading) {
        if (remoteBusy) return;
        remoteBusy = true;
        lastRemoteCallMs = Date.now();
        try {
            const detection = await remoteRequest('/detect', {
                body: {
                    readings: [{
                        pipe_id: PIPE_ID,
                        timestamp: reading.timestamp,
                        flow_rate: lib.toNumber(reading.flow_rate_1),
                        flow_rate_1: lib.toNumber(reading.flow_rate_1),
                        flow_rate_2: lib.toNumber(reading.flow_rate_2),
                        percentage_loss: lib.toNumber(reading.percentage_loss),
                        humidity: lib.humidityOrNull(reading.humidity),
                        daily_total_liters: todayLiters
                    }]
                }
            });
            (Array.isArray(detection?.alerts) ? detection.alerts : [])
                .map(normalizeRemoteAlert)
                .forEach((alert) => alerts.addInsight(alert));

            const inputs = simulationInputs(risk);
            const remoteSim = await remoteRequest('/whatif', {
                body: {
                    alert_id: 'esp32-live',
                    leak_rate: risk.leakRateLpm,
                    population_affected: Math.max(1, Math.round(todayLiters / config.settings.litersPerPersonPerDay)),
                    repair_cost: inputs.repairCost,
                    time_horizon_days: inputs.horizonDays
                }
            });
            const sim = {
                horizonDays: inputs.horizonDays,
                repairCostUsd: inputs.repairCost,
                ignoreLossLiters: lib.toNumber(remoteSim?.ignore_scenario?.total_water_loss_liters),
                ignoreCostUsd: lib.toNumber(remoteSim?.ignore_scenario?.financial_cost_usd),
                preventedLiters: lib.toNumber(remoteSim?.repair_scenario?.water_loss_prevented_liters),
                savingsUsd: lib.toNumber(remoteSim?.savings_usd)
            };
            renderSimulation(sim);
            const explanation = await remoteRequest('/explain', {
                body: { simulation_result: remoteSim, simulation_id: remoteSim?.simulation_id, pipe_id: PIPE_ID, reading }
            });
            renderRecommendation(risk, sim, explanation?.urgency_rationale || explanation?.ai_text || null);
        } catch (_) {
            // Fall back to local estimates when the remote service is unavailable.
            runLocalSimulation(risk);
        } finally {
            remoteBusy = false;
        }
    }

    function analyse(force = false) {
        if (!latestReading) return;
        const risk = lib.computeRiskProfile(latestReading, { todayLiters });
        renderRisk(risk);
        if (adapter.mode === 'remote') {
            if (force || Date.now() - lastRemoteCallMs >= REMOTE_MIN_INTERVAL_MS) runRemoteAnalysis(risk, latestReading);
        } else {
            maybeRaiseInsight(risk);
            runLocalSimulation(risk);
        }
    }

    // ---------------------------------------------------------------------
    // Sustainability Impact Lab (last 24 hours)
    // ---------------------------------------------------------------------
    function renderSustainability(history24h) {
        const rows = (history24h && history24h.rows) || [];
        const samples = lib.sumField(rows, 'samples');
        const impact = lib.sustainabilityImpact({
            loss24hLiters: lib.lossLiters(rows),
            total24hLiters: lib.sumField(rows, 'volume_1_liters'),
            allowancePercent: config.settings.warningFromPercent,
            co2KgPerLiter: config.settings.co2KgPerLiter,
            litersPerPersonPerDay: config.settings.litersPerPersonPerDay
        });

        setText('impactOpportunityLiters', `${impact.preventablePerDay.toFixed(1)} L/day`);
        setText('impactMonthlySavings', `${impact.monthlyLiters.toFixed(1)} L/month`);
        setText('impactCo2Saved', `${impact.co2KgPerMonth.toFixed(2)} kg/month`);
        setText('impactPeopleSupported', `${impact.peopleEquivalent.toFixed(1)} people/day`);

        let readiness = 'Gathering baseline data';
        let tech = 'Core pipeline connected. Keep collecting readings to strengthen the technical proof.';
        if (samples >= 720) {
            readiness = 'Pilot-grade evidence available';
            tech = 'Strong evidence: a stable live stream with at least an hour of history in the last day.';
        } else if (samples >= 60) {
            readiness = 'Functional prototype validated';
            tech = 'Prototype evidence: live readings and the control loop are working, with early trend data.';
        }
        setText('impactReadiness', `Readiness: ${readiness}`);
        setText('criterionTechStatus', tech);

        let impactText = 'Low loss in the last 24 hours, which points to efficient operation. Keep monitoring to confirm long-term savings.';
        if (impact.preventablePerDay >= 100) {
            impactText = 'High measurable impact: the last 24 hours show a large amount of preventable water loss.';
        } else if (impact.preventablePerDay >= 20) {
            impactText = 'Moderate measurable impact: the dashboard quantifies savings and emissions from real data.';
        }
        setText('criterionImpactStatus', impactText);

        const liveImbalance = latestReading
            ? Math.max(0, lib.toNumber(latestReading.flow_rate_1) - lib.toNumber(latestReading.flow_rate_2))
            : 0;
        setText('criterionFeasibilityStatus', liveImbalance > 1.5
            ? 'Actionable now: the detected imbalance supports pilot interventions and remote valve control tests.'
            : 'Deployment-ready architecture: low-cost sensors, cloud telemetry and a static dashboard that scales.');
    }

    function update(reading, context) {
        latestReading = reading;
        todayLiters = Math.max(0, lib.toNumber(context && context.todayLiters));
        analyse();
    }

    function init() {
        $('runImpactSimulationBtn').addEventListener('click', () => {
            if (!latestReading) {
                ui.toast('No live reading yet to analyse.', 'warning');
                return;
            }
            analyse(true);
            ui.toast('Impact analysis updated');
        });
        ['impactHorizonDays', 'impactRepairCost'].forEach((id) => $(id).addEventListener('change', () => analyse(true)));
        renderAdapterHealth();
        if (adapter.mode === 'remote') window.setInterval(renderAdapterHealth, HEALTH_CHECK_MS);
    }

    FlowState.insights = { init, update, renderSustainability };
})(window.FlowState = window.FlowState || {});
