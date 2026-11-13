/**
 * Web Preview — persistent browser-side bundle.
 *
 * Two surfaces:
 *  A. A floating button + draggable iframe preview window (shell.overlay),
 *     useful when you want the preview beside the conversation.
 *  B. A `conversation.view` tab ("Web Preview") that embeds the preview
 *     full-size inside the current conversation window, with a collapsible
 *     developer toolbox (Console / Network / Errors) that polls the host
 *     diagnostic buffer.
 *
 * The embedded tab must render as a React component (the slot system renders
 * React elements), so the DOM-heavy preview UI is mounted into a React host
 * via a ref + useEffect. Plain-DOM UI, React only as a mount shim.
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-preview',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    // React is provided by the shell; use it only as a mount shim for the
    // embedded conversation-view tab. If it is unavailable, fall back to a
    // plain-DOM placeholder (the floating window still works).
    let React = null
    let useEffect = null
    let useRef = null
    try {
      React = require('react')
      useEffect = React.useEffect
      useRef = React.useRef
    } catch (_) { React = null }

    // ── named tunables (single place; no magic numbers in the handlers) ─────
    // Client load clock: how long we wait for iframe `onload` before declaring
    // a timeout and probing. Overridable per-deployment via __config.timeoutMs.
    const LOAD_TIMEOUT_MS = 20000
    // Zoom clamp + step + default.
    const ZOOM_MIN = 25
    const ZOOM_MAX = 300
    const ZOOM_DEFAULT = 100
    const ZOOM_STEP = 25
    // Recent-address list size (module scope → survives panel rebuilds).
    const RECENT_MAX = 15
    // One shared <datalist> id so every panel instance (floating + embedded)
    // suggests the same recent addresses.
    const RECENT_LIST_ID = 'wprev-recent-urls'

    // Config-driven values, fetched from /web-preview/__config in apply().
    // Defaults keep the panel correct even if the config has not landed yet.
    let hostTimeoutMs = null   // null → makePreviewPanel uses LOAD_TIMEOUT_MS
    let cacheEnabled = true    // gates whether auto-restore performs a live reload

    // ── CSS ──────────────────────────────────────────────────────────────────
    const CLIENT_CSS = `
      /* ── floating window ─────────────────────────────────────────────── */
      .wprev-fab{position:fixed!important;right:22px!important;bottom:22px!important;z-index:2147483647!important;width:60px!important;height:60px!important;border-radius:50%!important;background:#4f6ef7!important;color:#ffffff!important;display:flex!important;align-items:center!important;justify-content:center!important;font:600 10px/1.2 ui-sans-serif,system-ui,sans-serif!important;letter-spacing:.14em!important;cursor:pointer!important;box-shadow:0 6px 20px rgba(0,0,0,.28)!important;border:2px solid rgba(255,255,255,.35)!important;user-select:none!important;padding:0!important;box-sizing:border-box!important;transition:transform .15s ease,box-shadow .15s ease!important}
      .wprev-hidden{display:none!important}
      .wprev-fab:hover{transform:scale(1.06)!important;box-shadow:0 10px 26px rgba(0,0,0,.34)!important}
      .wprev-win{position:fixed!important;top:72px!important;right:96px!important;width:960px!important;height:620px!important;min-width:320px!important;min-height:240px!important;z-index:2147483646!important;background:var(--bg-overlay,#1c1d1f)!important;color:var(--label-primary,#f9fafb)!important;border:1px solid var(--border-l2,#ffffff1f)!important;border-radius:10px!important;box-shadow:0 24px 64px rgba(0,0,0,.42)!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;font:13px/1.4 ui-sans-serif,system-ui,sans-serif!important}
      .wprev-win.wprev-hidden{display:none!important}
      .wprev-fab.wprev-hidden{display:none!important}
      .wprev-head{display:flex!important;align-items:center!important;gap:8px!important;padding:8px 10px!important;background:var(--bg-layer-2,#2c2c2e)!important;border-bottom:1px solid var(--border-l2,#ffffff1f)!important;cursor:grab!important;user-select:none!important;flex:none!important}
      .wprev-head:active{cursor:grabbing!important}
      .wprev-title{font:600 11px/1 ui-sans-serif,system-ui,sans-serif!important;letter-spacing:.12em!important;color:var(--label-secondary,#9ca3af)!important;margin-right:2px!important;white-space:nowrap!important}
      .wprev-dot{width:8px!important;height:8px!important;border-radius:50%!important;background:var(--label-secondary,#9ca3af)!important;flex-shrink:0!important}
      .wprev-dot.loading{background:var(--state-warn-primary,#b45309)!important}
      .wprev-dot.loaded{background:var(--state-success-primary,#16a34a)!important}
      .wprev-dot.error{background:var(--state-error-primary,#dc2626)!important}
      .wprev-url{flex:1!important;min-width:0!important;background:var(--bg-layer-1,#ffffff)!important;color:var(--label-primary,#1f2328)!important;border:1px solid var(--border-l2,#e5e7eb)!important;border-radius:6px!important;padding:5px 9px!important;font:12px ui-monospace,SFMono-Regular,Menlo,monospace!important;outline:none!important}
      .wprev-url:focus{border-color:var(--brand-primary,#4f6ef7)!important}
      .wprev-btn{background:var(--bg-layer-1,#ffffff)!important;color:var(--label-primary,#1f2328)!important;border:1px solid var(--border-l2,#e5e7eb)!important;border-radius:6px!important;padding:5px 10px!important;cursor:pointer!important;font-size:12px!important;font-family:ui-sans-serif,system-ui,sans-serif!important;line-height:1.2!important}
      .wprev-btn:hover{border-color:var(--brand-primary,#4f6ef7)!important;color:var(--brand-primary,#4f6ef7)!important}
      .wprev-btn.primary{background:var(--brand-primary,#4f6ef7)!important;color:#ffffff!important;border-color:var(--brand-primary,#4f6ef7)!important}
      .wprev-btn.primary:hover{filter:brightness(1.08)!important;color:#ffffff!important}
      .wprev-btn.active{background:var(--brand-primary,#4f6ef7)!important;color:#ffffff!important;border-color:var(--brand-primary,#4f6ef7)!important}
      .wprev-body{flex:1!important;position:relative!important;background:#ffffff!important;min-height:0!important}
      .wprev-frame{width:100%!important;height:100%!important;border:0!important;background:#ffffff!important;display:block!important}
      .wprev-empty{position:absolute!important;inset:0!important;display:flex!important;align-items:center!important;justify-content:center!important;color:var(--label-secondary,#9ca3af)!important;font-size:13px!important}

      /* ── conversation-view tab (embedded) ──────────────────────────────── */
      .wprev-embed{display:flex!important;flex-direction:column!important;width:100%!important;height:100%!important;min-height:0!important;background:var(--dsw-alias-bg-layer-1,#ffffff)!important;color:var(--dsw-alias-label-primary,#1f2328)!important;font:13px/1.4 ui-sans-serif,system-ui,sans-serif!important}
      .wprev-embed-head{display:flex!important;align-items:center!important;gap:8px!important;padding:8px 12px!important;background:var(--dsw-alias-bg-layer-2,#2c2c2e)!important;border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff1f)!important;flex:none!important}
      .wprev-embed-title{font:600 11px/1 ui-sans-serif,system-ui,sans-serif!important;letter-spacing:.12em!important;color:var(--dsw-alias-label-secondary,#9ca3af)!important;white-space:nowrap!important}
      .wprev-embed-dot{width:8px!important;height:8px!important;border-radius:50%!important;background:var(--dsw-alias-label-secondary,#9ca3af)!important;flex-shrink:0!important}
      .wprev-embed-dot.loading{background:var(--dsw-alias-state-warn-primary,#b45309)!important}
      .wprev-embed-dot.loaded{background:var(--dsw-alias-state-success-primary,#16a34a)!important}
      .wprev-embed-dot.error{background:var(--dsw-alias-state-error-primary,#dc2626)!important}
      .wprev-embed-url{flex:1!important;min-width:0!important;background:var(--dsw-alias-bg-layer-1,#ffffff)!important;color:var(--dsw-alias-label-primary,#1f2328)!important;border:1px solid var(--dsw-alias-border-l2,#e5e7eb)!important;border-radius:6px!important;padding:5px 9px!important;font:12px ui-monospace,SFMono-Regular,Menlo,monospace!important;outline:none!important}
      .wprev-embed-url:focus{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4f6ef7)!important}
      .wprev-embed-btn{background:var(--dsw-alias-bg-layer-1,#ffffff)!important;color:var(--dsw-alias-label-primary,#1f2328)!important;border:1px solid var(--dsw-alias-border-l2,#e5e7eb)!important;border-radius:6px!important;padding:5px 10px!important;cursor:pointer!important;font-size:12px!important;font-family:ui-sans-serif,system-ui,sans-serif!important;line-height:1.2!important}
      .wprev-embed-btn:hover{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4f6ef7)!important;color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4f6ef7)!important}
      .wprev-embed-btn.primary{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4f6ef7)!important;color:#ffffff!important;border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4f6ef7)!important}
      .wprev-embed-btn.primary:hover{filter:brightness(1.08)!important;color:#ffffff!important}
      .wprev-embed-btn.active{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4f6ef7)!important;color:#ffffff!important;border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4f6ef7)!important}
      .wprev-embed-view{flex:1!important;min-height:0!important;position:relative!important;display:flex!important;flex-direction:column!important}
      .wprev-embed-frame-wrap{flex:1!important;min-height:0!important;position:relative!important;background:#ffffff!important}
      .wprev-embed-frame{width:100%!important;height:100%!important;border:0!important;background:#ffffff!important;display:block!important}
      .wprev-embed-empty{position:absolute!important;inset:0!important;display:flex!important;align-items:center!important;justify-content:center!important;color:var(--dsw-alias-label-secondary,#9ca3af)!important;font-size:13px!important}

      /* ── devtools toolbox ──────────────────────────────────────────────── */
      .wprev-tools{border-top:1px solid var(--dsw-alias-border-l2,#ffffff1f)!important;background:var(--dsw-alias-bg-layer-2,#2c2c2e)!important;flex:none!important;display:flex!important;flex-direction:column!important;min-height:0!important}
      .wprev-tools-bar{display:flex!important;align-items:center!important;gap:4px!important;padding:4px 8px!important;flex:none!important}
      .wprev-tools-tab{background:transparent!important;color:var(--dsw-alias-label-secondary,#9ca3af)!important;border:0!important;border-radius:6px!important;padding:4px 10px!important;cursor:pointer!important;font:600 11px/1 ui-sans-serif,system-ui,sans-serif!important;letter-spacing:.06em!important}
      .wprev-tools-tab:hover{color:var(--dsw-alias-label-primary,#f9fafb)!important;background:var(--dsw-alias-interactive-bg-hover,#ffffff14)!important}
      .wprev-tools-tab.active{color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4f6ef7)!important;background:var(--dsw-alias-interactive-bg-active,#ffffff1f)!important}
      .wprev-tools-count{font:600 10px/1 ui-sans-serif,system-ui,sans-serif!important;color:var(--dsw-alias-label-secondary,#9ca3af)!important;margin-left:2px!important}
      .wprev-tools-toggle{margin-left:auto!important;background:var(--dsw-alias-bg-layer-1,#ffffff)!important;color:var(--dsw-alias-label-primary,#1f2328)!important;border:1px solid var(--dsw-alias-border-l2,#e5e7eb)!important;border-radius:6px!important;padding:3px 8px!important;cursor:pointer!important;font-size:11px!important;font-family:ui-sans-serif,system-ui,sans-serif!important}
      .wprev-tools-clear{background:var(--dsw-alias-bg-layer-1,#ffffff)!important;color:var(--dsw-alias-label-primary,#1f2328)!important;border:1px solid var(--dsw-alias-border-l2,#e5e7eb)!important;border-radius:6px!important;padding:3px 8px!important;cursor:pointer!important;font-size:11px!important;font-family:ui-sans-serif,system-ui,sans-serif!important}
      .wprev-tools-panel{height:180px!important;min-height:60px!important;overflow:auto!important;background:var(--dsw-alias-bg-base,#0f1115)!important;border-top:1px solid var(--dsw-alias-border-l1,#ffffff0f)!important;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace!important;color:var(--dsw-alias-label-primary,#e5e7eb)!important;padding:4px 0!important}
      .wprev-tools-panel.collapsed{display:none!important}
      .wprev-tools-row{padding:2px 10px!important;border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff08)!important;white-space:pre-wrap!important;word-break:break-all!important}
      .wprev-tools-row.err{color:var(--dsw-alias-state-error-primary,#f87171)!important}
      .wprev-tools-row.warn{color:var(--dsw-alias-state-warn-label,#fbbf24)!important}
      .wprev-tools-row.ok{color:var(--dsw-alias-state-success-primary,#34d399)!important}
      .wprev-tools-row.info{color:var(--dsw-alias-label-secondary,#9ca3af)!important}
      .wprev-tools-row .lv{font-weight:700!important;margin-right:6px!important}
      .wprev-tools-row .ts{color:var(--dsw-alias-label-tertiary,#6b7280)!important;margin-right:6px!important}
      .wprev-tools-empty{color:var(--dsw-alias-label-tertiary,#6b7280)!important;padding:12px 10px!important;text-align:center!important}

      /* ── toolbar buttons: disabled / danger states ─────────────────────── */
      /* Disabled must beat the hover rules above, so it carries !important. */
      .wprev-btn[disabled]{opacity:.4!important;cursor:not-allowed!important;border-color:var(--border-l2,#e5e7eb)!important;color:var(--label-secondary,#9ca3af)!important;background:var(--bg-layer-1,#ffffff)!important;filter:none!important}
      .wprev-embed-btn[disabled]{opacity:.4!important;cursor:not-allowed!important;border-color:var(--dsw-alias-border-l2,#e5e7eb)!important;color:var(--dsw-alias-label-secondary,#9ca3af)!important;background:var(--dsw-alias-bg-layer-1,#ffffff)!important;filter:none!important}

      /* ── status line (under the toolbar) ───────────────────────────────── */
      .wprev-status{display:flex!important;align-items:center!important;gap:6px!important;padding:3px 10px!important;font:11px/1.3 ui-sans-serif,system-ui,sans-serif!important;color:var(--dsw-alias-label-secondary,#9ca3af)!important;background:var(--dsw-alias-bg-layer-2,#2c2c2e)!important;border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff1f)!important;flex:none!important;min-height:20px!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
      .wprev-status .wprev-status-msg{overflow:hidden!important;text-overflow:ellipsis!important}
      .wprev-status.ok .wprev-status-msg{color:var(--dsw-alias-state-success-primary,#34d399)!important}
      .wprev-status.warn .wprev-status-msg{color:var(--dsw-alias-state-warn-label,#fbbf24)!important}
      .wprev-status.error .wprev-status-msg{color:var(--dsw-alias-state-error-primary,#f87171)!important}

      /* ── zoom segmented control ────────────────────────────────────────── */
      .wprev-zoom{display:inline-flex!important;align-items:center!important;border:1px solid var(--dsw-alias-border-l2,#e5e7eb)!important;border-radius:6px!important;overflow:hidden!important;flex:none!important}
      .wprev-zoom button{background:var(--dsw-alias-bg-layer-1,#ffffff)!important;color:var(--dsw-alias-label-primary,#1f2328)!important;border:0!important;border-right:1px solid var(--dsw-alias-border-l2,#e5e7eb)!important;padding:4px 7px!important;cursor:pointer!important;font:11px/1.2 ui-sans-serif,system-ui,sans-serif!important}
      .wprev-zoom button:last-child{border-right:0!important}
      .wprev-zoom button:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)!important}
      .wprev-zoom button[disabled]{opacity:.4!important;cursor:not-allowed!important}
      .wprev-zoom .wprev-zoom-val{min-width:42px!important;text-align:center!important;font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace!important;color:var(--dsw-alias-label-secondary,#9ca3af)!important;background:var(--dsw-alias-bg-layer-2,#2c2c2e)!important;align-self:stretch!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:0 2px!important}

      /* ── zoomable frame stage ──────────────────────────────────────────── */
      /* The stage clips; the inner scaler is the transform target. The frame is
         sized to 100%/zoom so that after scale() it exactly fills the stage. */
      .wprev-stage{position:absolute!important;inset:0!important;overflow:hidden!important;background:#ffffff!important}
      .wprev-scaler{position:absolute!important;top:0!important;left:0!important;width:100%!important;height:100%!important;transform-origin:top left!important}
      .wprev-err-card{position:absolute!important;inset:0!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:24px!important;background:var(--dsw-alias-bg-base,#0f1115)!important;z-index:3!important}
      .wprev-err-inner{max-width:520px!important;width:100%!important;background:var(--dsw-alias-bg-layer-2,#2c2c2e)!important;border:1px solid var(--dsw-alias-border-l2,#ffffff1f)!important;border-left:3px solid var(--dsw-alias-state-error-primary,#dc2626)!important;border-radius:10px!important;padding:18px 20px!important;color:var(--dsw-alias-label-primary,#f9fafb)!important;font:13px/1.5 ui-sans-serif,system-ui,sans-serif!important;box-shadow:0 12px 40px rgba(0,0,0,.4)!important}
      .wprev-err-title{font-size:15px!important;font-weight:600!important;margin:0 0 8px!important;display:flex!important;align-items:center!important;gap:8px!important}
      .wprev-err-title .ico{color:var(--dsw-alias-state-error-primary,#f87171)!important;font-size:18px!important}
      .wprev-err-reason{margin:0 0 10px!important;color:var(--dsw-alias-label-secondary,#9ca3af)!important;font-size:12.5px!important}
      .wprev-err-url{margin:0 0 14px!important;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace!important;color:var(--dsw-alias-label-tertiary,#6b7280)!important;word-break:break-all!important;max-height:48px!important;overflow:auto!important}
      .wprev-err-actions{display:flex!important;gap:8px!important;flex-wrap:wrap!important}
    `

    // ── helpers ──────────────────────────────────────────────────────────────
    function normalize(raw) {
      const s = String(raw || '').trim()
      if (!s) return ''
      if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
      if (s.indexOf('//') === 0) return 'https:' + s
      // Bare `host:port` (e.g. `127.0.0.1:5173`) — common for local dev servers.
      if (/^[a-zA-Z0-9.-]+:[0-9]{1,5}(\/|$)/.test(s)) return 'http://' + s
      return 'https://' + s
    }

    // Rewrite a localhost/loopback URL to a same-origin proxy path so a REMOTE
    // browser can load a LOCAL web server through the DSH origin. `http://` on
    // an https page would otherwise be mixed content, and `127.0.0.1` would
    // resolve to the browser's OWN machine, not the host running DSH.
    // ANY loopback origin is supported: the host encodes `host:port` into the
    // path and the Host half forwards to it (no hardcoded port).
    function toProxyUrl(raw) {
      let u
      try { u = new URL(raw) } catch { return null }
      const host = u.hostname
      const loop = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
      if (!loop) return null
      const origin = u.hostname + (u.port ? ':' + u.port : '')
      const enc = encodeURIComponent(origin)
      return location.origin + '/web-preview/__proxy/' + enc + (u.pathname || '/') + u.search
    }

    function el(tag, attrs, ...children) {
      const node = document.createElement(tag)
      if (attrs) {
        for (const k in attrs) {
          if (!attrs.hasOwnProperty(k)) continue
          const v = attrs[k]
          if (k === 'style') Object.assign(node.style, v)
          else if (k === 'class' || k === 'className') node.className = v
          else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
          else if (v === true) node.setAttribute(k, '')
          else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v)
        }
      }
      for (const c of children) {
        if (c === null || c === undefined || c === false) continue
        if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)))
        else node.appendChild(c)
      }
      return node
    }

    // ── friendly failure copy (no stack traces, ever) ───────────────────────
    // `kind` comes from the host probe (`__probe.error`) or a client-side check.
    // These cover the distinct cases a local preview actually hits.
    const ERROR_TEXT = {
      empty:    { title: 'No address entered',            reason: 'Type a local address (e.g. localhost:5173) or a URL, then press GO.' },
      invalid:  { title: 'That address looks invalid',     reason: 'It could not be parsed as a URL. Check for typos or a missing host.' },
      dns:      { title: 'Host not found',                 reason: 'The hostname did not resolve on the server running DSH. Check the address for typos, or use 127.0.0.1 / localhost for a local service.' },
      refused:  { title: 'Service not started',            reason: 'Nothing is listening on that port yet. Start your dev server, then press Retry.' },
      timeout:  { title: 'Timed out',                      reason: 'The page did not finish loading in time. The service may be slow to start or hung. Retry once it responds.' },
      cert:     { title: 'Certificate / TLS error',        reason: 'The HTTPS certificate could not be validated (self-signed, expired, or an incomplete chain).' },
      aborted:  { title: 'Connection interrupted',         reason: 'The connection was cut short before the page finished loading.' },
      http:     { title: 'Upstream error',                 reason: 'The server is reachable but returned an error status. The exact code is shown above.' },
      error:    { title: 'Could not load the page',        reason: 'The page did not load. If this is a local service, make sure it is running and reachable from the DSH host.' },
    }

    // ── recent addresses (module scope → survives panel rebuilds) ───────────
    // "Remember recent addresses" is satisfied client-side: the module persists
    // across slot remounts, so no filesystem/host writes are needed.
    const recentUrls = []
    // One shared <datalist> appended to <body>; every panel's urlInput points at
    // it via list=<RECENT_LIST_ID>, so suggestions stay in sync across panels.
    let recentDatalist = null
    function ensureDatalist() {
      if (recentDatalist) return recentDatalist
      try {
        recentDatalist = document.createElement('datalist')
        recentDatalist.id = RECENT_LIST_ID
        document.body.appendChild(recentDatalist)
      } catch (_) { recentDatalist = null }
      return recentDatalist
    }
    function renderDatalist() {
      const dl = ensureDatalist()
      if (!dl) return
      try {
        dl.innerHTML = ''
        for (const u of recentUrls) {
          const opt = document.createElement('option')
          opt.value = u
          dl.appendChild(opt)
        }
      } catch (_) {}
    }
    // Add an address most-recent-first, de-duplicated, capped at RECENT_MAX.
    function rememberUrl(u) {
      const s = String(u || '').trim()
      if (!s) return
      const i = recentUrls.indexOf(s)
      if (i >= 0) recentUrls.splice(i, 1)
      recentUrls.unshift(s)
      if (recentUrls.length > RECENT_MAX) recentUrls.length = RECENT_MAX
      renderDatalist()
    }

    // ── devtools toolbox ────────────────────────────────────────────────────
    // Polls /web-preview/__events and renders console/network/error rows.
    function makeDevtools() {
      const state = {
        open: true,
        tab: 'console',
        events: [],
        since: 0,
        timer: null,
      }

      const consolePanel = el('div', { className: 'wprev-tools-panel' })
      const networkPanel = el('div', { className: 'wprev-tools-panel collapsed' })
      const errorPanel = el('div', { className: 'wprev-tools-panel collapsed' })
      const panels = { console: consolePanel, network: networkPanel, error: errorPanel }

      const countEl = el('span', { className: 'wprev-tools-count' }, '')
      const tabs = {}
      function setActive(tab) {
        state.tab = tab
        for (const t in tabs) {
          tabs[t].className = t === tab ? 'wprev-tools-tab active' : 'wprev-tools-tab'
          panels[t].className = t === tab ? 'wprev-tools-panel' : 'wprev-tools-panel collapsed'
        }
      }

      function row(cls, ...parts) {
        const r = el('div', { className: 'wprev-tools-row ' + cls })
        for (const p of parts) r.appendChild(p)
        return r
      }
      function span(cls, txt) { return el('span', { className: cls }, txt) }

      function renderConsole() {
        consolePanel.innerHTML = ''
        const list = state.events.filter(e => e.type === 'console')
        if (!list.length) { consolePanel.appendChild(el('div', { className: 'wprev-tools-empty' }, 'No console output yet.')); return }
        for (const e of list) {
          const lv = (e.level || 'log')
          const cls = lv === 'error' ? 'err' : lv === 'warn' ? 'warn' : lv === 'info' ? 'info' : ''
          consolePanel.appendChild(row(cls, span('ts', new Date(e.t).toLocaleTimeString()), span('lv', lv), el('span', null, e.args || '')))
        }
      }
      function renderNetwork() {
        networkPanel.innerHTML = ''
        const list = state.events.filter(e => e.type === 'network')
        if (!list.length) { networkPanel.appendChild(el('div', { className: 'wprev-tools-empty' }, 'No network activity yet.')); return }
        for (const e of list) {
          const st = e.status
          const cls = st === 'ERR' || (typeof st === 'number' && st >= 400) ? 'err' : (st === 200 || st === 'OK') ? 'ok' : ''
          const ms = e.ms ? ' · ' + e.ms + 'ms' : ''
          networkPanel.appendChild(row(cls, span('ts', new Date(e.t).toLocaleTimeString()), span('lv', String(st)), el('span', null, (e.method || 'GET') + ' ' + (e.url || '') + ms)))
        }
      }
      function renderErrors() {
        errorPanel.innerHTML = ''
        const list = state.events.filter(e => e.type === 'error')
        if (!list.length) { errorPanel.appendChild(el('div', { className: 'wprev-tools-empty' }, 'No errors captured.')); return }
        for (const e of list) {
          errorPanel.appendChild(row('err', span('ts', new Date(e.t).toLocaleTimeString()), el('span', null, (e.k ? e.k + ': ' : '') + (e.v || ''))))
        }
      }

      function refresh() {
        fetch('/web-preview/__events?since=' + state.since)
          .then(r => r.json())
          .then(d => {
            if (d && d.events && d.events.length) {
              state.events = state.events.concat(d.events)
              if (state.events.length > 1000) state.events = state.events.slice(-1000)
              state.since = d.latest || state.since
              const errs = state.events.filter(e => e.type === 'error').length
              const cons = state.events.filter(e => e.type === 'console').length
              const net = state.events.filter(e => e.type === 'network').length
              countEl.textContent = '● ' + errs + '  ✦ ' + cons + '  ⇄ ' + net
              if (state.tab === 'console') renderConsole()
              else if (state.tab === 'network') renderNetwork()
              else renderErrors()
            }
          }).catch(() => {})
      }

      const tabDefs = [
        { id: 'console', label: 'Console' },
        { id: 'network', label: 'Network' },
        { id: 'error', label: 'Errors' },
      ]
      const tabBar = el('div', { className: 'wprev-tools-bar' })
      for (const t of tabDefs) {
        const btn = el('button', {
          className: 'wprev-tools-tab' + (t.id === 'console' ? ' active' : ''),
          onclick: () => setActive(t.id),
        }, t.label)
        tabs[t.id] = btn
        tabBar.appendChild(btn)
      }
      tabBar.appendChild(countEl)
      const clearBtn = el('button', { className: 'wprev-tools-clear', onclick: () => {
        try { fetch('/web-preview/__clear', { method: 'POST' }).catch(() => {}) } catch (_) {}
        state.events = []
        state.since = 0
        countEl.textContent = ''
        renderConsole(); renderNetwork(); renderErrors()
      } }, 'Clear')
      const toggleBtn = el('button', { className: 'wprev-tools-toggle', onclick: () => {
        state.open = !state.open
        for (const p in panels) panels[p].className = state.open ? 'wprev-tools-panel' : 'wprev-tools-panel collapsed'
        toggleBtn.textContent = state.open ? '▾' : '▴'
      } }, '▾')
      tabBar.appendChild(clearBtn)
      tabBar.appendChild(toggleBtn)

      const root = el('div', { className: 'wprev-tools' }, tabBar, consolePanel, networkPanel, errorPanel)

      state.timer = setInterval(refresh, 1200)
      refresh()
      return {
        root,
        reset() { state.events = []; state.since = 0; countEl.textContent = ''; renderConsole(); renderNetwork(); renderErrors() },
        dispose() { if (state.timer) clearInterval(state.timer); state.timer = null },
      }
    }

    // ── shared preview frame builder ────────────────────────────────────────
    // Builds a toolbar (status, url + recent-address datalist, GO/Back/Reload/
    // Copy/Open/DEV/zoom, optional Close) + a status line + a zoomable frame
    // stage that races iframe `onload` against a timeout and, on failure, probes
    // the URL server-side to explain WHY. Returns DOM root + controls.
    function makePreviewPanel(opts) {
      const loadTimeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : LOAD_TIMEOUT_MS

      const dot = el('span', { className: 'wprev-dot' })
      const title = el('span', { className: 'wprev-title' }, opts.title || 'WEB PREVIEW')
      const urlInput = el('input', {
        className: 'wprev-url', type: 'text', list: RECENT_LIST_ID,
        placeholder: 'localhost:5173  or  https://example.com',
      })
      // Prefer a previously-loaded URL so switching conversations/views does
      // not lose the address; fall back to the configured default.
      if (persistedUrl) urlInput.value = persistedUrl
      else if (opts.defaultUrl) urlInput.value = opts.defaultUrl

      const goBtn = el('button', { className: 'wprev-btn primary', title: 'Load (Enter)' }, 'GO')
      const backBtn = el('button', { className: 'wprev-btn', title: 'Back (same-origin only)' }, '\u2190')
      const reloadBtn = el('button', { className: 'wprev-btn', title: 'Reload' }, '\u21BB')
      const copyBtn = el('button', { className: 'wprev-btn', title: 'Copy address' }, 'Copy')
      const extA = el('a', { className: 'wprev-btn', target: '_blank', rel: 'noreferrer noopener', title: 'Open in new tab' }, '\u2197')
      const devBtn = opts.withDevtools ? el('button', { className: 'wprev-btn', title: 'Toggle devtools' }, 'DEV') : null
      const closeBtn = opts.draggable ? el('button', { className: 'wprev-btn', title: 'Close' }, '\u2715') : null
      const zoomOut = el('button', { title: 'Zoom out' }, '\u2212')
      const zoomVal = el('span', { className: 'wprev-zoom-val' }, '100%')
      const zoomIn = el('button', { title: 'Zoom in' }, '+')
      const zoomReset = el('button', { title: 'Reset zoom to 100%' }, 'Reset')
      const zoom = el('div', { className: 'wprev-zoom', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomVal, zoomIn, zoomReset)

      const head = el('div', { className: 'wprev-head' }, dot, title, urlInput, goBtn, backBtn, reloadBtn, copyBtn, extA, devBtn, zoom, closeBtn)

      // Status line — the human-readable loading/success/failure state (the dot
      // mirrors it for glanceability).
      const statusMsg = el('span', { className: 'wprev-status-msg' }, 'Enter a URL and press GO.')
      const statusLine = el('div', { className: 'wprev-status' }, statusMsg)

      // Zoomable stage: stage (clips) → scaler (transform target) → frame.
      const scaler = el('div', { className: 'wprev-scaler' })
      const stage = el('div', { className: 'wprev-stage' }, scaler)
      const errCard = el('div', { className: 'wprev-err-card wprev-hidden' })
      const frameWrap = el('div', { className: 'wprev-body' }, stage, errCard)

      let frame = null
      let currentUrl = ''
      let currentInput = ''
      let devRoot = null
      let devOpen = false
      let devDispose = null
      let zoomPct = ZOOM_DEFAULT
      let loadTimer = null
      let probeTimer = null
      let loadStart = 0
      let dragging = null
      let destroyed = false

      // Buttons that only make sense once a frame is loaded.
      const needsFrame = [backBtn, reloadBtn, copyBtn]
      function setEnabled(btn, on) { try { btn.disabled = !on } catch (_) {} }
      function refreshEnabled() {
        const has = !!frame
        for (const b of needsFrame) setEnabled(b, has)
        if (!has) { stage.style.cursor = ''; }
      }
      function setStatus(text, kind) {
        statusMsg.textContent = text
        statusLine.className = 'wprev-status' + (kind ? ' ' + kind : '')
        const cls = kind === 'ok' ? 'wprev-dot loaded' : kind === 'error' || kind === 'warn' ? 'wprev-dot error' : kind === 'loading' ? 'wprev-dot loading' : 'wprev-dot'
        dot.className = cls
      }

      // Render a friendly failure card over the frame area. `kind` is a stable
      // code (empty|invalid|dns|refused|timeout|cert|aborted|http|error) that
      // maps to plain-language title + reason. Never shows a stack trace.
      function showError(kind, url, status) {
        const info = ERROR_TEXT[kind] || ERROR_TEXT.error
        let titleTxt = info.title
        // Upstream answered but with an error status → say which.
        if (kind === 'http' && status) titleTxt = 'Upstream returned ' + status
        errCard.innerHTML = ''
        errCard.appendChild(el('div', { className: 'wprev-err-inner' },
          el('div', { className: 'wprev-err-title' }, el('span', { className: 'ico' }, '\u26A0'), titleTxt),
          el('p', { className: 'wprev-err-reason' }, info.reason),
          url ? el('div', { className: 'wprev-err-url' }, url) : null,
          el('div', { className: 'wprev-err-actions' },
            el('button', {
              className: 'wprev-btn primary',
              onclick: () => { hideError(); loadUrl() },
            }, 'Retry'),
          ),
        ))
        errCard.classList.remove('wprev-hidden')
      }
      function hideError() { errCard.classList.add('wprev-hidden') }

      // Map a probe result ({ok,status,error}) to a failure kind + reason.
      function probeFailure(res) {
        const code = res && res.error
        if (code && ERROR_TEXT[code]) return { kind: code, status: res.status }
        if (res && res.status && res.status >= 400) return { kind: 'http', status: res.status }
        return { kind: 'error' }
      }
      function probeUrl(u) {
        try {
          fetch('/web-preview/__probe?u=' + encodeURIComponent(u))
            .then(r => r.json())
            .then(res => {
              if (destroyed) return
              if (res && res.ok) {
                // Reachable now (transient slowness) — offer retry, soft message.
                setStatus('The server answered the probe but the page did not load in time. Retry.', 'warn')
                return
              }
              const f = probeFailure(res)
              showError(f.kind, currentUrl || u, f.status)
              setStatus((ERROR_TEXT[f.kind] || ERROR_TEXT.error).title, 'error')
            })
            .catch(() => {
              if (!destroyed) { showError('error', currentUrl || u); setStatus(ERROR_TEXT.error.title, 'error') }
            })
        } catch (_) {
          if (!destroyed) { showError('error', currentUrl || u); setStatus(ERROR_TEXT.error.title, 'error') }
        }
      }

      function postMetric(fields) {
        try { fetch('/web-preview/__metric', { method: 'POST', 'content-type': 'application/json', body: JSON.stringify(fields) }).catch(() => {}) } catch (_) {}
      }

      function clearLoadTimer() {
        if (loadTimer) { try { clearTimeout(loadTimer) } catch (_) {} loadTimer = null }
      }

      function loadUrl() {
        const raw = String(urlInput.value || '').trim()
        const u = normalize(raw)
        if (!u) {
          // Empty / unnormalizable address — friendly inline message, not silent.
          setStatus(!raw ? 'Enter an address to preview.' : 'That does not look like a valid address.', 'warn')
          if (!raw) showError('empty')
          return
        }
        const proxy = toProxyUrl(u)
        const target = proxy || u
        // Keep the toolbar showing the HUMAN-readable input, not the proxy path.
        urlInput.value = u
        currentUrl = target
        currentInput = u
        persistedUrl = u
        rememberUrl(u)
        hideError()

        // Tear down any previous frame before building a fresh one.
        if (frame) { try { frame.src = 'about:blank' } catch (_) {} try { scaler.removeChild(frame) } catch (_) {} frame = null }
        frame = el('iframe', {
          className: 'wprev-frame',
          src: 'about:blank',
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
          referrerpolicy: 'no-referrer',
        })
        scaler.appendChild(frame)
        refreshEnabled()
        applyZoom()

        // Race iframe `onload` against a timeout. Cross-origin frames expose no
        // load status to the parent, so this clock + the host probe are the only
        // reliable failure signals.
        setStatus('Loading\u2026', 'loading')
        loadStart = performance.now()
        clearLoadTimer()
        loadTimer = setTimeout(() => {
          loadTimer = null
          if (destroyed || !frame) return
          setStatus('Timed out', 'error')
          // Explain WHY via a server-side probe (service down / DNS / cert / slow).
          if (probeTimer) clearTimeout(probeTimer)
          probeTimer = setTimeout(() => { probeTimer = null; probeUrl(u) }, 0)
        }, loadTimeoutMs)

        frame.onload = () => {
          if (destroyed) return
          clearLoadTimer()
          const ms = Math.max(0, Math.round(performance.now() - loadStart))
          setStatus('Loaded in ' + ms + 'ms', 'ok')
          postMetric({ loadId: currentInput, url: currentUrl, ms, ok: true })
        }
        // NOTE: cross-origin frame load *errors* do not surface to the parent;
        // `onerror` is unreliable here, so the timeout + probe path handles it.

        // Defer the real navigation so the frame is attached first.
        setTimeout(() => { if (!destroyed && frame) { try { frame.src = target } catch (_) {} } }, 0)
        extA.href = target
      }

      function doReload() {
        if (!frame) return
        setStatus('Reloading\u2026', 'loading')
        // Re-run the full load path so the timeout/probe race re-arms.
        try { loadUrl() } catch (_) {}
      }

      function doBack() {
        if (!frame) return
        try {
          frame.contentWindow.history.back()
        } catch (_) {
          // Cross-origin frames do not expose history to the parent.
          setStatus('Back is unavailable for cross-origin pages.', 'warn')
        }
      }

      function doCopy() {
        const text = currentUrl || currentInput || urlInput.value || ''
        if (!text) return
        let done = false
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {}, () => {})
            done = true
          }
        } catch (_) {}
        if (!done) {
          // Fallback for non-secure contexts where the async clipboard is absent.
          try {
            const ta = el('textarea', { style: { position: 'fixed', left: '-1000px', top: '0' } })
            ta.value = text
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
          } catch (_) {}
        }
        const prev = copyBtn.textContent
        copyBtn.textContent = 'Copied'
        setTimeout(() => { try { copyBtn.textContent = prev === 'Copied' ? 'Copy' : prev } catch (_) {} }, 1200)
      }

      function applyZoom() {
        const pct = zoomPct / 100
        try {
          scaler.style.transform = 'scale(' + pct + ')'
          // Size the frame to 100%/zoom so the scaled content fills the stage.
          frame.style.width = (100 / pct) + '%'
          frame.style.height = (100 / pct) + '%'
          zoomVal.textContent = zoomPct + '%'
        } catch (_) {}
        setEnabled(zoomOut, zoomPct > ZOOM_MIN)
        setEnabled(zoomIn, zoomPct < ZOOM_MAX)
        setEnabled(zoomReset, zoomPct !== ZOOM_DEFAULT)
      }
      function setZoom(pct) {
        zoomPct = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(pct)))
        applyZoom()
      }

      goBtn.onclick = loadUrl
      reloadBtn.onclick = doReload
      backBtn.onclick = doBack
      copyBtn.onclick = doCopy
      zoomOut.onclick = () => setZoom(zoomPct - ZOOM_STEP)
      zoomIn.onclick = () => setZoom(zoomPct + ZOOM_STEP)
      zoomReset.onclick = () => setZoom(ZOOM_DEFAULT)
      urlInput.onkeydown = (e) => { if (e.key === 'Enter') loadUrl() }
      extA.onclick = (e) => { if (!currentUrl) e.preventDefault() }
      if (devBtn) devBtn.onclick = () => {
        devOpen = !devOpen
        if (devRoot) devRoot.style.display = devOpen ? '' : 'none'
        devBtn.className = 'wprev-btn' + (devOpen ? ' active' : '')
      }
      if (closeBtn) closeBtn.onclick = () => { if (opts.onClose) opts.onClose() }

      refreshEnabled()
      applyZoom()

      let win
      let onDocPointerMove = null
      let onDocPointerUp = null
      if (opts.draggable) {
        win = el('div', {
          className: 'wprev-win wprev-hidden',
          style: { right: '96px', top: '72px', width: '960px', height: '620px' },
        }, head, statusLine, frameWrap)
        // Drag the window via the head. The document-level move/up handlers are
        // stored so destroy() can remove them — they previously leaked on every
        // panel rebuild because nothing ever removed them.
        let drag = null
        head.onpointerdown = (e) => {
          const t = e.target
          if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'A')) return
          const rect = win.getBoundingClientRect()
          drag = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top }
          e.preventDefault()
        }
        onDocPointerMove = (e) => {
          if (!drag) return
          const w = window.innerWidth
          const h = window.innerHeight
          const nx = Math.max(0, Math.min(w - 200, drag.ox + (e.clientX - drag.sx)))
          const ny = Math.max(0, Math.min(h - 60, drag.oy + (e.clientY - drag.sy)))
          win.style.left = nx + 'px'
          win.style.top = ny + 'px'
          win.style.right = 'auto'
        }
        onDocPointerUp = () => { drag = null }
        document.addEventListener('pointermove', onDocPointerMove)
        document.addEventListener('pointerup', onDocPointerUp)
      } else {
        win = el('div', { className: 'wprev-embed-view' }, head, statusLine, frameWrap)
      }

      // Auto-restore the last-loaded URL: a rebuilt panel (e.g. after switching
      // conversations) should re-open the previous address instead of leaving
      // the frame area empty and requiring the user to type it again. When
      // caching is disabled, restore only the address text, not a live reload.
      if (persistedUrl && cacheEnabled) {
        try { loadUrl() } catch (_) {}
      } else if (persistedUrl) {
        setStatus('Address restored. Press GO to load.', '')
      }

      return {
        root: win,
        head,
        loadUrl,
        show: () => {
          win.classList.remove('wprev-hidden')
          // Re-opening an already-loaded panel should not force a reload when
          // the address is unchanged and a live frame exists.
          if (frame && currentInput && String(urlInput.value || '').trim() === currentInput) return
          if (persistedUrl && cacheEnabled && (!frame || String(urlInput.value || '').trim() !== persistedUrl)) {
            try { loadUrl() } catch (_) {}
          }
        },
        hide: () => { win.classList.add('wprev-hidden') },
        mountDevtools: (dt) => { devRoot = dt.root; devDispose = dt && dt.dispose ? dt.dispose : null; win.appendChild(dt.root) },
        destroy: () => {
          destroyed = true
          clearLoadTimer()
          if (probeTimer) { try { clearTimeout(probeTimer) } catch (_) {} probeTimer = null }
          if (onDocPointerMove) { try { document.removeEventListener('pointermove', onDocPointerMove) } catch (_) {} onDocPointerMove = null }
          if (onDocPointerUp) { try { document.removeEventListener('pointerup', onDocPointerUp) } catch (_) {} onDocPointerUp = null }
          dragging = null
          if (frame) { try { frame.src = 'about:blank' } catch (_) {} try { scaler.removeChild(frame) } catch (_) {} frame = null }
          if (devDispose) { try { devDispose() } catch (_) {} devDispose = null }
        },
      }
    }

    // ── floating window (shell.overlay) ─────────────────────────────────────
    function buildFloating() {
      const fab = el('button', { className: 'wprev-fab', title: 'Open Web Preview' }, 'PREVIEW')
      const panel = makePreviewPanel({
        title: 'WEB PREVIEW',
        draggable: true,
        defaultUrl: defaultUrl,
        timeoutMs: hostTimeoutMs,
        cacheEnabled: cacheEnabled,
        onClose: () => { panel.hide(); fab.classList.remove('wprev-hidden') },
      })
      fab.onclick = () => { panel.show(); fab.classList.add('wprev-hidden') }
      const root = el('div', { id: 'wprev-root' }, panel.root, fab)
      return { root, panel }
    }

    // ── embedded tab DOM (mounted by React host) ────────────────────────────
    function buildEmbeddedDOM() {
      const panel = makePreviewPanel({
        title: 'WEB PREVIEW',
        draggable: false,
        withDevtools: true,
        defaultUrl: defaultUrl,
        timeoutMs: hostTimeoutMs,
        cacheEnabled: cacheEnabled,
      })
      const devtools = makeDevtools()
      panel.mountDevtools(devtools)
      return { root: panel.root, devtools, panel }
    }

    // ── apply ────────────────────────────────────────────────────────────────
    const inject = ['slots']

    // Config default URL, fetched from the host's /web-preview/__config and
    // used to prefill the toolbar. Empty until loaded.
    let defaultUrl = ''

    // Last URL the user loaded, kept at module scope so the preview survives
    // slot unmount/remount (e.g. switching conversations), which would
    // otherwise rebuild the panel from scratch and lose the address.
    let persistedUrl = ''

    function apply(ctx) {
      console.info('[dsh-web-preview] apply entered')

      // 1. Stylesheet — install immediately so the config fetch below doesn't
      //    delay first paint of the shell.
      ctx.effect(() => {
        const tagId = 'dsh-web-preview/app.css'
        if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return () => {}
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', tagId)
        style.setAttribute('data-plugin', 'dsh-web-preview')
        style.textContent = CLIENT_CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'dsh-web-preview: styles')

      // 0. Fetch the host config FIRST, then build the panels, so the load
      //    timeout / cache behavior / default URL are already resolved when the
      //    toolbar is constructed. Falls back to consts if the fetch fails.
      const ready = fetch('/web-preview/__config')
        .then(r => r.json())
        .then(d => {
          if (d) {
            if (d.defaultUrl) defaultUrl = d.defaultUrl
            if (Number.isFinite(d.timeoutMs) && d.timeoutMs > 0) hostTimeoutMs = d.timeoutMs
            if (typeof d.cacheEnabled === 'boolean') cacheEnabled = d.cacheEnabled
          }
        })
        .catch(() => {})

      // Build both surfaces once config is in hand. `go()` is idempotent-safe:
      // each surface builds at most once per apply.
      let builtFloating = false
      let builtEmbedded = false
      ready.then(() => { try { buildFloatingSurface(ctx) } catch (err) { console.error('[dsh-web-preview] floating UI failed:', err) } })
      ready.then(() => { try { buildEmbeddedSurface(ctx) } catch (err) { console.error('[dsh-web-preview] embedded UI failed:', err) } })

      // ── floating window surface ───────────────────────────────────────────
      // Mounted into a React host so the shell's own re-renders don't wipe it.
      // If React is unavailable, fall back to a plain body append (best-effort).
      let container = null
      function buildFloatingSurface(ctx) {
        if (builtFloating) return
        builtFloating = true
        if (React && useEffect && useRef) {
          const FloatingHost = () => {
            const hostRef = useRef(null)
            useEffect(() => {
              if (!hostRef.current) return
              const built = buildFloating()
              hostRef.current.appendChild(built.root)
              // destroy() releases the draggable document listeners + timers.
              return () => { try { built.panel.destroy() } catch (_) {}; try { hostRef.current.innerHTML = '' } catch (_) {} }
            }, [])
            return React.createElement('div', { ref: hostRef })
          }
          try {
            ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay',
              id: 'web-preview-fab',
              order: 50,
            }, () => React.createElement(FloatingHost)))
          } catch (_) {}
        } else {
          container = document.createElement('div')
          container.id = 'dsh-web-preview-root'
          container.setAttribute('data-plugin', 'dsh-web-preview')
          document.body.appendChild(container)
          const built = buildFloating()
          container.appendChild(built.root)
        }
      }

      // ── embedded conversation-view surface ────────────────────────────────
      function buildEmbeddedSurface(ctx) {
        if (builtEmbedded) return
        builtEmbedded = true
        if (ctx.slots === undefined) return
        // Must return a React element (the slot system renders React). If React
        // is missing, fall back to a plain DOM node best-effort.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'web-preview',
          order: 5,
          label: () => 'Web Preview',
        }, (props) => {
          if (React && useEffect && useRef) {
            const hostRef = useRef(null)
            useEffect(() => {
              if (!hostRef.current) return
              const built = buildEmbeddedDOM()
              hostRef.current.appendChild(built.root)
              // devtools owns the poll interval; panel.destroy() clears the
              // load clock. Both are idempotent, so dispose twice is harmless.
              return () => {
                try { built.devtools.dispose() } catch (_) {}
                try { built.panel.destroy() } catch (_) {}
                try { hostRef.current.innerHTML = '' } catch (_) {}
              }
            }, [])
            return React.createElement('div', { ref: hostRef, className: 'wprev-embed', style: { width: '100%', height: '100%' } })
          }
          // React unavailable: best-effort plain DOM host.
          const built = buildEmbeddedDOM()
          const host = el('div', { className: 'wprev-embed', style: { width: '100%', height: '100%' } }, built.root)
          setTimeout(() => {
            try { built.devtools.dispose() } catch (_) {}
            try { built.panel.destroy() } catch (_) {}
          }, 0)
          return host
        }))
      }

      // 4. Cleanup on dispose
      ctx.effect(() => () => {
        try { container && container.remove() } catch (_) {}
      }, 'dsh-web-preview: cleanup')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
