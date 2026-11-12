// Unit tests for Web_Dashboard/assets/js/lib.js. Run with: npm test
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const lib = require('../../Web_Dashboard/assets/js/lib.js');

const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-11-12T06:30:00Z'); // 12:00 noon in India

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

/** Start of an hour in India time, as the database function returns it. */
function istHour(dateKey, hour) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour) - 5.5 * 3600000).toISOString();
}

function hourRow(dateKey, hour, used, extra = {}) {
  return { hour_start: istHour(dateKey, hour), used_liters: used, lost_liters: 0, readings: 360, flow_readings: 0, ...extra };
}

/** A day with the same usage pattern: 10 L at 7 AM, 5 L at 1 PM and 15 L at 7 PM. */
function typicalDay(dateKey) {
  return [hourRow(dateKey, 7, 10), hourRow(dateKey, 13, 5), hourRow(dateKey, 19, 15)];
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
test('wall-clock time is read in the device time zone', () => {
  assert.deepEqual(lib.zonedParts(NOW, TZ), { dateKey: '2026-11-12', hour: 12, minute: 0, second: 0 });
  assert.deepEqual(lib.zonedParts(Date.parse('2026-11-11T18:30:00Z'), TZ).dateKey, '2026-11-12');
  assert.equal(lib.startOfZonedDay(NOW, TZ), Date.parse('2026-11-11T18:30:00Z'));
  assert.equal(lib.addDays('2026-11-01', -1), '2026-10-31');
  assert.deepEqual(lib.lastDays('2026-11-12', 3), ['2026-11-10', '2026-11-11', '2026-11-12']);
  assert.equal(lib.shortDay('2026-11-12'), 'Thu 12 Nov');
});

test('hour ranges read naturally', () => {
  assert.equal(lib.hourRange(0), '12–1 AM');
  assert.equal(lib.hourRange(7), '7–8 AM');
  assert.equal(lib.hourRange(11), '11 AM–12 PM');
  assert.equal(lib.hourRange(12), '12–1 PM');
  assert.equal(lib.hourRange(23), '11 PM–12 AM');
});

test('litres and rupees are formatted for India', () => {
  assert.equal(lib.formatLiters(3.14159), '3.14');
  assert.equal(lib.formatLiters(42.25), '42.3');
  assert.equal(lib.formatLiters(123456), '1,23,456');
  assert.equal(lib.formatLiters(-2), '0.00');
  assert.equal(lib.formatRupees(0.0456), '₹0.05');
  assert.equal(lib.formatRupees(1234.5), '₹1,234.50');
});

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------
test('device freshness follows the 10-second upload interval', () => {
  const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();
  assert.equal(lib.classifyFreshness(null, NOW, 10000).state, 'no-data');
  assert.equal(lib.classifyFreshness(at(25), NOW, 10000).state, 'live');
  assert.equal(lib.classifyFreshness(at(90), NOW, 10000).state, 'delayed');
  assert.equal(lib.classifyFreshness(at(300), NOW, 10000).state, 'offline');
  assert.equal(lib.classifyFreshness(at(-5), NOW, 10000).ageMs, 0);
  assert.equal(lib.formatAge(3000), 'just now');
  assert.equal(lib.formatAge(42000), '42 s ago');
  assert.equal(lib.formatAge(5 * 60000), '5 min ago');
  assert.equal(lib.formatAge(null), 'never');
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

test('the live chart keeps the last window of readings, oldest first, without repeats', () => {
  const at = (secondsAgo, id) => ({ id, timestamp: new Date(NOW - secondsAgo * 1000).toISOString() });
  const kept = lib.trimLiveWindow([at(10, 3), at(1000, 1), at(20, 2), at(10, 3), { id: 9, timestamp: '2099-01-01T00:00:00Z' }], NOW, 900000);
  assert.deepEqual(kept.map((reading) => reading.id), [2, 3]);
});

test('optional sensors are null when not sent, never a fake 0', () => {
  assert.equal(lib.optionalNumber(null, 0, 100), null);
  assert.equal(lib.optionalNumber(undefined, 0, 100), null);
  assert.equal(lib.optionalNumber('abc', 0, 100), null);
  assert.equal(lib.optionalNumber(55.5, 0, 100), 55.5);
  assert.equal(lib.optionalNumber(140, 0, 100), 100);
});

test('tank level and the leak scale stay within range', () => {
  assert.equal(lib.tankPercent(45, 100), 45);
  assert.equal(lib.tankPercent(120, 100), 100);
  assert.equal(lib.tankPercent(50, 0), 0);
  assert.equal(lib.lossScalePosition(15), 0.5);
  assert.equal(lib.lossScalePosition(80), 1);
  assert.equal(lib.lossScalePosition(-3), 0);
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
test('alert types from the sketch get plain names and the right tab', () => {
  assert.equal(lib.alertName('NIGHTTIME_LEAK_CRITICAL'), 'Night-time flow for 10 minutes');
  assert.equal(lib.alertName('SOMETHING_NEW'), 'Something new');
  assert.equal(lib.alertName(''), 'Alert');
  assert.equal(lib.alertGroup({ alert_type: 'CRITICAL_LEAK', severity: 'high' }), 'critical');
  assert.equal(lib.alertGroup({ alert_type: 'LEAK_WARNING', severity: 'medium' }), 'warning');
  assert.equal(lib.alertGroup({ alert_type: 'VALVE_OPENED', severity: 'medium' }), 'info');
  assert.equal(lib.alertGroup({ alert_type: 'VALVE_CLOSED', severity: 'medium' }), 'warning');
  assert.equal(lib.alertGroup({ alert_type: 'X', severity: 'low' }), 'info');
});

test('alerts merge without duplicates, newest first, and filter by tab and search', () => {
  const alerts = lib.mergeAlerts(
    [{ id: 1, timestamp: '2026-11-12T01:00:00Z', alert_type: 'CRITICAL_LEAK', severity: 'high', message: 'Loss 22%' }],
    [
      { id: 1, timestamp: '2026-11-12T01:00:00Z', alert_type: 'CRITICAL_LEAK', severity: 'high', message: 'Loss 22%' },
      { id: 2, timestamp: '2026-11-12T02:00:00Z', alert_type: 'NIGHTTIME_FLOW_START', severity: 'medium', message: 'Flow' },
      { id: 3, timestamp: '2026-11-12T03:00:00Z', alert_type: 'VALVE_OPENED', severity: 'medium', message: 'Opened' }
    ]
  );
  assert.deepEqual(alerts.map((alert) => alert.id), [3, 2, 1]);
  assert.deepEqual(lib.countAlerts(alerts), { all: 3, critical: 1, warning: 1, info: 1 });
  assert.deepEqual(lib.filterAlerts(alerts, { group: 'critical', search: '' }).map((a) => a.id), [1]);
  assert.deepEqual(lib.filterAlerts(alerts, { group: 'all', search: 'night' }).map((a) => a.id), [2]);
});

// ---------------------------------------------------------------------------
// The five questions
// ---------------------------------------------------------------------------
test('hourly rows are grouped by India date and hour', () => {
  const days = lib.groupByDay([
    hourRow('2026-11-12', 0, 2, { lost_liters: 0.5, flow_readings: 30 }),
    hourRow('2026-11-11', 23, 3, { lost_liters: 9 })
  ], TZ);
  assert.equal(days['2026-11-12'].hours[0].used, 2);
  assert.equal(days['2026-11-12'].hours[0].flowReadings, 30);
  assert.equal(days['2026-11-11'].hours[23].used, 3);
  assert.equal(days['2026-11-11'].lost, 3, 'loss can never exceed the water used');
});

test('Q1 adds up the water lost today and over the week', () => {
  const days = lib.groupByDay([
    hourRow('2026-11-10', 8, 100, { lost_liters: 4 }),
    hourRow('2026-11-12', 8, 50, { lost_liters: 6 })
  ], TZ);
  const loss = lib.answerLoss(days, '2026-11-12');
  assert.equal(loss.perDay.length, 7);
  assert.equal(loss.todayUsed, 50);
  assert.equal(loss.todayLost, 6);
  assert.equal(loss.weekUsed, 150);
  assert.equal(loss.weekLost, 10);
  assert.equal(lib.round(loss.sharePercent, 2), 6.67);
  assert.equal(loss.daysWithData, 2);
  assert.equal(lib.answerLoss({}, '2026-11-12').sharePercent, null);
});

test('Q2 finds the busiest hour on an average day', () => {
  const rows = [...typicalDay('2026-11-10'), ...typicalDay('2026-11-11'), hourRow('2026-11-12', 7, 40)];
  const peak = lib.answerPeak(lib.groupByDay(rows, TZ), '2026-11-12');
  assert.equal(peak.peakHour, 19);
  assert.equal(peak.peakLiters, 15);
  assert.equal(peak.averageByHour[7], 10);
  assert.equal(peak.todayByHour[7], 40);
  assert.equal(peak.daysAveraged, 2);
  assert.equal(peak.basedOnToday, false);
  assert.deepEqual(peak.busiestDay, { dateKey: '2026-11-12', used: 40 });

  const firstDay = lib.answerPeak(lib.groupByDay([hourRow('2026-11-12', 9, 4)], TZ), '2026-11-12');
  assert.equal(firstDay.peakHour, 9);
  assert.equal(firstDay.basedOnToday, true);
  assert.equal(lib.answerPeak({}, '2026-11-12').peakHour, null);
});

test('Q3 compares today with the normal amount by the same time of day', () => {
  const now = { hour: 12, minute: 0 };
  const history = [...typicalDay('2026-11-09'), ...typicalDay('2026-11-10'), ...typicalDay('2026-11-11')];

  const learning = lib.answerUnusual(lib.groupByDay(history.slice(3), TZ), '2026-11-12', now);
  assert.equal(learning.state, 'learning');
  assert.equal(learning.baselineDays, 2);

  // Normal by noon is 10 L (only the 7 AM use has happened).
  const high = lib.answerUnusual(lib.groupByDay([...history, hourRow('2026-11-12', 7, 16)], TZ), '2026-11-12', now);
  assert.equal(high.state, 'high');
  assert.equal(high.normalSoFar, 10);
  assert.equal(high.ratio, 1.6);
  assert.equal(high.normalCumulative[23], 30);
  assert.equal(high.todayCumulative.length, 13);

  assert.equal(lib.answerUnusual(lib.groupByDay([...history, hourRow('2026-11-12', 7, 11)], TZ), '2026-11-12', now).state, 'normal');
  assert.equal(lib.answerUnusual(lib.groupByDay([...history, hourRow('2026-11-12', 7, 5)], TZ), '2026-11-12', now).state, 'low');

  // Half an hour into 1 PM, half of the usual 1 PM use is expected.
  const halfHour = lib.answerUnusual(lib.groupByDay(history, TZ), '2026-11-12', { hour: 13, minute: 30 });
  assert.equal(halfHour.normalSoFar, 12.5);
});

test('Q4 reports night-time flow between 2 and 5 AM', () => {
  const rows = [
    hourRow('2026-11-10', 3, 0, { readings: 360, flow_readings: 0 }),                       // dry night
    hourRow('2026-11-11', 2, 0.8, { readings: 360, flow_readings: 72 }),                    // 12 minutes
    hourRow('2026-11-11', 12, 50, { readings: 360, flow_readings: 300 }),                   // daytime, ignored
    hourRow('2026-11-12', 4, 0.2, { readings: 360, flow_readings: 6 })                      // 1 minute
  ];
  const night = lib.answerNight(lib.groupByDay(rows, TZ), '2026-11-12', { hour: 12, minute: 0 });
  const byDay = Object.fromEntries(night.nights.map((entry) => [entry.dateKey, entry]));
  assert.equal(night.nights.length, 7);
  assert.equal(byDay['2026-11-10'].state, 'dry');
  assert.equal(byDay['2026-11-11'].state, 'critical');
  assert.equal(byDay['2026-11-11'].minutes, 12);
  assert.equal(byDay['2026-11-12'].state, 'flow');
  assert.equal(byDay['2026-11-09'].state, 'no-data');
  assert.equal(night.lastNight.dateKey, '2026-11-12');
  assert.equal(night.nightsWithData, 3);
  assert.equal(night.nightsWithFlow, 2);

  const beforeTwo = lib.answerNight({}, '2026-11-12', { hour: 1, minute: 0 });
  assert.equal(beforeTwo.lastNight.dateKey, '2026-11-11', 'tonight has not started yet');
  assert.equal(lib.answerNight({}, '2026-11-12', { hour: 3, minute: 0 }).lastNight.inProgress, true);
});

test('Q5 turns litres into rupees at the chosen tariff', () => {
  const days = lib.groupByDay([
    hourRow('2026-11-10', 8, 200, { lost_liters: 10 }),
    hourRow('2026-11-11', 8, 100, { lost_liters: 0 }),
    hourRow('2026-11-12', 8, 50, { lost_liters: 5 })
  ], TZ);
  const cost = lib.answerCost(lib.answerLoss(days, '2026-11-12'), 20);
  assert.equal(cost.perLiter, 0.02);
  assert.equal(cost.todayCost, 1);
  assert.equal(cost.todayLeakCost, 0.1);
  assert.equal(cost.dailyUsed, 150);
  assert.equal(lib.round(cost.monthCost, 2), 90);
  assert.equal(lib.round(cost.monthLeakCost, 2), 3);
  assert.equal(cost.basisDays, 2);
});

// ---------------------------------------------------------------------------
// Export and connection settings
// ---------------------------------------------------------------------------
test('CSV export neutralises spreadsheet formulas and quotes special characters', () => {
  assert.equal(lib.csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  assert.equal(lib.csvCell('+cmd'), "'+cmd");
  assert.equal(lib.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(lib.csvCell(-5.2), '-5.2');
  assert.equal(lib.csvCell('a,b'), '"a,b"');
  assert.equal(lib.csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(lib.csvCell(null), '');
  assert.equal(lib.toCsv([{ a: 1, b: 'x' }, { a: 2, b: '-y' }], ['a', 'b']), "a,b\r\n1,x\r\n2,'-y");
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

// ---------------------------------------------------------------------------
// MQTT, signed commands and performance
// ---------------------------------------------------------------------------
test('MQTT telemetry becomes a reading stamped with its arrival time', () => {
  const reading = lib.telemetryToReading({
    seq: 41, ts: 1, f1: 4.27, f2: 3.98, loss: 6.8, lvl: 63.5, valve: 1, auto: 1, leak: 'Warning',
    anom: 'Learning', night: 'Normal', total: 12.346, hum: 58.2, temp: 27.1, rssi: -61, up: 3600,
    heap: 182000, upms: 240, hfail: 0
  }, NOW);
  assert.equal(reading.id, 'mqtt:41');
  assert.equal(reading.timestamp, new Date(NOW).toISOString());
  assert.equal(reading.flow_rate_1, 4.27);
  assert.equal(reading.leak_status, 'Warning');
  assert.equal(reading.valve_state, 1);
  assert.equal(reading.humidity, 58.2);
  assert.equal(reading.wifi_rssi, -61);

  const odd = lib.telemetryToReading({ seq: 2, f1: 1, f2: 1, leak: '<b>x</b>', hum: 'wet', anom: 'x'.repeat(500) }, NOW);
  assert.equal(odd.leak_status, 'Normal');
  assert.equal(odd.humidity, null);
  assert.equal(odd.anomaly_status.length, 40);
  assert.equal(lib.telemetryToReading({ f1: 'a', f2: 1 }, NOW), null);
  assert.equal(lib.telemetryToReading(null, NOW), null);
});

test('sequence numbers count lost MQTT messages and device restarts', () => {
  let stats = null;
  [1, 2, 3, 6, 6, 7, 1, 2].forEach((seq) => {
    stats = lib.nextSequenceStats(stats, seq);
  });
  assert.deepEqual(stats, { lastSeq: 2, received: 7, missed: 2, restarts: 1 });
  assert.equal(lib.round(lib.deliveryPercent(stats.received, stats.missed), 1), 77.8);
  assert.equal(lib.deliveryPercent(0, 0), null);
  assert.equal(lib.median([300, 100, 200]), 200);
  assert.equal(lib.median([4, 1, 3, 2]), 2.5);
  assert.equal(lib.median([]), null);
});

test('HMAC-SHA256 matches the RFC 4231 test vector', async () => {
  assert.equal(
    await lib.hmacHex('Jefe', 'what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
  );
});

test('signed valve commands use the exact text the ESP32 checks', async () => {
  const { createHmac } = await import('node:crypto');
  const key = 'a-test-key-of-sixteen+';
  const command = await lib.signedCommand(key, 'flowstate/team10-test', 'close', 1762930000123, 'n0nce1234');
  const expected = createHmac('sha256', key).update('flowstate/team10-test|close|1762930000123|n0nce1234').digest('hex');
  assert.deepEqual(command, { action: 'close', ts: 1762930000123, nonce: 'n0nce1234', sig: expected });
  assert.equal(
    await lib.keyFingerprint(key),
    createHmac('sha256', key).update('flowstate-key-check').digest('hex').slice(0, 8)
  );
});

test('an alert seen over MQTT and again from the database is listed once', () => {
  const live = { id: 'mqtt:1', source: 'mqtt', timestamp: new Date(NOW).toISOString(), alert_type: 'CRITICAL_LEAK', message: 'Loss 22%' };
  const stored = { id: 7, timestamp: new Date(NOW - 20000).toISOString(), alert_type: 'CRITICAL_LEAK', message: 'Loss 22%' };
  const other = { id: 'mqtt:2', source: 'mqtt', timestamp: new Date(NOW).toISOString(), alert_type: 'VALVE_CLOSED', message: 'x' };
  assert.deepEqual(lib.mergeAlerts([live, other], [stored]).map((alert) => alert.id), ['mqtt:2', 7]);
  assert.deepEqual(lib.mergeAlerts([live]).map((alert) => alert.id), ['mqtt:1']);
});

test('storage delivery, signal quality and durations read plainly', () => {
  const readings = Array.from({ length: 85 }, (_, index) => ({ timestamp: new Date(NOW - index * 10000).toISOString() }));
  assert.deepEqual(lib.storageDelivery(readings, NOW, 900000, 10000), { received: 85, expected: 90, percent: 85 / 90 * 100 });
  assert.equal(lib.signalQuality(-50), 'excellent');
  assert.equal(lib.signalQuality(-70), 'fair');
  assert.equal(lib.signalQuality(-80), 'weak');
  assert.equal(lib.signalQuality(null), '');
  assert.equal(lib.formatDuration(59), '59 s');
  assert.equal(lib.formatDuration(3720), '1 h 2 min');
  assert.equal(lib.formatDuration(90000), '1 d 1 h');
});
