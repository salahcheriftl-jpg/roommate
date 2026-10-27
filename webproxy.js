// Web proxy for the TV browser.
//
// Most sites (Google included) refuse to be shown inside an <iframe> (X-Frame-Options /
// CSP frame-ancestors). So the TV loads pages through this server instead:
//
//   /web/<scheme>/<host>/<path>?<query>      e.g.  /web/https/www.google.com/search?q=cats
//
// The proxy fetches the page, drops the headers that forbid framing, rewrites links so they
// keep going through the proxy, and injects a small script (see `shim`) for the things that
// can't be rewritten ahead of time (fetch, XHR, history, ...).
//
// Safety:
//  - private / loopback / link-local addresses are refused (checked at connect time, so DNS
//    tricks can't get around it)
//  - every proxied response carries `Content-Security-Policy: sandbox`, so proxied scripts run
//    with an opaque origin and can never touch the ROOMMATE page, its storage or its sockets
//  - simple per-IP rate limit so a public deployment is not a free open proxy
//
// Known limits: no cookies/logins, no WebSockets, heavy web apps may break.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const express = require('express');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_REWRITE_BYTES = 6 * 1024 * 1024; // html/css bigger than this is refused
const RATE_LIMIT = 900;                    // requests per IP per minute

// ---------------------------------------------------------------- safety
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return s.startsWith('::ffff:') || s.startsWith('64:ff9b:') || /^(fc|fd|fe[89ab]|ff)/.test(s);
  }
  return true;
}

// used as the `lookup` option of http(s).request: only public addresses may be connected to
function safeLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !isPrivateIp(a.address));
    if (!ok.length) return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

const hits = new Map(); // ip -> { n, t }
function rateLimited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.t > 60000) { h = { n: 0, t: now }; hits.set(ip, h); }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > 60000) hits.delete(k);
  return ++h.n > RATE_LIMIT;
}

// ---------------------------------------------------------------- url helpers
function toProxy(a) { // URL object -> proxied path
  return '/web/' + a.protocol.slice(0, -1) + '/' + a.host + a.pathname + a.search + a.hash;
}

const SKIP = /^(#|data:|blob:|javascript:|about:|mailto:|tel:|sms:)/i;
function proxify(raw, base, html) {
  let s = String(raw || '').trim();
  if (!s || SKIP.test(s)) return raw;
  if (html) s = s.replace(/&amp;/gi, '&');
  try {
    const a = new URL(s, base);
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return raw;
    return toProxy(a);
  } catch (e) { return raw; }
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi, (m, a, b, c) => {
      const u = a !== undefined ? a : b !== undefined ? b : c;
      return 'url("' + String(proxify(u, base, false)).replace(/"/g, '%22') + '")';
    })
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (m, a, b) => '@import "' + String(proxify(a !== undefined ? a : b, base, false)).replace(/"/g, '%22') + '"');
}

function rewriteHtml(html, pageUrl) {
  let base = pageUrl;
  const bm = html.match(/<base\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/i);
  if (bm) { try { base = new URL(bm[1] !== undefined ? bm[1] : bm[2], pageUrl).href; } catch (e) {} }
  html = html.replace(/<base\s[^>]*>/gi, '');

  // integrity hashes and credentialed CORS no longer hold once we rewrite things
  html = html.replace(/\s(?:integrity|crossorigin)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');

  html = html.replace(/(\s(?:href|src|action|formaction|poster|data-src|data-href|background)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (m, pre, a, b) => pre + '"' + esc(proxify(a !== undefined ? a : b, base, true)) + '"');

  html = html.replace(/(\s(?:srcset|data-srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, b) => {
    const list = (a !== undefined ? a : b).split(/\s*,\s+/).map((c) => {
      const p = c.trim().split(/\s+/);
      p[0] = proxify(p[0], base, true);
      return p.join(' ');
    });
    return pre + '"' + esc(list.join(', ')) + '"';
  });

  html = html.replace(/(<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'])(\s*\d+\s*;\s*url\s*=\s*)([^"']+)/i,
    (m, a, b, c) => a + b + esc(proxify(c, base, true)));

  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, c) => a + rewriteCss(css, base) + c);
  return html;
}

// ---------------------------------------------------------------- injected script (runs in the page)
// Written as a normal function and serialised into the page. `REAL` = the real URL of the page.
function shim(REAL) {
  var RX = /^\/web\/https?\//i;
  function px(u) {
    try {
      if (u == null) return u;
      var s = String(u);
      if (!s || /^(#|data:|blob:|javascript:|about:|mailto:|tel:)/i.test(s)) return s;
      if (RX.test(s) || s.indexOf(location.origin + '/web/') === 0) return s;
      var a = new URL(s, REAL);
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return s;
      return '/web/' + a.protocol.slice(0, -1) + '/' + a.host + a.pathname + a.search + a.hash;
    } catch (e) { return u; }
  }
  function note() { try { parent.postMessage({ rmweb: 1, url: REAL, title: document.title }, '*'); } catch (e) {} }
  function fromLoc() {
    var m = location.pathname.match(/^\/web\/(https?)\/([^\/]+)(\/.*)?$/);
    if (m) REAL = m[1] + '://' + m[2] + (m[3] || '/') + location.search + location.hash;
  }

  // this page has an opaque origin (sandbox): give scripts harmless in-memory storage
  function mem() {
    var d = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
      setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; },
      clear: function () { d = {}; }, key: function (i) { return Object.keys(d)[i] || null; },
      get length() { return Object.keys(d).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (n) {
    try { var s = mem(); Object.defineProperty(window, n, { configurable: true, get: function () { return s; } }); } catch (e) {}
  });
  try {
    var jar = {};
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get: function () { return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; '); },
      set: function (v) { var p = String(v).split(';')[0], i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
    });
  } catch (e) {}

  // requests made by scripts
  var of = window.fetch;
  if (of) window.fetch = function (i, o) {
    try {
      if (typeof i === 'string' || i instanceof URL) i = px(i);
      else if (i && i.url) i = new Request(px(i.url), i);
    } catch (e) {}
    o = Object.assign({}, o, { credentials: 'omit' });
    return of.call(this, i, o);
  };
  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { var a = [].slice.call(arguments); a[1] = px(u); return xo.apply(this, a); };
  try { Object.defineProperty(XMLHttpRequest.prototype, 'withCredentials', { configurable: true, get: function () { return false; }, set: function () {} }); } catch (e) {}
  if (navigator.sendBeacon) { var sb = navigator.sendBeacon; navigator.sendBeacon = function (u, d) { return sb.call(navigator, px(u), d); }; }

  // urls set on elements by scripts
  var URLATTR = { href: 1, src: 1, action: 1, formaction: 1, poster: 1 };
  var sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) { if (URLATTR[String(n).toLowerCase()]) v = px(v); return sa.call(this, n, v); };
  [[HTMLAnchorElement, 'href'], [HTMLLinkElement, 'href'], [HTMLScriptElement, 'src'], [HTMLImageElement, 'src'],
   [HTMLIFrameElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLFormElement, 'action'],
   [HTMLEmbedElement, 'src'], [HTMLTrackElement, 'src']].forEach(function (p) {
    try {
      var d = Object.getOwnPropertyDescriptor(p[0].prototype, p[1]);
      if (d && d.set) Object.defineProperty(p[0].prototype, p[1], { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, px(v)); } });
    } catch (e) {}
  });

  // single-page apps changing the address
  ['pushState', 'replaceState'].forEach(function (k) {
    var o = history[k];
    history[k] = function (s, t, u) {
      if (u != null && u !== '') {
        try { REAL = new URL(String(u), REAL).href; } catch (e) {}
        u = px(u);
      }
      var r = o.call(history, s, t, u);
      note();
      return r;
    };
  });
  addEventListener('popstate', function () { fromLoc(); note(); });
  addEventListener('hashchange', function () { fromLoc(); note(); });

  // never open real popups / new tabs: stay on the TV
  window.open = function (u) { if (u && navigator.userActivation && navigator.userActivation.isActive) location.href = px(u); return null; };
  addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[target]');
    if (a && a.target !== '_self') a.target = '_self';
  }, true);
  addEventListener('submit', function (e) { var f = e.target; if (f && f.target && f.target !== '_self') f.target = '_self'; }, true);

  // talk to the ROOMMATE page
  addEventListener('keydown', function (e) { if (e.key === 'Escape') { try { parent.postMessage({ rmweb: 1, esc: 1 }, '*'); } catch (x) {} } }, true);
  addEventListener('message', function (e) {
    var d = e.data;
    if (!d || e.source !== parent) return;
    if (d.rmcmd === 'back') history.back();
    else if (d.rmcmd === 'forward') history.forward();
    else if (d.rmcmd === 'reload') location.reload();
  });
  var lt = null;
  setInterval(function () { if (document.title !== lt) { lt = document.title; note(); } }, 1500);
  addEventListener('load', note);
  note();
}

function shimTag(real) {
  return '<script>(' + shim.toString() + ')(' + JSON.stringify(real).replace(/</g, '\\u003c') + ')</script>';
}

function injectShim(html, real) {
  const tag = shimTag(real);
  let m = html.match(/<head[^>]*>/i);
  if (!m) m = html.match(/<html[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const d = html.match(/^\s*<!doctype[^>]*>/i);
  return d ? d[0] + tag + html.slice(d[0].length) : tag + html;
}

// ---------------------------------------------------------------- the route
const PASS_HEADERS = ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control', 'expires', 'content-disposition'];

function errorPage(res, status, msg) {
  if (res.headersSent) return res.end();
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': 'sandbox allow-scripts allow-forms',
    'Access-Control-Allow-Origin': '*'
  }).send('<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0f12;color:#9fb0b8;font:16px system-ui,sans-serif;text-align:center">' +
    '<div><div style="font-size:42px;letter-spacing:4px;color:#c4cdd2">NO SIGNAL</div><p>' + String(msg).replace(/</g, '&lt;') + '</p></div>');
}

function handle(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
      'Access-Control-Max-Age': '600'
    }).end();
  }
  if (rateLimited(req.ip)) return errorPage(res, 429, 'Too many requests, slow down.');

  const m = req.originalUrl.match(/^\/web\/(https?)\/([^\/?#]+)([^#]*)$/i);
  if (!m) return errorPage(res, 400, 'Bad address.');
  const rest = m[3] ? (m[3][0] === '?' ? '/' + m[3] : m[3]) : '/';
  let target;
  try { target = new URL(m[1].toLowerCase() + '://' + m[2] + rest); } catch (e) { return errorPage(res, 400, 'Bad address.'); }
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_PORTS.has(target.port)) return errorPage(res, 403, 'That port is not allowed.');
  if (net.isIP(host) && isPrivateIp(host)) return errorPage(res, 403, 'That address is not allowed.');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) return errorPage(res, 403, 'That address is not allowed.');

  const headers = {
    'user-agent': UA,
    'accept': req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'accept-encoding': 'identity'
  };
  if (req.headers.range) headers.range = req.headers.range;
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    headers['content-type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    headers['content-length'] = body.length;
    headers['origin'] = target.origin;
    headers['referer'] = target.origin + '/';
  }

  const lib = target.protocol === 'https:' ? https : http;
  const up = lib.request({
    protocol: target.protocol, hostname: host, port: target.port || undefined,
    path: target.pathname + target.search, method: req.method, headers, lookup: safeLookup, timeout: 15000
  }, (ur) => {
    const status = ur.statusCode || 502;

    if (status >= 300 && status < 400 && ur.headers.location) {
      ur.resume();
      let loc;
      try { loc = toProxy(new URL(ur.headers.location, target)); } catch (e) { return errorPage(res, 502, 'Bad redirect.'); }
      return res.status(status).set({ Location: loc, 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': 'sandbox allow-scripts allow-forms' }).end();
    }

    const ct = String(ur.headers['content-type'] || '').toLowerCase();
    const isHtml = /text\/html|application\/xhtml/.test(ct);
    const isCss = /text\/css/.test(ct);
    const out = {
      'Access-Control-Allow-Origin': '*',
      'Referrer-Policy': 'unsafe-url',
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms'
    };
    for (const h of PASS_HEADERS) if (ur.headers[h]) out[h] = ur.headers[h];

    if (!isHtml && !isCss) { // images, scripts, video, fonts...: stream straight through
      if (ur.headers['content-encoding']) out['content-encoding'] = ur.headers['content-encoding'];
      if (ur.headers['content-length']) out['content-length'] = ur.headers['content-length'];
      res.writeHead(status, out);
      return ur.pipe(res);
    }

    const enc = String(ur.headers['content-encoding'] || '').toLowerCase();
    const src = enc === 'gzip' ? ur.pipe(zlib.createGunzip()) : enc === 'br' ? ur.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? ur.pipe(zlib.createInflate()) : ur;
    const chunks = []; let size = 0, dead = false;
    src.on('data', (c) => {
      size += c.length;
      if (size > MAX_REWRITE_BYTES && !dead) { dead = true; ur.destroy(); errorPage(res, 502, 'That page is too large.'); }
      else if (!dead) chunks.push(c);
    });
    src.on('error', () => { if (!dead) { dead = true; errorPage(res, 502, 'Could not read that page.'); } });
    src.on('end', () => {
      if (dead) return;
      const buf = Buffer.concat(chunks);
      const cs = (ct.match(/charset\s*=\s*["']?([\w-]+)/) || [])[1] || (isHtml && (buf.slice(0, 2048).toString('latin1').match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) || [])[1]) || 'utf-8';
      let text;
      try { text = new TextDecoder(cs).decode(buf); } catch (e) { text = buf.toString('utf8'); }
      text = isHtml ? injectShim(rewriteHtml(text, target.href), target.href) : rewriteCss(text, target.href);
      out['content-type'] = (isHtml ? 'text/html' : 'text/css') + '; charset=utf-8';
      out['cache-control'] = 'no-store';
      delete out['content-range']; delete out['etag'];
      res.writeHead(status === 206 ? 200 : status, out);
      res.end(req.method === 'HEAD' ? undefined : text);
    });
  });

  up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  up.on('error', (err) => {
    const c = err && err.code;
    errorPage(res, c === 'EBLOCKED' ? 403 : 502,
      c === 'EBLOCKED' ? 'That address is not allowed.' : c === 'ENOTFOUND' ? 'Could not find ' + host : c === 'ETIMEDOUT' ? 'The site took too long to answer.' : 'Could not load that page.');
  });
  req.on('aborted', () => up.destroy());
  up.end(body || undefined);
}

module.exports = function mountWebProxy(app) {
  app.set('trust proxy', 1); // so the rate limit sees the real client IP behind Render/Railway/Fly

  // Safety net: pages sometimes request root-relative urls we could not rewrite (e.g. "/api/x").
  // The browser tells us which proxied page asked (Referer), so send it to the right site.
  // Must run before express.static.
  app.use((req, res, next) => {
    const m = (req.headers.referer || '').match(/^https?:\/\/[^\/]+\/web\/(https?)\/([^\/?#]+)/i);
    if (!m || req.originalUrl.startsWith('/web/') || req.originalUrl.startsWith('/socket.io/')) return next();
    res.redirect(307, '/web/' + m[1].toLowerCase() + '/' + m[2] + req.originalUrl);
  });

  app.all(/^\/web\/https?\//i, express.raw({ type: () => true, limit: '1mb' }), handle);
};
module.exports.isPrivateIp = isPrivateIp;
