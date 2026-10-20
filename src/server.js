import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { logger } from './logger.js';
import { Engine } from './engine.js';
import { requireAuth, isAuthorized, authEnabled } from './auth.js';

const engine = new Engine();
const app = express();

app.use(express.json({ limit: '64kb' }));
// Auth sits in front of the static files too, so the dashboard itself is
// never served to an unauthenticated visitor.
app.use(requireAuth);
app.use(express.static(config.paths.public, { extensions: ['html'] }));

const wrap = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    logger.error(`Request ${req.method} ${req.path} failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  });
};

// ------------------------------------------------------------------- REST API

app.get('/api/state', wrap((req, res) => {
  res.json({ ok: true, state: engine.getState() });
}));

/**
 * Push a price straight into the pipeline. Use this to drive the bot from
 * your own websocket feed, a different exchange, or a test script.
 * An optional "t" (epoch ms) lets you replay history with real timestamps.
 */
app.post('/api/tick', wrap((req, res) => {
  const price = Number(req.body?.price);
  if (!Number.isFinite(price) || price <= 0) {
    res.status(400).json({ ok: false, error: 'price must be a positive number' });
    return;
  }
  const timestamp = Number(req.body?.t);
  const result = engine.ingest(
    price,
    req.body?.source || 'manual',
    Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null
  );
  res.json({ ok: true, signal: result?.evaluation?.signal ?? 'HOLD' });
}));

app.post('/api/settings', wrap((req, res) => {
  const settings = engine.updateSettings(req.body ?? {});
  res.json({ ok: true, settings });
}));

app.post('/api/trade', wrap((req, res) => {
  const result = engine.manualTrade(req.body?.side, req.body?.price, Number(req.body?.quoteAmount));
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.reason });
    return;
  }
  res.json({ ok: true, trade: result.trade, state: engine.getState() });
}));

app.post('/api/poll', wrap(async (req, res) => {
  await engine.poll();
  res.json({ ok: true, state: engine.getState() });
}));

app.post('/api/reset', wrap((req, res) => {
  engine.reset();
  res.json({ ok: true, state: engine.getState() });
}));

app.get('/health', wrap((req, res) => {
  res.json({ ok: true, status: engine.status, bars: engine.history.length });
}));

// ----------------------------------------------------------------- WebSocket

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// The upgrade is handled manually so the handshake can be authenticated -
// the browser replays the cached Basic credentials on the socket request.
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (!isAuthorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Cross Engine"\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const clients = new Set();

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === 1) client.send(message);
  }
}

wss.on('connection', (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: 'state', state: engine.getState() }));

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    } catch {
      /* ignore malformed client frames */
    }
  });
});

engine.on('state', (state) => broadcast({ type: 'state', state }));
engine.on('trade', (trade) => broadcast({ type: 'trade', trade }));

// ------------------------------------------------------------------- Startup

server.listen(config.port, () => {
  logger.info(`Dashboard ready at http://localhost:${config.port}`);
  logger.info(
    `Market ${config.market.pair} | feed ${config.market.baseId}/${config.market.quoteId} | key: ${
      config.coingecko.apiKey ? config.coingecko.keyType : 'public (no key)'
    }`
  );
  logger.info(`State directory: ${config.paths.data}`);
  if (authEnabled) {
    logger.info(`Dashboard protected with Basic auth (user "${config.auth.user}")`);
  } else {
    logger.warn('AUTH_PASSWORD is not set - the dashboard is open to anyone who can reach it');
  }
  engine.start().catch((err) => logger.error(`Engine failed to start: ${err.message}`));
});

function shutdown(signal) {
  logger.info(`Received ${signal} - shutting down`);
  engine.stop();
  for (const client of clients) {
    try {
      client.close(1001, 'server shutting down');
    } catch {
      /* the socket is already gone */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
