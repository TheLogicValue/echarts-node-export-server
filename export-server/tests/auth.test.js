'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { loadImage } = require('canvas');
const { Client, StreamableHTTPClientTransport } =
  require('@modelcontextprotocol/client');

const token = 'local-auth-test-token';
const option = {
  xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: {},
  series: [{ type: 'bar', data: [2, 5] }]
};

async function startServer(t, configuredToken) {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port) };
  delete env.MCP_ALLOWED_HOSTS;
  delete env.MCP_ALLOWED_ORIGINS;
  if (configuredToken === undefined) delete env.AUTH_TOKEN;
  else env.AUTH_TOKEN = configuredToken;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out.')),
      10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Server exited during startup.'));
    });
    child.stderr.resume();
    child.stdout.on('data', data => {
      if (data.toString().includes('Server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return 'http://127.0.0.1:' + port;
}

async function request(base, target, headers = {}, body = '{}', method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(base + target, { method, headers }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode,
        headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Request timed out.')));
    req.end(method === 'POST' ? body : undefined);
  });
}

for (const configuredToken of [undefined, '']) {
  test('authentication stays disabled when AUTH_TOKEN is ' +
    (configuredToken === undefined ? 'unset' : 'empty'), async t => {
    const base = await startServer(t, configuredToken);
    const result = await request(base, '/', { 'X-Image-Format': 'svg',
      'X-Auth-Token': 'ignored-when-disabled' }, JSON.stringify(option));
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /<svg/);
    assert.equal((await request(base, '/', {}, '', 'OPTIONS')).status, 204);
    assert.equal((await request(base, '/', {}, '', 'GET')).status, 405);
    assert.equal((await request(base, '/missing')).status, 404);
    const client = new Client({ name: 'no-auth-test', version: '1.0' }, {
      versionNegotiation: { mode: 'auto' }
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(
        new URL(base + '/mcp')));
      assert.equal((await client.listTools()).tools[0].name, 'render_chart');
    } finally { await client.close(); }
  });
}

test('configured token rejects missing or incorrect headers before parsing',
  async t => {
    const base = await startServer(t, token);
    for (const target of ['/', '/mcp']) {
      for (const supplied of [undefined, '', 'wrong', token.toUpperCase(),
        token + '-extra', token.slice(0, -1)]) {
        const response = await request(base, target,
          supplied === undefined ? {} : { 'X-Auth-Token': supplied }, '{');
        assert.equal(response.status, 403);
        assert.equal(response.body.toString(), 'Forbidden.\n');
        assert.doesNotMatch(response.body.toString(), /local-auth-test-token/);
      }
    }
    for (const [target, method] of [['/', 'OPTIONS'], ['/', 'GET'],
      ['/mcp', 'GET'], ['/mcp', 'DELETE'], ['/missing', 'POST']]) {
      assert.equal((await request(base, target, {}, '', method)).status, 403);
    }
  });

test('valid token renders root PNG/SVG and restores routing behavior',
  async t => {
    const base = await startServer(t, token);
    const headers = { 'x-auth-token': token, 'X-Image-Width': '120',
      'X-Image-Height': '80' };
    for (const format of ['png', 'svg']) {
      const response = await request(base, '/', { ...headers,
        'X-Image-Format': format }, JSON.stringify(option));
      assert.equal(response.status, 200);
      if (format === 'png') {
        const image = await loadImage(response.body);
        assert.equal(image.width, 120);
        assert.equal(image.height, 80);
      } else {
        assert.match(response.body.toString(), /width="120" height="80"/);
      }
    }
    assert.equal((await request(base, '/', headers, '', 'OPTIONS')).status,
      204);
    assert.equal((await request(base, '/', headers, '', 'GET')).status, 405);
    assert.equal((await request(base, '/missing', headers)).status, 404);
    assert.equal((await request(base, '/mcp/', headers)).status, 404);
  });

test('duplicate token headers are rejected even when both match', async t => {
  const base = await startServer(t, token);
  for (const target of ['/', '/mcp']) {
    const response = await request(base, target, [
      'Host', new URL(base).host,
      'X-Auth-Token', token, 'x-auth-token', token
    ]);
    assert.equal(response.status, 403);
  }
});

for (const mode of ['modern', 'legacy']) {
  test(mode + ' SDK client authenticates and renders through MCP', async t => {
    const base = await startServer(t, token);
    const client = new Client({ name: 'auth-test', version: '1.0' },
      mode === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {});
    try {
      await client.connect(new StreamableHTTPClientTransport(
        new URL(base + '/mcp'), {
          requestInit: { headers: { 'X-Auth-Token': token } }
        }));
      assert.equal((await client.listTools()).tools[0].name, 'render_chart');
      const result = await client.callTool({ name: 'render_chart', arguments: {
        option, format: 'svg', width: 120, height: 80
      } });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].resource.text,
        /width="120" height="80"/);
    } finally { await client.close(); }
  });
}

test('valid token does not bypass MCP Host/Origin validation', async t => {
  const base = await startServer(t, token);
  for (const forbidden of [{ Host: 'untrusted.example' },
    { Origin: 'https://untrusted.example' }]) {
    const response = await request(base, '/mcp', {
      'X-Auth-Token': token, ...forbidden
    });
    assert.equal(response.status, 403);
    assert.notEqual(response.body.toString(), 'Forbidden.\n');
  }
});

test('unauthenticated formatter code is never executed', async t => {
  const base = await startServer(t, token);
  const malicious = JSON.stringify({ series: [{ type: 'pie', data: [1],
    label: { formatter: '() => { throw new Error("must-not-run"); }' }
  }] });
  assert.equal((await request(base, '/', { 'X-Image-Format': 'svg' },
    malicious)).status, 403);
  const response = await request(base, '/', { 'X-Auth-Token': token,
    'X-Image-Format': 'svg' }, JSON.stringify(option));
  assert.equal(response.status, 200);
});
