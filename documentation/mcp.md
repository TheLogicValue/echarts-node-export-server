# MCP chart rendering

The existing server also exposes Streamable HTTP MCP at
`http://localhost:3000/mcp`, on the same `HOST` and `PORT` as `POST /`.
Node.js >=20 is required. Install dependencies with `npm ci` and start with
`npm start` from `export-server/`.

The official MCP SDK v2 handles protocol framing and negotiation. Modern
2026-07-28 requests use JSON responses; 2025 clients can initialize and make
stateless calls. There are no sessions, GET SSE streams, `/sse`, or `/messages`
endpoints. GET, DELETE and other non-POST methods on `/mcp` return 405.
`/mcp/` and other paths return 404. The original root API remains available.
Raw ECharts JSON is for `POST /`; `/mcp` requires MCP protocol messages.

## Tool: `render_chart`

| Argument | Meaning |
| -------- | ------- |
| `option` | Required JSON object with arbitrary ECharts properties. Arrays, null and primitive roots are rejected. |
| `format` | `png` (default) or `svg`. |
| `width` | Optional integer from 1 through 4096, in pixels. |
| `height` | Optional integer from 1 through 4096, in pixels. |

Unknown top-level arguments are rejected. Each dimension is resolved
independently: explicit argument, then `option.imageWidth` /
`option.imageHeight`, then 700 / 400. The selected value must be a positive
integer; strings, null and fractions are rejected. An explicit valid argument
can override an invalid corresponding option value. The image area must not
exceed 8,388,608 pixels. The MCP body limit is 5,000,000 bytes; oversized
requests return HTTP 413 before rendering. These limits apply only to MCP.

PNG returns an MCP image block with base64 data and MIME `image/png`.
SVG returns an embedded resource with SVG text and MIME `image/svg+xml`.
Its generated `echarts://render/<id>.svg` URI identifies that inline result;
it does not provide persistent storage or a download endpoint. Both formats
include a short text block with the format and dimensions. Animation is
disabled, and the renderer disposes each chart after success or failure.

Rendering failures return a tool result with `isError: true` and a generic
English error. Dimension failures report the supported limits. Protocol
errors are handled separately by the SDK. A failed render does not prevent
subsequent valid calls.

## Trusted internal access

Only provide trusted options. Stringified formatter functions execute through
`Function` inside the server process without a sandbox. Function formatters
and ECharts template strings remain supported. Input validation and limits do
not make untrusted formatters safe. Rendering is synchronous: a formatter can
block the event loop; there is no cancellable rendering timeout or worker pool.

Optional `AUTH_TOKEN` authentication protects `/mcp` and the original root
API. Set a non-empty value in the server environment and send exactly one
matching `X-Auth-Token` header on every request. Missing, incorrect or duplicate
headers return 403 before MCP dispatch. Unset or empty disables authentication.
Token values are case-sensitive and read at startup; changes require a restart.
See [Optional authentication](../readme.md#optional-authentication) for server
and Docker setup. A valid token does not bypass Host/Origin checks or sandbox
formatters. Use trusted clients and HTTPS when transmitting tokens.

There is no built-in TLS or CORS. Default MCP Host validation
allows `localhost`, `127.0.0.1` and `[::1]`, with any valid port. Default
Origin validation allows HTTP/HTTPS origins on those loopback hostnames, with
any port. Native clients may omit Origin. A supplied invalid or empty Origin
is rejected. Invalid Host/Origin values return 403 before rendering. Binding
`HOST=0.0.0.0` does not disable these checks; forwarded headers are not trusted.

To select intentional internal names, configure comma-separated allowlists:

```sh
HOST=0.0.0.0 \
MCP_ALLOWED_HOSTS=charts.internal.example \
MCP_ALLOWED_ORIGINS=https://app.internal.example:8443 \
npm start
```

`MCP_ALLOWED_HOSTS` replaces the default host list and contains hostnames
without ports or schemes (IPv6 addresses require brackets).
`MCP_ALLOWED_ORIGINS` replaces default origins and contains exact canonical
HTTP/HTTPS origins, including a non-default port when needed. Scheme and port
must match exactly; omit paths and trailing slashes. Use lowercase canonical
URLs and omit default ports. Omitted Origin remains accepted. Wildcards,
empty entries and malformed values fail startup. These checks protect only
`/mcp`; shared-token authentication, when enabled, also protects the root API.
Host/Origin allowlists are not a replacement for authentication.

## SDK client smoke example

The development dependency `@modelcontextprotocol/client` is installed by
`npm ci`. With the server running, save or execute this CommonJS example from
`export-server/`. If the server requires a token, also set `AUTH_TOKEN` in the
client's environment; the example sends it through the transport headers:

```js
const { Client, StreamableHTTPClientTransport } =
  require('@modelcontextprotocol/client');

async function main() {
  const client = new Client({ name: 'chart-example', version: '1.0.0' }, {
    versionNegotiation: { mode: 'auto' }
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://localhost:3000/mcp'), {
        requestInit: {
          headers: process.env.AUTH_TOKEN ?
            { 'X-Auth-Token': process.env.AUTH_TOKEN } : {}
        }
      }));
    console.log(await client.listTools());
    const result = await client.callTool({
      name: 'render_chart',
      arguments: {
        format: 'svg', width: 700, height: 400,
        option: {
          xAxis: { type: 'category', data: ['A', 'B', 'C'] },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: [5, 12, 8] }]
        }
      }
    });
    console.log(result);
  } finally {
    await client.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
```

Use `format: 'png'` or omit it for PNG. This example prints the inline result
and does not save an image. Omitting `versionNegotiation` exercises the SDK's
2025 initialization flow. It does not configure a specific MCP host.
