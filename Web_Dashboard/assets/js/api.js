/*
 * Everything the dashboard reads from Supabase. The dashboard only reads: the
 * ESP32 is the only thing that writes (see supabase/flowstate_setup.sql).
 *
 * sample.js offers the same functions with made-up data, so app.js can use
 * either one as its data source.
 */
(function (FlowState) {
    'use strict';

    const EXPORT_COLUMNS = Object.freeze([
        'id', 'timestamp', 'flow_rate_1', 'flow_rate_2', 'percentage_loss', 'water_level', 'valve_state',
        'leak_status', 'anomaly_status', 'system_online', 'daily_total_liters', 'humidity', 'temperature',
        'device_timestamp', 'received_at', 'wifi_rssi', 'uptime_s', 'free_heap', 'upload_ms', 'http_failures',
        'mqtt_connected'
    ]);
    const LIVE_COLUMNS = 'id,timestamp,flow_rate_1,flow_rate_2,percentage_loss,water_level,valve_state,'
        + 'leak_status,anomaly_status,system_online,daily_total_liters,humidity,temperature,'
        + 'wifi_rssi,uptime_s,free_heap,upload_ms,http_failures,mqtt_connected';
    const EXPORT_MAX_ROWS = 70000;
    const PAGE_SIZE = 1000;
    const FUTURE_TOLERANCE_MS = 60000;

    let client = null;

    function libraryLoaded() {
        return Boolean(window.supabase && typeof window.supabase.createClient === 'function');
    }

    /** @returns {boolean} true when a client was created */
    function connect(connection) {
        disconnect();
        if (!libraryLoaded() || !connection.url || !connection.key) return false;
        client = window.supabase.createClient(connection.url, connection.key, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
        });
        return true;
    }

    function disconnect() {
        if (client) client.removeAllChannels().catch(() => {});
        client = null;
    }

    // Rows dated in the future can only come from clock bugs or forged data.
    function latestAllowedTimestamp() {
        return new Date(Date.now() + FUTURE_TOLERANCE_MS).toISOString();
    }

    function unwrap({ data, error }) {
        if (error) throw error;
        return data;
    }

    async function fetchLatestReading() {
        const rows = unwrap(await client
            .from('water_readings')
            .select(LIVE_COLUMNS)
            .lte('timestamp', latestAllowedTimestamp())
            .order('timestamp', { ascending: false })
            .limit(1));
        return rows && rows.length ? rows[0] : null;
    }

    /** Readings since `since`, oldest first (at most one page: enough for the live chart). */
    async function fetchRecentReadings(since) {
        const rows = unwrap(await client
            .from('water_readings')
            .select(LIVE_COLUMNS)
            .gte('timestamp', since.toISOString())
            .lte('timestamp', latestAllowedTimestamp())
            .order('timestamp', { ascending: false })
            .limit(PAGE_SIZE)) || [];
        return rows.reverse();
    }

    async function fetchRecentAlerts(limit) {
        return unwrap(await client
            .from('alerts')
            .select('id,timestamp,alert_type,message,severity')
            .lte('timestamp', latestAllowedTimestamp())
            .order('timestamp', { ascending: false })
            .limit(limit)) || [];
    }

    async function fetchHourlySummary(since, timeZone) {
        return unwrap(await client.rpc('get_hourly_summary', { p_since: since.toISOString(), p_tz: timeZone })) || [];
    }

    async function fetchReadingsSince(since) {
        const rows = [];
        for (let from = 0; from < EXPORT_MAX_ROWS; from += PAGE_SIZE) {
            const page = unwrap(await client
                .from('water_readings')
                .select(EXPORT_COLUMNS.join(','))
                .gte('timestamp', since.toISOString())
                .lte('timestamp', latestAllowedTimestamp())
                .order('timestamp', { ascending: true })
                .range(from, from + PAGE_SIZE - 1)) || [];
            rows.push(...page);
            if (page.length < PAGE_SIZE) break;
        }
        return rows;
    }

    /**
     * @param {{onReading: Function, onAlert: Function, onStatus: (name: string, status: string) => void}} handlers
     */
    function subscribe(handlers) {
        client
            .channel('flowstate-readings')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'water_readings' },
                (payload) => handlers.onReading(payload.new))
            .subscribe((status) => handlers.onStatus('readings', status));

        client
            .channel('flowstate-alerts')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' },
                (payload) => handlers.onAlert(payload.new))
            .subscribe((status) => handlers.onStatus('alerts', status));
    }

    FlowState.api = {
        EXPORT_COLUMNS,
        libraryLoaded,
        connect,
        disconnect,
        fetchLatestReading,
        fetchRecentReadings,
        fetchRecentAlerts,
        fetchHourlySummary,
        fetchReadingsSince,
        subscribe
    };
})(window.FlowState = window.FlowState || {});
