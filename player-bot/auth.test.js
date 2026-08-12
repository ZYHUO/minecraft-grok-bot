'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTH_CHANNEL,
  loadAuthConfig,
  isAuthConfigured,
  formatBearer,
  fetchAccessToken,
  sendAuth,
} = require('./auth');

test('formatBearer', () => {
  assert.equal(formatBearer('abc'), 'Bearer abc');
  assert.equal(formatBearer('Bearer xyz'), 'Bearer xyz');
});

test('loadAuthConfig prefers soul client_id over env', () => {
  const cfg = loadAuthConfig(
    {
      GROK_CLIENT_ID: 'andy',
      GROK_CLIENT_SECRET: 's',
      GROK_TOKEN_URL: 'http://127.0.0.1:3200/oauth/token',
      GROK_MC_AUDIENCE: 'mc-paper-1.20.1',
    },
    { username: 'Miner', clientId: 'miner' }
  );
  assert.equal(cfg.username, 'Miner');
  assert.equal(cfg.clientId, 'miner');
  assert.ok(isAuthConfigured(cfg));
});

test('legacy token counts as configured', () => {
  const cfg = loadAuthConfig({ GROK_BOT_TOKEN: 'static' }, { username: 'Andy' });
  assert.ok(isAuthConfigured(cfg));
});

test('fetchAccessToken jwt path', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'jwt-1', expires_in: 90 }),
    };
  };
  const tok = await fetchAccessToken(
    {
      tokenUrl: 'http://127.0.0.1:3200/oauth/token',
      clientId: 'andy',
      clientSecret: 'sek',
      username: 'Andy',
      audience: 'mc-paper-1.20.1',
      maxRetries: 1,
    },
    { fetchFn, now: () => 1000 }
  );
  assert.equal(tok.method, 'jwt');
  assert.equal(tok.access_token, 'jwt-1');
  assert.equal(tok.expires_at, 91000);
  assert.equal(calls[0].body.grant_type, 'client_credentials');
  assert.equal(calls[0].body.username, 'Andy');
});

test('fetchAccessToken denies 401 without retry storm', async () => {
  let n = 0;
  const fetchFn = async () => {
    n += 1;
    return { ok: false, status: 401, json: async () => ({ error: 'invalid_client' }) };
  };
  await assert.rejects(
    () =>
      fetchAccessToken(
        {
          tokenUrl: 'http://x/token',
          clientId: 'a',
          clientSecret: 'b',
          username: 'Andy',
          maxRetries: 3,
        },
        { fetchFn }
      ),
    /invalid_client/
  );
  assert.equal(n, 1);
});

test('legacy static token', async () => {
  const tok = await fetchAccessToken({ legacyToken: 'old' }, { now: () => 0 });
  assert.equal(tok.method, 'legacy');
  assert.equal(tok.access_token, 'old');
});

test('sendAuth writes Bearer payload', () => {
  const writes = [];
  const bot = {
    _client: {
      registerChannel() {},
      writeChannel(ch, buf) {
        writes.push({ ch, text: buf.toString('utf8') });
      },
    },
  };
  sendAuth(bot, 'jwt-1');
  assert.equal(writes[0].ch, AUTH_CHANNEL);
  assert.equal(writes[0].text, 'Bearer jwt-1');
});
