'use strict';

/**
 * GrokBotGate client: OAuth2 client-credentials JWT (or legacy static token).
 * Spawn → send plugin message grokbot:auth → Paper keeps SURVIVAL or forces SPECTATOR.
 * No hub. No tab prefix. Secrets never logged.
 *
 * Plugin channels must be registerChannel(name, type, true) so minecraft-protocol
 * emits S→C events and Paper delivers messages (minecraft:register).
 */

const AUTH_CHANNEL = 'grokbot:auth';
const REG_CHANNEL = 'grokbot:reg';
const DEFAULT_AUDIENCE = 'mc-paper-1.20.1';
const CHANNEL_TYPE = ['restBuffer', []];

function loadAuthConfig(env = process.env, opts = {}) {
  const username = String(opts.username || env.BOT_NAME || '').trim();
  const clientId = String(
    opts.clientId || env.GROK_CLIENT_ID || username || ''
  ).trim();
  return {
    username,
    clientId,
    clientSecret: String(env.GROK_CLIENT_SECRET || '').trim(),
    tokenUrl: String(env.GROK_TOKEN_URL || '').trim(),
    audience: String(env.GROK_MC_AUDIENCE || DEFAULT_AUDIENCE).trim(),
    legacyToken: String(env.GROK_BOT_TOKEN || '').trim(),
    timeoutMs: Number(env.GROK_TOKEN_TIMEOUT_MS || 5000),
    maxRetries: Number(env.GROK_TOKEN_RETRIES || 3),
  };
}

function isAuthConfigured(cfg) {
  if (!cfg) return false;
  if (cfg.legacyToken) return true;
  return Boolean(cfg.tokenUrl && cfg.clientId && cfg.clientSecret);
}

function formatBearer(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  if (/^Bearer\s+/i.test(t)) return t;
  return `Bearer ${t}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchAccessToken(cfg, hooks = {}) {
  const fetchImpl = hooks.fetchFn || globalThis.fetch;
  const now = () => (hooks.now ? hooks.now() : Date.now());

  if (cfg.tokenUrl && cfg.clientId && cfg.clientSecret) {
    if (typeof fetchImpl !== 'function') {
      const err = new Error('fetch is not available');
      err.code = 'AUTH_FETCH';
      throw err;
    }
    let lastErr;
    const attempts = Math.max(1, Number(cfg.maxRetries || 3));
    for (let i = 0; i < attempts; i++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 5000);
        let res;
        try {
          res = await fetchImpl(cfg.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              grant_type: 'client_credentials',
              client_id: cfg.clientId,
              client_secret: cfg.clientSecret,
              username: cfg.username,
              audience: cfg.audience,
            }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(body.error_description || body.error || `token http ${res.status}`);
          err.code = 'AUTH_DENIED';
          err.status = res.status;
          if (res.status >= 500 && i + 1 < attempts) {
            lastErr = err;
            await sleep(400 * 2 ** i);
            continue;
          }
          throw err;
        }
        const access = body.access_token || body.accessToken;
        if (!access) {
          const err = new Error('token response missing access_token');
          err.code = 'AUTH_DENIED';
          throw err;
        }
        const expiresIn = Number(body.expires_in || 90);
        return {
          access_token: access,
          token_type: body.token_type || 'Bearer',
          method: 'jwt',
          expires_at: now() + expiresIn * 1000,
        };
      } catch (e) {
        if (e.code === 'AUTH_DENIED') throw e;
        lastErr = e;
        if (i + 1 < attempts) await sleep(400 * 2 ** i);
      }
    }
    const err = new Error(lastErr?.message || 'token fetch failed');
    err.code = 'AUTH_FETCH';
    if (cfg.legacyToken) {
      return {
        access_token: cfg.legacyToken,
        token_type: 'Bearer',
        method: 'legacy',
        expires_at: now() + 120000,
        fallback: true,
      };
    }
    throw err;
  }

  if (cfg.legacyToken) {
    return {
      access_token: cfg.legacyToken,
      token_type: 'Bearer',
      method: 'legacy',
      expires_at: now() + 120000,
    };
  }

  const err = new Error('no GROK_TOKEN_URL+secret and no GROK_BOT_TOKEN');
  err.code = 'AUTH_SKIP';
  throw err;
}

function protocolClient(bot) {
  return bot?._client || null;
}

/** Register a custom plugin channel (sends minecraft:register when custom=true). */
function ensureChannel(client, name) {
  if (!client || typeof client.registerChannel !== 'function') return false;
  try {
    client.registerChannel(name, CHANNEL_TYPE, true);
    return true;
  } catch {
    /* already registered */
    return true;
  }
}

/** Register grokbot:auth + grokbot:reg early (login) so Paper can deliver S→C. */
function registerGateChannels(bot) {
  const client = protocolClient(bot);
  if (!client) {
    const err = new Error('bot has no protocol client');
    err.code = 'AUTH_SEND';
    throw err;
  }
  ensureChannel(client, AUTH_CHANNEL);
  ensureChannel(client, REG_CHANNEL);
  return { channels: [AUTH_CHANNEL, REG_CHANNEL] };
}

function writePlugin(client, channel, data) {
  if (typeof client.writeChannel === 'function') {
    client.writeChannel(channel, data);
    return;
  }
  client.write('custom_payload', { channel, data });
}

function sendAuth(bot, token) {
  const text = formatBearer(token);
  if (!text) {
    const err = new Error('empty auth token');
    err.code = 'AUTH_SEND';
    throw err;
  }
  const data = Buffer.from(text, 'utf8');
  const client = protocolClient(bot);
  if (!client) {
    const err = new Error('bot has no protocol client');
    err.code = 'AUTH_SEND';
    throw err;
  }
  try {
    registerGateChannels(bot);
    writePlugin(client, AUTH_CHANNEL, data);
    return { channel: AUTH_CHANNEL, bytes: data.length };
  } catch {
    /* fall through */
  }
  client.write('custom_payload', { channel: AUTH_CHANNEL, data });
  return { channel: AUTH_CHANNEL, bytes: data.length };
}

function bufferToUtf8(data) {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  if (typeof data === 'string') return data;
  if (data && Buffer.isBuffer(data.data)) return data.data.toString('utf8');
  return String(data ?? '');
}

function parseRegJson(data) {
  const text = bufferToUtf8(data).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Optional older-server chat fallback: `[grokbot:reg] {...json...}` */
function parseRegChatFallback(message) {
  const m = String(message || '').match(/\[grokbot:reg\]\s*(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Request a reg code on grokbot:reg (primary) with optional chat fallback.
 * Payload: raw UTF-8 JSON (restBuffer). Reply is JSON on the same channel.
 */
async function requestReg(bot, opts = {}) {
  const client = protocolClient(bot);
  if (!client) {
    const err = new Error('bot has no protocol client');
    err.code = 'REG_SEND';
    throw err;
  }
  registerGateChannels(bot);

  const timeoutMs = Number(opts.timeoutMs || 10000);
  const chatFallback = opts.chatFallback !== false;
  const request = opts.request != null ? opts.request : { op: 'request' };
  const payload = Buffer.from(JSON.stringify(request), 'utf8');

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(Object.assign(new Error(`grokbot:reg timeout after ${timeoutMs}ms`), { code: 'REG_TIMEOUT' }));
    }, timeoutMs);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.off?.(REG_CHANNEL, onPlugin);
        client.removeListener?.(REG_CHANNEL, onPlugin);
      } catch {
        /* */
      }
      if (bot && chatFallback) {
        try {
          bot.off?.('chat', onChat);
          bot.removeListener?.('chat', onChat);
          bot.off?.('messagestr', onMsg);
          bot.removeListener?.('messagestr', onMsg);
        } catch {
          /* */
        }
      }
      if (err) reject(err);
      else resolve(result);
    };

    const accept = (json, via) => {
      if (!json || typeof json !== 'object') return;
      finish(null, { channel: REG_CHANNEL, via, payload: json });
    };

    const onPlugin = (data) => {
      const json = parseRegJson(data);
      if (json) accept(json, 'plugin');
    };

    const onChat = (_username, message) => {
      const json = parseRegChatFallback(message);
      if (json) accept(json, 'chat');
    };

    const onMsg = (msg) => {
      const json = parseRegChatFallback(msg);
      if (json) accept(json, 'chat');
    };

    if (typeof client.on === 'function') client.on(REG_CHANNEL, onPlugin);
    if (chatFallback && bot) {
      if (typeof bot.on === 'function') {
        bot.on('chat', onChat);
        bot.on('messagestr', onMsg);
      }
    }

    try {
      writePlugin(client, REG_CHANNEL, payload);
    } catch (e) {
      finish(Object.assign(e, { code: e.code || 'REG_SEND' }));
    }
  });
}

async function runGateAuth(bot, cfg, hooks = {}) {
  const log = hooks.log || (() => {});
  if (!isAuthConfigured(cfg)) {
    return { authenticated: false, method: null, skipped: true, error: null };
  }
  const token = await fetchAccessToken(cfg, hooks);
  sendAuth(bot, token.access_token);
  log('auth sent', token.method, AUTH_CHANNEL);
  return {
    authenticated: true,
    method: token.method,
    skipped: false,
    error: null,
    expires_at: token.expires_at || null,
    client_id: cfg.clientId,
  };
}

module.exports = {
  AUTH_CHANNEL,
  REG_CHANNEL,
  DEFAULT_AUDIENCE,
  loadAuthConfig,
  isAuthConfigured,
  formatBearer,
  fetchAccessToken,
  ensureChannel,
  registerGateChannels,
  sendAuth,
  parseRegJson,
  parseRegChatFallback,
  requestReg,
  runGateAuth,
};
