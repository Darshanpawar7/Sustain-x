/*
 * Valve control: signs Open / Close / Auto commands in the browser with the
 * valve key (HMAC-SHA256) and sends them to the ESP32 over MQTT. The ESP32
 * checks the signature, the age of the command and that it was never used.
 */
(function (FlowState) {
    'use strict';

    const { lib, config, mqttLink } = FlowState;
    const $ = (id) => document.getElementById(id);

    const BUTTONS = ['valveOpenBtn', 'valveCloseBtn', 'valveAutoBtn'];
    const DONE_TEXT = { open: 'Valve opened', close: 'Valve closed', auto: 'Automatic protection on' };

    let busy = false;
    let link = { connected: false, deviceOnline: null };
    let sampleMode = false;
    let fingerprintRun = 0;
    let lastResult = { text: '', tone: 'neutral' };   // the ESP32's answer to the last command

    function setStatus(text, tone) {
        const status = $('valveCommandStatus');
        status.textContent = text;
        status.dataset.tone = tone || 'neutral';
    }

    function blockedReason() {
        if (sampleMode) return 'Valve control is off while sample data is shown.';
        if (!mqttLink.libraryLoaded()) return 'The MQTT library could not load, so the valve cannot be controlled from here.';
        if (!link.connected) return 'Connecting to the MQTT broker…';
        if (link.deviceOnline === false) return 'The ESP32 is offline (its MQTT Last Will says so).';
        if (link.deviceOnline === null) return 'Waiting to hear from the ESP32 over MQTT…';
        if (!config.getValveKey()) return 'Enter the valve key to use these buttons.';
        return '';
    }

    function refresh() {
        const reason = blockedReason();
        BUTTONS.forEach((id) => {
            $(id).disabled = busy || reason !== '';
        });
        if (busy) return;
        // A reason the buttons are off comes first; otherwise keep showing the last answer.
        if (reason) setStatus(reason, 'neutral');
        else setStatus(lastResult.text, lastResult.tone);
    }

    async function showFingerprint() {
        const run = ++fingerprintRun;
        const key = config.getValveKey();
        const note = $('valveKeyCheck');
        if (!key) {
            note.textContent = 'Commands are signed in this browser with the key (HMAC-SHA256) and sent over MQTT. The key itself is never sent.';
            return;
        }
        try {
            const fingerprint = await lib.keyFingerprint(key);
            if (run !== fingerprintRun) return;
            note.textContent = `Key check: ${fingerprint}. Type KEY_CHECK in the Serial Monitor; the ESP32 prints the same 8 characters when the key is right.`;
        } catch (error) {
            note.textContent = error.message;
        }
    }

    async function send(action) {
        if (busy) return;
        const key = config.getValveKey();
        busy = true;
        refresh();
        setStatus(`Sending a signed "${action}" command…`, 'neutral');
        try {
            const ack = await mqttLink.sendCommand(key, action);
            lastResult = ack.ok
                ? { text: `Done: ${ack.text || `${DONE_TEXT[action]}.`}`, tone: 'good' }
                : { text: `The ESP32 refused it: ${ack.text}.`, tone: 'critical' };
        } catch (error) {
            lastResult = { text: error && error.message ? error.message : 'The command could not be sent.', tone: 'critical' };
        } finally {
            busy = false;
            refresh();
        }
    }

    /** @param {object} reading latest reading (from MQTT or the database) */
    function renderReading(reading) {
        if (!reading) return;
        const mode = $('valveMode');
        if (reading.auto_protection === undefined) {
            mode.textContent = 'Automatic protection: closes on a critical leak';
            return;
        }
        mode.textContent = reading.auto_protection === 1
            ? 'Automatic protection: on'
            : 'Automatic protection: paused (press Auto to turn it back on)';
    }

    function setLink(snapshot) {
        link = snapshot;
        refresh();
    }

    function setSampleMode(active) {
        sampleMode = active;
        refresh();
    }

    function init() {
        const input = $('valveKeyInput');
        input.value = config.getValveKey();
        input.addEventListener('input', () => {
            config.setValveKey(input.value);
            lastResult = { text: '', tone: 'neutral' };
            refresh();
            showFingerprint();
        });
        BUTTONS.forEach((id) => {
            $(id).addEventListener('click', () => send($(id).dataset.action));
        });
        showFingerprint();
        refresh();
    }

    FlowState.valve = { init, renderReading, setLink, setSampleMode };
})(window.FlowState = window.FlowState || {});
