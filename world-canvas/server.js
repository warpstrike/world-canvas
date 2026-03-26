const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GRID_SIZE = 10;

// Canvas state: flat array of hex colors
const canvas = Array(GRID_SIZE * GRID_SIZE).fill('#ffffff');

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
  // Send current canvas state to new client
  ws.send(JSON.stringify({ type: 'init', canvas }));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'paint' && typeof msg.index === 'number' && typeof msg.color === 'string') {
      // Validate index and color
      if (msg.index < 0 || msg.index >= canvas.length) return;
      if (!/^#[0-9a-fA-F]{6}$/.test(msg.color)) return;

      canvas[msg.index] = msg.color;

      // Broadcast to all clients
      const update = JSON.stringify({ type: 'paint', index: msg.index, color: msg.color });
      wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(update);
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`World Canvas running at http://localhost:${PORT}`));
