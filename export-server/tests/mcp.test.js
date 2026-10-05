'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test, before, after } = require('node:test');
const { Client, StreamableHTTPClientTransport } =
  require('@modelcontextprotocol/client');
const { loadImage } = require('canvas');
const { createEndpoint, resolveDimensions } = require('../mcp.js');
const echarts = require('../echarts.v5.6.0.min.js');
const ssr = require('../ssr.js');

const option = {
  xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: {},
  series: [{ type: 'bar', data: [2, 5] }]
};
let endpoint;
let server;
let base;
let client;

before(async () => {
  endpoint = createEndpoint({});
  server = http.createServer((req, res) => void endpoint.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port + '/mcp';
  client = new Client({ name: 'mcp-tests', version: '1.0.0' }, {
    versionNegotiation: { mode: 'auto' }
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(base)));
});

after(async () => {
  if (client) await client.close();
  if (endpoint) await endpoint.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function raw(body, headers = {}, method = 'POST', target = base) {
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method, headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...headers
    } }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(method === 'POST' ? typeof body === 'string' ? body :
      JSON.stringify(body) : undefined);
  });
}

test('modern discovery advertises the strict tool contract', async () => {
  const discovery = client.getDiscoverResult();
  assert.ok(discovery);
  assert.match(JSON.stringify(discovery), /2026-07-28/);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'render_chart');
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.match(tools[0].description, /unsandboxed/);
});

test('PNG is a decoded image with default dimensions', async () => {
  const result = await client.callTool({ name: 'render_chart',
    arguments: { option } });
  assert.equal(result.isError, undefined);
  const image = result.content[0];
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  const decoded = await loadImage(Buffer.from(image.data, 'base64'));
  assert.equal(decoded.width, 700);
  assert.equal(decoded.height, 400);
});

test('SVG is inline and dimensions resolve independently', async () => {
  const result = await client.callTool({ name: 'render_chart', arguments: {
    option: { ...option, imageWidth: 123, imageHeight: 234 },
    format: 'svg', width: 345
  } });
  const { resource } = result.content[0];
  assert.equal(resource.mimeType, 'image/svg+xml');
  assert.match(resource.uri, /^echarts:\/\/render\/.+\.svg$/);
  assert.match(resource.text, /width="345" height="234"/);
});

test('dimensions reject invalid selected values and cover bounds', () => {
  for (const value of [null, '120', 0, -1, 1.2, 4097]) {
    assert.throws(() => resolveDimensions({
      option: { imageWidth: value }, height: 1
    }));
  }
  assert.deepEqual(resolveDimensions({ option: {}, width: 4096,
    height: 2048 }), { width: 4096, height: 2048 });
  assert.throws(() => resolveDimensions({ option: {}, width: 4096,
    height: 2049 }), /area/);
  assert.deepEqual(resolveDimensions({ option: { imageWidth: 'bad' },
    width: 1, height: 1 }), { width: 1, height: 1 });
});

test('invalid arguments fail without terminating later calls', async () => {
  for (const args of [
    { option: null }, { option: [] }, { option: 1 },
    { option, format: 'gif' }, { option, width: 1.1 },
    { option, width: 4097 }, { option, height: -1 },
    { option, extra: true }, { option: { imageWidth: '10' } },
    { option, width: 4096, height: 4096 }
  ]) {
    const result = await client.callTool({ name: 'render_chart',
      arguments: args });
    assert.equal(result.isError, true);
  }
  const result = await client.callTool({ name: 'render_chart',
    arguments: { option, format: 'svg' } });
  assert.equal(result.isError, undefined);
});

test('trusted formatter functions and templates render', async () => {
  for (const formatter of ['function(p) { return "VALUE " + p.value; }',
    'p => "VALUE " + p.value', 'VALUE {c}']) {
    const result = await client.callTool({ name: 'render_chart', arguments: {
      option: { series: [{ type: 'pie', data: [{ value: 8, name: 'A' }],
        label: { show: true, formatter } }] }, format: 'svg'
    } });
    assert.match(result.content[0].resource.text, /VALUE 8/);
  }
});

test('render failure hides exception details and next request succeeds',
  async () => {
    const result = await client.callTool({ name: 'render_chart', arguments: {
      option: { series: [{ type: 'pie', data: [1], label: {
        formatter: '() => { throw new Error("secret-payload"); }'
      } }] }, format: 'svg'
    } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /secret-payload|stack/);
    const next = await client.callTool({ name: 'render_chart',
      arguments: { option, format: 'svg' } });
    assert.equal(next.isError, undefined);
  });

test('ECharts instances are disposed on success and exception', () => {
  const original = echarts.init;
  let disposed = 0;
  echarts.init = (...args) => {
    const chart = original(...args);
    const dispose = chart.dispose.bind(chart);
    chart.dispose = () => { disposed++; dispose(); };
    return chart;
  };
  try {
    for (const svg of [true, false]) {
      ssr.render(JSON.stringify(option), svg, 10, 10);
      assert.throws(() => ssr.render(JSON.stringify({
        series: [{ type: 'pie', data: [1], label: {
          formatter: '() => { throw new Error("failure"); }'
        } }]
      }), svg, 100, 100));
    }
    assert.equal(disposed, 4);
  } finally {
    echarts.init = original;
  }
});

test('legacy SDK client initializes statelessly and renders', async () => {
  const legacy = new Client({ name: 'legacy-tests', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base));
  try {
    await legacy.connect(transport);
    assert.equal(legacy.getDiscoverResult(), undefined);
    assert.equal(transport.sessionId, undefined);
    const { tools } = await legacy.listTools();
    assert.equal(tools[0].name, 'render_chart');
    const result = await legacy.callTool({ name: 'render_chart', arguments: {
      option, format: 'svg'
    } });
    assert.equal(result.content[0].type, 'resource');
  } finally {
    await legacy.close();
  }
});

test('concurrent calls keep results isolated', async () => {
  const results = await Promise.all([101, 202, 303].map(width =>
    client.callTool({ name: 'render_chart', arguments: {
      option, format: 'svg', width, height: 50
    } })));
  for (let i = 0; i < results.length; i++) {
    assert.match(results[i].content[0].resource.text,
      new RegExp('width="' + [101, 202, 303][i] + '"'));
  }
  assert.equal(new Set(results.map(result =>
    result.content[0].resource.uri)).size, 3);
});

test('methods, invalid headers, malformed messages and body limits',
  async () => {
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      assert.equal((await raw(undefined, {}, method)).status, 405);
    }
    for (const headers of [{ Host: 'attacker.example' },
      { Host: 'localhost/extra' }, { Host: 'user@localhost' },
      { Origin: '' },
      { Origin: 'https://attacker.example' }, { Origin: 'null' },
      { Origin: 'ftp://localhost' }]) {
      assert.equal((await raw({}, headers)).status, 403);
    }
    const malformed = await raw('{');
    assert.equal(malformed.status, 400);
    const invalid = await raw({ jsonrpc: '1.0', method: 'tools/list', id: 1 });
    assert.equal(invalid.status, 400);
    await assert.rejects(client.callTool({ name: 'unknown', arguments: {} }),
      error => error.code === -32602);
    const big = await fetch(base, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ' '.repeat(5000001) });
    assert.equal(big.status, 413);
  });

test('allowlist startup validation rejects invalid configuration', () => {
  for (const value of ['', '*', 'localhost,', 'https://localhost',
    'localhost:3000', 'bad/name', '-bad.example']) {
    assert.throws(() => createEndpoint({ MCP_ALLOWED_HOSTS: value }));
  }
  for (const value of ['', '*', 'https://host,', 'host',
    'https://host/path', 'ftp://host', 'https://user@host']) {
    assert.throws(() => createEndpoint({ MCP_ALLOWED_ORIGINS: value }));
  }
});

test('oversized chunked upload is rejected before upload completion',
  async () => {
    await new Promise((resolve, reject) => {
      const req = http.request(base, { method: 'POST', headers: {
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked'
      } }, res => {
        res.resume();
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 413);
            assert.equal(req.writableEnded, false);
            req.destroy();
            resolve();
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.write(' '.repeat(2500000));
      req.write(' '.repeat(2500001));
    });
  });

test('body limit accepts exactly 5000000 bytes', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'boundary', version: '1.0' } } });
  const response = await raw(body + ' '.repeat(5000000 - body.length));
  assert.equal(response.status, 200);
});

test('forbidden headers reject requests before formatter evaluation',
  async () => {
    const key = '__mcp_guard_test';
    const body = { jsonrpc: '2.0', id: 78, method: 'tools/call', params: {
      name: 'render_chart', arguments: { format: 'svg', option: {
        series: [{ type: 'pie', data: [1], label: {
          formatter: `() => { globalThis.${key} = true; return "x"; }`
        } }]
      } }
    } };
    try {
      assert.equal((await raw(body, { Origin: 'https://evil.example' })).status,
        403);
      assert.equal(globalThis[key], undefined);
    } finally { delete globalThis[key]; }
  });

test('explicit internal allowlists retain scheme and port restrictions',
  async () => {
    const configured = createEndpoint({
      MCP_ALLOWED_HOSTS: 'internal.example',
      MCP_ALLOWED_ORIGINS: 'https://internal.example:8443'
    });
    const local = http.createServer((req, res) =>
      void configured.handle(req, res));
    local.listen(0, '127.0.0.1');
    await once(local, 'listening');
    const target = 'http://127.0.0.1:' + local.address().port + '/mcp';
    try {
      for (const origin of ['http://internal.example:8443',
        'https://internal.example', 'https://internal.example:9443']) {
        assert.equal((await raw({}, { Host: 'internal.example',
          Origin: origin }, 'POST', target)).status, 403);
      }
      for (const origin of [undefined, 'https://internal.example:8443']) {
        const response = await raw('{', { Host: 'internal.example',
          ...(origin ? { Origin: origin } : {}) }, 'POST', target);
        assert.equal(response.status, 400);
      }
    } finally {
      await configured.close();
      await new Promise(resolve => local.close(resolve));
    }
  });

test('configured IPv6 hosts normalize expanded and IPv4-mapped addresses',
  async () => {
    for (const host of ['[0:0:0:0:0:0:0:1]', '[::ffff:192.0.2.1]']) {
      const configured = createEndpoint({ MCP_ALLOWED_HOSTS: host });
      const local = http.createServer((req, res) =>
        void configured.handle(req, res));
      local.listen(0, '127.0.0.1');
      await once(local, 'listening');
      try {
        const target = 'http://127.0.0.1:' + local.address().port + '/mcp';
        assert.equal((await raw('{', { Host: host }, 'POST', target)).status,
          400);
      } finally {
        await configured.close();
        await new Promise(resolve => local.close(resolve));
      }
    }
  });
