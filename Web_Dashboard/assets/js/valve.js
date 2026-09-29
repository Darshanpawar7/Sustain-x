/*
 * Remote valve control. A command is queued in the database (operator key
 * required); the device collects it with its next upload and moves the valve.
 * The page only reports success once a reading from the device confirms it.
 */
(function (FlowState) {
    'use strict';

    const { lib, config, api, ui } = FlowState;
    const $ = (id) => document.getElementById(id);

    let pending = null;  // { id, action, status, delivered_at, sentAtMs }
    let pollTimer = null;
    let latestReading = null;

    function showStatus(message, tone = 'info') {
        const element = $('valveCommandStatus');
        if (!element) return;
        element.textContent = message;
        element.dataset.tone = tone;
        element.hidden = message === '';
    }

    function setBusy(busy) {
        ['valveOpenBtn', 'valveCloseBtn'].forEach((id) => {
            const button = $(id);
            if (button) button.disabled = busy;
        });
    }

    function stopPolling() {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }

    function finish(message, tone) {
        stopPolling();
        pending = null;
        setBusy(false);
        showStatus(message, tone);
        ui.toast(message, tone === 'info' ? 'normal' : tone);
    }

    function refresh() {
        if (!pending) return;
        const verb = pending.action === 'open' ? 'open' : 'close';
        switch (lib.valveCommandState(pending, latestReading, Date.now(), config.settings.commandTimeoutMs)) {
            case 'waiting':
                showStatus(`"${verb}" sent. Waiting for the device to collect it (it checks every few seconds)…`);
                break;
            case 'delivered':
                showStatus('The device received the command. Waiting for it to confirm…');
                break;
            case 'done':
                finish(`Valve ${verb === 'open' ? 'opened' : 'closed'}. Confirmed by the device.`, 'normal');
                break;
            case 'expired':
                finish('The device did not collect the command within 2 minutes, so it was cancelled. Is the device online?', 'warning');
                break;
            case 'timeout':
                finish('No confirmation from the device yet. Check that it is online, then try again.', 'warning');
                break;
            default:
                break;
        }
    }

    async function pollCommand() {
        if (!pending || !api.isReady()) return;
        try {
            const row = await api.fetchValveCommand(pending.id);
            if (row && pending && row.id === pending.id) {
                pending.status = row.status;
                pending.delivered_at = row.delivered_at;
            }
        } catch (_) {
            // Temporary network problems are retried on the next poll.
        }
        refresh();
    }

    async function request(action) {
        const operatorKey = config.getOperatorKey();
        if (!operatorKey) {
            showStatus('Enter the valve control key in Settings first.', 'warning');
            ui.openSettings('operatorKey');
            return;
        }
        if (!api.isReady()) {
            showStatus('Not connected to the database.', 'warning');
            return;
        }

        setBusy(true);
        showStatus(`Sending "${action}"…`);
        try {
            const result = await api.requestValveCommand(operatorKey, action);
            pending = { id: result.command_id, action, status: 'pending', delivered_at: null, sentAtMs: Date.now() };
            stopPolling();
            pollTimer = window.setInterval(pollCommand, config.settings.commandPollMs);
            refresh();
        } catch (error) {
            setBusy(false);
            if (error && error.code === '28000') {
                config.setOperatorKey('');
                showStatus('The valve control key was not accepted. Check it in Settings.', 'critical');
            } else {
                showStatus(`Could not send the command: ${error && error.message ? error.message : 'unknown error'}`, 'critical');
            }
        }
    }

    function setLatestReading(reading) {
        latestReading = reading;
        refresh();
    }

    // Forget any command in flight, e.g. when the dashboard switches database.
    function reset() {
        stopPolling();
        pending = null;
        latestReading = null;
        setBusy(false);
        showStatus('');
    }

    function init() {
        $('valveOpenBtn').addEventListener('click', () => request('open'));
        $('valveCloseBtn').addEventListener('click', () => request('close'));
        showStatus('');
    }

    FlowState.valve = { init, setLatestReading, refresh, reset };
})(window.FlowState = window.FlowState || {});
