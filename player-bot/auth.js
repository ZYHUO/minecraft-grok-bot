'use strict';

/**
 * GrokBotGate client: OAuth2 client-credentials JWT (or legacy static token).
 * Spawn → send plugin message grokbot:auth → Paper keeps SURVIVAL or forces SPECTATOR.
 * No hub. No tab prefix. Secrets never logged.
 */

const AUTH_CHANNEL = 'grokbot:auth';
const DEFAULT_AUDIENCE = 'mc-paper-1.20.1';

function loadAuthConfig(env = process.env, opts = {}) {
  const username = String(opts.username || env.BOT_NAME || '').trim();
  const clientId = String(
    env.GROK_CLIENT_ID || opts.clientId || username || ''
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

function sendAuth(bot, token) {
  const text = formatBearer(token);
  if (!text) {
    const err = new Error('empty auth token');
    err.code = 'AUTH_SEND';
    throw err;
  }
  const data = Buffer.from(text, 'utf8');
  const client = bot?._client;
  if (!client) {
    const err = new Error('bot has no protocol client');
    err.code = 'AUTH_SEND';
    throw err;
  }
  try {
    if (typeof client.registerChannel === 'function') {
      try {
        client.registerChannel(AUTH_CHANNEL, ['restBuffer', []]);
      } catch {
        /* already registered */
      }
    }
    if (typeof client.writeChannel === 'function') {
      client.writeChannel(AUTH_CHANNEL, data);
      return { channel: AUTH_CHANNEL, bytes: data.length };
    }
  } catch {
    /* fall through */
  }
  client.write('custom_payload', { channel: AUTH_CHANNEL, data });
  return { channel: AUTH_CHANNEL, bytes: data.length };
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
  DEFAULT_AUDIENCE,
  loadAuthConfig,
  isAuthConfigured,
  formatBearer,
  fetchAccessToken,
  sendAuth,
  runGateAuth,
};
