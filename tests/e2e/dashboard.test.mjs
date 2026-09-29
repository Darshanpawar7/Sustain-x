// End-to-end tests: the real dashboard in headless Chromium, served with the
// production Content-Security-Policy, talking to a simulated Supabase.
//
// Run: npm install && npx playwright install chromium && npm run test:e2e
// To use an installed Chrome instead of downloading Chromium: PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const dashboardRoot = join(repoRoot, 'Web_Dashboard');
const SUPABASE_URL = 'https://flowstate-e2e.supabase.test';
const OPERATOR_KEY = 'b'.repeat(48);
const CDN_FILES = {
  'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js':
    join(repoRoot, 'node_modules', 'chart.js', 'dist', 'chart.min.js'),
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js':
    join(repoRoot, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js')
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
    env: { ...process.env, NETLIFY: '', OUTPUT_DIR: dir, SUPABASE_URL, SUPABASE_ANON_KEY: fakeJwt({ role: 'anon' }) }
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

function makeReading(overrides = {}) {
  return {
    id: 1,
    timestamp: isoAgo(2000),
    flow_rate_1: 2.4,
    flow_rate_2: 2.3,
    percentage_loss: 3.2,
    water_level: 45,
    humidity: 52.5,
    valve_state: 1,
    leak_status: 'Normal',
    anomaly_status: 'Learning',
    system_online: 1,
    daily_total_liters: 10,
    volume_1_ml: 200,
    volume_2_ml: 195,
    ...overrides
  };
}

function makeBackend() {
  return {
    latest: makeReading(),
    exportRows: [
      { id: 1, timestamp: isoAgo(60000), flow_rate_1: 1, anomaly_status: '=HYPERLINK("http://evil.example")' },
      { id: 2, timestamp: isoAgo(30000), flow_rate_1: 2, anomaly_status: 'Normal' }
    ],
    alerts: [
      {
        id: 11,
        timestamp: isoAgo(60000),
        alert_type: 'IMMEDIATE_CRITICAL_LEAK',
        message: '22.0% of the water leaving the tank is not reaching the tap. Valve closed automatically.',
        severity: 'critical'
      },
      {
        id: 12,
        timestamp: isoAgo(120000),
        alert_type: '<img src=x onerror="window.__xss=1">',
        message: '<script>window.__xss=2</script><b>bold?</b>',
        severity: 'medium'
      },
      { id: 13, timestamp: isoAgo(180000), alert_type: 'VALVE_OPENED', message: 'Valve opened from the dashboard.', severity: 'low' }
    ],
    usage: {
      total_1_liters: 123.4,
      total_2_liters: 120.1,
      loss_liters: 3.3,
      samples: 400,
      first_reading_at: isoAgo(3600000),
      last_reading_at: isoAgo(2000)
    },
    command: null
  };
}

function historyRows(range) {
  const spans = { '15m': [900, 15], '1h': [3600, 60], '6h': [21600, 300], '24h': [86400, 1200] };
  const [spanSeconds, bucketSeconds] = spans[range] || [0, 1];
  const rows = [];
  for (let offset = spanSeconds; offset > 0; offset -= bucketSeconds) {
    rows.push({
      bucket_start: isoAgo(offset * 1000),
      avg_flow_rate_1: 2,
      avg_flow_rate_2: 1.9,
      avg_percentage_loss: 5,
      max_percentage_loss: 7,
      avg_water_level: 45,
      avg_humidity: 50,
      volume_1_liters: 0.5,
      volume_2_liters: 0.45,
      samples: Math.max(1, bucketSeconds / 5)
    });
  }
  return rows;
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
}

function handleSupabase(route, backend) {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const url = new URL(request.url());
  const body = request.postData() ? JSON.parse(request.postData()) : {};

  switch (url.pathname) {
    case '/rest/v1/water_readings':
      if (url.searchParams.get('select') === '*') return json(route, backend.latest ? [backend.latest] : []);
      return json(route, backend.exportRows);
    case '/rest/v1/alerts':
      return json(route, backend.alerts);
    case '/rest/v1/rpc/get_reading_history':
      return json(route, historyRows(body.p_range));
    case '/rest/v1/rpc/get_usage_summary':
      return json(route, [backend.usage]);
    case '/rest/v1/rpc/request_valve_command':
      if (body.p_operator_key !== OPERATOR_KEY) {
        return json(route, { code: '28000', message: 'Invalid or revoked operator key', details: null, hint: null }, 403);
      }
      backend.command = { id: 7, action: body.p_action, status: 'pending', requested_at: new Date().toISOString(), delivered_at: null };
      return json(route, { ok: true, command_id: 7, action: body.p_action, status: 'pending' });
    case '/rest/v1/valve_commands':
      return json(route, backend.command ? [backend.command] : []);
    default:
      return json(route, { message: 'not found' }, 404);
  }
}

/**
 * @param {object} backend simulated Supabase state
 * @param {{envJs?: string}} [options] envJs replaces the deployment's env.js (for example, local use)
 */
async function openDashboard(backend, options = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
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
  await page.goto(baseUrl);
  return { context, page, problems };
}

function textIs(selector, expected) {
  return [(args) => document.querySelector(args.selector)?.textContent === args.expected, { selector, expected }];
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

test('shows live readings under the production security policy', async () => {
  const { context, page, problems } = await openDashboard(makeBackend());
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'Device live'));
    assert.equal(await page.textContent('#tankLevel'), '45.0 cm');
    assert.equal(await page.textContent('#tankLabel'), '45%');
    assert.equal(await page.textContent('#flow1'), '2.40 L/min');
    assert.equal(await page.textContent('#valveState'), 'OPEN');
    assert.equal(await page.textContent('#humidityValue'), '52.5%');
    await page.waitForFunction(...textIs('#dailyTotal', '123.40 L'));
    assert.equal(await page.textContent('#estimatedLoss'), '3.30 L');
    assert.equal(await page.isHidden('#staleBanner'), true);
    await page.waitForFunction(() => document.querySelector('[data-chart-empty="hourly"]').hidden);
    assert.match(await page.textContent('[data-chart-title="hourly"]'), /\(24h\)/);

    // The charts must actually be painted, not just hold data (Chart.js can skip drawing).
    await page.waitForFunction(() => window.Chart.getChart('flowChart').data.datasets[0].data.length > 0);
    const paintedShare = await page.evaluate(() => {
      const chart = window.Chart.getChart('flowChart');
      const ratio = chart.currentDevicePixelRatio;
      const { left, top, width, height } = chart.chartArea;
      const pixels = chart.ctx.getImageData(left * ratio, top * ratio, width * ratio, height * ratio).data;
      let painted = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) painted += 1;
      return painted / (pixels.length / 4);
    });
    assert.ok(paintedShare > 0.25, `flow chart looks blank (${(paintedShare * 100).toFixed(1)}% painted)`);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('alert text from the database is shown as text, never run as code', async () => {
  const { context, page, problems } = await openDashboard(makeBackend());
  try {
    await page.waitForFunction(() => document.querySelectorAll('#alertsContainer .alert-item:not(.empty)').length === 3);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#alertsContainer img, #alertsContainer script, #alertsContainer b').count(), 0);
    assert.ok((await page.textContent('#alertsContainer')).includes('<script>window.__xss=2</script>'));
    assert.equal(await page.textContent('#countCritical'), '1');
    assert.equal(await page.textContent('#countWarning'), '1');
    assert.equal(await page.textContent('#countInfo'), '1');

    await page.click('.alerts-tab[data-severity="critical"]');
    const visible = await page.locator('#alertsContainer .alert-item').allTextContents();
    assert.equal(visible.length, 1);
    assert.match(visible[0], /Immediate critical leak/);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('warns clearly when the device stops sending data', async () => {
  const backend = makeBackend();
  backend.latest = makeReading({ timestamp: isoAgo(10 * 60000) });
  const { context, page, problems } = await openDashboard(backend);
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'Device offline'));
    assert.equal(await page.isVisible('#staleBanner'), true);
    assert.match(await page.textContent('#staleBanner'), /No data from the device for 10 min/);
    assert.equal(await page.evaluate(() => document.body.classList.contains('readings-stale')), true);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('ignores readings dated in the future', async () => {
  const backend = makeBackend();
  backend.latest = makeReading({ timestamp: '2099-01-01T00:00:00Z', water_level: 99 });
  const { context, page, problems } = await openDashboard(backend);
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'No readings yet'));
    assert.equal(await page.textContent('#tankLevel'), '-- cm');
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('valve buttons send a real command and wait for the device to confirm', async () => {
  const backend = makeBackend();
  const { context, page, problems } = await openDashboard(backend);
  try {
    await page.waitForFunction(...textIs('#valveState', 'OPEN'));

    // Without a key the dashboard asks for one.
    await page.click('#valveCloseBtn');
    await page.waitForFunction(...textMatches('#valveCommandStatus', 'valve control key'));
    assert.equal(await page.evaluate(() => document.getElementById('settingsPanel').open), true);

    // A wrong key is rejected by the database.
    await page.fill('#operatorKey', 'c'.repeat(48));
    await page.click('#saveSettingsBtn');
    await page.click('#valveCloseBtn');
    await page.waitForFunction(...textMatches('#valveCommandStatus', 'not accepted'));
    assert.equal(backend.command, null);

    // The right key queues a command; the display waits for the device.
    await page.fill('#operatorKey', OPERATOR_KEY);
    await page.click('#saveSettingsBtn');
    await page.click('#valveCloseBtn');
    await page.waitForFunction(...textMatches('#valveCommandStatus', 'Waiting for the device'));
    assert.equal(backend.command.action, 'close');
    assert.equal(await page.textContent('#valveState'), 'OPEN');

    const deliveredAt = new Date().toISOString();
    backend.command = { ...backend.command, status: 'delivered', delivered_at: deliveredAt };
    await page.waitForFunction(...textMatches('#valveCommandStatus', 'received the command'));

    backend.latest = makeReading({ id: 2, timestamp: new Date(Date.parse(deliveredAt) + 1000).toISOString(), valve_state: 0 });
    await page.waitForFunction(...textMatches('#valveCommandStatus', 'Valve closed\\. Confirmed'), { timeout: 20000 });
    assert.equal(await page.textContent('#valveState'), 'CLOSED');
    // The browser logs the deliberate wrong-key rejection above; nothing else may fail.
    assert.deepEqual(problems.filter((problem) => !problem.includes('status of 403')), []);
    assert.equal(problems.length, 1);
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
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test('local settings refuse a secret service key', async () => {
  const { context, page, problems } = await openDashboard(makeBackend(), { envJs: 'window.__ENV__ = {};' });
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'Not connected'));
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
  const { context, page, problems } = await openDashboard(makeBackend());
  try {
    await page.waitForFunction(...textMatches('#systemStatus', 'Device live'));
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportCsvBtn')]);
    const csv = readFileSync(await download.path(), 'utf8');
    assert.match(csv.split('\r\n')[0], /^id,timestamp,flow_rate_1/);
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"")"`));
    assert.match(download.suggestedFilename(), /^flowstate_1h_\d{4}-\d{2}-\d{2}\.csv$/);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
