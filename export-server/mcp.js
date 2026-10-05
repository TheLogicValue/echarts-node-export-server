'use strict';

const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const { McpServer, createMcpHandler } =
  require('@modelcontextprotocol/server');
const { toNodeHandler, hostHeaderValidation, originValidation } =
  require('@modelcontextprotocol/node');
const { z } = require('zod');
const ssr = require('./ssr.js');
const { version } = require('./package.json');

const MAX_DIMENSION = 4096;
const MAX_PIXELS = 8388608;
const MAX_BODY = 5000000;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const dimension = z.number().int().positive().max(MAX_DIMENSION);
const inputSchema = z.strictObject({
  option: z.record(z.string(), z.json()).describe(
    'ECharts options object. Only trusted input: formatter functions execute ' +
    'inside the server process.'),
  format: z.enum(['png', 'svg']).default('png'),
  width: dimension.optional().describe(
    'Pixels; overrides option.imageWidth. Default 700. Maximum 4096.'),
  height: dimension.optional().describe(
    'Pixels; overrides option.imageHeight. Default 400. Maximum 4096.')
});

function resolveDimensions(args) {
  const width = args.width !== undefined ? args.width :
    args.option.imageWidth !== undefined ? args.option.imageWidth : 700;
  const height = args.height !== undefined ? args.height :
    args.option.imageHeight !== undefined ? args.option.imageHeight : 400;
  if (!dimension.safeParse(width).success ||
      !dimension.safeParse(height).success) {
    throw new Error('Dimensions must be integers between 1 and 4096.');
  }
  if (width * height > MAX_PIXELS) {
    throw new Error('Image area must not exceed 8388608 pixels.');
  }
  return { width, height };
}

function renderChart(args) {
  let size;
  try {
    size = resolveDimensions(args);
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
  try {
    const { width, height } = size;
    const result = ssr.render(JSON.stringify(args.option),
      args.format === 'svg', width, height);
    if (!result.success) {
      throw new Error('Rendering failed.');
    }
    const image = args.format === 'svg' ? {
      type: 'resource',
      resource: {
        uri: 'echarts://render/' + randomUUID() + '.svg',
        mimeType: 'image/svg+xml', text: result.data
      }
    } : {
      type: 'image', mimeType: 'image/png',
      data: result.data.toString('base64')
    };
    return { content: [image, {
      type: 'text',
      text: `Rendered ${args.format.toUpperCase()} chart (${width} x ${height}).`
    }] };
  } catch (error) {
    // Formatter exceptions may contain secrets or complete chart payloads.
    return { isError: true, content: [{
      type: 'text', text: 'Chart rendering failed. Check the ECharts options ' +
        'and formatter functions.'
    }] };
  }
}

function createChartServer() {
  const server = new McpServer({ name: 'echarts-export-server', version });
  server.registerTool('render_chart', {
    title: 'Render ECharts chart',
    description: 'Render trusted ECharts options to inline PNG or SVG. ' +
      'Formatter functions execute unsandboxed in this process. ' +
      'Maximum 4096 pixels per dimension and 8388608 total pixels. ' +
      'SVG resource identities are not persistent download URLs.',
    inputSchema
  }, renderChart);
  return server;
}

function parseList(value, name, validate) {
  if (value === undefined) return undefined;
  const entries = value.split(',').map(entry => entry.trim());
  if (entries.some(entry => !entry || entry.includes('*') ||
      !validate(entry))) {
    throw new Error(name + ' contains an invalid allowlist entry.');
  }
  return entries;
}

function validHostname(value) {
  if (value.startsWith('[') && value.endsWith(']')) {
    return isIP(value.slice(1, -1)) === 6;
  }
  if (isIP(value)) return true;
  return value.length <= 253 && value.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function validOrigin(value) {
  try {
    const origin = new URL(value);
    return ['http:', 'https:'].includes(origin.protocol) &&
      origin.origin === value && validHostname(origin.hostname);
  } catch (error) {
    return false;
  }
}

function createEndpoint(env = process.env) {
  const hosts = parseList(env.MCP_ALLOWED_HOSTS, 'MCP_ALLOWED_HOSTS',
    validHostname) || LOOPBACK;
  const origins = parseList(env.MCP_ALLOWED_ORIGINS, 'MCP_ALLOWED_ORIGINS',
    validOrigin);
  const validateHost = hostHeaderValidation(hosts.map(host =>
    new URL('http://' + host).hostname));
  const validateOrigin = originValidation(origins ?
    origins.map(origin => new URL(origin).hostname) : LOOPBACK);
  const handler = createMcpHandler(createChartServer, {
    legacy: 'stateless', responseMode: 'json', maxRequestBodySize: MAX_BODY
  });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MAX_BODY });
  return {
    close: () => handler.close(),
    async handle(req, res) {
      const host = req.headers.host;
      const origin = req.headers.origin;
      if (typeof host !== 'string' ||
          !/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]+)?$/i.test(host) ||
          (origin !== undefined && (typeof origin !== 'string' ||
            !validOrigin(origin)))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden Host or Origin.');
        return;
      }
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      if (origin && (origins ? !origins.includes(origin) :
        !validOrigin(origin))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden Origin.');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end('Method not allowed.');
        return;
      }
      try {
        // The adapter stops iteration on a body-limit error. Node's default
        // iterator destroys the socket on return, before its 413 can flush.
        const request = {
          method: req.method, url: req.url, headers: req.headers,
          [Symbol.asyncIterator]: () => req.iterator({ destroyOnReturn: false })
        };
        const response = {
          get destroyed() { return res.destroyed; },
          on: res.on.bind(res), write: res.write.bind(res),
          end: res.end.bind(res),
          writeHead(status, headers) {
            // Drain rejected uploads without buffering so the HTTP 413 can
            // reach a client which is still writing its request body.
            if (status === 413) {
              // Closing before the incoming upload finishes causes TCP reset
              // on Node.js. Give the client time to receive the rejection.
              delete headers.connection;
              const timeout = setTimeout(() => req.socket.destroy(), 5000);
              timeout.unref();
              req.socket.once('close', () => clearTimeout(timeout));
              req.once('end', () => {
                if (res.writableFinished) req.socket.end();
                else res.once('finish', () => req.socket.end());
              });
              req.resume();
            }
            return res.writeHead(status, headers);
          }
        };
        await nodeHandler(request, response);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('MCP request failed.');
        } else if (!res.destroyed) {
          res.destroy();
        }
      }
    }
  };
}

module.exports = { createEndpoint, resolveDimensions };
