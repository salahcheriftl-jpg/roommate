const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// roomCode -> { id, playing, time, updatedAt }  (current video state)
const videos = {};

io.on('connection', (socket) => {
  socket.on('join', (code) => {
    code = String(code || '').toUpperCase().trim();
    if (!code) return;
    socket.join(code);
    socket.room = code;

    // tell others someone arrived (they will re-send their position)
    socket.to(code).emit('player-joined', socket.id);

    // catch the newcomer up on the current video
    const v = videos[code];
    if (v) {
      const time = v.playing ? v.time + (Date.now() - v.updatedAt) / 1000 : v.time;
      socket.emit('video', { id: v.id, playing: v.playing, time });
    }
  });

  socket.on('move', (pos) => {
    if (!socket.room) return;
    socket.to(socket.room).emit('move', { id: socket.id, x: pos.x, z: pos.z, ry: pos.ry });
  });

  socket.on('video-load', (id) => {
    if (!socket.room) return;
    videos[socket.room] = { id, playing: true, time: 0, updatedAt: Date.now() };
    io.to(socket.room).emit('video', { id, playing: true, time: 0 });
  });

  socket.on('video-state', (s) => {
    const v = videos[socket.room];
    if (!v) return;
    v.playing = !!s.playing;
    v.time = Number(s.time) || 0;
    v.updatedAt = Date.now();
    socket.to(socket.room).emit('video', { id: v.id, playing: v.playing, time: v.time });
  });

  socket.on('disconnect', () => {
    if (socket.room) socket.to(socket.room).emit('player-left', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ROOMMATE alpha running at http://localhost:${PORT}`));
