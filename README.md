# dsh-web-preview

Preview **any local web server** inside the DeepSeek Harness GUI — reliably, even
when the GUI is reached through a reverse proxy from a remote browser.

## The problem it solves

The DSH web GUI is usually reached over `https` through a reverse proxy (a
hostname or public IP). A plain `<iframe src="http://127.0.0.1:4173/">` inside
that GUI **does not work** from a remote browser:

- `127.0.0.1` resolves to the *browser's* own machine, not the host running DSH;
- `http://` on an `https` page is blocked as **mixed content**.

`dsh-web-preview` proxies a **local server on the DSH host** through the DSH
origin, so the iframe stays same-origin and `https` while the bytes come from a
`localhost` port on the machine DSH runs on.

## Features

- **Remote-browser-safe** — no mixed-content, no wrong-localhost, no
  X-Frame-Options issues from the DSH side.
- **Embedded tab** — a "Web Preview" tab in the conversation window (rendered
  as a real React slot component).
- **Floating window** — a `PREVIEW` button + draggable window, if you prefer a
  side panel.
- **Diagnostic toolbox** — collapsible **Console / Network / Errors** panels
  that capture what actually happens inside the iframe (the plugin injects a
  capture script into proxied HTML and beacons console output, fetch/XHR
  activity and runtime errors back to a host buffer you can poll).
- **Any local port** — type `localhost:5173`, `127.0.0.1:8080`, etc. The client
  encodes the origin into `/web-preview/__proxy/<origin>/<path>` and the host
  forwards to it. No hardcoded port.
- **Config-driven defaults** — prefill the toolbar, pin a default upstream, and
  add extra same-origin aliases (e.g. for an app that hardcodes `/cesium/`).

## Install

From the DSH **Plugin Market** (or any curated registry source):

```sh
dsh plugin --profile web add dsh-web-preview
```

Restart `dsh web`. No approval needed on boot — it is a bundle, not a dynamic
Cordis plugin.

## Configuration

All keys are optional. Put them under the plugin's `config:` in the profile
patch (the loader passes only `config:` to the plugin):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-web-preview
  config:
    # Prefill the toolbar with this URL (client-side convenience).
    defaultUrl: "http://127.0.0.1:4173/"
    # Optional fixed upstream for the bare /web-preview/<path> form.
    defaultUpstream: "http://127.0.0.1:4173"
    # Extra DSH-origin prefixes forwarded to a local service. Needed when the
    # previewed app makes root-absolute requests that must stay on the same
    # origin but are NOT under /web-preview (e.g. Cesium's hardcoded /cesium/).
    extraAliases:
      - prefix: "/cesium"
        origin: "127.0.0.1:4173"
        path: "/cesium"
    # Optional override for the browser-error log (defaults to the OS temp dir).
    logPath: "/tmp/dsh-web-preview-errors.log"
```

If `defaultUpstream` is empty, the toolbar's typed URL is the only way to pick a
target — and the **dynamic** `/web-preview/__proxy/<origin>/<path>` form works
for any localhost origin, with no config at all.

## How it works

| Layer | What it does |
| --- | --- |
| **Client** (`client.js`) | Registers a `conversation.view` tab (React host) + a `shell.overlay` floating window. Rewrites loopback URLs (`localhost`, `127.0.0.1`, `::1`) to same-origin `/web-preview/__proxy/<encoded origin>/<path>`. Polls `/web-preview/__events` for diagnostics. |
| **Host** (`index.js`) | Registers proxy + diagnostic routes on the DSH `webServer`. Forwards to `http://<origin>/<path>`, injects the capture script into HTML, buffers diagnostics. |

## Routes (all under the DSH origin)

| Route | Method | Purpose |
| --- | --- | --- |
| `/web-preview/__proxy/<origin>/<path>` | any | Forward to `http://<origin>/<path>` (dynamic, any local port) |
| `/web-preview/<path>` | any | Forward to `defaultUpstream` (only if configured) |
| `<alias.prefix>/<path>` | any | Forward to `alias.origin + alias.path` (per `extraAliases`) |
| `/web-preview/__report` | POST | Browser errors (capture script) |
| `/web-preview/__console` | POST | Browser console output (capture script) |
| `/web-preview/__network` | POST | Browser network activity (capture script) |
| `/web-preview/__events` | GET | Buffered diagnostics (`?since=<id>`) |
| `/web-preview/__clear` | POST | Reset the diagnostic buffer |
| `/web-preview/__config` | GET | The resolved plugin config (Client reads defaults) |

## Security notes

- The host forwards only to a **local loopback** origin that the client encodes
  — it never proxies an arbitrary remote URL. Loopback targets are validated
  client-side before encoding.
- The capture script runs **inside the proxied iframe**, sandboxed by the
  iframe's own `sandbox` attribute; it only beacons to the DSH origin.
- The diagnostic buffer is in-memory and capped (2000 events).

## License

MIT — see `LICENSE`.
