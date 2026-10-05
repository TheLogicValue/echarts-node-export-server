# Node.js server for offline export of ECharts graphs

This repository contains a Node.js application that starts a server which can
render [ECharts](https://echarts.apache.org/) graphs to PNG or SVG images.

Rendering runs on the server without a browser. ECharts 5.6.0 is bundled in the
repository, and PNG rendering uses the native `canvas` package. The response
contains the image itself; the server does not save it to disk. Animation is
disabled for both output formats.

Streamable HTTP MCP is also available at `/mcp` on the same listener. Its
`render_chart` tool returns inline PNG or SVG results using the existing
renderer. See [MCP chart rendering](./documentation/mcp.md) for the arguments,
SDK client example, stateless compatibility and internal access configuration.
Only trusted inputs are supported: formatter functions execute unsandboxed
inside this process. MCP applies Host/Origin checks, a 5,000,000-byte body
limit, 4096-pixel dimension bounds and an 8,388,608-pixel area limit.

## Project layout

| Path | Purpose |
| ---- | ------- |
| `export-server/server.js` | HTTP endpoint and host/port configuration |
| `export-server/ssr.js` | Image dimensions, formatter functions and rendering |
| `export-server/mcp.js` | MCP tool, transport, validation and limits |
| `export-server/echarts.v5.6.0.min.js` | Bundled ECharts library |
| `export-server/package.json` / `package-lock.json` | npm dependency manifest and lockfile |
| `export-server/tests/` | HTTP and chart tests using the Node.js test runner |
| `export-server/test.sh` | Linux test helper that starts and stops the server |
| `Dockerfile` | Debian 13 image with Node.js 24 and native rendering dependencies |
| `documentation/` | Setup guides, troubleshooting and example images |
| `AGENTS.md` | Repository instructions for coding agents |

## Requirements

This application needs the following prerequisites:

* Node.js 20 or later, as declared in `export-server/package.json`
* npm
* internet connection to download required dependencies (only once before
  first start)

### Installation of Node.js

The installation of Node.js is covered in a [separate document](./documentation/installation-node-js.md).

_(If you prefer a setup within a Docker container over a native installation,
then please take a look at [Setup with Docker](./documentation/docker.md).)_

## Initial setup: install Node.js dependency packages

The application requires a package for canvas-based rendering. To install that,
type

```sh
cd export-server
npm ci
```

Run these commands from the repository root. `npm ci` installs the versions in
the tracked lockfile into `node_modules/`; repeat it when dependencies change.
Use `npm install` when intentionally updating dependencies and review changes
to both the manifest and lockfile.

If a prebuilt `canvas` binary is unavailable for your platform, installation
requires native build dependencies, including Cairo and Pango. See the
[installation guide](./documentation/installation-node-js.md) for details.
The `canvas` package is required even when only requesting SVG, because the
renderer imports it at startup.

## Start the application

From `export-server/`, start the application via

    npm start

which fires up the Node.js application. The server will then listen on
<http://localhost:3000/> for incoming connections.

If you want the server to listen on a different port, then you can set the
environment variable `PORT` accordingly. On Linux-like systems you can do

``` bash
export PORT=4000
npm start
```

The equivalent on Windows command prompt would be

``` cmd
SET PORT=4000
npm start
```

In these cases the server will bind to port 4000 instead of the default port
3000.

The hostname can be changed, too, by setting the `HOST` environment variable in
the same manner, e. g.:

``` bash
export HOST=0.0.0.0
npm start
```

If `HOST` is not set, then `localhost` will be used as hostname.

In PowerShell, set these variables before starting the server:

```powershell
$env:HOST = 'localhost'
$env:PORT = '4000'
npm start
```

An invalid or out-of-range `PORT` falls back to 3000. Stop the foreground server
with Ctrl+C. Visiting the URL with a browser sends GET and returns HTTP 405;
the endpoint accepts image generation requests through POST.

### Docker quick start

From the repository root:

```sh
docker build -t exportapp .
docker run --rm -p 127.0.0.1:3000:3000 -e HOST=0.0.0.0 exportapp
```

`HOST=0.0.0.0` makes the server reachable through the container's published
port; the host port above is bound to loopback. If changing `PORT` inside the
container, also update the container port in `-p`. Stop the foreground container
with Ctrl+C. See [Setup with Docker](./documentation/docker.md) for the existing
Linux host-network setup.

## Usage

To generate a PNG file of an ECharts plot, just send an HTTP POST request to the
running Node.js server on <http://localhost:3000/> containing the data for the
plot as JSON in its body.

For example, POSTing the following JSON code to the server

    {
      "title": {
        "text": "ECharts entry example"
      },
      "tooltip": {},
      "legend": {
        "data": ["Sales"]
      },
      "backgroundColor": "#ffffff",
      "xAxis": {
        "data": ["shirt","cardigan","chiffon shirt","pants","heels","socks"]
      },
      "yAxis": {},
      "series": [{
        "name": "Sales",
        "type": "bar",
        "data": [5,20,36,10,10,20]
      }]
    }

Save the JSON above as `chart.json`. With the server running on its default
port, request and save the image using curl:

```sh
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  --data-binary @chart.json \
  --output chart.png http://localhost:3000/
```

Or use PowerShell:

```powershell
Invoke-WebRequest -Uri 'http://localhost:3000/' -Method Post `
  -ContentType 'application/json' -InFile './chart.json' -OutFile './chart.png'
```

The request generates a PNG image that looks like this:

![Generated image example](./documentation/graph-4a8d8e1d-eef8-4593-bd4c-422866243121.png)

The generated image will be contained in the response message body.

### Adjusting the width and height of the generated image

The generated PNG image has a width of 700 pixels and a height of 400 pixels by
default. If no size is specified, then the image will be of that default size.
However, this may not always be suitable for your needs.

There are two ways to change the image size:

* adding certain HTTP headers to the request _(preferred way)_, or
* adding two data members to the POST-ed JSON data.

If both are present, then the HTTP headers take precedence.

#### Changing the size via HTTP headers

To change the size, add the HTTP headers `X-Image-Width` and / or
`X-Image-Height` to the request. Acceptable values are integers only, the values
will be interpreted as pixels, not centimetres, inches or other. For example, if
you want the image to be 750 x 500 pixels, then set the HTTP headers

    X-Image-Width: 750
    X-Image-Height: 500

Using the same JSON as above, the created image will now be slightly larger and
look like this:

![Custom size image example](./documentation/graph-2eae6ee3-cb0c-464d-8997-7c2476e8d69d.png)

#### Changing the size via JSON

If sending HTTP headers with your request is too cumbersome and you do not mind
"polluting" the ECharts JSON with a bit of extra data, then that can be used to
adjust the image size, too. Just add the members `imageWidth` and / or
`imageHeight` to the top-level object. As with the HTTP headers, the values will
be interpreted as pixels, not centimetres or inches.

For example, POSTing the following JSON code to the server

    {
      "imageWidth": 750,
      "imageHeight": 500,
      "title": {
        "text": "ECharts entry example"
      },
      "tooltip": {},
      "legend": {
        "data": ["Sales"]
      },
      "backgroundColor": "#ffffff",
      "xAxis": {
        "data": ["shirt","cardigan","chiffon shirt","pants","heels","socks"]
      },
      "yAxis": {},
      "series": [{
        "name": "Sales",
        "type": "bar",
        "data": [5,20,36,10,10,20]
      }]
    }

will generate the same image with dimensions of 750 x 500 pixels.

### Switch rendering to SVG

By default, the application renders charts to PNG files. However, sometimes one
may want a vector-based graphic format like SVG. To get SVG, add the HTTP header
`X-Image-Format` to your request and set its value to `svg` (all lower case).
Using that, it will create a SVG file like this:

![SVG image example](./documentation/graph-e7df5157-ef8d-424f-a3db-e9184cbd570d.svg)

For example, using the same `chart.json`:

```sh
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -H 'X-Image-Format: svg' \
  -H 'X-Image-Width: 750' -H 'X-Image-Height: 500' \
  --data-binary @chart.json \
  --output chart.svg http://localhost:3000/
```

Only the exact value `svg` selects SVG. Other values, or an omitted format
header, select PNG. Successful responses use `image/svg+xml` or `image/png`.

### Formatter functions in JSON

The renderer supports `formatter` properties containing JavaScript functions
as strings, including arrow functions. For example, a value axis can include:

```json
{
  "yAxis": {
    "type": "value",
    "axisLabel": {
      "formatter": "function (value) { return value + ' €'; }"
    }
  }
}
```

This is an option fragment to merge into a complete chart. Ordinary formatter
templates such as `"{value} €"` remain strings. Strings that cannot be parsed
as functions also remain unchanged.

**Use trusted chart input.** Function strings are evaluated using JavaScript's
`Function` constructor in the server process, without a sandbox. The server
provides no authentication or TLS. Restrict access when binding beyond
localhost. The request-size check does not impose a maximum image dimension
or a rendering timeout.

### HTTP behavior

| Request or condition | Response |
| -------------------- | -------- |
| Successful `POST /` | 200 with binary PNG or SVG text |
| `OPTIONS /` | 204 with `Allow: POST` |
| Other methods on `/` | 405 with `Allow: POST` |
| Any path other than `/` | 404 |
| Malformed JSON in `POST /` | 400 with a plain text message |
| Accumulated request string exceeds 5,000,000 characters | 413, followed by connection closure |

The size check uses JavaScript string length, rather than a byte count. The
connection may close before the client receives the full 413 response.
The handler has a 500 JSON response branch for a renderer result with
`success: false`, but rendering exceptions are not caught by that branch and
can terminate the server. Valid JSON alone does not guarantee valid chart
options. `OPTIONS` does not add CORS headers.

## Development and validation

Install dependencies in `export-server/` with `npm ci`. There is no `npm test`,
lint, type-check or build script configured. The JavaScript runs directly in
Node.js.

The tests require a running server at `localhost:3000`. In a dedicated terminal,
from the repository root, start it with explicit defaults:

```sh
cd export-server
HOST=localhost PORT=3000 npm start
```

On PowerShell, use:

```powershell
cd export-server
$env:HOST = 'localhost'
$env:PORT = '3000'
npm start
```

Then, in a second terminal:

```sh
cd export-server
node --test
```

Stop the server with Ctrl+C afterwards. On Linux, `cd export-server` followed
by `./test.sh` starts the server, runs the suite and stops it. That helper uses
`pgrep node` and may stop unrelated Node.js processes; use the two-terminal
workflow if other Node.js applications are running.

The suite covers HTTP methods, invalid requests, PNG/SVG responses, dimensions,
formatter function strings and several chart types. GitHub Actions and GitLab
CI define Node.js 20, 22, 24 and 26 jobs; GitHub also defines Docker build,
Alpine dependency installation and npm audit workflows. Local checks do not
confirm those remote jobs have passed.

## Troubleshooting

If you encounter problems while trying to generate a chart image, then please
take a look at [the FAQ](./documentation/troubleshooting-faq.md). Some common
errors and possible solutions are listed there.

## Version history

A version history is available in [changelog.md](./changelog.md).

## Copyright and Licensing

Copyright 2018, 2020, 2021, 2022, 2023, 2024, 2025, 2026  Dirk Stolle

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
