'use strict';

/**
 * Defaults for the read-only status watcher + site.
 * Override via env or CLI flags (see server.js).
 */
module.exports = {
  // Minecraft (match start-server.sh / player-bot)
  host: process.env.MC_HOST || '127.0.0.1',
  mcPort: Number(process.env.MC_PORT || 25565),
  version: process.env.MC_VERSION || '1.20.4',
  auth: 'offline',
  botName: process.env.WEB_BOT_NAME || process.env.BOT_NAME || 'WebWatcher',

  // HTTP bind — default loopback; set WEB_BIND=0.0.0.0 to expose
  bind: process.env.WEB_BIND || '127.0.0.1',
  port: Number(process.env.WEB_PORT || 3200),

  // Event history
  eventLimit: Number(process.env.WEB_EVENT_LIMIT || 300),
  autoReconnect: process.env.AUTO_RECONNECT !== '0',
  reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS || 5000),

  // Optional NDJSON tail file for other tools (not required for the site)
  sharedEventsFile:
    process.env.WEB_EVENTS_FILE ||
    require('path').resolve(__dirname, '../shared/web/events.ndjson'),
  appendSharedEvents: process.env.WEB_APPEND_EVENTS !== '0',
};
