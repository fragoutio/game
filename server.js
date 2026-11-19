// fragout.io online server: static files + WebSocket transport around the shared game core.
// Run: npm start   (env: PORT, default 8123; BOT_FILL_MS, default 30000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const core = require('./public/core.js');

const PORT = +process.env.PORT || 8123;
const BOT_FILL_MS = +process.env.BOT_FILL_MS || 30_000;

// ---------- Static files ----------
const PUBLIC = path.join(__dirname, 'public');
const THREE_FILE = path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }   // for the host's health check
  // three.js is served from node_modules so the game works on networks that block CDNs
  const file = urlPath === '/vendor/three.min.js' ? THREE_FILE
    : path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (file !== THREE_FILE && !file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});

// ---------- WebSocket transport ----------
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  const conn = core.connect(msg => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); });
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => { try { conn.receive(JSON.parse(raw)); } catch { /* ignore bad packets */ } });
  ws.on('close', () => conn.close());
  ws.send(JSON.stringify({ t: 'online', n: wss.clients.size, v: core.MAP_ID }));
});
// keep connections open through hosting proxies (they drop idle sockets) and drop dead ones
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, 25000);
// tell everyone how many players are online (shown on the title screen)
setInterval(() => {
  const msg = JSON.stringify({ t: 'online', n: wss.clients.size, v: core.MAP_ID });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}, 5000);

core.start({ botFillMs: BOT_FILL_MS, log: console.log });
server.listen(PORT, () => console.log(`fragout.io on http://localhost:${PORT}  (bots fill after ${BOT_FILL_MS / 1000}s)`));
