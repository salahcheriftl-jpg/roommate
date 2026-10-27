const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

require('./webproxy')(app); // /web/... lets the TV open any website (must come before static)
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------
// roomCode -> { kind: 'yt'|'file', id | url, title, playing, time, updatedAt }
const videos = {};
const lights = {}; // roomCode -> boolean (false = off)
const webs = {};   // roomCode -> { url, mode: 'live' | 'proxy' } website on the TV (replaces any video)
const live = require('./livebrowser')(io, {
  isPrivateIp: require('./webproxy').isPrivateIp,
  onUrl: (room, url) => { if (webs[room] && webs[room].mode === 'live') webs[room].url = url; },
  onBroken: () => io.emit('caps', { live: false }) // Chromium would not start: everyone falls back to the light proxy
});

// show a website on the TV: 'live' = real Chromium on the server (if installed), else the light proxy
async function showWeb(room, url, wantLive) {
  delete videos[room];
  const mode = wantLive && live.available() ? 'live' : 'proxy';
  webs[room] = { url, mode };
  io.to(room).emit('web', webs[room]);
  if (mode !== 'live') return live.stop(room);
  const ok = await live.load(room, url);
  if (!ok && webs[room] && webs[room].url === url && webs[room].mode === 'live') {
    webs[room] = { url, mode: 'proxy' };
    io.to(room).emit('web', webs[room]);
  }
}

function cleanWeb(p) {
  const u = String((p && p.url) || '').trim();
  if (!u || u.length > 2000) return null;
  try { const a = new URL(u); return /^https?:$/.test(a.protocol) ? a.href : null; } catch (e) { return null; }
}

function cleanVideo(v) {
  if (typeof v === 'string') v = { kind: 'yt', id: v }; // old clients
  if (!v || typeof v !== 'object') return null;
  if (v.kind === 'file') {
    const url = String(v.url || '');
    if (!/^https?:\/\//i.test(url) || url.length > 2000) return null;
    return { kind: 'file', url, title: String(v.title || '').slice(0, 120) };
  }
  const id = String(v.id || '');
  if (!/^[\w-]{11}$/.test(id)) return null;
  return { kind: 'yt', id };
}

io.on('connection', (socket) => {
  socket.emit('caps', { live: live.available() });
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
    } else if (webs[code]) {
      socket.emit('web', webs[code]);
      if (webs[code].mode === 'live') live.join(code, socket, webs[code].url);
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
    delete webs[socket.room];
    live.stop(socket.room);
    io.to(socket.room).emit('video', { ...c, playing: true, time: 0 });
  });

  // website on the TV. 'web-load' = typed in the deck (everyone sees it); 'web-nav' = someone clicked a
  // link on a LITE (proxy) page, everyone else follows. In LIVE mode there is one shared browser, so no sync is needed.
  socket.on('web-load', (p) => {
    if (!socket.room) return;
    const url = cleanWeb(p);
    if (url) showWeb(socket.room, url, !!(p && p.mode === 'live'));
  });
  socket.on('web-nav', (p) => {
    if (!socket.room || (webs[socket.room] && webs[socket.room].mode === 'live')) return;
    const url = cleanWeb(p);
    if (!url) return;
    webs[socket.room] = { url, mode: 'proxy' }; delete videos[socket.room];
    socket.to(socket.room).emit('web', webs[socket.room]);
  });
  socket.on('live-input', (e) => { if (socket.room) live.input(socket.room, e); });
  socket.on('live-cmd', (p) => { if (socket.room && p) live.cmd(socket.room, String(p.c)); });

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
