'use strict';

/**
 * Status website + Mineflayer watcher bridge.
 *
 * Read-only spectator surface for humans. Does NOT use hub/ as a social bus.
 * Social truth stays in the Minecraft world; this process only mirrors it.
 *
 *   GET /api/status   → online count, players, server meta, uptime
 *   GET /api/events   → recent ring-buffer history (?since=&limit=)
 *   GET /api/stream   → SSE: event + status frames
 *   GET /             → static UI
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const defaults = require('./config');
const { EventLog } = require('./events');
const { createWatcher } = require('./watcher');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--mc-port') out.mcPort = Number(argv[++i]);
    else if (a === '--name' || a === '-n') out.botName = argv[++i];
    else if (a === '--bind') out.bind = argv[++i];
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`Usage: node server.js [options]
  --host HOST       MC host (default ${defaults.host})
  --mc-port N       MC port (default ${defaults.mcPort})
  --name NAME       watcher username (default ${defaults.botName})
  --bind ADDR       HTTP bind (default ${defaults.bind}; use 0.0.0.0 to expose)
  --port N          HTTP port (default ${defaults.port})
  --version VER     MC protocol version (default ${defaults.version})

Env: MC_HOST MC_PORT MC_VERSION WEB_BOT_NAME WEB_BIND WEB_PORT WEB_EVENT_LIMIT
     WEB_EVENTS_FILE WEB_APPEND_EVENTS=0 AUTO_RECONNECT=0`);
  process.exit(0);
}

const config = {
  ...defaults,
  host: args.host || defaults.host,
  mcPort: args.mcPort || defaults.mcPort,
  botName: args.botName || defaults.botName,
  bind: args.bind || defaults.bind,
  port: args.port || defaults.port,
  version: args.version || defaults.version,
};

const logDir = path.resolve(__dirname, '../logs');
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {
  /* */
}
const logFile = path.join(logDir, 'web-status.app.log');

function log(...parts) {
  const line = `[${new Date().toISOString()}] [web] ${parts.map(String).join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* */
  }
}

const eventLog = new EventLog(config.eventLimit);
const sseClients = new Set();

function appendShared(ev) {
  if (!config.appendSharedEvents || !config.sharedEventsFile) return;
  try {
    const dir = path.dirname(config.sharedEventsFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(config.sharedEventsFile, JSON.stringify(ev) + '\n');
  } catch (e) {
    log('shared append warn', e.message);
  }
}

function broadcastSse(frame) {
  const data = `data: ${JSON.stringify(frame)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

eventLog.on((ev) => {
  appendShared(ev);
  broadcastSse({ type: 'event', event: ev });
});

const watcher = createWatcher(config, eventLog, {
  log: (...p) => log(...p),
  onStatus: (snap) => broadcastSse({ type: 'status', status: snap }),
});

const app = express();
app.disable('x-powered-by');

app.get('/api/status', (_req, res) => {
  res.json(watcher.snapshot());
});

app.get('/api/events', (req, res) => {
  const since = Number(req.query.since || 0);
  const limit = Math.min(Number(req.query.limit || 100), config.eventLimit);
  if (since > 0) {
    res.json(eventLog.since(since, limit));
    return;
  }
  const items = eventLog.recent(limit);
  res.json({
    items,
    next_since: items.length ? items[items.length - 1].id : 0,
    latest: eventLog.seq,
  });
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Snapshot so refresh still has history + current roster
  const history = eventLog.recent(config.eventLimit);
  res.write(
    `data: ${JSON.stringify({
      type: 'hello',
      status: watcher.snapshot(),
      events: history,
    })}\n\n`
  );

  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* */
    }
  }, 25000);

  // Periodic status in case join/leave edge cases miss a hook
  const statusTick = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'status', status: watcher.snapshot() })}\n\n`);
    } catch {
      /* */
    }
  }, 10000);

  req.on('close', () => {
    clearInterval(ping);
    clearInterval(statusTick);
    sseClients.delete(res);
  });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const server = app.listen(config.port, config.bind, () => {
  log(`HTTP http://${config.bind}:${config.port}`);
  log(`watcher → ${config.host}:${config.mcPort} as ${config.botName}`);
  watcher.start();
});

function shutdown(sig) {
  log(`shutdown ${sig}`);
  watcher.stop();
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* */
    }
  }
  sseClients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
