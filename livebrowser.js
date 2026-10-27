// LIVE browser for the TV: a real Chromium (puppeteer) runs on the server, one private window per
// room. Its screen is streamed to everybody in the room as JPEG frames (CDP screencast) and
// everybody's mouse / keyboard is sent back to it. Because it is a real browser on the site's real
// domain, captchas, "verify you are human" pages, logins and heavy web apps work.
//
// puppeteer is an *optional* dependency: without it (or without Chromium) `available()` is false
// and the TV falls back to the light proxy in webproxy.js.
//
// Known limits: no sound (headless Chromium), a few frames of lag, and cloud-server IPs may still
// get extra bot checks. See README for deployment (Docker recommended).

const dns = require('dns');
const net = require('net');

const W = 1280, H = 720;
const MAX_SESSIONS = Math.max(1, Number(process.env.LIVE_MAX) || 2); // each one costs ~300-500 MB RAM
const IDLE_MS = 15 * 60 * 1000;   // a room's browser is closed after 15 min without input
const FRAME_GAP = 60;             // ms between frames sent (about 16 fps max)

module.exports = function createLive(io, opts) {
  opts = opts || {};
  const isPrivateIp = opts.isPrivateIp || (() => false);
  const sessions = new Map();     // room -> session
  const starting = new Map();     // room -> Promise<session>
  let pptr = null, pptrTried = false, broken = false, browserP = null, emptySince = 0;

  function lib() {
    if (!pptrTried) { pptrTried = true; try { pptr = require('puppeteer'); } catch (e) { pptr = null; } }
    return pptr;
  }
  function available() { return !broken && !!lib(); }

  // ---- only public sites may be opened (the browser sits inside your server's network)
  const dnsCache = new Map();
  async function publicHost(h) {
    h = String(h).replace(/^\[|\]$/g, '');
    if (net.isIP(h)) return !isPrivateIp(h);
    if (/^localhost$|\.local$|\.internal$/i.test(h)) return false;
    const c = dnsCache.get(h);
    if (c && Date.now() - c.t < 60000) return c.ok;
    let ok = false;
    try { const a = await dns.promises.lookup(h, { all: true }); ok = a.length > 0 && a.every((x) => !isPrivateIp(x.address)); } catch (e) { ok = false; }
    dnsCache.set(h, { ok, t: Date.now() });
    if (dnsCache.size > 2000) dnsCache.clear();
    return ok;
  }

  function getBrowser() {
    if (!browserP) {
      browserP = lib().launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio',
          '--no-first-run', '--lang=en-US', '--disable-blink-features=AutomationControlled', '--window-size=' + W + ',' + H]
      }).then((b) => {
        b.on('disconnected', () => { browserP = null; for (const room of [...sessions.keys()]) drop(room); });
        return b;
      }).catch((e) => {
        browserP = null; broken = true;
        console.error('[live] could not start Chromium, live browser disabled:', e.message);
        if (opts.onBroken) opts.onBroken();
        throw e;
      });
    }
    return browserP;
  }

  async function pushUrl(s, error) {
    if (!s.url || s.url === 'about:blank') return;
    try { s.title = await s.page.title(); } catch (e) {}
    io.to(s.room).emit('live-url', { url: s.url, title: s.title, error });
    if (opts.onUrl) opts.onUrl(s.room, s.url);
  }

  async function create(room) {
    const browser = await getBrowser();
    const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext()); // private cookies per room
    const page = await ctx.newPage();
    const s = { room, ctx, page, cdp: null, url: '', title: '', last: Date.now(), lastFrame: null, lastSent: 0, timer: null };
    try {
      await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
      const ua = (await browser.userAgent()).replace(/Headless/g, '');
      const ver = (ua.match(/Chrome\/(\d+)/) || [])[1] || '126';
      const cdp = await page.target().createCDPSession();
      s.cdp = cdp;
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: ua, acceptLanguage: 'en-US,en;q=0.9',
        userAgentMetadata: {
          brands: [{ brand: 'Chromium', version: ver }, { brand: 'Google Chrome', version: ver }, { brand: 'Not.A/Brand', version: '24' }],
          platform: 'Linux', platformVersion: '6.0.0', architecture: 'x86', model: '', mobile: false
        }
      }).catch(() => {});
      await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
      await cdp.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {}); // so every request goes through the check below
      await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

      await page.setRequestInterception(true);
      page.on('request', async (req) => {
        try {
          const u = new URL(req.url());
          if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return await req.continue();
          if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !(await publicHost(u.hostname))) return await req.abort('blockedbyclient');
          return await req.continue();
        } catch (e) { try { await req.abort(); } catch (x) {} }
      });
      page.on('dialog', (d) => d.dismiss().catch(() => {}));
      page.on('popup', async (pop) => { // new tabs / window.open: stay on the one TV page
        try {
          let u = pop.url();
          if (!u || u === 'about:blank') { await pop.waitForNavigation({ timeout: 4000 }).catch(() => {}); u = pop.url(); }
          await pop.close().catch(() => {});
          if (/^https?:/i.test(u) && sessions.get(room) === s) page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        } catch (e) {}
      });
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) { s.url = f.url(); pushUrl(s); } });
      page.on('load', () => pushUrl(s));

      const send = () => {
        s.timer = null; s.lastSent = Date.now();
        if (s.lastFrame) io.to(room).volatile.emit('live-frame', s.lastFrame);
      };
      cdp.on('Page.screencastFrame', (f) => {
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
        s.lastFrame = Buffer.from(f.data, 'base64');
        const wait = FRAME_GAP - (Date.now() - s.lastSent);
        if (wait <= 0) send(); else if (!s.timer) s.timer = setTimeout(send, wait); // always ends on the newest frame
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    } catch (e) { try { await ctx.close(); } catch (x) {} throw e; }
    sessions.set(room, s);
    return s;
  }

  function start(room) {
    if (sessions.has(room)) return Promise.resolve(sessions.get(room));
    if (starting.has(room)) return starting.get(room);
    if (sessions.size + starting.size >= MAX_SESSIONS) return Promise.reject(new Error('too many live browsers running (LIVE_MAX=' + MAX_SESSIONS + ')'));
    const p = create(room).finally(() => starting.delete(room));
    starting.set(room, p);
    return p;
  }

  async function drop(room) {
    const s = sessions.get(room);
    if (!s) return;
    sessions.delete(room);
    clearTimeout(s.timer);
    try { await s.cdp.send('Page.stopScreencast'); } catch (e) {}
    try { await s.page.close(); } catch (e) {}
    try { await s.ctx.close(); } catch (e) {}
  }

  // ---- API used by server.js
  async function load(room, url) {
    try {
      const s = await start(room);
      s.last = Date.now();
      s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
        if (/ERR_ABORTED/.test(String(e && e.message)) || sessions.get(room) !== s) return; // superseded by another navigation
        s.url = url; pushUrl(s, String((e && e.message) || 'could not load').split('\n')[0].slice(0, 120));
      });
      return true;
    } catch (e) {
      console.error('[live]', e.message);
      return false;
    }
  }

  function cmd(room, c) {
    const s = sessions.get(room);
    if (!s) return;
    s.last = Date.now();
    const p = c === 'back' ? s.page.goBack() : c === 'forward' ? s.page.goForward() : c === 'reload' ? s.page.reload() : null;
    if (p) p.catch(() => {});
  }

  function join(room, socket, url) { // somebody entered a room that is showing the live browser
    const s = sessions.get(room);
    if (!s) { if (!starting.has(room) && url) load(room, url); return; }
    if (s.lastFrame) socket.emit('live-frame', s.lastFrame);
    if (s.url) socket.emit('live-url', { url: s.url, title: s.title });
  }

  const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0; };
  const KEYS = new Set(['Backspace', 'Tab', 'Enter', 'Escape', 'PageUp', 'PageDown', 'End', 'Home', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Delete', 'Insert']);

  function input(room, e) {
    const s = sessions.get(room);
    if (!s || !s.cdp || !e || typeof e !== 'object') return;
    s.last = Date.now();
    const send = (m, p) => s.cdp.send(m, p).catch(() => {});
    if (e.t === 'mouse') {
      const type = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[e.type];
      if (!type) return;
      const buttons = num(e.buttons, 0, 7);
      const named = ['left', 'middle', 'right'][num(e.button, 0, 2)];
      send('Input.dispatchMouseEvent', {
        type, x: num(e.x, 0, W), y: num(e.y, 0, H),
        button: type === 'mouseMoved' ? (buttons & 1 ? 'left' : buttons & 4 ? 'middle' : buttons & 2 ? 'right' : 'none') : named,
        buttons, clickCount: type === 'mouseMoved' ? 0 : num(e.detail, 1, 3)
      });
    } else if (e.t === 'wheel') {
      send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: num(e.x, 0, W), y: num(e.y, 0, H), deltaX: num(e.dx, -3000, 3000), deltaY: num(e.dy, -3000, 3000) });
    } else if (e.t === 'key') {
      const key = String(e.key || '').slice(0, 20);
      if (!key) return;
      const mods = (e.alt ? 1 : 0) | (e.ctrl ? 2 : 0) | (e.meta ? 4 : 0) | (e.shift ? 8 : 0);
      const p = { type: e.down ? 'rawKeyDown' : 'keyUp', key, code: String(e.code || '').slice(0, 24), windowsVirtualKeyCode: num(e.keyCode, 0, 255), modifiers: mods };
      if (e.down) {
        if (key === 'Enter') p.text = '\r';
        else if ([...key].length === 1 && !e.ctrl && !e.meta) p.text = key;
        if (p.text) p.type = 'keyDown';
        if ((e.ctrl || e.meta) && key.toLowerCase() === 'a') p.commands = ['selectAll'];
      }
      if (!KEYS.has(key) && [...key].length !== 1 && !/^(F\d{1,2}|Shift|Control|Alt|Meta)$/.test(key)) return;
      send('Input.dispatchKeyEvent', p);
    } else if (e.t === 'text') {
      send('Input.insertText', { text: String(e.text || '').slice(0, 5000) });
    }
  }

  // housekeeping: close browsers nobody uses, keep titles fresh, close Chromium itself when idle
  setInterval(async () => {
    for (const s of [...sessions.values()]) {
      const members = io.sockets.adapter.rooms.get(s.room);
      if (!members || !members.size || Date.now() - s.last > IDLE_MS) { drop(s.room); continue; }
      try { const t = await s.page.title(); if (t !== s.title) pushUrl(s); } catch (e) {}
    }
    if (sessions.size || starting.size || !browserP) emptySince = 0;
    else if (!emptySince) emptySince = Date.now();
    else if (Date.now() - emptySince > 60000) {
      const b = browserP; browserP = null; emptySince = 0;
      b.then((x) => x.close()).catch(() => {});
    }
  }, 3000).unref();

  return { available, load, stop: drop, cmd, input, join };
};
