'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  AUTH_CHANNEL,
  REG_CHANNEL,
  loadAuthConfig,
  isAuthConfigured,
  formatBearer,
  fetchAccessToken,
  sendAuth,
  registerGateChannels,
  requestReg,
  parseRegChatFallback,
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

test('sendAuth writes Bearer payload and registers with custom=true', () => {
  const writes = [];
  const regs = [];
  const bot = {
    _client: {
      registerChannel(name, typ, custom) {
        regs.push({ name, typ, custom });
      },
      writeChannel(ch, buf) {
        writes.push({ ch, text: buf.toString('utf8') });
      },
    },
  };
  sendAuth(bot, 'jwt-1');
  assert.equal(writes[0].ch, AUTH_CHANNEL);
  assert.equal(writes[0].text, 'Bearer jwt-1');
  assert.ok(regs.some((r) => r.name === AUTH_CHANNEL && r.custom === true));
  assert.ok(regs.some((r) => r.name === REG_CHANNEL && r.custom === true));
});

test('registerGateChannels uses custom=true for auth and reg', () => {
  const regs = [];
  const bot = {
    _client: {
      registerChannel(name, typ, custom) {
        regs.push({ name, typ, custom });
      },
    },
  };
  const out = registerGateChannels(bot);
  assert.deepEqual(out.channels, [AUTH_CHANNEL, REG_CHANNEL]);
  assert.equal(regs.length, 2);
  assert.ok(regs.every((r) => r.custom === true && Array.isArray(r.typ)));
});

test('parseRegChatFallback', () => {
  assert.deepEqual(parseRegChatFallback('[grokbot:reg] {"code":"AB12"}'), { code: 'AB12' });
  assert.equal(parseRegChatFallback('hello'), null);
});

test('requestReg receives plugin-channel JSON without chat', async () => {
  const client = new EventEmitter();
  const regs = [];
  const writes = [];
  client.registerChannel = (name, typ, custom) => {
    regs.push({ name, custom });
  };
  client.writeChannel = (ch, buf) => {
    writes.push({ ch, text: buf.toString('utf8') });
    queueMicrotask(() => client.emit(REG_CHANNEL, Buffer.from('{"code":"ZX9"}', 'utf8')));
  };
  const bot = { _client: client };
  const res = await requestReg(bot, { timeoutMs: 1000, chatFallback: false });
  assert.equal(res.via, 'plugin');
  assert.equal(res.payload.code, 'ZX9');
  assert.equal(writes[0].ch, REG_CHANNEL);
  assert.ok(regs.every((r) => r.custom === true));
});

test('requestReg can fall back to chat marker', async () => {
  const client = new EventEmitter();
  client.registerChannel = () => {};
  client.writeChannel = () => {};
  const bot = new EventEmitter();
  bot._client = client;
  const p = requestReg(bot, { timeoutMs: 1000, chatFallback: true });
  queueMicrotask(() => bot.emit('chat', 'Server', '[grokbot:reg] {"code":"CHAT1"}'));
  const res = await p;
  assert.equal(res.via, 'chat');
  assert.equal(res.payload.code, 'CHAT1');
});
