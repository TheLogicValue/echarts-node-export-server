# Agent instructions

## Scope and structure

This repository contains a Node.js HTTP server that accepts ECharts options
as JSON and returns a PNG or SVG image. The application lives in
`export-server/`; do not run npm from the repository root.

- `server.js`: HTTP methods and paths, request bodies, headers and responses.
- `ssr.js`: dimensions, formatter function revival and rendering.
- `mcp.js`: Streamable HTTP MCP tool, validation and resource limits.
- `echarts.v5.6.0.min.js`: vendored library; do not edit it manually.
- `package.json` and `package-lock.json`: npm dependencies, including `canvas`.
- `tests/server.test.js` and `tests/charts/`: HTTP and chart tests.
- `test.sh`: Linux test helper.
- `Dockerfile`, `.github/workflows/` and `.gitlab-ci.yml`: image and CI.
- `readme.md` and `documentation/`: public documentation.

Read `CONTRIBUTING.md` before changing contribution conventions.
Preserve the existing `readme.md` filename and use `AGENTS.md` for these
instructions.

## Language

Use English throughout the project, matching the upstream repository:

- Write documentation, agent instructions, comments and developer-facing text
  in English.
- Use English for new identifiers, test descriptions, log messages and error
  messages, following existing conventions.
- Write commit messages, pull request titles and descriptions in English.
- Keep project-related communication in English unless the user explicitly
  requests another language.

Preserve literal data, API names, third-party content and test fixtures when
translating them would change their meaning or behavior.

## Setup and commands

From the repository root:

```sh
cd export-server
npm ci
npm start
```

The package declares Node.js >=20. CI defines versions 20, 22, 24 and 26;
the Dockerfile installs Node.js 24 on Debian 13. `canvas` is native and may
require build tools, Cairo and Pango if no prebuilt binary is available.
Do not change dependencies to work around an environment failure.
Report the blocker if installing or loading `canvas` fails.

`npm ci` uses the existing lockfile. For a requested dependency update,
use `npm install` and review the manifest and lockfile together.
Do not add `node_modules/`, generated images, logs or files containing secrets.
Example images in `documentation/` must remain versioned.

## Behavior to preserve

- The legacy rendering endpoint is `POST /`; `OPTIONS /` returns 204 and
  `Allow: POST`. Other methods on `/` return 405.
- `/mcp` serves the official SDK v2 Streamable HTTP tool `render_chart`.
  Non-POST methods return 405. Other paths, including `/mcp/`, return 404.
- MCP is stateless for modern and 2025 clients, limited to 5,000,000 body
  bytes, 4096 pixels per dimension and 8,388,608 total pixels. Validate Host,
  supplied Origin and selected integer dimensions before formatter execution.
  Keep SDK protocol handling and a fresh server factory per request.
- Default MCP allowlists permit loopback hosts and HTTP/HTTPS loopback
  origins. Explicit origins match exact scheme/host/port. See
  `documentation/mcp.md` for configuration. These guards apply only to MCP.
- `HOST` defaults to `localhost`; `PORT` defaults to 3000.
- PNG is the default format. Only `X-Image-Format: svg` selects SVG.
- Default dimensions are 700 x 400. Valid `X-Image-Width` / `X-Image-Height`
  headers take precedence over `imageWidth` / `imageHeight` in JSON;
  review the actual parsing in `ssr.js` when changing this behavior.
- Responses contain the image; the server does not save files.
- Animation is disabled in both renderers.

Stringified `formatter` functions are evaluated using `Function` inside the
process, without a sandbox. Do not describe untrusted input as safe.
The server does not implement authentication, TLS or CORS. The root body limit
uses string length, and there is no maximum image dimension or rendering
timeout. Review these points when changing exposure or validation.
Root rendering errors may throw uncaught exceptions; do not promise an HTTP
500 response for every root rendering failure. MCP catches renderer errors
and returns generic tool errors without exception details. Dispose ECharts
instances in `finally` and preserve synchronous rendering without claiming a
cancellable timeout.

## Validation

There are no npm test, lint, type-check or build scripts. The project uses
CommonJS and the native `node:test` runner. Do not invent commands such as
`npm test` or `npm run lint`.

To run the suite, start your own server at `localhost:3000`, from
`export-server/`, in a dedicated terminal:

```sh
HOST=localhost PORT=3000 npm start
```

In PowerShell:

```powershell
$env:HOST = 'localhost'
$env:PORT = '3000'
npm start
```

In another terminal, from `export-server/`:

```sh
node --test
```

Stop only the server you started. If the port is occupied, do not kill
unrelated processes. `./test.sh` is the Linux CI entry point, but uses
`pgrep node` to stop processes and may affect other Node.js applications.
Do not run it in a shared environment with other Node.js processes.

For JavaScript changes, also check syntax with `node --check` on affected
files. Add behavior tests for logic changes; when extending HTTP tests,
wait for responses and assertions using promises or the runner's asynchronous
mechanism. For Docker changes, validate the image and a real request when
the environment allows it:

```sh
docker build -t exportapp .
docker run --rm -p 127.0.0.1:3000:3000 -e HOST=0.0.0.0 exportapp
```

For documentation-only or `.gitignore` changes, check links, commands,
`git diff --check` and ignore rules with `git check-ignore --no-index`.
A Docker build is not required for documentation-only changes.
Report which checks you ran and which remain pending; local tests do not
confirm remote CI results.

## Changes and commits

- Stay within the requested scope and preserve the user's existing changes.
- Use two spaces for JavaScript indentation and aim for lines of up to 80
  characters, following `CONTRIBUTING.md`. Preserve copyright and GPL notices.
- Update the README when options, API behavior, setup or commands change;
  keep related guides consistent when they are part of the change.
- Do not commit or push unless explicitly requested by the user.
- Before every commit, review the full diff and staged files to ensure no
  unrelated changes are included.
- Run the applicable tests and syntax, lint, type-check or build checks
  supported by the actual project configuration. Explain the scope if you
  limit the test suite.
- If a related check fails, fix the problem and rerun it. If a failure or
  necessary check remains blocked, explain the blocker and do not commit
  until it is resolved or the user explicitly decides how to proceed.
- Follow the commit message conventions in `CONTRIBUTING.md`: English,
  imperative mood and lines of up to 65 characters, except URLs. For commits
  containing only documentation changes, that file requires `[ci skip]` on
  a separate line.

## Communication and subagents

Be clear and concise. Distinguish verified results, inferences and pending
checks. Base repository instructions on its files; verify changing external
information against current primary sources when necessary.

When presenting real subagents, assign each a randomly chosen animal emoji
and a short task label. Keep its emoji throughout the task and avoid reusing
emojis among active subagents while alternatives remain available. This rule
only affects text: it does not change identifiers or avatars. Do not create
subagents solely to display emojis.
