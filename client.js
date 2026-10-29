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
    // Builds a toolbar (dot, title, url, GO, reload, new-tab, optional devtools
    // toggle) + a frame area. Returns an object with the DOM root and controls.
    function makePreviewPanel(opts) {
      const dot = el('span', { className: 'wprev-dot' })
      const title = el('span', { className: 'wprev-title' }, opts.title || 'WEB PREVIEW')
      const urlInput = el('input', { className: 'wprev-url', type: 'text', placeholder: 'localhost:5173  or  https://example.com' })
      if (opts.defaultUrl) urlInput.value = opts.defaultUrl
      const goBtn = el('button', { className: 'wprev-btn primary' }, 'GO')
      const reloadBtn = el('button', { className: 'wprev-btn', title: 'Reload' }, '\u21BB')
      const extA = el('a', { className: 'wprev-btn', target: '_blank', rel: 'noreferrer noopener', title: 'Open in new tab' }, '\u2197')
      const devBtn = opts.withDevtools ? el('button', { className: 'wprev-btn', title: 'Toggle devtools' }, 'DEV') : null
      const closeBtn = opts.draggable ? el('button', { className: 'wprev-btn', title: 'Close' }, '\u2715') : null

      const head = el('div', { className: 'wprev-head' }, dot, title, urlInput, goBtn, reloadBtn, extA, devBtn, closeBtn)

      const empty = el('div', { className: 'wprev-empty' }, 'Enter a URL and press GO.')
      const frameWrap = el('div', { className: 'wprev-body' }, empty)
      let frame = null
      let currentUrl = ''
      let devRoot = null
      let devOpen = false

      function loadUrl() {
        const u = normalize(urlInput.value)
        if (!u) return
        const proxy = toProxyUrl(u)
        const target = proxy || u
        // Keep the toolbar showing the HUMAN-readable input, not the proxy path.
        urlInput.value = u
        currentUrl = target
        if (frame) { try { frameWrap.removeChild(frame) } catch (_) {} }
        frame = el('iframe', {
          className: 'wprev-frame',
          src: 'about:blank',
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
          referrerpolicy: 'no-referrer',
        })
        if (empty.parentNode === frameWrap) frameWrap.removeChild(empty)
        frameWrap.appendChild(frame)
        setTimeout(() => { if (frame) frame.src = target }, 0)
        frame.onload = () => { dot.className = 'wprev-dot loaded' }
        dot.className = 'wprev-dot loading'
        extA.href = target
      }
      goBtn.onclick = loadUrl
      reloadBtn.onclick = () => { if (frame) { frame.src = frame.src } }
      urlInput.onkeydown = (e) => { if (e.key === 'Enter') loadUrl() }
      extA.onclick = (e) => { if (!currentUrl) e.preventDefault() }
      if (devBtn) devBtn.onclick = () => {
        devOpen = !devOpen
        if (devRoot) devRoot.style.display = devOpen ? '' : 'none'
        devBtn.className = 'wprev-btn' + (devOpen ? ' active' : '')
      }
      if (closeBtn) closeBtn.onclick = () => { if (opts.onClose) opts.onClose() }

      let win
      if (opts.draggable) {
        win = el('div', {
          className: 'wprev-win wprev-hidden',
          style: { right: '96px', top: '72px', width: '960px', height: '620px' },
        }, head, frameWrap)
        // Drag the window via the head.
        let drag = null
        head.onpointerdown = (e) => {
          const t = e.target
          if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'A')) return
          const rect = win.getBoundingClientRect()
          drag = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top }
          e.preventDefault()
        }
        document.addEventListener('pointermove', (e) => {
          if (!drag) return
          const w = window.innerWidth
          const h = window.innerHeight
          const nx = Math.max(0, Math.min(w - 200, drag.ox + (e.clientX - drag.sx)))
          const ny = Math.max(0, Math.min(h - 60, drag.oy + (e.clientY - drag.sy)))
          win.style.left = nx + 'px'
          win.style.top = ny + 'px'
          win.style.right = 'auto'
        })
        document.addEventListener('pointerup', () => { drag = null })
      } else {
        win = el('div', { className: 'wprev-embed-view' }, head, frameWrap)
      }

      return {
        root: win,
        head,
        loadUrl,
        show: () => { win.classList.remove('wprev-hidden') },
        hide: () => { win.classList.add('wprev-hidden') },
        mountDevtools: (dt) => { devRoot = dt.root; win.appendChild(dt.root) },
        destroy: () => { if (frame) frame.src = 'about:blank' },
      }
    }

    // ── floating window (shell.overlay) ─────────────────────────────────────
    function buildFloating() {
      const fab = el('button', { className: 'wprev-fab', title: 'Open Web Preview' }, 'PREVIEW')
      const panel = makePreviewPanel({
        title: 'WEB PREVIEW',
        draggable: true,
        defaultUrl: defaultUrl,
        onClose: () => { panel.hide(); fab.classList.remove('wprev-hidden') },
      })
      fab.onclick = () => { panel.show(); fab.classList.add('wprev-hidden') }
      const root = el('div', { id: 'wprev-root' }, panel.root, fab)
      return root
    }

    // ── embedded tab DOM (mounted by React host) ────────────────────────────
    function buildEmbeddedDOM() {
      const panel = makePreviewPanel({
        title: 'WEB PREVIEW',
        draggable: false,
        withDevtools: true,
        defaultUrl: defaultUrl,
      })
      const devtools = makeDevtools()
      panel.mountDevtools(devtools)
      return { root: panel.root, devtools }
    }

    // ── apply ────────────────────────────────────────────────────────────────
    const inject = ['slots']

    // Config default URL, fetched from the host's /web-preview/__config and
    // used to prefill the toolbar. Empty until loaded.
    let defaultUrl = ''

    function apply(ctx) {
      console.info('[dsh-web-preview] apply entered')

      // 0. Fetch the host config so the toolbar can prefill a sensible default.
      try {
        fetch('/web-preview/__config').then(r => r.json()).then(d => {
          if (d && d.defaultUrl) defaultUrl = d.defaultUrl
        }).catch(() => {})
      } catch (_) {}

      // 1. Stylesheet
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

      // 2. Floating window — mount into a React host so the shell's own
      // re-renders don't wipe it. If React is unavailable, fall back to a
      // plain body append (best-effort, may be wiped by shell re-renders).
      let container = null
      if (React && useEffect && useRef) {
        const FloatingHost = () => {
          const hostRef = useRef(null)
          useEffect(() => {
            if (!hostRef.current) return
            const root = buildFloating()
            hostRef.current.appendChild(root)
            return () => { try { hostRef.current.innerHTML = '' } catch (_) {} }
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
        try { container.appendChild(buildFloating()) } catch (err) { console.error('[dsh-web-preview] floating UI failed:', err) }
      }

      // 3. Slot registrations. Mirror the reference pattern exactly: the
      // inject callback RETURNS the register(...) disposer.
      if (ctx.slots !== undefined) {
        // 3b. Embedded conversation-view tab with devtools. Must return a
        // React element (the slot system renders React). If React is missing,
        // fall back to a plain DOM node best-effort.
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
              return () => { try { built.devtools.dispose() } catch (_) {}; try { hostRef.current.innerHTML = '' } catch (_) {} }
            }, [])
            return React.createElement('div', { ref: hostRef, className: 'wprev-embed', style: { width: '100%', height: '100%' } })
          }
          // React unavailable: best-effort plain DOM host.
          const built = buildEmbeddedDOM()
          const host = el('div', { className: 'wprev-embed', style: { width: '100%', height: '100%' } }, built.root)
          setTimeout(() => { try { built.devtools.dispose() } catch (_) {} }, 0)
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
