const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const GRID_SIZE = 10;
const EXPIRE_MS = 60 * 1000; // 1 minute

// Each pixel: { color, expiresAt: timestamp|null, queue: [{color, scheduledAt}] }
const pixels = Array(GRID_SIZE * GRID_SIZE).fill(null).map(() => ({
  color: '#ffffff',
  expiresAt: null,
  queue: []
}));

app.use(express.static(path.join(__dirname, 'public')));

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

function snapshot(index) {
  const p = pixels[index];
  return { index, color: p.color, expiresAt: p.expiresAt, queueLength: p.queue.length };
}

function applyNext(index) {
  const p = pixels[index];
  const prevExpiresAt = p.expiresAt;

  if (p.queue.length > 0) {
    const next = p.queue.shift();
    p.color = next.color;
    // Chain timing to avoid drift from polling delay
    p.expiresAt = prevExpiresAt + EXPIRE_MS;
  } else {
    p.color = '#ffffff';
    p.expiresAt = null;
  }
  broadcast({ type: 'update', ...snapshot(index) });
}

// Check expired pixels every 500ms
setInterval(() => {
  const now = Date.now();
  pixels.forEach((p, i) => {
    if (p.expiresAt && now >= p.expiresAt) applyNext(i);
  });
}, 500);

wss.on('connection', ws => {
  // Send full state to new client
  ws.send(JSON.stringify({ type: 'init', pixels: pixels.map((_, i) => snapshot(i)) }));

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type !== 'paint') return;

    const { index, color } = msg;
    if (typeof index !== 'number' || index < 0 || index >= pixels.length) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;

    const p = pixels[index];

    if (!p.expiresAt) {
      // Blank pixel — paint immediately
      p.color = color;
      p.expiresAt = Date.now() + EXPIRE_MS;
      broadcast({ type: 'update', ...snapshot(index) });
    } else {
      // Pixel is taken — queue it
      const lastSlotEndsAt = p.queue.length > 0
        ? p.queue[p.queue.length - 1].scheduledAt + EXPIRE_MS
        : p.expiresAt;

      const scheduledAt = lastSlotEndsAt;
      p.queue.push({ color, scheduledAt });

      // Acknowledge only to this client
      ws.send(JSON.stringify({
        type: 'queue_ack',
        index,
        color,
        scheduledAt,
        queuePosition: p.queue.length
      }));

      // Broadcast updated queue length to all
      broadcast({ type: 'update', ...snapshot(index) });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`World Canvas → http://localhost:${PORT}`));
