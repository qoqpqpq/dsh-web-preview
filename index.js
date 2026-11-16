/**
 * dsh-web-preview — Host half.
 *
 * A generic "preview any local web server inside the DSH GUI" plugin.
 *
 * Why this exists:
 *   The DSH web GUI is usually reached through a reverse proxy (https, a
 *   public hostname or IP). A plain `<iframe src="http://127.0.0.1:4173/">`
 *   inside it does NOT work from a remote browser:
 *     • `127.0.0.1` resolves to the BROWSER's own machine, not the host running
 *       DSH;
 *     • `http://` on an `https` page is blocked as mixed content.
 *   This plugin proxies a LOCAL server through the DSH origin, so the iframe
 *   stays same-origin and https while the bytes come from a localhost port on
 *   the DSH host.
 *
 * Routes (registered once `webServer` exists; exact routes are registered
 * before the prefix proxy so they are never forwarded upstream):
 *   /web-preview/__report   POST   browser errors (from capture script)
 *   /web-preview/__console  POST   browser console output (from capture script)
 *   /web-preview/__network  POST   browser network activity (from capture script)
 *   /web-preview/__metric   POST   client-measured load timing/failure {loadId,url,ms,ok}
 *   /web-preview/__events   GET    buffered diagnostics for the Client devtools
 *   /web-preview/__clear    POST   reset the diagnostic buffer (devtools Clear)
 *   /web-preview/__config   GET    the plugin config (Client reads defaults)
 *   /web-preview/__probe    GET    server-side reachability probe ?u=<url> -> {ok,status,ms,error?}
 *   /web-preview/__proxy/<enc(origin)>/<path>  GET/POST/PUT/...  ->  http://<origin>/<path>
 *   /web-preview/<path>     GET/POST/...        ->  defaultUpstream/<path>   (only if defaultUpstream set)
 *   <alias>/<path>          GET/POST/...        ->  alias.origin + alias.path/<path>   (per extraAliases entry)
 *
 * `origin` is `host:port` (or a full http(s):// origin) of a LOCAL service on
 * the DSH host, URL-encoded into the path. The client encodes it; the host
 * decodes it and forwards. This makes ANY local port previewable with zero
 * configuration — the whole point of the generic plugin.
 */

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-web-preview'

// Route prefix we own at the DSH origin. (Change only if it collides.)
const APP_PREFIX = '/web-preview'

// Where browser-side errors are logged. Configurable; defaults to the OS temp
// dir so it never writes into a user's home directory.
const DEFAULT_LOG = path.join(os.tmpdir(), 'dsh-web-preview-errors.log')

// ── named tunables (no magic numbers scattered through the handlers) ─────────
// Cap on the diagnostic event ring buffer.
const EVENTS_MAX = 2000
// Cap on one JSON POST body we are willing to buffer (capture-script reports).
const BODY_MAX_BYTES = 131072
// Default server-side probe timeout. Overridable per-deployment via config
// `probeTimeoutMs`; the client's own load clock uses `timeoutMs` (its own const).
const PROBE_TIMEOUT_MS = 8000
// Redirects the probe will follow before giving up (we only need a status).
const PROBE_MAX_REDIRECTS = 4
// Cap on how much of an upstream probe body we read — we only need the status.
const PROBE_BODY_MAX_BYTES = 65536

// ── diagnostic event buffer ────────────────────────────────────────────────
const EVENTS = []
let EVENT_SEQ = 0
function pushEvent(type, payload) {
  const ev = Object.assign({ id: ++EVENT_SEQ, t: Date.now(), type }, payload || {})
  EVENTS.push(ev)
  if (EVENTS.length > EVENTS_MAX) EVENTS.splice(0, EVENTS.length - EVENTS_MAX)
  return ev
}

export function apply(ctx, config) {
  const cfg = config || {}

  // ── resolved config ───────────────────────────────────────────────────────
  // defaultUpstream: optional fixed upstream for bare /web-preview/<path>.
  //   e.g. "http://127.0.0.1:4173"  (the legacy/quick form; not required)
  // defaultUrl: the URL the Client prefills in its toolbar.
  //   e.g. "http://127.0.0.1:4173/"
  // extraAliases: list of { prefix, origin, path } — extra DSH-origin prefixes
  //   forwarded to a local service. Needed when a previewed app makes
  //   root-absolute requests that must stay on the same origin but are NOT
  //   under /web-preview. e.g. Cesium's hardcoded /cesium/.
  //   [{ prefix: '/cesium', origin: '127.0.0.1:4173', path: '/cesium' }]
  // logPath: optional override for the error log.
  // timeoutMs: optional client load clock (ms) — how long the Client waits for
  //   the iframe `onload` before declaring a timeout and probing. Falls back to
  //   the client's own const when absent.
  // probeTimeoutMs: optional server-side probe timeout (ms) for /__probe.
  const defaultUpstream = cfg.defaultUpstream || ''
  const defaultUrl = cfg.defaultUrl || ''
  const extraAliases = Array.isArray(cfg.extraAliases) ? cfg.extraAliases : []
  const errorLog = cfg.logPath || DEFAULT_LOG
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : null
  const probeTimeoutMs = Number.isFinite(cfg.probeTimeoutMs) && cfg.probeTimeoutMs > 0 ? cfg.probeTimeoutMs : PROBE_TIMEOUT_MS

  const aliasRoutes = []
  for (const a of extraAliases) {
    if (a && a.prefix && a.origin) {
      aliasRoutes.push({ prefix: String(a.prefix), origin: String(a.origin), path: String(a.path || a.prefix) })
    }
  }

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer

    // Collect one JSON POST body (capped).
    const readJson = (req, cb) => {
      let body = ''
      req.on('data', c => { body += c; if (body.length > BODY_MAX_BYTES) req.destroy() })
      req.on('end', () => {
        let data = null
        try { data = JSON.parse(body || '{}') } catch { data = { raw: body } }
        cb(data)
      })
      req.on('error', () => cb(null))
    }

    // POST /web-preview/__report  — browser errors
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__report',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        readJson(req, (data) => {
          try { fs.appendFileSync(errorLog, `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`) } catch (_) {}
          pushEvent('error', data || {})
          res.writeHead(204); res.end()
        })
      },
    }), 'web-preview: error report route')

    // POST /web-preview/__console  — browser console output
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__console',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        readJson(req, (data) => {
          pushEvent('console', data || {})
          res.writeHead(204); res.end()
        })
      },
    }), 'web-preview: console route')

    // POST /web-preview/__network  — browser network activity
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__network',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        readJson(req, (data) => {
          pushEvent('network', data || {})
          res.writeHead(204); res.end()
        })
      },
    }), 'web-preview: network route')

    // POST /web-preview/__metric  — client-measured load timing/failure.
    // The client races iframe `onload` against a timeout clock and reports the
    // outcome here: { loadId, url, ms, ok, reason? }. Cross-origin iframes hide
    // load status from the parent, so this client-side clock + the host probe
    // are the only reliable timing/failure signals. Recorded as a `metric`
    // event so it shows up in the devtools buffer.
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__metric',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        readJson(req, (data) => {
          pushEvent('metric', data || {})
          res.writeHead(204); res.end()
        })
      },
    }), 'web-preview: load metric route')

    // GET /web-preview/__events?since=<id> — buffered diagnostics
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__events',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const since = parseInt((req.url || '').split('since=')[1], 10) || 0
        const list = EVENTS.filter(e => e.id > since)
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ latest: EVENT_SEQ, events: list }))
      },
    }), 'web-preview: events route')

    // POST /web-preview/__clear — reset the diagnostic buffer (devtools Clear)
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__clear',
      handler: (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        EVENTS.length = 0
        EVENT_SEQ = 0
        res.writeHead(204); res.end()
      },
    }), 'web-preview: clear route')

    // GET /web-preview/__config — the plugin config (Client reads defaults)
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__config',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          defaultUrl,
          defaultUpstream: defaultUpstream || null,
          extraAliases: aliasRoutes,
          // Client load clock (ms); null → client uses its own const default.
          timeoutMs: timeoutMs,
          probeTimeoutMs,
        }))
      },
    }), 'web-preview: config route')

    // GET /web-preview/__sandbox-check?target=<urlencoded>
    // Same-origin diagnostic page. Loads the target through the proxy inside an
    // iframe that uses the EXACT sandbox attribute the real preview uses, so the
    // user can see the frame's own content and any errors it throws — the same
    // origin means those errors are observable, unlike inside the deployed
    // preview where cross-origin frames hide everything. Opens the door to
    // telling "proxy is fine but the app itself fails in the sandbox" apart from
    // "the proxy broke the page".
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__sandbox-check',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        let target = ''
        try {
          const u = new URL(req.url || '/', 'http://x')
          target = u.searchParams.get('target') || ''
        } catch (_) {}
        const sbFull = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
        const sbMin = 'allow-scripts allow-same-origin'
        const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>web-preview sandbox check</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#f5f5f7;color:#222}
h2{font-size:15px;margin:14px 0 4px}
.grid{display:flex;gap:10px}.col{flex:1}.frame{height:300px;border:1px solid #ccc;border-radius:8px;overflow:hidden;background:#fff}
.frame iframe{width:100%;height:100%;border:0;display:block}
.cap{font-size:12px;color:#666;margin:2px 0 8px}code{background:#eee;padding:1px 4px;border-radius:4px;font-size:11px;word-break:break-all}
.ok{color:#16a34a;font-weight:600}.bad{color:#dc2626;font-weight:600}
</style></head><body>
<h2>web-preview 沙箱对比诊断</h2>
<p class="cap">三个 iframe 都通过<strong>同一个代理</strong>加载目标页,只有 sandbox 不同。哪个能正常显示,就说明该用那种 sandbox 配置。</p>
<p class="cap">目标: <code>${target.replace(/[<>&]/g, '')}</code></p>
<div class="grid">
  <div class="col"><div class="frame"><iframe id="f0"></iframe></div><p class="cap"><strong>① 无 sandbox</strong><br><span id="s0">加载中…</span></p></div>
  <div class="col"><div class="frame"><iframe id="f1" sandbox="${sbMin}"></iframe></div><p class="cap"><strong>② 最小 sandbox</strong><br><code>allow-scripts allow-same-origin</code><br><span id="s1">加载中…</span></p></div>
  <div class="col"><div class="frame"><iframe id="f2" sandbox="${sbFull}"></iframe></div><p class="cap"><strong>③ 插件当前 sandbox</strong><br><code>${sbFull}</code><br><span id="s2">加载中…</span></p></div>
</div>
<script>
(function(){
  var enc = encodeURIComponent(${JSON.stringify(target)});
  var url = location.origin + '${APP_PREFIX}/__proxy/' + enc + '/';
  var ids = ['f0','f1','f2'], st = ['s0','s1','s2'];
  for (var i=0;i<ids.length;i++){
    (function(idx){
      var f = document.getElementById(ids[idx]);
      f.onload = function(){ document.getElementById(st[idx]).innerHTML = '<span class="ok">onload 已触发</span>（看上面是否白屏）'; };
      f.src = url;
    })(i);
  }
})();
</script></body></html>`
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      },
    }), 'web-preview: sandbox-check route')

    // GET /web-preview/__probe?u=<urlencoded target url>
    // Server-side reachability probe. Cross-origin iframes hide HTTP status and
    // load errors from the parent, so this is the ONLY way the Client can tell
    // "service not started" apart from "page 404" apart from "DNS/network down".
    // Does a HEAD (falling back to GET on 405/404/403), follows a bounded number
    // of redirects, caps the body, and returns { ok, status, ms, error? } where
    // `error` is a short friendly code. Never throws; always answers JSON.
    scoped.effect(() => server.register({
      kind: 'exact',
      path: APP_PREFIX + '/__probe',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const q = (req.url || '').split('?')[1] || ''
        let target = ''
        for (const kv of q.split('&')) {
          const i = kv.indexOf('=')
          if (i > 0 && kv.slice(0, i) === 'u') { try { target = decodeURIComponent(kv.slice(i + 1)) } catch (_) { target = '' } break }
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        if (!target) { res.end(JSON.stringify({ ok: false, status: 0, ms: 0, error: 'empty' })); return }
        let parsed
        try { parsed = new URL(target) } catch (_) { res.end(JSON.stringify({ ok: false, status: 0, ms: 0, error: 'invalid' })); return }
        probe(parsed, probeTimeoutMs, (result) => {
          try { res.end(JSON.stringify(result)) } catch (_) { try { res.end('{"ok":false,"error":"other"}') } catch (_) {} }
        })
      },
    }), 'web-preview: probe route')

    // /web-preview/__proxy/<enc(origin)>/<path>  ->  http://<origin>/<path>
    scoped.effect(() => server.register({
      kind: 'prefix',
      path: APP_PREFIX + '/__proxy',
      handler: (req, res) => {
        const rest = (req.url || '').replace(/^.*?\/__proxy\//, '')
        const slash = rest.indexOf('/')
        const encOrigin = slash >= 0 ? rest.slice(0, slash) : rest
        const upstreamPath = slash >= 0 ? rest.slice(slash) : '/'
        let origin
        try { origin = decodeURIComponent(encOrigin) } catch { origin = '' }
        if (!origin) { res.writeHead(400); res.end('web-preview: missing origin'); return }
        proxy(req, res, origin, upstreamPath, { subPrefix: APP_PREFIX + '/__proxy/' + encOrigin + '/' })
      },
    }), 'web-preview: dynamic proxy route')

    // /web-preview/<path>  ->  defaultUpstream/<path>  (legacy/quick form)
    if (defaultUpstream) {
      scoped.effect(() => server.register({
        kind: 'prefix',
        path: APP_PREFIX,
        handler: (req, res) => proxy(req, res, defaultUpstream, stripPrefix(req.url || '', APP_PREFIX)),
      }), 'web-preview: default-upstream proxy route')
    }

    // <alias.prefix>/<path>  ->  alias.origin + alias.path/<path>
    for (const a of aliasRoutes) {
      scoped.effect(() => server.register({
        kind: 'prefix',
        path: a.prefix,
        handler: (req, res) => {
          const rest = stripPrefix(req.url || '', a.prefix)
          proxy(req, res, a.origin, a.path + rest)
        },
      }), 'web-preview: alias proxy route ' + a.prefix)
    }
  })
}

/** Remove `prefix` from the start of a request URL (keep the query). */
function stripPrefix(url, prefix) {
  let p = url
  try { p = decodeURIComponent(new URL(url, 'http://x').pathname) } catch (_) {}
  if (p.startsWith(prefix)) p = p.slice(prefix.length)
  if (p === '') p = '/'
  const q = url.split('?')[1]
  return p + (q ? '?' + q : '')
}

/**
 * Forward one request to a local `origin` (host[:port]) at `upstreamPath`.
 * HTML responses have a capture script injected so the user's browser reports
 * console output, network activity and runtime errors back to the host.
 *
 * `opts.subPrefix` — when the proxy runs under a sub-path (e.g.
 * `/web-preview/__proxy/<enc>/`), root-absolute asset references in the
 * HTML (`src="/assets/x"`, `href="/cesium/y"`) are rewritten to be relative
 * to that sub-path, and a bootstrap script patches the browser history so a
 * BrowserRouter SPA keeps matching its routes under the sub-path. Passed
 * through to the HTML rewriter; `undefined` disables rewriting.
 */
function proxy(req, res, origin, upstreamPath, opts) {
  opts = opts || {}
  let upstream
  try {
    const base = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(origin) ? origin : 'http://' + origin)
    const u = new URL(upstreamPath || '/', base)
    upstream = u
  } catch {
    res.writeHead(400)
    res.end('web-preview: bad upstream origin')
    return
  }

  const headers = { ...req.headers, host: upstream.host }
  // Strip hop-by-hop + forwarded headers the upstream must not see.
  for (const h of ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host']) {
    delete headers[h]
  }
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    headers['content-length'] = String(req.headers['content-length'] ?? 0)
  }

  const fwd = transportFor(upstream.protocol).request({
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: upstream.pathname + upstream.search,
    method: req.method,
    headers,
  }, (up) => {
    const outHeaders = pickResponseHeaders(up)
    const ctype = String(up.headers['content-type'] || '').toLowerCase()
    const wantsHtml = ctype.includes('text/html')
    if (wantsHtml) {
      // Buffer HTML so we can inject the capture script.
      const chunks = []
      up.on('data', c => chunks.push(c))
      up.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8')
        if (opts.subPrefix) html = rewriteForSubPath(html, opts.subPrefix)
        html = stripViteHmr(html)
        html = injectCaptureScript(html)
        const body = Buffer.from(html, 'utf8')
        outHeaders['content-length'] = String(body.length)
        res.writeHead(up.statusCode ?? 200, outHeaders)
        res.end(body)
      })
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end() } })
    } else {
      res.writeHead(up.statusCode ?? 502, outHeaders)
      up.pipe(res)
    }
  })
  fwd.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502)
      res.end('web-preview: upstream unreachable (' + (err && err.code ? err.code : 'error') + ')')
    } else {
      res.destroy()
    }
  })
  req.pipe(fwd)
}

/**
 * Rewrite a proxied HTML document for a sub-path so that root-absolute
 * assets and BrowserRouter SPAs keep working.
 *
 * Two problems, one fix:
 *   1. Assets: `src="/assets/x"` / `href="/cesium/y"` resolve against the
 *      DSH origin (not the upstream), so they 404 or hit the wrong service.
 *      Rewriting them to `sub + path` makes them go through the proxy to the
 *      correct upstream (which serves the real files).
 *   2. Routing: a BrowserRouter reads `location.pathname` and matches routes
 *      against it. Under a sub-path it sees `/web-preview/__proxy/<enc>/gis`
 *      instead of `/gis`, so NO route matches → blank page. We inject a
 *      bootstrap script that makes `location.pathname` appear to start at the
 *      sub-path root, and strips the prefix when the app navigates via
 *      `history.pushState`/`replaceState`.
 *
 * `sub` must end with `/` and is the URL prefix of the proxied app relative
 * to the DSH origin (e.g. `/web-preview/__proxy/127.0.0.1%3A3001/`).
 */
/**
 * Strip Vite's HMR client (`/@vite/client`) from proxied HTML.
 *
 * Why: Vite's dev injects a client that opens a WebSocket back to the dev
 * server at `ws://<host>:<port>` to do hot-module replacement. When previewing
 * REMOTELY (browser on another machine reaching the DSH host through a
 * tunnel/reverse-proxy), that WebSocket target is unreachable, so the client
 * retries forever (`WebSocket ... failed` / `connection lost, retry #N`) and the
 * app's boot path stalls → blank page. Removing the client lets the app render
 * normally; the only trade-off is no hot-reload (manual refresh instead).
 *
 * Idempotent and conservative: only touches `/@vite/client` (script + any
 * modulepreload link); never throws.
 */
function stripViteHmr(html) {
  if (!html || html.indexOf('/@vite/client') === -1) return html
  // Remove the module script that loads the HMR client, e.g.
  //   <script type="module" src="/@vite/client"></script>
  // (the src may be sub-path prefixed already, so match any src ending in it).
  html = html.replace(/<script\b[^>]*\bsrc=["'][^"']*\/@vite\/client[^"']*["'][^>]*>\s*<\/script>/gi, '')
  // Remove modulepreload hints pointing at the client.
  html = html.replace(/<link\b[^>]*\bhref=["'][^"']*\/@vite\/client[^"']*["'][^>]*>/gi, '')
  return html
}

function rewriteForSubPath(html, sub) {
  // 1) Prefix root-absolute src/href attributes so they route through the proxy.
  //    e.g. src="/assets/index.js"  ->  src="<sub>assets/index.js"
  //    Skip data:, http(s):, //, #, and already-prefixed refs.
  html = html.replace(/(\b(?:src|href)\s*=\s*["'])\/(?![\/"'])/g, (m, q) => q + sub)

  // 2) Bootstrap script (runs before the app's module scripts) that makes the
  //    browser history / location appear rooted at the sub-path.
  const boot = `<script>(function(){
var SUB=${JSON.stringify(sub)};
// location.pathname getter: strip the sub-path so app code sees "/gis" etc.
var __origPath=Object.getOwnPropertyDescriptor(location,'pathname');
if(__origPath&&__origPath.get){try{
  var g=__origPath.get;Object.defineProperty(location,'pathname',{get:function(){
    var p=g.call(location);return p.indexOf(SUB)===0?p.slice(SUB.length-1):p;}});
}catch(e){}}
// history.pushState/replaceState: rewrite URLs so the browser's real path keeps
// the sub-prefix while the app thinks it navigated to the sub-rooted path.
function wrap(fn){return function(state,title,url){
  if(typeof url==='string'&&url.indexOf('/')===0&&url.indexOf(SUB)!==0){
    url=SUB+url.slice(1);}
  return fn.call(this,state,title,url);};}
try{history.pushState=wrap(history.pushState);history.replaceState=wrap(history.replaceState);}catch(e){}
})();</script>`
  const at = html.toLowerCase().lastIndexOf('</head>')
  if (at >= 0) return html.slice(0, at) + boot + html.slice(at)
  return boot + html
}

/**
 * Inject a capture <script> just before </head>. It hooks console output,
 * network activity (fetch + XHR) and runtime errors inside the iframe, and
 * beacons them back to the host's __console/__network/__report endpoints.
 * Runs before any module script, so even module-load failures are captured.
 */
function injectCaptureScript(html) {
  const script = `<script>(function(){
var _fetch=window.fetch.bind(window);
function post(path,body){try{_fetch(path,{method:"POST",keepalive:true,body:JSON.stringify(body)}).catch(function(){})}catch(e){}}
function str(a){try{if(typeof a==="string")return a;var s=JSON.stringify(a);return s===undefined?String(a):s}catch(e){return String(a)}}
function fmt(args){return Array.prototype.map.call(args||[],str).join(" ").slice(0,4000)}
window.addEventListener("error",function(e){post("/web-preview/__report",{k:"error",v:(e&&e.message||"")+" @ "+(e&&e.filename||"")+":"+(e&&e.lineno||"")+":"+(e&&e.colno||""),ua:navigator.userAgent,url:location.href})},true);
window.addEventListener("unhandledrejection",function(e){post("/web-preview/__report",{k:"unhandledrejection",v:(e&&e.reason&&(e.reason.stack||e.reason.message||String(e.reason)))||String(e&&e.reason),url:location.href})});
["log","warn","error","info","debug"].forEach(function(l){var orig=console[l]&&console[l].bind(console);if(!orig)return;console[l]=function(){try{post("/web-preview/__console",{level:l,args:fmt(arguments),url:location.href})}catch(e){}orig.apply(null,arguments)}});
var __of=window.fetch;window.fetch=function(){var u=arguments[0];var m=(arguments[1]&&arguments[1].method)||"GET";var s=Date.now();var p=__of.apply(this,arguments);p.then(function(r){try{post("/web-preview/__network",{method:m,url:String(u),status:r.status,ms:Date.now()-s})}catch(e){}}).catch(function(){try{post("/web-preview/__network",{method:m,url:String(u),status:"ERR",ms:Date.now()-s})}catch(e){}});return p};
var __open=XMLHttpRequest.prototype.open,__send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){this.__m=m;this.__u=u;return __open.apply(this,arguments)};
XMLHttpRequest.prototype.send=function(){var self=this,s=Date.now();this.addEventListener("load",function(){try{post("/web-preview/__network",{method:self.__m,url:String(self.__u),status:self.status,ms:Date.now()-s})}catch(e){}});this.addEventListener("error",function(){try{post("/web-preview/__network",{method:self.__m,url:String(self.__u),status:"ERR",ms:Date.now()-s})}catch(e){}});return __send.apply(this,arguments)};
post("/web-preview/__report",{k:"load",v:"page loaded: "+location.href,url:location.href});
})();</script>`
  const at = html.toLowerCase().lastIndexOf('</head>')
  if (at >= 0) return html.slice(0, at) + script + html.slice(at)
  return script + html
}

/** Forward only the response headers the upstream app actually needs. */
function pickResponseHeaders(up) {
  const keep = ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'vary', 'content-encoding', 'content-disposition', 'expires']
  const out = {}
  for (const k of keep) {
    const v = up.headers[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * Map a low-level probe error to a short, friendly code the Client can render.
 * These cover the cases that actually matter when a local preview fails:
 *   dns     — the hostname didn't resolve (typo, or a name only the browser knows)
 *   refused — nothing is listening on that port (service not started) — the
 *             single most common "why is my preview blank" cause
 *   timeout — the target didn't answer within the probe budget (slow/hung)
 *   cert    — TLS problem (self-signed, expired, depth-zero chain)
 *   aborted — the request was cut short (proxy shutdown, socket destroyed)
 *   other   — anything else; the Client falls back to a generic message
 */
function probeErrorKind(err) {
  const code = (err && err.code) || ''
  const msg = String((err && err.message) || '')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENOTDIR') return 'dns'
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout'
  if (code.startsWith('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || /certificate|self-signed|tls|ssl/i.test(msg)) return 'cert'
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || code === 'ABORT_ERR') return 'aborted'
  return 'other'
}

/**
 * Probe one absolute URL from the DSH host. Tries HEAD first (cheap, no body);
 * on 405/404/403 — where a server may not implement HEAD or may reject it —
 * retries with GET. Follows up to PROBE_MAX_REDIRECTS redirects (switching to
 * GET for those, since 3xx bodies/redirects are conventionally GET). Caps the
 * buffered body so a chatty endpoint can't tie up the host.
 *
 * `done(result)` always fires exactly once with `{ ok, status, ms, error? }`.
 */
/**
 * Pick the right transport module for an upstream protocol. Both the proxy and
 * the probe must use `https.request` for `https:` upstreams — `http.request`
 * against port 443 sends a plaintext request to a TLS port and fails with a
 * confusing 400 / ECONNRESET.
 */
function transportFor(protocol) {
  return protocol === 'https:' ? https : http
}

function probe(parsedUrl, timeoutMs, done, method, redirects) {
  method = method || 'HEAD'
  redirects = redirects || 0
  const started = Date.now()
  let settled = false
  const finish = (result) => {
    if (settled) return
    settled = true
    done(result)
  }
  let req
  const timer = setTimeout(() => {
    try { req.destroy() } catch (_) {}
    finish({ ok: false, status: 0, ms: Date.now() - started, error: 'timeout' })
  }, timeoutMs)

  try {
    req = transportFor(parsedUrl.protocol).request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { host: parsedUrl.host, 'user-agent': 'dsh-web-preview-probe' },
    }, (up) => {
      const status = up.statusCode ?? 0
      // Consume/cap the body so the socket is released; we only need the status.
      let seen = 0
      up.on('data', (c) => {
        seen += c.length
        if (seen > PROBE_BODY_MAX_BYTES) { try { up.destroy() } catch (_) {} }
      })
      up.on('end', () => {})
      up.on('error', () => {})
      const ms = Date.now() - started
      const loc = up.headers.location
      if (status >= 300 && status < 400 && loc && redirects < PROBE_MAX_REDIRECTS) {
        let next
        try { next = new URL(loc, parsedUrl) } catch (_) { next = null }
        clearTimeout(timer)
        if (!next || !/^https?:$/.test(next.protocol)) {
          finish({ ok: status < 400, status, ms, error: status < 400 ? undefined : 'other' })
          return
        }
        probe(next, timeoutMs, finish, 'GET', redirects + 1)
        return
      }
      const ok = status >= 200 && status < 400
      clearTimeout(timer)
      // A 405/404/403 to HEAD is often just "no HEAD support"/"auth on HEAD";
      // retry once with GET before reporting the status as-is.
      if (!ok && method === 'HEAD' && (status === 405 || status === 404 || status === 403)) {
        probe(parsedUrl, timeoutMs, finish, 'GET', redirects)
        return
      }
      finish({ ok, status, ms, error: ok ? undefined : 'http' })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, status: 0, ms: Date.now() - started, error: probeErrorKind(err) })
    })
    req.end()
  } catch (err) {
    clearTimeout(timer)
    finish({ ok: false, status: 0, ms: Date.now() - started, error: probeErrorKind(err) })
  }
}
