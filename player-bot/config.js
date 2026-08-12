'use strict';

/**
 * Runtime defaults for Grok Bot Minecraft player control.
 * Override via CLI flags or env vars (see player-bot.js).
 */
module.exports = {
  // Minecraft
  host: process.env.MC_HOST || '127.0.0.1',
  mcPort: Number(process.env.MC_PORT || 25565),
  version: process.env.MC_VERSION || '1.20.1',
  // Modflared client port: auto = DNS TXT, on = always, off = direct
  tunnel: process.env.MC_TUNNEL || 'auto',
  tunnelHost: process.env.MC_TUNNEL_HOST || '',
  auth: 'offline',

  // HTTP is opt-in via --http-port (legacy). Default off.
  httpPort: null,
  botName: process.env.BOT_NAME || 'GrokBot1',

  // World awareness limits (keep /status small)
  entityRange: Number(process.env.ENTITY_RANGE || 16),
  playerRange: Number(process.env.PLAYER_RANGE || 32),
  chatHistoryLimit: Number(process.env.CHAT_HISTORY || 8),
  maxNearbyEntities: Number(process.env.MAX_NEARBY_ENTITIES || 12),
  maxNearbyPlayers: Number(process.env.MAX_NEARBY_PLAYERS || 8),

  // Pathfinder / movement
  moveRange: 1,
  digDistance: 4.5,
  placeDistance: 4.5,
  attackDistance: 3.5,

  // Safety defaults (Grok can toggle via POST /config)
  autoEat: process.env.AUTO_EAT !== '0',
  autoReconnect: process.env.AUTO_RECONNECT !== '0',
  reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS || 5000),
  voidY: Number(process.env.VOID_Y || -64),

  // Rate limit: max accepted actions per window
  actionRateLimit: Number(process.env.ACTION_RATE_LIMIT || 8),
  actionRateWindowMs: Number(process.env.ACTION_RATE_WINDOW_MS || 1000),

  // Job timeouts
  defaultJobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 120000),
  moveTimeoutMs: Number(process.env.MOVE_TIMEOUT_MS || 90000),
  digTimeoutMs: Number(process.env.DIG_TIMEOUT_MS || 30000),
  craftTimeoutMs: Number(process.env.CRAFT_TIMEOUT_MS || 20000),

  // Logging
  logDir: process.env.LOG_DIR || '../logs',
  sharedDir: process.env.SHARED_DIR || '../shared',

  // GrokBotGate (OAuth JWT or legacy static token)
  grokClientId: process.env.GROK_CLIENT_ID || '',
  grokTokenUrl: process.env.GROK_TOKEN_URL || '',
  grokAudience: process.env.GROK_MC_AUDIENCE || 'mc-paper-1.20.1',
};
