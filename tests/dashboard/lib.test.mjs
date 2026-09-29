// Unit tests for Web_Dashboard/assets/js/lib.js. Run with: node --test tests/dashboard
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const lib = require('../../Web_Dashboard/assets/js/lib.js');

const NOW = Date.parse('2026-09-29T12:00:00Z');

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

test('severity groups map device severities onto the alert tabs', () => {
  assert.equal(lib.severityGroup('critical'), 'critical');
  assert.equal(lib.severityGroup('HIGH'), 'critical');
  assert.equal(lib.severityGroup('medium'), 'warning');
  assert.equal(lib.severityGroup('low'), 'info');
  assert.equal(lib.severityGroup('something-new'), 'warning');
  assert.equal(lib.severityGroup(undefined), 'warning');
});

test('alerts merge without duplicates, newest first', () => {
  const merged = lib.mergeAlerts(
    [{ id: 1, timestamp: '2026-09-29T10:00:00Z' }, { id: 2, timestamp: '2026-09-29T11:00:00Z' }],
    [{ id: 1, timestamp: '2026-09-29T10:00:00Z' }, { id: 'x', source: 'insight', timestamp: '2026-09-29T11:30:00Z' }]
  );
  assert.deepEqual(merged.map((alert) => lib.alertKey(alert)), ['insight:x', 'db:2', 'db:1']);
});

test('alert filters combine severity, acknowledgement, search and critical-only mode', () => {
  const alerts = [
    { id: 1, severity: 'critical', alert_type: 'CRITICAL_LEAK', message: 'Valve closed' },
    { id: 2, severity: 'medium', alert_type: 'NIGHTTIME_FLOW_START', message: 'Flow at night' },
    { id: 3, severity: 'low', alert_type: 'VALVE_OPENED', message: 'Opened from the dashboard' }
  ];
  const acknowledged = new Set(['db:2']);
  const base = { severity: 'all', ack: 'all', search: '', criticalOnly: false, isAcknowledged: (key) => acknowledged.has(key) };

  assert.equal(lib.filterAlerts(alerts, base).length, 3);
  assert.deepEqual(lib.filterAlerts(alerts, { ...base, ack: 'open' }).map((a) => a.id), [1, 3]);
  assert.deepEqual(lib.filterAlerts(alerts, { ...base, ack: 'acknowledged' }).map((a) => a.id), [2]);
  assert.deepEqual(lib.filterAlerts(alerts, { ...base, severity: 'info' }).map((a) => a.id), [3]);
  assert.deepEqual(lib.filterAlerts(alerts, { ...base, criticalOnly: true }).map((a) => a.id), [1]);
  assert.deepEqual(lib.filterAlerts(alerts, { ...base, search: 'night' }).map((a) => a.id), [2]);
  assert.deepEqual(lib.countBySeverity(alerts), { all: 3, critical: 1, warning: 1, info: 1 });
});

test('device freshness separates live, delayed and offline', () => {
  const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();
  assert.equal(lib.classifyFreshness(null, NOW, 5000).state, 'no-data');
  assert.equal(lib.classifyFreshness(at(10), NOW, 5000).state, 'live');
  assert.equal(lib.classifyFreshness(at(40), NOW, 5000).state, 'delayed');
  assert.equal(lib.classifyFreshness(at(120), NOW, 5000).state, 'offline');
  assert.equal(lib.classifyFreshness(at(-5), NOW, 5000).ageMs, 0);
  assert.equal(lib.formatAge(3000), 'just now');
  assert.equal(lib.formatAge(42000), '42 s ago');
  assert.equal(lib.formatAge(5 * 60000), '5 min ago');
  assert.equal(lib.formatAge(null), 'never');
});

test('tank percentage uses the level as reported, with no inversion', () => {
  assert.equal(lib.tankPercent(100, 100), 100);
  assert.equal(lib.tankPercent(0, 100), 0);
  assert.equal(lib.tankPercent(45, 100), 45);
  assert.equal(lib.tankPercent(120, 100), 100);
  assert.equal(lib.tankPercent(50, 0), 0);
});

test('future-dated readings never replace real ones', () => {
  const real = { id: 1, timestamp: new Date(NOW - 5000).toISOString() };
  const forged = { id: 2, timestamp: '2099-01-01T00:00:00Z' };
  const newer = { id: 3, timestamp: new Date(NOW).toISOString() };
  assert.equal(lib.isFutureReading(forged.timestamp, NOW), true);
  assert.equal(lib.newerReading(real, forged, NOW), real);
  assert.equal(lib.newerReading(real, newer, NOW), newer);
  assert.equal(lib.newerReading(null, real, NOW), real);
});

test('humidity is null when unknown, never a fake 0', () => {
  assert.equal(lib.humidityOrNull(null), null);
  assert.equal(lib.humidityOrNull(undefined), null);
  assert.equal(lib.humidityOrNull('abc'), null);
  assert.equal(lib.humidityOrNull(55.5), 55.5);
  assert.equal(lib.humidityOrNull(140), 100);
});

test('history helpers total volumes by local hour and never report negative loss', () => {
  const threeAm = new Date(2026, 8, 29, 3, 20).toISOString();
  const threeAmLater = new Date(2026, 8, 29, 3, 40).toISOString();
  const twoPm = new Date(2026, 8, 29, 14, 0).toISOString();
  const rows = [
    { bucket_start: threeAm, volume_1_liters: 1.5, volume_2_liters: 1.2 },
    { bucket_start: threeAmLater, volume_1_liters: 0.5, volume_2_liters: 0.5 },
    { bucket_start: twoPm, volume_1_liters: 10, volume_2_liters: 10.4 }
  ];
  const hourly = lib.hourlyUsage(rows);
  assert.equal(hourly.length, 24);
  assert.equal(hourly[3], 2);
  assert.equal(hourly[14], 10);
  assert.equal(lib.round(lib.lossLiters(rows), 3), 0);
  assert.equal(lib.round(lib.lossLiters(rows.slice(0, 1)), 3), 0.3);
});

test('CSV export neutralises spreadsheet formulas and quotes special characters', () => {
  assert.equal(lib.csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(lib.csvCell('+cmd'), "'+cmd");
  assert.equal(lib.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(lib.csvCell(-5.2), '-5.2');
  assert.equal(lib.csvCell('a,b'), '"a,b"');
  assert.equal(lib.csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(lib.csvCell(null), '');
  assert.equal(
    lib.toCsv([{ a: 1, b: 'x' }, { a: 2, b: '-y' }], ['a', 'b']),
    "a,b\r\n1,x\r\n2,'-y"
  );
});

test('only https Supabase URLs (or local ones) are accepted', () => {
  assert.equal(lib.isValidSupabaseUrl('https://abc.supabase.co/'), true);
  assert.equal(lib.isValidSupabaseUrl('http://localhost:54321'), true);
  assert.equal(lib.isValidSupabaseUrl('http://abc.supabase.co'), false);
  assert.equal(lib.isValidSupabaseUrl('javascript:alert(1)'), false);
  assert.equal(lib.isValidSupabaseUrl(''), false);
});

test('secret Supabase keys are recognised so the browser never uses them', () => {
  assert.equal(lib.keyKind(fakeJwt({ role: 'service_role' })), 'secret');
  assert.equal(lib.keyKind(fakeJwt({ role: 'anon' })), 'public');
  assert.equal(lib.keyKind('sb_secret_abc123'), 'secret');
  assert.equal(lib.keyKind('sb_publishable_abc123'), 'public');
  assert.equal(lib.keyKind(''), 'missing');
  assert.equal(lib.keyKind('not-a-key'), 'unknown');
});

test('a deployment with a database is locked to it; saved values apply only to local use', () => {
  const env = { SUPABASE_URL: 'https://env.supabase.co', SUPABASE_KEY: 'env-key' };
  const deployed = { url: 'https://env.supabase.co', key: 'env-key', source: 'deployment', locked: true };
  assert.deepEqual(lib.resolveConnection(env, {}), deployed);
  assert.deepEqual(lib.resolveConnection(env, { url: 'https://attacker.example', key: 'k' }), deployed);
  assert.deepEqual(lib.resolveConnection({}, { url: 'https://mine.supabase.co/', key: 'my-key' }), {
    url: 'https://mine.supabase.co',
    key: 'my-key',
    source: 'browser',
    locked: false
  });
  assert.equal(lib.resolveConnection({}, {}).source, 'none');
  assert.equal(lib.overrideToSave(' https://env.supabase.co ', 'https://env.supabase.co'), null);
  assert.equal(lib.overrideToSave('', 'x'), null);
  assert.equal(lib.overrideToSave('https://mine.supabase.co', 'https://env.supabase.co'), 'https://mine.supabase.co');
});

test('valve command state follows delivery and the next matching reading', () => {
  const sentAtMs = NOW;
  const deliveredAt = new Date(NOW + 3000).toISOString();
  const waiting = { action: 'close', status: 'pending', sentAtMs };
  const delivered = { ...waiting, status: 'delivered', delivered_at: deliveredAt };
  const oldReading = { timestamp: new Date(NOW - 1000).toISOString(), valve_state: 0 };
  const readingAtDelivery = { timestamp: deliveredAt, valve_state: 1 };
  const nextReading = { timestamp: new Date(NOW + 8000).toISOString(), valve_state: 0 };

  assert.equal(lib.valveCommandState(null, null, NOW), 'idle');
  assert.equal(lib.valveCommandState(waiting, oldReading, NOW + 1000), 'waiting');
  assert.equal(lib.valveCommandState(delivered, oldReading, NOW + 4000), 'delivered');
  assert.equal(lib.valveCommandState(delivered, readingAtDelivery, NOW + 4000), 'delivered');
  assert.equal(lib.valveCommandState(delivered, nextReading, NOW + 9000), 'done');
  assert.equal(lib.valveCommandState({ ...waiting, status: 'expired' }, oldReading, NOW + 5000), 'expired');
  assert.equal(lib.valveCommandState(waiting, oldReading, NOW + 120000), 'timeout');
});

test('heavy but normal use never raises the risk priority on its own', () => {
  const noLeak = { flow_rate_1: 3, flow_rate_2: 3, percentage_loss: 0, humidity: 50 };
  const profile = lib.computeRiskProfile(noLeak, { todayLiters: 50000 });
  assert.equal(profile.priorityLevel, 'Low');
  assert.equal(profile.leakRateLpm, 0);
  assert.equal(profile.immediateAction, false);

  const jitter = lib.computeRiskProfile({ flow_rate_1: 1, flow_rate_2: 0.87, percentage_loss: 2 }, { todayLiters: 100 });
  assert.equal(jitter.leakRateLpm, 0);

  const bigLeak = lib.computeRiskProfile({ flow_rate_1: 4, flow_rate_2: 1, percentage_loss: 75, humidity: 50 }, { todayLiters: 3000 });
  assert.ok(['High', 'Critical'].includes(bigLeak.priorityLevel));
  assert.equal(bigLeak.leakRateLpm, 3);
  assert.equal(bigLeak.immediateAction, bigLeak.priorityScore >= 75 || bigLeak.failureRisk >= 0.75);
});

test('dashboard insights are raised only when risk climbs, with a cooldown', () => {
  assert.equal(lib.shouldRaiseInsight('Low', 'High', null, NOW), true);
  assert.equal(lib.shouldRaiseInsight('High', 'High', null, NOW), false);
  assert.equal(lib.shouldRaiseInsight('Low', 'Medium', null, NOW), false);
  assert.equal(lib.shouldRaiseInsight('Low', 'Critical', NOW - 60000, NOW), false);
  assert.equal(lib.shouldRaiseInsight('High', 'Critical', NOW - 700000, NOW), true);
});

test('what-if simulation and sustainability figures', () => {
  const sim = lib.simulateWhatIf({ leakRateLpm: 0.5, horizonDays: 30, repairCost: 800, costPerLiter: 0.05 });
  assert.equal(sim.ignoreLossLiters, 21600);
  assert.equal(sim.ignoreCostUsd, 1108.8);
  assert.equal(sim.savingsUsd, 308.8);
  assert.equal(sim.recommendedAction, 'Repair immediately');
  assert.equal(lib.simulateWhatIf({ leakRateLpm: 0, horizonDays: 999, repairCost: 0, costPerLiter: 0.05 }).horizonDays, 365);

  const impact = lib.sustainabilityImpact({
    loss24hLiters: 30,
    total24hLiters: 400,
    allowancePercent: 5,
    co2KgPerLiter: 0.00034,
    litersPerPersonPerDay: 50
  });
  assert.equal(impact.preventablePerDay, 10);
  assert.equal(impact.monthlyLiters, 300);
  assert.equal(lib.round(impact.co2KgPerMonth, 3), 0.102);
  assert.equal(impact.peopleEquivalent, 0.2);
});
