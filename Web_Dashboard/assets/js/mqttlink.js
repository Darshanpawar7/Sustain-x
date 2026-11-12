/*
 * The page's MQTT connection: subscribes to the ESP32's topics over a secure
 * WebSocket, measures the round-trip time, counts lost messages and sends
 * signed valve commands. Everything received is treated as untrusted data.
 */
(function (FlowState) {
    'use strict';

    const { lib, config } = FlowState;

    const MAX_RTT_SAMPLES = 20;
    const MAX_MESSAGE_BYTES = 2048;
    const ALERT_TYPE = /^[A-Z0-9_]{1,60}$/;

    let client = null;
    let handlers = {};
    let generation = 0;
    let pingTimer = null;
    let pingId = 0;
    const pendingPings = new Map();
    const pendingCommands = new Map();
    let stats = freshStats();

    function freshStats() {
        return {
            connected: false,
            everConnected: false,
            deviceOnline: null,
            deviceInfo: null,
            messages: 0,
            bytes: 0,
            firstMessageMs: null,
            lastMessageMs: null,
            sequence: null,
            rtts: []
        };
    }

    function libraryLoaded() {
        return Boolean(window.mqtt && typeof window.mqtt.connect === 'function');
    }

    function topic(name) {
        return `${config.mqtt.topicRoot}/${name}`;
    }

    function decode(payload) {
        if (typeof payload === 'string') return payload;
        try {
            return new TextDecoder().decode(payload);
        } catch (_) {
            return '';
        }
    }

    function parse(text) {
        if (!text || text.length > MAX_MESSAGE_BYTES) return null;
        try {
            const value = JSON.parse(text);
            return value && typeof value === 'object' ? value : null;
        } catch (_) {
            return null;
        }
    }

    function snapshot() {
        const now = Date.now();
        const sequence = stats.sequence || { received: 0, missed: 0, restarts: 0 };
        const minutes = stats.firstMessageMs === null ? 0 : (now - stats.firstMessageMs) / 60000;
        return {
            connected: stats.connected,
            everConnected: stats.everConnected,
            deviceOnline: stats.deviceOnline,
            deviceInfo: stats.deviceInfo,
            messages: stats.messages,
            averageBytes: stats.messages ? stats.bytes / stats.messages : null,
            messagesPerMinute: minutes >= 0.25 ? stats.messages / minutes : null,
            bytesPerMinute: minutes >= 0.25 ? stats.bytes / minutes : null,
            lastMessageAgeMs: stats.lastMessageMs === null ? null : now - stats.lastMessageMs,
            received: sequence.received,
            missed: sequence.missed,
            restarts: sequence.restarts,
            deliveryPercent: lib.deliveryPercent(sequence.received, sequence.missed),
            rttMedian: lib.median(stats.rtts),
            rttMin: stats.rtts.length ? Math.min(...stats.rtts) : null,
            rttMax: stats.rtts.length ? Math.max(...stats.rtts) : null,
            rttSamples: stats.rtts.length
        };
    }

    function notify() {
        if (handlers.onChange) handlers.onChange(snapshot());
    }

    function onTelemetry(message, bytes) {
        const now = Date.now();
        stats.messages += 1;
        stats.bytes += bytes;
        if (stats.firstMessageMs === null) stats.firstMessageMs = now;
        stats.lastMessageMs = now;
        stats.sequence = lib.nextSequenceStats(stats.sequence, message.seq);
        // A device that publishes is online, whatever an old retained status says.
        stats.deviceOnline = true;
        const reading = lib.telemetryToReading(message, now);
        if (reading && handlers.onReading) handlers.onReading(reading);
    }

    function onStatus(message) {
        stats.deviceOnline = message.state === 'online';
        stats.deviceInfo = {
            state: message.state === 'online' ? 'online' : 'offline',
            firmware: typeof message.fw === 'string' ? message.fw.slice(0, 16) : null,
            rssi: Number.isFinite(message.rssi) ? message.rssi : null,
            reconnects: Number.isFinite(message.reconnects) ? message.reconnects : null
        };
    }

    function onAlert(message) {
        if (!ALERT_TYPE.test(String(message.alert_type || ''))) return;
        const now = Date.now();
        const alert = {
            id: `mqtt:${now}:${message.alert_type}`,
            source: 'mqtt',
            timestamp: new Date(now).toISOString(),
            alert_type: message.alert_type,
            message: String(message.message || '').slice(0, 500),
            severity: ['low', 'medium', 'high', 'critical'].includes(message.severity) ? message.severity : 'medium'
        };
        if (handlers.onAlert) handlers.onAlert(alert);
    }

    function onAck(message) {
        const resolve = pendingCommands.get(String(message.nonce || ''));
        if (!resolve) return;
        pendingCommands.delete(String(message.nonce));
        resolve({
            ok: message.ok === true,
            text: String(message.msg || '').slice(0, 200),
            valve: message.valve === 1 ? 1 : 0,
            auto: message.auto === 0 ? 0 : 1
        });
    }

    function onPong(message) {
        const sentAt = pendingPings.get(message.id);
        if (sentAt === undefined) return;
        pendingPings.delete(message.id);
        stats.rtts = [...stats.rtts, Math.round(performance.now() - sentAt)].slice(-MAX_RTT_SAMPLES);
    }

    function onMessage(mine, topicName, payload) {
        if (mine !== generation) return;
        const text = decode(payload);
        const message = parse(text);
        if (!message) return;
        const name = topicName.slice(config.mqtt.topicRoot.length + 1);
        if (name === 'telemetry') onTelemetry(message, text.length);
        else if (name === 'status') onStatus(message);
        else if (name === 'alert') onAlert(message);
        else if (name === 'ack') onAck(message);
        else if (name === 'pong') onPong(message);
        notify();
    }

    function ping() {
        if (!client || !stats.connected) return;
        pingId += 1;
        const now = performance.now();
        pendingPings.forEach((sentAt, id) => {
            if (now - sentAt > 30000) pendingPings.delete(id);
        });
        pendingPings.set(pingId, now);
        client.publish(topic('ping'), JSON.stringify({ id: pingId }), { qos: 0 });
    }

    /** @returns {boolean} true when a connection attempt started */
    function connect(nextHandlers) {
        disconnect();
        handlers = nextHandlers || {};
        if (!libraryLoaded()) {
            notify();
            return false;
        }
        generation += 1;
        const mine = generation;
        const random = new Uint32Array(1);
        crypto.getRandomValues(random);
        client = window.mqtt.connect(config.mqtt.url, {
            clientId: `flowstate-web-${random[0].toString(16)}`,
            clean: true,
            keepalive: 30,
            reconnectPeriod: 5000,
            connectTimeout: 10000,
            protocolVersion: 4,
            // Plain timers: the default starts a Web Worker from a blob, which the site's security policy blocks.
            timerVariant: 'native'
        });
        client.on('connect', () => {
            if (mine !== generation) return;
            stats.connected = true;
            stats.everConnected = true;
            client.subscribe(['telemetry', 'status', 'alert', 'ack', 'pong'].map(topic), { qos: 0 });
            ping();
            notify();
        });
        client.on('close', () => {
            if (mine !== generation) return;
            stats.connected = false;
            notify();
        });
        client.on('error', (error) => {
            if (mine !== generation) return;
            console.warn('[FlowState MQTT]', error && error.message ? error.message : error);
        });
        client.on('message', (topicName, payload) => onMessage(mine, topicName, payload));
        pingTimer = window.setInterval(ping, config.mqtt.pingEveryMs);
        notify();
        return true;
    }

    function disconnect() {
        generation += 1;
        window.clearInterval(pingTimer);
        pingTimer = null;
        pendingPings.clear();
        pendingCommands.clear();
        if (client) client.end(true);
        client = null;
        stats = freshStats();
    }

    function randomNonce() {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Signs and sends a valve command, then waits for the ESP32's answer.
     * @returns {Promise<{ok: boolean, text: string, valve: number, auto: number}>}
     */
    async function sendCommand(key, action) {
        if (!client || !stats.connected) throw new Error('Not connected to the MQTT broker.');
        const nonce = randomNonce();
        const command = await lib.signedCommand(key, config.mqtt.topicRoot, action, Date.now(), nonce);
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {
                pendingCommands.delete(nonce);
                reject(new Error(`No answer from the ESP32 within ${config.mqtt.commandTimeoutMs / 1000} s. Is it online?`));
            }, config.mqtt.commandTimeoutMs);
            pendingCommands.set(nonce, (ack) => {
                window.clearTimeout(timer);
                resolve(ack);
            });
            client.publish(topic('cmd'), JSON.stringify(command), { qos: 1 }, (error) => {
                if (!error) return;
                window.clearTimeout(timer);
                pendingCommands.delete(nonce);
                reject(error);
            });
        });
    }

    FlowState.mqttLink = { libraryLoaded, connect, disconnect, sendCommand, snapshot };
})(window.FlowState = window.FlowState || {});
