// End-to-end tests: the real dashboard in headless Chromium, served with the
// production Content-Security-Policy, talking to a simulated Supabase and a
// simulated MQTT broker that behaves like the FlowState ESP32.
//
// Run: npm install && npx playwright install chromium && npm run test:e2e
// To use an installed Chrome instead of downloading Chromium: PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const mqttPacket = require('mqtt-packet');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const dashboardRoot = join(repoRoot, 'Web_Dashboard');
const SUPABASE_URL = 'https://flowstate-e2e.supabase.test';
const MQTT_URL = 'wss://broker.flowstate.test/mqtt';
const ROOT = 'flowstate/e2e-test';
const VALVE_KEY = 'e2e-valve-key-0123456789abcdef';
const CDN_FILES = {
  'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js':
    join(repoRoot, 'node_modules', 'chart.js', 'dist', 'chart.min.js'),
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js':
    join(repoRoot, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'),
  'https://cdn.jsdelivr.net/npm/mqtt@5.15.2/dist/mqtt.min.js':
    join(repoRoot, 'node_modules', 'mqtt', 'dist', 'mqtt.min.js')
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': '*'
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

let browser;
let server;
let baseUrl;
let deployment;

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// Generates env.js and the CSP exactly as the Netlify build does.
function buildDeploymentFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'flowstate-e2e-'));
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'netlify-build.mjs')], {
    cwd: dashboardRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NETLIFY: '',
      OUTPUT_DIR: dir,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: fakeJwt({ role: 'anon' }),
      MQTT_URL,
      MQTT_TOPIC_ROOT: ROOT
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const headers = readFileSync(join(dir, '_headers'), 'utf8');
  return {
    dir,
    csp: headers.match(/Content-Security-Policy: (.+)/)[1].trim(),
    envJs: readFileSync(join(dir, 'assets', 'env.js'), 'utf8')
  };
}

function startServer() {
  const httpServer = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': type, 'content-security-policy': deployment.csp });
      response.end(body);
    };
    if (path === '/assets/env.js') return send(200, MIME['.js'], deployment.envJs);
    const file = normalize(join(dashboardRoot, path === '/' ? 'index.html' : path));
    if (!file.startsWith(dashboardRoot + sep)) return send(403, 'text/plain', 'forbidden');
    try {
      return send(200, MIME[extname(file)] || 'application/octet-stream', readFileSync(file));
    } catch (_) {
      return send(404, 'text/plain', 'not found');
    }
  });
  return new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(httpServer)));
}

// ---------------------------------------------------------------------------
// Simulated Supabase
// ---------------------------------------------------------------------------
function makeReading(overrides = {}) {
  return {
    id: 1,
    timestamp: isoAgo(3000),
    flow_rate_1: 2.4,
    flow_rate_2: 2.3,
    percentage_loss: 3.2,
    water_level: 45,
    valve_state: 1,
    leak_status: 'Normal',
    anomaly_status: 'Learning',
    system_online: 1,
    daily_total_liters: 10,
    humidity: 52.5,
    temperature: 27.4,
    wifi_rssi: -61,
    uptime_s: 3720,
    free_heap: 180224,
    upload_ms: 240,
    http_failures: 1,
    mqtt_connected: 1,
    ...overrides
  };
}

/** Seven days of hourly rows in India time, with a small leak and one night of flow. */
function summaryRows() {
  const rows = [];
  const hourMs = 3600000;
  const now = Date.now();
  // India hours start at :30 UTC.
  const firstHour = Math.floor((now - 6 * 86400000 - 1800000) / hourMs) * hourMs + 1800000;
  for (let start = firstHour; start <= now; start += hourMs) {
    const hour = new Date(start + 19800000).getUTCHours();
    const used = [7, 8, 19, 20].includes(hour) ? 20 : hour >= 6 && hour <= 22 ? 4 : 0;
    rows.push({
      hour_start: new Date(start).toISOString(),
      readings: 360,
      used_liters: used,
      lost_liters: used * 0.08,
      flow_readings: hour === 3 ? 30 : Math.round(used * 4),
      max_loss_percent: 8,
      avg_flow_1: used / 60,
      avg_flow_2: (used / 60) * 0.92,
      avg_level_cm: 60,
      avg_humidity: 55,
      avg_temperature: 27,
      avg_rssi: -60,
      avg_upload_ms: 250,
      mqtt_share: 1
    });
  }
  return rows;
}

function makeBackend() {
  const latest = makeReading();
  return {
    latest,
    recent: Array.from({ length: 20 }, (_, index) => makeReading({ id: 100 + index, timestamp: isoAgo(index * 10000 + 5000) })),
    exportRows: [
      { id: 1, timestamp: isoAgo(60000), flow_rate_1: 1, anomaly_status: '=HYPERLINK("http://evil.example")' },
      { id: 2, timestamp: isoAgo(30000), flow_rate_1: 2, anomaly_status: 'Normal' }
    ],
    alerts: [
      {
        id: 11,
        timestamp: isoAgo(60000),
        alert_type: 'CRITICAL_LEAK',
        message: 'Flow difference detected. Sensor 1: 4.270 L, Sensor 2: 3.300 L, estimated loss: 22.7%.',
        severity: 'high'
      },
      {
        id: 12,
        timestamp: isoAgo(120000),
        alert_type: '<img src=x onerror="window.__xss=1">',
        message: '<script>window.__xss=2</script><b>bold?</b>',
        severity: 'medium'
      },
      { id: 13, timestamp: isoAgo(180000), alert_type: 'VALVE_OPENED', message: 'Valve opened manually/by command.', severity: 'medium' }
    ],
    summary: summaryRows()
  };
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
}

function handleSupabase(route, backend) {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const url = new URL(request.url());
  switch (url.pathname) {
    case '/rest/v1/water_readings':
      if (url.searchParams.get('limit') === '1') return json(route, backend.latest ? [backend.latest] : []);
      if (url.searchParams.get('order') === 'timestamp.asc') return json(route, backend.exportRows);
      return json(route, backend.recent);
    case '/rest/v1/alerts':
      return json(route, backend.alerts);
    case '/rest/v1/rpc/get_hourly_summary':
      return json(route, backend.summary);
    default:
      return json(route, { message: 'not found' }, 404);
  }
}

// ---------------------------------------------------------------------------
// Simulated MQTT broker + ESP32
// ---------------------------------------------------------------------------
function makeDevice() {
  return {
    subscribed: false,
    commands: [],
    send: null,
    publish(topic, payload, retain = false) {
      this.send({ cmd: 'publish', topic, payload: Buffer.from(JSON.stringify(payload)), qos: 0, retain });
    },
    telemetry(seq, overrides = {}) {
      this.publish(`${ROOT}/telemetry`, {
        seq, ts: Math.floor(Date.now() / 1000), f1: 4.27, f2: 3.98, loss: 6.8, lvl: 63.5, valve: 1, auto: 1,
        leak: 'Warning', anom: 'Learning', night: 'Normal', total: 12.346, hum: 58.2, temp: 27.1,
        rssi: -58, up: 7300, heap: 176000, upms: 210, hfail: 0, ...overrides
      });
    },
    onPublish(topic, message) {
      if (topic === `${ROOT}/ping`) {
        this.publish(`${ROOT}/pong`, { id: message.id, up: 7300 });
      } else if (topic === `${ROOT}/cmd`) {
        this.commands.push(message);
        const expected = createHmac('sha256', VALVE_KEY)
          .update(`${ROOT}|${message.action}|${message.ts}|${message.nonce}`).digest('hex');
        const ok = expected === message.sig;
        this.publish(`${ROOT}/ack`, {
          nonce: message.nonce, action: message.action, ok,
          msg: ok ? 'Valve closed.' : 'wrong valve key', valve: ok && message.action === 'close' ? 0 : 1, auto: 0
        });
        if (ok) this.telemetry(99, { valve: message.action === 'close' ? 0 : 1, auto: 0 });
      }
    }
  };
}

function connectBroker(socket, device) {
  const parser = mqttPacket.parser({ protocolVersion: 4 });
  device.send = (packet) => socket.send(mqttPacket.generate(packet));
  parser.on('packet', (packet) => {
    if (packet.cmd === 'connect') {
      device.send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
    } else if (packet.cmd === 'subscribe') {
      device.send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
      device.subscribed = true;
      if (device.status) device.publish(`${ROOT}/status`, device.status, true);
    } else if (packet.cmd === 'pingreq') {
      device.send({ cmd: 'pingresp' });
    } else if (packet.cmd === 'publish') {
      if (packet.qos === 1) device.send({ cmd: 'puback', messageId: packet.messageId });
      device.onPublish(packet.topic, JSON.parse(packet.payload.toString()));
    }
  });
  socket.onMessage((message) => parser.parse(typeof message === 'string' ? Buffer.from(message) : message));
}

async function waitUntil(check, timeoutMs = 10000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * @param {object} backend simulated Supabase state
 * @param {{envJs?: string, device?: object, mqttDown?: boolean, path?: string, viewport?: object}} [options]
 */
async function openDashboard(backend, options = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: options.viewport || { width: 1366, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  if (options.envJs) {
    await page.route(`${baseUrl}assets/env.js`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: options.envJs }));
  }
  await page.route('https://cdn.jsdelivr.net/**', (route) => {
    const file = CDN_FILES[route.request().url()];
    if (!file) return route.abort();
    return route.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: readFileSync(file) });
  });
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route(`${SUPABASE_URL}/**`, (route) => handleSupabase(route, backend));
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (socket) => socket.close());
  const device = options.device || makeDevice();
  await page.routeWebSocket(MQTT_URL, (socket) => {
    if (options.mqttDown) socket.close();
    else connectBroker(socket, device);
  });
  await page.goto(`${baseUrl}${options.path || ''}`);
  return { context, page, problems, device };
}

function textIs(selector, expected) {
  return [(args) => document.querySelector(args.selector)?.textContent.trim() === args.expected, { selector, expected }];
}

function textMatches(selector, source) {
  return [(args) => new RegExp(args.source).test(document.querySelector(args.selector)?.textContent || ''), { selector, source }];
}

before(async () => {
  deployment = buildDeploymentFiles();
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (deployment) rmSync(deployment.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test('the security policy allows only the project database and the MQTT broker', () => {
  assert.match(deployment.csp, /connect-src 'self' https:\/\/flowstate-e2e\.supabase\.test wss:\/\/flowstate-e2e\.supabase\.test wss:\/\/broker\.flowstate\.test;/);
  assert.match(deployment.csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net;/);
  assert.doesNotMatch(deployment.csp, /unsafe-inline|unsafe-eval/);
  assert.match(deployment.envJs, /"MQTT_TOPIC_ROOT": "flowstate\/e2e-test"/);
});

test('live readings arrive over MQTT every 2 s and the pipeline updates', async () => {
  const { context, page, problems, device } = await openDashboard(makeBackend());
  try {
    await waitUntil(() => device.subscribed);
    device.status = null;
    device.publish(`${ROOT}/status`, { state: 'online', fw: '2.0.0', rssi: -58 }, true);
    device.telemetry(1);
    device.telemetry(2);
    device.telemetry(5); // seq 3 and 4 lost on the way
    await page.waitForFunction(...textIs('#flow1', '4.27'));
    assert.equal(await page.textContent('#flow2'), '3.98');
    assert.equal(await page.textContent('#flowGap'), '0.29');
    assert.equal(await page.textContent('#lossPercentage'), '6.8');
    assert.equal(await page.getAttribute('#leakTile', 'data-status'), 'warning');
    assert.match(await page.textContent('#systemStatus'), /Live/);
    assert.match(await page.textContent('#stageIngest'), /MQTT live every 2 s/);
    assert.match(await page.textContent('#humidityValue'), /58\.2% RH/);

    await page.waitForFunction(...textIs('#perfMqtt', 'Connected'));
    assert.match(await page.textContent('#perfMqttDetail'), /ESP32 online · firmware v2\.0\.0/);
    await page.waitForFunction(...textMatches('#perfRtt', '^\\d+ ms$'));
    await page.waitForFunction(...textIs('#perfDelivery', '60.0%'));
    assert.match(await page.textContent('#perfDeliveryDetail'), /3 received, 2 missed/);
    assert.match(await page.textContent('#perfSignal'), /-58 dBm|−58 dBm/);
    assert.match(await page.textContent('#cmpMqttSize'), /^\d+ B of JSON$/);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('stored readings answer the five questions and feed the performance panel', async () => {
  const { context, page, problems } = await openDashboard(makeBackend(), { mqttDown: true });
  try {
    await page.waitForFunction(...textMatches('#q1Answer', 'lost in 7 days'));
    assert.match(await page.textContent('#q1Detail'), /8\.0% of the .* that left the tank never reached the tap/);
    assert.match(await page.textContent('#q2Answer'), /^Most between (7–8 AM|8–9 AM|7–8 PM|8–9 PM)$/);
    assert.match(await page.textContent('#q3Answer'), /close to normal|more than normal|less than normal/);
    assert.match(await page.textContent('#q4Answer'), /^Yes: about 5 min of flow (last night|tonight so far)$/);
    assert.equal(await page.locator('#nightStrip .night').count(), 7);
    assert.match(await page.textContent('#q5Answer'), /^About ₹[\d.,]+ a month$/);
    assert.match(await page.textContent('#stageStore'), /readings in the last 24 h/);

    // The performance panel refreshes once a second.
    await page.waitForFunction(...textIs('#perfUpload', '240 ms'));
    assert.match(await page.textContent('#perfStorage'), /^\d+%$/);
    assert.match(await page.textContent('#perfStorageDetail'), /of 90 expected readings in the last 15 min/);
    assert.match(await page.textContent('#perfUploadDetail'), /1 failed since boot/);
    assert.match(await page.textContent('#cmpHttpsSize'), /≈ \d+ B of JSON \+ ≈ \d+ B of HTTP headers/);
    await page.waitForFunction(() => document.querySelector('[data-chart-empty="reliability"]').hidden);

    // The charts must actually be painted, not just hold data (Chart.js can skip drawing).
    await page.waitForFunction(() => window.Chart.getChart('lossChart').data.datasets[0].data.length === 7);
    const paintedShare = await page.evaluate(() => {
      const chart = window.Chart.getChart('lossChart');
      const ratio = chart.currentDevicePixelRatio;
      const { left, top, width, height } = chart.chartArea;
      const pixels = chart.ctx.getImageData(left * ratio, top * ratio, width * ratio, height * ratio).data;
      let painted = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) painted += 1;
      return painted / (pixels.length / 4);
    });
    assert.ok(paintedShare > 0.15, `loss chart looks blank (${(paintedShare * 100).toFixed(1)}% painted)`);
    assert.deepEqual(problems.filter((problem) => !/WebSocket|broker\.flowstate\.test/.test(problem)), []);
  } finally {
    await context.close();
  }
});

test('alert text from the database or MQTT is shown as text, never run as code', async () => {
  const { context, page, problems, device } = await openDashboard(makeBackend());
  try {
    await page.waitForFunction(() => document.querySelectorAll('#alertsContainer .alert-item:not(.empty)').length === 3);
    await waitUntil(() => device.subscribed);
    device.publish(`${ROOT}/alert`, { alert_type: 'NIGHTTIME_FLOW_START', message: '<img src=x onerror="window.__xss=3">', severity: 'medium' });
    device.publish(`${ROOT}/alert`, { alert_type: '<b>bad</b>', message: 'dropped: the type is not valid', severity: 'high' });
    await page.waitForFunction(() => document.querySelectorAll('#alertsContainer .alert-item:not(.empty)').length === 4);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#alertsContainer img, #alertsContainer script, #alertsContainer b').count(), 0);
    const text = await page.textContent('#alertsContainer');
    assert.ok(text.includes('<script>window.__xss=2</script>'));
    assert.ok(text.includes('Night-time flow started'));
    assert.ok(!text.includes('dropped: the type is not valid'));
    assert.equal(await page.textContent('#countCritical'), '1');
    assert.equal(await page.textContent('#countInfo'), '1');

    await page.click('.alert-tab[data-group="critical"]');
    const visible = await page.locator('#alertsContainer .alert-item').allTextContents();
    assert.equal(visible.length, 1);
    assert.match(visible[0], /Critical leak/);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('valve commands are signed in the browser and confirmed by the ESP32 over MQTT', async () => {
  const { context, page, problems, device } = await openDashboard(makeBackend());
  try {
    await waitUntil(() => device.subscribed);
    device.telemetry(1);
    await page.waitForFunction(...textMatches('#valveCommandStatus', 'Enter the valve key'));
    assert.equal(await page.isDisabled('#valveCloseBtn'), true);

    // A wrong key: the ESP32 refuses the signature.
    await page.fill('#valveKeyInput', 'not-the-right-key-123');
    await page.waitForFunction(...textMatches('#valveKeyCheck', 'Key check: [0-9a-f]{8}'));
    await page.click('#valveCloseBtn');
    await page.waitForFunction(...textMatches('#valveCommandStatus', 'refused it: wrong valve key'));

    // The right key: the command is accepted and the next telemetry shows the valve closed.
    await page.fill('#valveKeyInput', VALVE_KEY);
    const fingerprint = createHmac('sha256', VALVE_KEY).update('flowstate-key-check').digest('hex').slice(0, 8);
    await page.waitForFunction(...textMatches('#valveKeyCheck', `Key check: ${fingerprint}`));
    await page.click('#valveCloseBtn');
    await page.waitForFunction(...textMatches('#valveCommandStatus', 'Valve closed'));
    await page.waitForFunction(...textIs('#valveState', 'Closed'));
    assert.match(await page.textContent('#valveMode'), /paused/);

    assert.equal(device.commands.length, 2);
    const accepted = device.commands[1];
    assert.equal(accepted.action, 'close');
    assert.match(accepted.nonce, /^[0-9a-f]{16}$/);
    assert.ok(Math.abs(accepted.ts - Date.now()) < 60000);
    assert.equal(JSON.stringify(device.commands).includes(VALVE_KEY), false, 'the key itself is never sent');
    assert.equal(await page.evaluate(() => localStorage.getItem('flowstate.valveKey')), null, 'the key is not kept after the tab closes');
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('warns clearly when the device stops sending data', async () => {
  const backend = makeBackend();
  backend.latest = makeReading({ timestamp: isoAgo(10 * 60000) });
  backend.recent = [];
  const { context, page, problems } = await openDashboard(backend, { mqttDown: true });
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'ESP32 offline'));
    assert.equal(await page.isVisible('#statusBanner'), true);
    assert.match(await page.textContent('#statusBanner'), /No reading from the ESP32 for 10 min/);
    assert.equal(await page.evaluate(() => document.body.classList.contains('readings-stale')), true);
    assert.equal(await page.textContent('#perfStorage'), '0%');
    assert.deepEqual(problems.filter((problem) => !/WebSocket|broker\.flowstate\.test/.test(problem)), []);
  } finally {
    await context.close();
  }
});

test('ignores readings dated in the future', async () => {
  const backend = makeBackend();
  backend.latest = makeReading({ timestamp: '2099-01-01T00:00:00Z', water_level: 99 });
  backend.recent = [];
  const { context, page, problems } = await openDashboard(backend, { mqttDown: true });
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'Waiting for the ESP32'));
    assert.equal(await page.textContent('#tankLevel'), '--');
    assert.deepEqual(problems.filter((problem) => !/WebSocket|broker\.flowstate\.test/.test(problem)), []);
  } finally {
    await context.close();
  }
});

test('a deployed site cannot be pointed at another database', async () => {
  const { context, page, problems } = await openDashboard(makeBackend());
  try {
    await page.click('#settingsPanel > summary');
    assert.equal(await page.evaluate(() => document.getElementById('supabaseUrl').readOnly), true);
    assert.equal(await page.evaluate(() => document.getElementById('supabaseKey').readOnly), true);
    assert.equal(await page.isHidden('#resetSettingsBtn'), true);
    assert.match(await page.textContent('#connectionSource'), /deployed with/);
    assert.match(await page.textContent('#mqttSettingsNote'), /flowstate\/e2e-test/);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('local settings refuse a secret service key', async () => {
  const { context, page, problems } = await openDashboard(makeBackend(), {
    envJs: `window.__ENV__ = { MQTT_URL: '${MQTT_URL}', MQTT_TOPIC_ROOT: '${ROOT}' };`
  });
  try {
    await page.click('#settingsPanel > summary');
    await page.fill('#supabaseUrl', 'https://my-own-project.supabase.co');
    await page.fill('#supabaseKey', fakeJwt({ role: 'service_role' }));
    await page.click('#saveSettingsBtn');
    await page.waitForFunction(...textMatches('#toastHost', 'secret'));
    assert.equal(await page.evaluate(() => localStorage.getItem('flowstate.supabaseKey')), null);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const { context, page, problems } = await openDashboard(makeBackend(), { mqttDown: true });
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'Live'));
    await page.selectOption('#exportRange', '1h');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsvBtn')]);
    const csv = readFileSync(await download.path(), 'utf8');
    assert.match(csv.split('\r\n')[0], /^id,timestamp,flow_rate_1,.*,wifi_rssi,uptime_s,free_heap,upload_ms,http_failures,mqtt_connected$/);
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"")"`));
    assert.match(download.suggestedFilename(), /^flowstate_team10_1h_\d{4}-\d{2}-\d{2}\.csv$/);
    assert.deepEqual(problems.filter((problem) => !/WebSocket|broker\.flowstate\.test/.test(problem)), []);
  } finally {
    await context.close();
  }
});

test('sample data is clearly labelled and never shown as a measurement', async () => {
  const { context, page, problems } = await openDashboard(makeBackend(), { path: '?sample' });
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'Sample data'));
    assert.equal(await page.isVisible('#sampleBanner'), true);
    await page.waitForFunction(() => document.getElementById('flow1').textContent !== '--');
    assert.equal(await page.textContent('#perfRtt'), '--');
    assert.match(await page.textContent('#perfRttDetail'), /Not measured with sample data/);
    assert.equal(await page.isDisabled('#valveOpenBtn'), true);
    await page.click('#sampleStopBtn');
    await page.waitForFunction(() => document.getElementById('sampleBanner').hidden);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('fits a phone screen without sideways scrolling', async () => {
  const { context, page, problems } = await openDashboard(makeBackend(), { path: '?sample', viewport: { width: 360, height: 780 } });
  try {
    await page.waitForFunction(() => document.getElementById('flow1').textContent !== '--');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
