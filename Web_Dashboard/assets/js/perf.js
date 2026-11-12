/*
 * Connectivity and performance: live measurements of both data paths.
 *   MQTT  - round-trip time (ping/pong), delivery from sequence numbers, traffic
 *   HTTPS - share of expected readings stored, upload time measured on the ESP32
 *   ESP32 - Wi-Fi signal, uptime, free memory
 * Nothing here is estimated from sample data: in sample mode it stays empty.
 */
(function (FlowState) {
    'use strict';

    const { lib, config, ui, charts, mqttLink } = FlowState;
    const $ = (id) => document.getElementById(id);

    const STORAGE_WINDOW_MS = 15 * 60000;
    // The fields the ESP32 posts, in its order, to estimate the HTTPS body size.
    const POSTED_FIELDS = [
        'flow_rate_1', 'flow_rate_2', 'percentage_loss', 'water_level', 'valve_state', 'leak_status',
        'anomaly_status', 'system_online', 'daily_total_liters', 'humidity', 'temperature', 'wifi_rssi',
        'uptime_s', 'free_heap', 'upload_ms', 'http_failures', 'mqtt_connected'
    ];

    function metric(id, value, detail, tone) {
        ui.setLive(id, value);
        ui.setText(`${id}Detail`, detail);
        const card = $(id).closest('.metric');
        if (card) card.dataset.tone = tone || 'neutral';
    }

    function estimateBodyBytes(row) {
        if (!row) return null;
        const body = { timestamp: '2026-01-01T00:00:00+05:30' };
        POSTED_FIELDS.forEach((field) => {
            if (row[field] !== null && row[field] !== undefined) body[field] = row[field];
        });
        return JSON.stringify(body).length;
    }

    function renderMqtt(mqtt) {
        if (!mqttLink.libraryLoaded()) {
            metric('perfMqtt', 'Unavailable', 'The MQTT library could not load (check the internet connection).', 'critical');
            return;
        }
        const device = mqtt.deviceOnline === true ? 'ESP32 online'
            : mqtt.deviceOnline === false ? 'ESP32 offline (Last Will)' : 'ESP32 not heard yet';
        const firmware = mqtt.deviceInfo && mqtt.deviceInfo.firmware ? ` · firmware v${mqtt.deviceInfo.firmware}` : '';
        let tone = 'neutral';
        if (mqtt.connected && mqtt.deviceOnline === true) tone = 'good';
        else if (mqtt.connected && mqtt.deviceOnline === false) tone = 'warning';
        metric('perfMqtt',
            mqtt.connected ? 'Connected' : mqtt.everConnected ? 'Reconnecting…' : 'Connecting…',
            `${config.mqtt.brokerName} · ${device}${firmware}`, tone);

        metric('perfRtt',
            mqtt.rttMedian === null ? '--' : `${Math.round(mqtt.rttMedian)} ms`,
            mqtt.rttSamples
                ? `Median of ${mqtt.rttSamples} pings (${mqtt.rttMin}–${mqtt.rttMax} ms): page → broker → ESP32 → broker → page`
                : 'A ping goes to the ESP32 every 10 s once it is online.',
            mqtt.rttMedian === null ? 'neutral' : mqtt.rttMedian < 1000 ? 'good' : 'warning');

        const delivery = mqtt.deliveryPercent;
        metric('perfDelivery',
            delivery === null ? '--' : `${delivery.toFixed(1)}%`,
            mqtt.received
                ? `${mqtt.received} received, ${mqtt.missed} missed (from sequence numbers)${mqtt.restarts ? `, ${mqtt.restarts} ESP32 restart${mqtt.restarts === 1 ? '' : 's'}` : ''}`
                : 'Counted from each message\'s sequence number.',
            delivery === null ? 'neutral' : delivery >= 98 ? 'good' : 'warning');

        metric('perfTraffic',
            mqtt.averageBytes === null ? '--' : `${Math.round(mqtt.averageBytes)} B`,
            mqtt.messagesPerMinute === null
                ? 'Average size of one telemetry message.'
                : `per message · ${mqtt.messagesPerMinute.toFixed(1)} messages/min · ${(mqtt.bytesPerMinute / 1024).toFixed(1)} KB/min`);
    }

    function renderStorage(dbReadings, latest, dbConnected, nowMs) {
        if (!dbConnected) {
            metric('perfStorage', '--', 'Not connected to the database.');
            metric('perfUpload', '--', 'Not connected to the database.');
            return { storagePercent: null, uploadMedian: null };
        }
        const delivery = lib.storageDelivery(dbReadings, nowMs, STORAGE_WINDOW_MS, config.device.uploadIntervalMs);
        metric('perfStorage', `${delivery.percent.toFixed(0)}%`,
            `${delivery.received} of ${delivery.expected} expected readings in the last 15 min (one every ${config.device.uploadIntervalMs / 1000} s)`,
            delivery.received === 0 ? 'critical' : delivery.percent >= 95 ? 'good' : 'warning');

        const uploads = dbReadings.map((row) => lib.toNumber(row.upload_ms, NaN)).filter((value) => value > 0);
        const uploadMedian = lib.median(uploads);
        const failures = latest && Number.isFinite(Number(latest.http_failures)) ? Number(latest.http_failures) : null;
        metric('perfUpload',
            uploadMedian === null ? '--' : `${Math.round(uploadMedian)} ms`,
            uploadMedian === null
                ? 'Sent by firmware v2 with each reading.'
                : `Median HTTPS POST time on the ESP32 (last 15 min)${failures === null ? '' : ` · ${failures} failed since boot`}`,
            uploadMedian === null ? 'neutral' : uploadMedian < 1500 ? 'good' : 'warning');
        return { storagePercent: delivery.percent, uploadMedian };
    }

    function renderDevice(latest) {
        const rssi = latest && latest.wifi_rssi !== null && latest.wifi_rssi !== undefined ? Number(latest.wifi_rssi) : null;
        const quality = lib.signalQuality(rssi);
        metric('perfSignal', rssi === null ? '--' : `${rssi} dBm`,
            rssi === null ? 'Sent by firmware v2.' : `${quality.charAt(0).toUpperCase()}${quality.slice(1)} (above −67 dBm is good for Wi-Fi)`,
            rssi === null ? 'neutral' : quality === 'weak' ? 'warning' : 'good');

        const uptime = latest && latest.uptime_s !== null && latest.uptime_s !== undefined ? Number(latest.uptime_s) : null;
        const heap = latest && latest.free_heap !== null && latest.free_heap !== undefined ? Number(latest.free_heap) : null;
        metric('perfUptime', uptime === null ? '--' : lib.formatDuration(uptime),
            heap === null ? 'Time since the ESP32 last started.' : `Since the last restart · ${Math.round(heap / 1024)} KB of memory free`);
    }

    function renderComparison(mqtt, storage, latestStored) {
        const bodyBytes = estimateBodyBytes(latestStored);
        const keyLength = (config.getConnection().key || '').length;
        ui.setText('cmpMqttSize', mqtt.averageBytes === null ? '--' : `${Math.round(mqtt.averageBytes)} B of JSON`);
        ui.setText('cmpHttpsSize', bodyBytes === null ? '--'
            : `≈ ${bodyBytes} B of JSON + ≈ ${Math.round((2 * keyLength + 220) / 10) * 10} B of HTTP headers`);
        ui.setText('cmpMqttDelay', mqtt.rttMedian === null ? '--' : `${Math.round(mqtt.rttMedian)} ms round trip`);
        ui.setText('cmpHttpsDelay', storage.uploadMedian === null ? '--' : `${Math.round(storage.uploadMedian)} ms per upload`);
        ui.setText('cmpMqttDelivered', mqtt.deliveryPercent === null ? '--' : `${mqtt.deliveryPercent.toFixed(1)}%`);
        ui.setText('cmpHttpsDelivered', storage.storagePercent === null ? '--' : `${storage.storagePercent.toFixed(0)}% (last 15 min)`);
    }

    /**
     * @param {{mqtt: object, dbReadings: object[], latest: object|null, latestStored: object|null,
     *          summaryRows: object[]|null, sample: boolean, dbConnected: boolean, nowMs: number}} context
     */
    function render(context) {
        if (context.sample) {
            ['perfMqtt', 'perfRtt', 'perfDelivery', 'perfTraffic', 'perfStorage', 'perfUpload', 'perfSignal', 'perfUptime']
                .forEach((id) => metric(id, '--', 'Not measured with sample data.'));
            ['cmpMqttSize', 'cmpHttpsSize', 'cmpMqttDelay', 'cmpHttpsDelay', 'cmpMqttDelivered', 'cmpHttpsDelivered']
                .forEach((id) => ui.setText(id, '--'));
            ui.setText('perfNote', 'Showing sample data: connect the ESP32 to measure.');
            charts.renderReliability([], context.nowMs, 'Not measured with sample data.');
            return;
        }
        ui.setText('perfNote', '');
        renderMqtt(context.mqtt);
        const storage = renderStorage(context.dbReadings, context.latest, context.dbConnected, context.nowMs);
        renderDevice(context.latest);
        renderComparison(context.mqtt, storage, context.latestStored);
        charts.renderReliability(context.summaryRows || [], context.nowMs,
            context.dbConnected ? 'No readings stored in the last 24 hours.' : 'Not connected to the database.');
    }

    FlowState.perf = { render, estimateBodyBytes };
})(window.FlowState = window.FlowState || {});
