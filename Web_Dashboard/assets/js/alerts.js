/*
 * Alerts panel. Alert text is always inserted as plain text (never as HTML),
 * so nothing stored in the database can run as code in the page.
 */
(function (FlowState) {
    'use strict';

    const { lib } = FlowState;
    const $ = (id) => document.getElementById(id);

    const MAX_VISIBLE = 30;
    const MAX_KEPT = 200;

    let alerts = [];
    const filters = { group: 'all', search: '' };

    function buildItem(alert) {
        const item = document.createElement('li');
        item.className = 'alert-item';
        item.dataset.group = lib.alertGroup(alert);

        const head = document.createElement('div');
        head.className = 'alert-head';
        const title = document.createElement('strong');
        title.textContent = lib.alertName(alert.alert_type);
        const time = document.createElement('time');
        const when = lib.toTime(alert.timestamp);
        if (when !== null) {
            time.dateTime = new Date(when).toISOString();
            time.textContent = new Date(when).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        }
        head.append(title, time);

        const message = document.createElement('p');
        message.textContent = alert.message || '';
        item.append(head, message);
        return item;
    }

    function render() {
        const counts = lib.countAlerts(alerts);
        $('countAll').textContent = String(counts.all);
        $('countCritical').textContent = String(counts.critical);
        $('countWarning').textContent = String(counts.warning);
        $('countInfo').textContent = String(counts.info);

        const visible = lib.filterAlerts(alerts, filters).slice(0, MAX_VISIBLE);
        if (!visible.length) {
            const empty = document.createElement('li');
            empty.className = 'alert-item empty';
            empty.textContent = alerts.length ? 'No alerts match this filter.' : 'No alerts yet. The ESP32 raises one when something needs attention.';
            $('alertsContainer').replaceChildren(empty);
            return;
        }
        $('alertsContainer').replaceChildren(...visible.map(buildItem));
    }

    function setAlerts(list) {
        alerts = lib.mergeAlerts(list || []).slice(0, MAX_KEPT);
        render();
    }

    /** @returns {boolean} true when the alert was new */
    function addAlert(alert) {
        const key = lib.alertKey(alert);
        if (alerts.some((existing) => lib.alertKey(existing) === key)) return false;
        alerts = lib.mergeAlerts([alert], alerts).slice(0, MAX_KEPT);
        render();
        return true;
    }

    function list() {
        return alerts.slice();
    }

    function init() {
        document.querySelectorAll('.alert-tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                filters.group = tab.dataset.group;
                document.querySelectorAll('.alert-tab').forEach((other) => {
                    const active = other === tab;
                    other.classList.toggle('active', active);
                    other.setAttribute('aria-pressed', String(active));
                });
                render();
            });
        });
        $('alertSearch').addEventListener('input', (event) => {
            filters.search = event.target.value;
            render();
        });
        render();
    }

    FlowState.alerts = { init, setAlerts, addAlert, list };
})(window.FlowState = window.FlowState || {});
