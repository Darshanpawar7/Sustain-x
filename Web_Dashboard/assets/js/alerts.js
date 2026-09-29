/*
 * Recent alerts panel. Alert text is always inserted as plain text (never as
 * HTML), so nothing stored in the database can run as code in the page.
 */
(function (FlowState) {
    'use strict';

    const { lib, config } = FlowState;
    const $ = (id) => document.getElementById(id);

    const MAX_VISIBLE = 30;
    const MAX_ACKNOWLEDGED = 500;

    let deviceAlerts = [];
    let insightAlerts = [];
    let criticalOnly = false;
    const filters = { severity: 'all', ack: 'open', search: '' };
    const acknowledged = new Set(loadAcknowledged());

    function loadAcknowledged() {
        try {
            const saved = JSON.parse(config.local.get(config.KEYS.acknowledged) || '[]');
            return Array.isArray(saved) ? saved.filter((key) => typeof key === 'string') : [];
        } catch (_) {
            return [];
        }
    }

    function saveAcknowledged() {
        const keys = Array.from(acknowledged).slice(-MAX_ACKNOWLEDGED);
        config.local.set(config.KEYS.acknowledged, JSON.stringify(keys));
    }

    /** "NIGHTTIME_LEAK_ALERT" -> "Nighttime leak alert" */
    function readableType(type) {
        const words = String(type || 'Alert').replace(/_/g, ' ').toLowerCase();
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    function buildAlert(alert) {
        const key = lib.alertKey(alert);
        const isAcknowledged = acknowledged.has(key);
        const item = document.createElement('div');
        item.className = `alert-item ${lib.severityGroup(alert.severity)}`;
        if (isAcknowledged) item.classList.add('acknowledged');

        const title = document.createElement('strong');
        title.textContent = readableType(alert.alert_type);
        if (alert.source === 'insight') {
            item.classList.add('insight');
            const tag = document.createElement('span');
            tag.className = 'alert-source-tag';
            tag.textContent = alert.origin || 'Dashboard estimate';
            title.append(' ', tag);
        }

        const message = document.createElement('div');
        message.textContent = alert.message || '';

        const time = document.createElement('div');
        time.className = 'alert-timestamp';
        const when = lib.toTime(alert.timestamp);
        time.textContent = when === null ? '' : new Date(when).toLocaleString();

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ack-btn';
        button.dataset.alertKey = key;
        button.textContent = isAcknowledged ? 'Mark as open' : 'Acknowledge';

        item.append(title, message, time, button);
        return item;
    }

    function render() {
        const container = $('alertsContainer');
        if (!container) return;

        const all = lib.mergeAlerts(insightAlerts, deviceAlerts);
        const counts = lib.countBySeverity(all);
        $('countAll').textContent = String(counts.all);
        $('countCritical').textContent = String(counts.critical);
        $('countWarning').textContent = String(counts.warning);
        $('countInfo').textContent = String(counts.info);

        const visible = lib.filterAlerts(all, {
            ...filters,
            criticalOnly,
            isAcknowledged: (key) => acknowledged.has(key)
        });

        if (!visible.length) {
            const empty = document.createElement('div');
            empty.className = 'alert-item empty';
            empty.textContent = all.length ? 'No alerts match these filters.' : 'No alerts yet.';
            container.replaceChildren(empty);
        } else {
            container.replaceChildren(...visible.slice(0, MAX_VISIBLE).map(buildAlert));
        }

        const open = visible.filter((alert) => !acknowledged.has(lib.alertKey(alert))).length;
        $('ackSummary').textContent = `${open} open • ${visible.length - open} acknowledged`;
    }

    function setDeviceAlerts(alerts) {
        deviceAlerts = (alerts || []).map((alert) => ({ ...alert, source: 'db' }));
        render();
    }

    /** @returns {boolean} true when the alert was new */
    function addDeviceAlert(alert) {
        if (!alert) return false;
        const entry = { ...alert, source: 'db' };
        const key = lib.alertKey(entry);
        if (deviceAlerts.some((existing) => lib.alertKey(existing) === key)) return false;
        deviceAlerts = [entry, ...deviceAlerts].slice(0, config.settings.maxAlerts);
        render();
        return true;
    }

    function addInsight(alert) {
        insightAlerts = [{ ...alert, source: 'insight' }, ...insightAlerts].slice(0, 10);
        render();
    }

    function deviceAlertList() {
        return deviceAlerts.slice();
    }

    function setCriticalOnly(active) {
        criticalOnly = active;
        render();
    }

    function selectTab(buttons, selected) {
        buttons.forEach((button) => {
            const isActive = button === selected;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });
    }

    function init() {
        const severityTabs = document.querySelectorAll('.alerts-tab');
        severityTabs.forEach((tab) => tab.addEventListener('click', () => {
            filters.severity = tab.dataset.severity || 'all';
            selectTab(severityTabs, tab);
            render();
        }));

        const ackTabs = document.querySelectorAll('.alerts-ack-tab');
        ackTabs.forEach((tab) => tab.addEventListener('click', () => {
            filters.ack = tab.dataset.ack || 'open';
            selectTab(ackTabs, tab);
            render();
        }));

        const search = $('alertSearch');
        if (search) {
            search.addEventListener('input', () => {
                filters.search = search.value;
                render();
            });
        }

        const container = $('alertsContainer');
        if (container) {
            container.addEventListener('click', (event) => {
                const button = event.target.closest('.ack-btn');
                if (!button || !button.dataset.alertKey) return;
                const key = button.dataset.alertKey;
                if (acknowledged.has(key)) acknowledged.delete(key);
                else acknowledged.add(key);
                saveAcknowledged();
                render();
            });
        }
        render();
    }

    FlowState.alerts = { init, render, setDeviceAlerts, addDeviceAlert, addInsight, deviceAlertList, setCriticalOnly };
})(window.FlowState = window.FlowState || {});
