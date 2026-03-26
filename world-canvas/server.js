const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const GRID_SIZE = 10;
const SLOT_MS   = 60 * 1000; // 60-second universal slots

// Slot boundaries are derived from Unix epoch so every client/server agrees
function currentSlotStart() {
  return Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
}
function nextSlotStart() {
  return currentSlotStart() + SLOT_MS;
}

// Each pixel: { color, activeUntil: slot-end timestamp | null, queue: [{color, slotStart}] }
// slotStart values are always exact slot boundaries (multiples of SLOT_MS from epoch).
const pixels = Array(GRID_SIZE * GRID_SIZE).fill(null).map(() => ({
  color:       '#ffffff',
  activeUntil: null,
  queue:       []
}));

app.use(express.static(path.join(__dirname, 'public')));

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// Snapshot sent to clients. Includes the first queued item so clients can
// render a "pending" preview before the slot fires.
function snapshot(index) {
  const p = pixels[index];
  return {
    index,
    color:        p.color,
    activeUntil:  p.activeUntil,
    queueLength:  p.queue.length,
    pendingColor: p.queue.length > 0 ? p.queue[0].color    : null,
    pendingAt:    p.queue.length > 0 ? p.queue[0].slotStart : null,
  };
}

// Advance a pixel's state to the given timestamp:
// – expire the active color if its slot has ended
// – activate the earliest queued entry whose slot has begun (skip any that
//   have already expired without ever being displayed)
function processPixel(index, now) {
  const p = pixels[index];

  if (p.activeUntil !== null && p.activeUntil <= now) {
    p.color       = '#ffffff';
    p.activeUntil = null;
  }

  while (p.queue.length > 0) {
    const q    = p.queue[0];
    if (q.slotStart > now) break;          // not yet

    const qEnd = q.slotStart + SLOT_MS;
    p.queue.shift();

    if (qEnd > now) {                      // slot is currently active
      p.color       = q.color;
      p.activeUntil = qEnd;
      break;
    }
    // else: this slot already expired — discard and continue
  }
}

// Every 200 ms: tick all pixels.  Collect every pixel that changed and
// send ONE batch_update so all clients flip at exactly the same time.
setInterval(() => {
  const now     = Date.now();
  const updates = [];

  pixels.forEach((_, i) => {
    const before = JSON.stringify(snapshot(i));
    processPixel(i, now);
    const after  = JSON.stringify(snapshot(i));
    if (before !== after) updates.push(snapshot(i));
  });

  if (updates.length > 0) {
    broadcast({ type: 'batch_update', pixels: updates });
  }
}, 200);

wss.on('connection', ws => {
  // Send full board state to the new client
  ws.send(JSON.stringify({ type: 'init', pixels: pixels.map((_, i) => snapshot(i)) }));

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type !== 'batch_paint') return;
    if (!Array.isArray(msg.items) || msg.items.length === 0) return;

    const results = [];

    for (const item of msg.items) {
      const { index, color } = item;
      if (typeof index !== 'number' || index < 0 || index >= pixels.length) continue;
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) continue;

      const p = pixels[index];

      // Determine the slot to use.
      // Client may request a specific slot boundary; validate it then honour it.
      const ns       = nextSlotStart();
      let requested  = item.scheduledAt;
      let scheduledAt;

      const isValidRequest =
        typeof requested === 'number' &&
        requested % SLOT_MS === 0 &&
        requested >= ns &&
        // Pixel must be free at that slot (not still active)
        (p.activeUntil === null || requested >= p.activeUntil) &&
        // No existing queue entry already occupies that slot
        !p.queue.some(q => q.slotStart === requested);

      if (isValidRequest) {
        scheduledAt = requested;
      } else {
        // Auto: next available slot after current active period + queue
        if (p.queue.length > 0) {
          scheduledAt = p.queue[p.queue.length - 1].slotStart + SLOT_MS;
        } else if (p.activeUntil !== null) {
          scheduledAt = p.activeUntil;
        } else {
          scheduledAt = ns;
        }
      }

      p.queue.push({ color, slotStart: scheduledAt });
      // Keep queue sorted so processPixel always reads the earliest entry first
      p.queue.sort((a, b) => a.slotStart - b.slotStart);
      results.push({ index, scheduledAt, queuePosition: p.queue.length });
    }

    // Broadcast updated snapshots immediately so pending indicators appear
    // on every client's canvas without waiting for the next tick.
    results.forEach(({ index }) => {
      broadcast({ type: 'update', ...snapshot(index) });
    });

    ws.send(JSON.stringify({ type: 'batch_ack', results }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`World Canvas → http://localhost:${PORT}`));
