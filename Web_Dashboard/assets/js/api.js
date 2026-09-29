/*
 * Everything the dashboard reads from or asks of Supabase. The public key is
 * read-only; the valve command needs an operator key that the database checks.
 */
(function (FlowState) {
    'use strict';

    const EXPORT_COLUMNS = Object.freeze([
        'id', 'timestamp', 'flow_rate_1', 'flow_rate_2', 'percentage_loss', 'water_level', 'humidity',
        'valve_state', 'leak_status', 'anomaly_status', 'daily_total_liters', 'volume_1_ml', 'volume_2_ml'
    ]);
    const EXPORT_MAX_ROWS = 50000;
    const PAGE_SIZE = 1000;
    const FUTURE_TOLERANCE_MS = 60000;

    let client = null;

    function isReady() {
        return client !== null;
    }

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
        if (client) {
            client.removeAllChannels().catch(() => {});
        }
        client = null;
    }

    // Rows dated in the future can only come from old clock bugs or forged data.
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
            .select('*')
            .lte('timestamp', latestAllowedTimestamp())
            .order('timestamp', { ascending: false })
            .limit(1));
        return rows && rows.length ? rows[0] : null;
    }

    async function fetchRecentAlerts(limit) {
        return unwrap(await client
            .from('alerts')
            .select('id,timestamp,alert_type,message,severity')
            .lte('timestamp', latestAllowedTimestamp())
            .order('timestamp', { ascending: false })
            .limit(limit)) || [];
    }

    async function fetchHistory(range) {
        return unwrap(await client.rpc('get_reading_history', { p_range: range })) || [];
    }

    async function fetchUsageSummary(since) {
        const data = unwrap(await client.rpc('get_usage_summary', { p_since: since.toISOString() }));
        return Array.isArray(data) ? data[0] || null : data;
    }

    async function requestValveCommand(operatorKey, action) {
        return unwrap(await client.rpc('request_valve_command', { p_operator_key: operatorKey, p_action: action }));
    }

    async function fetchValveCommand(id) {
        return unwrap(await client
            .from('valve_commands')
            .select('id,action,status,requested_at,delivered_at')
            .eq('id', id)
            .maybeSingle());
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
        isReady,
        libraryLoaded,
        connect,
        disconnect,
        fetchLatestReading,
        fetchRecentAlerts,
        fetchHistory,
        fetchUsageSummary,
        requestValveCommand,
        fetchValveCommand,
        fetchReadingsSince,
        subscribe
    };
})(window.FlowState = window.FlowState || {});
