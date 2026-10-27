const express = require('express');
const http = require('http');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Link resolver + media proxy (lets the TV play direct video links and
// "download page" links like https://down.vidtube.one/d/xxxx)
// ---------------------------------------------------------------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MEDIA_RE = /\.(mp4|webm|m4v|mov|mkv|m3u8)(\?|#|$)/i;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
}

// refuse anything that points at the server's own network (SSRF protection)
async function assertPublicUrl(u) {
  const url = new URL(u);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links are supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!process.env.ROOMMATE_ALLOW_PRIVATE && (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))) throw new Error('That address is not allowed');
  return url;
}

// fetch that follows redirects manually so every hop is checked
async function safeFetch(u, opts = {}, hops = 0) {
  if (hops > 6) throw new Error('Too many redirects');
  const url = await assertPublicUrl(u);
  const res = await fetch(url, { ...opts, redirect: 'manual', headers: { 'User-Agent': UA, Referer: url.origin + '/', ...(opts.headers || {}) } });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    try { res.body && res.body.cancel(); } catch (e) {}
    return safeFetch(new URL(res.headers.get('location'), url).href, opts, hops + 1);
  }
  res.finalUrl = url.href;
  return res;
}

function looksLikeVideo(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const cd = res.headers.get('content-disposition') || '';
  if (ct.startsWith('video/')) return ct.includes('mpegurl') ? 'hls' : 'file';
  if (ct.includes('mpegurl')) return 'hls';
  if ((ct.includes('octet-stream') || ct === '') && (MEDIA_RE.test(res.finalUrl) || MEDIA_RE.test(cd))) return /m3u8/i.test(res.finalUrl) ? 'hls' : 'file';
  return null;
}

function findMediaLinks(html, base) {
  const text = html.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const out = [];
  const add = (raw) => {
    try { const abs = new URL(raw.startsWith('//') ? 'https:' + raw : raw, base).href; if (!out.includes(abs)) out.push(abs); } catch (e) {}
  };
  let m;
  const tagRe = /<(?:source|video)[^>]+src=["']([^"']+)["']/gi;
  while ((m = tagRe.exec(text))) add(m[1]);
  const metaRe = /<meta[^>]+(?:og:video(?::url|:secure_url)?|twitter:player:stream)["'][^>]*content=["']([^"']+)["']/gi;
  while ((m = metaRe.exec(text))) add(m[1]);
  const urlRe = /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:mp4|webm|m4v|mov|mkv|m3u8)(?:\?[^\s"'<>\\]*)?/gi;
  while ((m = urlRe.exec(text))) add(m[0]);
  return out.filter((l) => MEDIA_RE.test(l) || /<(?:source|video)/.test(text));
}

function findDownloadPages(html, base) {
  const text = html.replace(/&amp;/g, '&');
  const out = [];
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(text))) {
    if (!/download|direct|get link|watch|play/i.test(m[2] + ' ' + m[1])) continue;
    try { const abs = new URL(m[1], base).href; if (abs !== base && !out.includes(abs) && /^https?:/.test(abs)) out.push(abs); } catch (e) {}
  }
  return out.slice(0, 3);
}

async function resolveLink(input, depth = 0) {
  const res = await safeFetch(input);
  if (!res.ok && res.status !== 206) { try { res.body && res.body.cancel(); } catch (e) {} throw new Error('The link returned HTTP ' + res.status); }
  const kind = looksLikeVideo(res);
  if (kind) { try { res.body && res.body.cancel(); } catch (e) {} return { url: res.finalUrl, type: kind }; }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('json')) { try { res.body && res.body.cancel(); } catch (e) {} throw new Error('That link is not a video (' + (ct || 'unknown type') + ')'); }
  const html = (await res.text()).slice(0, 2_000_000);
  const links = findMediaLinks(html, res.finalUrl);
  if (links.length) return { url: links[0], type: /\.m3u8/i.test(links[0]) ? 'hls' : 'file', via: res.finalUrl };
  if (depth < 1) {
    for (const next of findDownloadPages(html, res.finalUrl)) {
      try { return await resolveLink(next, depth + 1); } catch (e) {}
    }
  }
  throw new Error('Could not find a playable video on that page');
}

app.get('/api/resolve', async (req, res) => {
  try {
    const r = await resolveLink(String(req.query.url || '').trim());
    const name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || '') || 'video';
    res.json({ ok: true, ...r, title: name });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Could not resolve link' });
  }
});

// streams the video through this server (with Range support so seeking works)
app.get('/proxy', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await safeFetch(String(req.query.u || ''), { headers, signal: ac.signal });
    res.status(up.status === 206 ? 206 : up.ok ? 200 : up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = up.headers.get(h); if (v) res.setHeader(h, v);
    }
    if (!up.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send(e.message || 'proxy error');
    else res.destroy();
  }
});

// ---------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------
// roomCode -> { kind: 'yt'|'file', id | url, title, playing, time, updatedAt }
const videos = {};
const lights = {}; // roomCode -> boolean (false = off)

function cleanVideo(v) {
  if (typeof v === 'string') v = { kind: 'yt', id: v }; // old clients
  if (!v || typeof v !== 'object') return null;
  if (v.kind === 'file') {
    const url = String(v.url || '');
    if (!/^(https?:\/\/|\/proxy\?)/i.test(url) || url.length > 2000) return null;
    return { kind: 'file', url, title: String(v.title || '').slice(0, 120) };
  }
  const id = String(v.id || '');
  if (!/^[\w-]{11}$/.test(id)) return null;
  return { kind: 'yt', id };
}

io.on('connection', (socket) => {
  socket.on('join', (code) => {
    code = String(code || '').toUpperCase().trim().slice(0, 8);
    if (!code) return;
    socket.join(code);
    socket.room = code;

    // tell others someone arrived (they will re-send their position)
    socket.to(code).emit('player-joined', socket.id);

    if (lights[code] === false) socket.emit('light', false);

    // catch the newcomer up on the current video
    const v = videos[code];
    if (v) {
      const time = v.playing ? v.time + (Date.now() - v.updatedAt) / 1000 : v.time;
      socket.emit('video', { kind: v.kind, id: v.id, url: v.url, title: v.title, playing: v.playing, time });
    }
  });

  socket.on('move', (pos) => {
    if (!socket.room || !pos) return;
    socket.to(socket.room).emit('move', { id: socket.id, x: pos.x, y: pos.y || 0, z: pos.z, ry: pos.ry });
  });

  // text chat
  socket.on('chat', (m) => {
    if (!socket.room || !m || typeof m.text !== 'string') return;
    const text = m.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!text) return;
    socket.to(socket.room).emit('chat', { id: socket.id, text, mid: typeof m.mid === 'string' ? m.mid.slice(0, 40) : undefined });
  });

  // light switch
  socket.on('light', (on) => {
    if (!socket.room) return;
    lights[socket.room] = !!on;
    socket.to(socket.room).emit('light', !!on);
  });

  socket.on('video-load', (payload) => {
    if (!socket.room) return;
    const c = cleanVideo(payload);
    if (!c) return;
    videos[socket.room] = { ...c, playing: true, time: 0, updatedAt: Date.now() };
    io.to(socket.room).emit('video', { ...c, playing: true, time: 0 });
  });

  socket.on('video-state', (s) => {
    const v = videos[socket.room];
    if (!v || !s) return;
    v.playing = !!s.playing;
    v.time = Number(s.time) || 0;
    v.updatedAt = Date.now();
    socket.to(socket.room).emit('video', { kind: v.kind, id: v.id, url: v.url, title: v.title, playing: v.playing, time: v.time });
  });

  socket.on('disconnect', () => {
    if (socket.room) socket.to(socket.room).emit('player-left', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ROOMMATE alpha running at http://localhost:${PORT}`));
