'use strict';

/**
 * Grok Bot Minecraft body — Mineflayer motor + Unix socket control (no LLM).
 *
 * Preferred control (decentralized):
 *   Unix socket JSONL  →  see ARCHITECTURE.md / gbot CLI
 *
 * CLI:
 *   node player-bot.js --name Andy --socket /tmp/gbot/Andy.sock \
 *        --soul ../souls/andy.toml --host 127.0.0.1 --mc-port 25565
 *
 * Optional legacy HTTP (off by default):
 *   --http-port 3001
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock');
const toolPlugin = require('mineflayer-tool').plugin;
const autoEatPlugin = require('mineflayer-auto-eat').plugin || require('mineflayer-auto-eat').loader;

const defaults = require('./config');
const { buildStatus, inventoryDetail, sampleBlocks } = require('./status');
const { executeAction, stopAll } = require('./actions');
const { loadSoul } = require('./soul');
const { EventLog } = require('./events');
const { ModeRunner } = require('./modes');
const { runSkill, SKILL_DOCS, signTextOf } = require('./skills');
const { PlaceBook } = require('./places');
const { createSocketServer } = require('./socket-server');
const { parseWorldMessage, parseWhisper } = require('./coord');
const { PeerBook } = require('./peers');
const presence = require('./presence');
const gateAuth = require('./auth');

// ---------- CLI ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name' || a === '-n') out.name = argv[++i];
    else if (a === '--port' || a === '-p' || a === '--http-port') out.httpPort = Number(argv[++i]);
    else if (a === '--socket' || a === '-s') out.socket = argv[++i];
    else if (a === '--soul') out.soul = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--mc-port') out.mcPort = Number(argv[++i]);
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--no-modes') out.noModes = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`Usage: node player-bot.js --name <name> [--socket PATH] [--soul FILE] [--http-port N]
  Default control: Unix socket at run/socks/<name>.sock (or --socket)
  HTTP only if --http-port is set. Prefer: gbot attach <name>`);
  process.exit(0);
}

const config = {
  ...defaults,
  botName: args.name || defaults.botName,
  httpPort: args.httpPort || null, // null = HTTP off
  host: args.host || defaults.host,
  mcPort: args.mcPort || defaults.mcPort,
  version: args.version || defaults.version,
};

const socketPath =
  args.socket ||
  process.env.GBOT_SOCKET ||
  path.resolve(__dirname, '../run/socks', `${config.botName}.sock`);

const soul = loadSoul(
  args.soul || process.env.GBOT_SOUL || path.resolve(__dirname, '../souls/andy.toml')
);
// MC username prefers soul.name if CLI name is default-ish
if (args.name) {
  /* keep */
} else if (soul.name) {
  config.botName = soul.name;
}

const authCfg = gateAuth.loadAuthConfig(process.env, {
  username: config.botName,
  clientId: soul.client_id || config.grokClientId || config.botName,
});
const authRequired = gateAuth.isAuthConfigured(authCfg);
/** @type {{ authenticated: boolean, method: string|null, skipped: boolean, error: string|null, expires_at: number|null, client_id: string|null }} */
let authState = {
  authenticated: false,
  method: null,
  skipped: !authRequired,
  error: null,
  expires_at: null,
  client_id: authCfg.clientId || null,
};
let pendingToken = null;

function authOk() {
  return !authRequired || authState.authenticated;
}

function resetAuthPending() {
  authState = {
    authenticated: false,
    method: null,
    skipped: !authRequired,
    error: null,
    expires_at: null,
    client_id: authCfg.clientId || null,
  };
  if (authRequired && !args.noModes) modeRunner.enabled = false;
}

async function finishAuth(instance) {
  if (bot !== instance) return;
  if (!authRequired) {
    authState = { ...authState, skipped: true, authenticated: false, error: null };
    log('auth skipped (no GROK_TOKEN_URL/secret and no GROK_BOT_TOKEN)');
    greetIfAllowed(instance);
    return;
  }
  try {
    let token = pendingToken ? await pendingToken : null;
    if (bot !== instance) return;
    pendingToken = null;
    if (token && token.error) token = null;
    const stale = !token || !token.access_token || (token.expires_at && token.expires_at < Date.now() + 5000);
    if (stale) token = await gateAuth.fetchAccessToken(authCfg);
    if (bot !== instance) return;
    gateAuth.sendAuth(instance, token.access_token);
    authState = {
      authenticated: true,
      method: token.method,
      skipped: false,
      error: null,
      expires_at: token.expires_at || null,
      client_id: authCfg.clientId,
      sent: true,
    };
    if (!args.noModes) modeRunner.enabled = true;
    log('auth sent', token.method, gateAuth.AUTH_CHANNEL);
    eventLog.push('auth', { ok: true, method: token.method });
    greetIfAllowed(instance);
  } catch (e) {
    if (bot !== instance) return;
    authState = {
      authenticated: false,
      method: null,
      skipped: false,
      error: e.message,
      expires_at: null,
      client_id: authCfg.clientId,
      sent: false,
    };
    lastError = `auth: ${e.message}`;
    if (!args.noModes) modeRunner.enabled = false;
    log('auth failed — expect SPECTATOR:', e.message);
    eventLog.push('auth', { ok: false, error: e.message });
  }
}

function greetIfAllowed(instance) {
  if (!soul.greeting || soul.modes?.social === false) return;
  if (!authOk()) return;
  setTimeout(() => {
    if (bot === instance && authOk()) {
      bot.chat?.(String(soul.greeting).slice(0, 100));
    }
  }, 1500);
}

// ---------- Logging ----------
const logDir = path.resolve(__dirname, config.logDir);
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {
  /* ignore */
}
const logFile = path.join(logDir, `player-${config.botName}.app.log`);

function log(...parts) {
  const line = `[${new Date().toISOString()}] [${config.botName}] ${parts.map(String).join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* ignore */
  }
}

// ---------- Runtime state ----------
let bot = null;
let connected = false;
let starting = false;
let lastError = null;
let quitting = false;
let reconnectTimer = null;
let jobCounter = 0;

/** @type {null | { id, type, state, target, message, startedAt, abortController }} */
let currentJob = null;
const chatRecent = [];
const eventLog = new EventLog(300);
const memoryDir = path.resolve(__dirname, '../memory');
try {
  fs.mkdirSync(memoryDir, { recursive: true });
} catch {
  /* */
}
const diaryFile = path.join(memoryDir, `${config.botName}.jsonl`);
const placeBook = new PlaceBook(config.botName, memoryDir);
const peers = new PeerBook();
const sense = new presence.WorldSense();

function diary(kind, data) {
  try {
    fs.appendFileSync(
      diaryFile,
      JSON.stringify({ ts: Date.now(), kind, ...data }) + '\n'
    );
  } catch {
    /* */
  }
}

// Rate limit
const actionTimestamps = [];

function rateLimited() {
  const now = Date.now();
  while (actionTimestamps.length && now - actionTimestamps[0] > config.actionRateWindowMs) {
    actionTimestamps.shift();
  }
  if (actionTimestamps.length >= config.actionRateLimit) return true;
  actionTimestamps.push(now);
  return false;
}

function jobSnapshot() {
  if (!currentJob) return null;
  return {
    id: currentJob.id,
    type: currentJob.type,
    state: currentJob.state,
    target: currentJob.target || null,
    message: currentJob.message || null,
    started_at: currentJob.startedAt,
  };
}

function meta() {
  return {
    botName: config.botName,
    httpPort: config.httpPort,
    connected,
    starting,
    lastError,
  };
}

function statusCtx() {
  return {
    bot,
    config,
    job: jobSnapshot(),
    chatRecent,
    meta: meta(),
  };
}

// ---------- Job management ----------
let clearJobTimer = null;

function scheduleClearJob(jobId, delayMs) {
  if (clearJobTimer) clearTimeout(clearJobTimer);
  clearJobTimer = setTimeout(() => {
    clearJobTimer = null;
    if (currentJob && currentJob.id === jobId && currentJob.state !== 'running') {
      currentJob = null;
    }
  }, delayMs);
}

/**
 * Mark job terminal but keep it visible for polling (3–5s).
 */
function finishJob(jobId, state, message, keepMs = 4000) {
  if (!currentJob || currentJob.id !== jobId) return;
  currentJob.state = state;
  currentJob.message = message;
  scheduleClearJob(jobId, keepMs);
}

async function abortCurrentJob(reason = 'aborted') {
  const job = currentJob;
  if (!job) {
    if (bot) await stopAll(bot);
    return jobSnapshot();
  }

  // Already terminal — just ensure movement stopped
  if (job.state !== 'running') {
    if (bot) await stopAll(bot);
    return jobSnapshot();
  }

  try {
    job.abortController?.abort?.();
  } catch {
    /* ignore */
  }
  if (bot) await stopAll(bot);

  // Keep aborted state visible for pollers (do NOT null immediately)
  job.state = 'aborted';
  job.message = reason;
  log('job aborted', job.id, reason);
  scheduleClearJob(job.id, 5000);
  return jobSnapshot();
}

function isLongRunning(type) {
  return ['move_to', 'dig', 'place', 'craft', 'follow_player'].includes(type);
}

let skillInFlight = false;

function isBusy() {
  return Boolean(currentJob && currentJob.state === 'running') || skillInFlight;
}

/**
 * Accept action: short actions may run inline; long ones always async.
 * Always returns quickly for long-running types.
 */
async function acceptAction(body) {
  const type = String(body.type || body.action || '').toLowerCase().trim();
  if (!type) {
    const err = new Error('Missing type');
    err.code = 'BAD_ARGS';
    throw err;
  }

  // stop is special: cancel job and return
  if (type === 'stop') {
    const snap = await abortCurrentJob('stop');
    return { accepted: true, sync: true, result: { ok: true, message: 'stopped' }, job: snap };
  }

  if (!bot?.entity || !connected) {
    const err = new Error('Bot not connected to Minecraft');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  if (isBusy()) {
    const err = new Error(
      `Busy with job ${currentJob.id} (${currentJob.type}). POST /stop or action stop first.`
    );
    err.code = 'BUSY';
    throw err;
  }

  // Terminal leftover job from previous action — clear before accepting new work
  if (currentJob && currentJob.state !== 'running') {
    currentJob = null;
    if (clearJobTimer) {
      clearTimeout(clearJobTimer);
      clearJobTimer = null;
    }
  }

  const target =
    body.x !== undefined
      ? { x: Number(body.x), y: Number(body.y), z: Number(body.z) }
      : body.player || body.name || body.item || null;

  const jobId = `job_${++jobCounter}_${Date.now()}`;
  const abortController = new AbortController();

  // Long-running → always async
  if (isLongRunning(type)) {
    currentJob = {
      id: jobId,
      type,
      state: 'running',
      target,
      message: null,
      startedAt: Date.now(),
      abortController,
    };

    // Capture bot ref for this job — ignore results if bot was replaced
    const botForJob = bot;

    setImmediate(async () => {
      try {
        log('job start', jobId, type, JSON.stringify(target));
        const result = await executeAction(botForJob, config, body, abortController.signal);
        if (currentJob && currentJob.id === jobId && currentJob.state === 'running') {
          finishJob(jobId, 'done', result.message || 'done', 3000);
          log('job done', jobId, result.message || 'done');
        }
      } catch (e) {
        if (!currentJob || currentJob.id !== jobId) return;
        // If already marked aborted by abortCurrentJob, keep that state
        if (currentJob.state === 'aborted') return;
        if (e.code === 'ABORTED' || abortController.signal.aborted) {
          finishJob(jobId, 'aborted', e.message || 'aborted', 5000);
        } else {
          finishJob(jobId, 'error', e.message, 5000);
          log('job error', jobId, e.code || '', e.message);
        }
      }
    });

    return {
      accepted: true,
      sync: false,
      job_id: jobId,
      type,
      message: 'Job accepted. Poll GET /status or GET /job',
    };
  }

  // Short actions: run now, return result
  currentJob = {
    id: jobId,
    type,
    state: 'running',
    target,
    message: null,
    startedAt: Date.now(),
    abortController,
  };

  try {
    const result = await executeAction(bot, config, body, abortController.signal);
    finishJob(jobId, 'done', result.message, 2000);
    return { accepted: true, sync: true, job_id: jobId, result, job: jobSnapshot() };
  } catch (e) {
    finishJob(jobId, 'error', e.message, 3000);
    const err = e;
    err.job = jobSnapshot();
    throw err;
  }
}

// ---------- Chat buffer (deduped) ----------
function pushChat(line, meta = {}) {
  const s = String(line).slice(0, 300);
  if (!s) return;
  // Drop exact duplicate of last line (messagestr + chat often double-fire)
  if (chatRecent.length && chatRecent[chatRecent.length - 1] === s) return;
  if (chatRecent.length) {
    const last = chatRecent[chatRecent.length - 1];
    if (s.startsWith('<') && last.includes(s.replace(/^<[^>]+>\s*/, ''))) {
      if (!last.startsWith('<') && last.includes(s.slice(s.indexOf('>') + 2))) {
        chatRecent[chatRecent.length - 1] = s;
        return;
      }
    }
  }
  chatRecent.push(s);
  while (chatRecent.length > config.chatHistoryLimit * 2) chatRecent.shift();

  // World-bus event (this is how other bots "talk" to this mind)
  const from = meta.from || null;
  eventLog.push(from ? 'chat' : 'system', {
    from,
    text: s,
    whisper: Boolean(meta.whisper),
  });
  diary('chat', { from, text: s });
}

// Idle wander goes through acceptAction so isBusy() is true and ticks cannot stack motors.
async function modeRunAction(body) {
  const type = String(body.type || '').toLowerCase();
  if (type === 'move_to' || type === 'follow_player') {
    return acceptAction(body);
  }
  return executeAction(bot, config, body, undefined);
}

const modeRunner = new ModeRunner({
  getBot: () => bot,
  soul,
  config,
  emit: (kind, data) => {
    eventLog.push(kind === 'mode' ? 'mode' : kind, data);
  },
  isBusy,
  runAction: modeRunAction,
  abortJob: (reason) => abortCurrentJob(reason || 'mode'),
  stopMotors: () => stopAll(bot),
});
if (!args.noModes) {
  if (authRequired) modeRunner.enabled = false;
  modeRunner.start();
}

// ---------- Mineflayer connection ----------
function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (quitting || !config.autoReconnect) return;
  clearReconnect();
  log(`reconnect in ${config.reconnectDelayMs}ms ...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, config.reconnectDelayMs);
}

/**
 * Tear down previous bot instance before creating a new one.
 */
async function destroyBot(reason = 'replace') {
  const old = bot;
  bot = null;
  connected = false;
  if (!old) return;
  try {
    old.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    await stopAll(old);
  } catch {
    /* ignore */
  }
  try {
    old.quit?.(reason);
  } catch {
    /* ignore */
  }
  try {
    old.end?.(reason);
  } catch {
    /* ignore */
  }
  log('destroyed previous bot', reason);
}

function createBot() {
  if (quitting) return;
  if (starting) return;
  starting = true;
  connected = false;
  lastError = null;
  resetAuthPending();

  // Abort in-flight work and drop old connection cleanly
  abortCurrentJob('reconnect').catch(() => {});
  // destroyBot is sync-enough; fire and continue
  const prev = bot;
  if (prev) {
    bot = null;
    try {
      prev.removeAllListeners();
    } catch {
      /* ignore */
    }
    try {
      stopAll(prev);
    } catch {
      /* ignore */
    }
    try {
      prev.quit('reconnect');
    } catch {
      /* ignore */
    }
    log('cleaned previous bot before reconnect');
  }

  log(`connecting to ${config.host}:${config.mcPort} as ${config.botName} (version ${config.version})`);

  let instance;
  try {
    instance = mineflayer.createBot({
      host: config.host,
      port: config.mcPort,
      username: config.botName,
      auth: 'offline',
      version: config.version,
      hideErrors: false,
      checkTimeoutInterval: 60_000,
    });
  } catch (e) {
    starting = false;
    lastError = e.message;
    log('createBot failed', e.message);
    scheduleReconnect();
    return;
  }

  bot = instance;
  bot._soul = soul;
  let reconnectScheduled = false;
  const requestReconnect = (why) => {
    if (quitting || reconnectScheduled) return;
    // Only reconnect if this instance is still the active bot
    if (bot !== instance) return;
    reconnectScheduled = true;
    starting = false;
    connected = false;
    scheduleReconnect();
    log('reconnect requested:', why);
  };

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock.plugin);
  bot.loadPlugin(toolPlugin);
  bot.loadPlugin(autoEatPlugin);

  if (authRequired) {
    pendingToken = gateAuth.fetchAccessToken(authCfg).catch((e) => ({ error: e }));
  }

  bot.once('spawn', () => {
    if (bot !== instance) return;
    starting = false;
    connected = true;
    lastError = null;
    log('spawned at', bot.entity.position.toString());
    eventLog.push('spawn', { pos: bot.entity.position });
    diary('spawn', { pos: String(bot.entity.position) });

    finishAuth(instance).catch((e) => log('auth hook', e.message));

    try {
      const autoEatOn = soul.modes?.auto_eat !== false && config.autoEat;
      if (autoEatOn) {
        bot.autoEat?.enable?.();
        if (bot.autoEat?.options) {
          bot.autoEat.options.startAt = 16;
          bot.autoEat.options.priority = 'saturation';
        }
      } else {
        bot.autoEat?.disable?.();
      }
    } catch (e) {
      log('autoEat setup warn', e.message);
    }

    const peerTick = setInterval(() => {
      if (bot !== instance || !bot?.entity) return;
      peers.observeVisible(bot);
    }, 4000);
    instance.once('end', () => clearInterval(peerTick));
  });

  // Player chat — primary multi-agent bus (in-world only)
  bot.on('chat', (username, message) => {
    if (bot !== instance) return;
    if (username === bot.username) return;
    if (presence.isSpectator(bot, username)) return;
    pushChat(`<${username}> ${message}`, { from: username });
    const parsed = parseWorldMessage(message, username);
    if (parsed) {
      eventLog.push('coord', parsed);
      if (parsed.x != null && parsed.z != null) {
        peers.note(username, parsed, parsed.kind || 'chat');
      }
    }

    const named =
      new RegExp(`\\b${bot.username}\\b`, 'i').test(String(message)) ||
      String(message).includes(bot.username);
    if (named) {
      const speaker = bot.players[username]?.entity;
      eventLog.push('named', { from: username, text: message });
      (async () => {
        if (bot !== instance) return;
        if (speaker?.position) {
          try {
            await bot.lookAt(speaker.position.offset(0, speaker.height * 0.85, 0), true);
          } catch {
            /* */
          }
        }
      })().catch(() => {});
      if (!isBusy() && soul.modes?.social !== false && authOk()) {
        setTimeout(() => {
          if (bot !== instance || !authOk()) return;
          try {
            bot.chat(presence.pickReactLine('named', soul));
          } catch {
            /* */
          }
        }, 500 + Math.random() * 900);
      } else {
        sense.push('named', { from: username, pos: speaker?.position, voiced: false });
      }
    } else if (soul.modes?.auto_chat_react && !isBusy() && String(message).includes('有人')) {
      setTimeout(() => {
        if (!isBusy() && bot === instance) {
          try {
            bot.chat('嗯？');
          } catch {
            /* */
          }
        }
      }, 800 + Math.random() * 1200);
    }
  });

  // System / non-player messages only
  bot.on('messagestr', (msg, position, original) => {
    if (bot !== instance) return;
    const line = String(msg);
    const whispered = parseWhisper(line, original);
    if (whispered) {
      ingestWhisper(whispered.from, whispered.text);
      return;
    }
    if (position === 'chat') return;
    if (/^<[^>]+>\s/.test(line)) return;
    pushChat(line);
    const death = presence.parseDeathLine(line);
    if (death && death.name !== bot.username) {
      const last = peers.get(death.name);
      eventLog.push('death_other', { name: death.name, how: death.how, last });
      if (!isBusy() && soul.modes?.social !== false && authOk()) {
        setTimeout(() => {
          if (bot !== instance || !authOk()) return;
          try {
            bot.chat(presence.pickReactLine('death', soul));
          } catch {
            /* */
          }
        }, 400 + Math.random() * 800);
      } else {
        sense.push('death', {
          name: death.name,
          how: death.how,
          pos: last ? { x: last.x, y: last.y, z: last.z } : null,
          voiced: false,
        });
      }
    }
  });

  let lastWhisperKey = '';
  function ingestWhisper(username, message) {
    if (!username || username === bot.username) return;
    if (presence.isSpectator(bot, username)) return;
    const text = String(message || '');
    const key = `${username}\0${text}`;
    if (key === lastWhisperKey) return;
    lastWhisperKey = key;
    pushChat(`[whisper][${username}] ${text}`, { from: username, whisper: true });
    eventLog.push('whisper', { from: username, text });
    const parsed = parseWorldMessage(text, username);
    if (parsed) {
      eventLog.push('coord', { ...parsed, whisper: true });
      if (parsed.x != null && parsed.z != null) peers.note(username, parsed, 'whisper');
    }
  }

  bot.on('whisper', (username, message) => {
    if (bot !== instance) return;
    ingestWhisper(username, message);
  });

  let lastBoomAt = 0;
  const onBoom = (label) => {
    if (bot !== instance) return;
    if (!/explod|explosion|explode/i.test(String(label || ''))) return;
    const now = Date.now();
    if (now - lastBoomAt < 1500) return;
    lastBoomAt = now;
    eventLog.push('explode', { sound: String(label) });
    if (!isBusy() && soul.modes?.social !== false && authOk()) {
      setTimeout(() => {
        if (bot !== instance || !authOk()) return;
        try {
          bot.chat(presence.pickReactLine('explode', soul));
        } catch {
          /* */
        }
      }, 200 + Math.random() * 500);
    } else {
      sense.push('explode', { voiced: false });
    }
  };
  bot.on('soundEffectHeard', (soundName) => onBoom(soundName));
  bot.on('hardcodedSoundEffectHeard', (_id, name) => onBoom(name));

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (bot !== instance) return;
    if (oldBlock && newBlock && oldBlock.name !== 'air' && (newBlock.name === 'air' || newBlock.name === 'cave_air')) {
      sense.noteTrace('dig', oldBlock.position);
    }
    if (newBlock && String(newBlock.name || '').includes('torch')) {
      sense.noteTrace('torch', newBlock.position);
    }
    if (
      oldBlock &&
      presence.interestingOre(oldBlock.name) &&
      newBlock &&
      (newBlock.name === 'air' || newBlock.name === 'cave_air') &&
      bot.entity
    ) {
      const d = bot.entity.position.distanceTo(oldBlock.position);
      if (d < 10) {
        sense.push('ore', { pos: oldBlock.position, block: oldBlock.name });
        eventLog.push('ore', { block: oldBlock.name, pos: oldBlock.position });
      }
    } else if (newBlock && presence.interestingOre(newBlock.name) && bot.entity) {
      const d = bot.entity.position.distanceTo(newBlock.position);
      if (d < 8) {
        sense.push('ore', { pos: newBlock.position, block: newBlock.name });
        eventLog.push('ore', { block: newBlock.name, pos: newBlock.position });
      }
    }
    if (!newBlock || !String(newBlock.name || '').includes('sign')) return;
    let parsedSign = { text: '', available: false };
    try {
      parsedSign = signTextOf(newBlock);
    } catch {
      /* */
    }
    const pos = {
      x: newBlock.position.x,
      y: newBlock.position.y,
      z: newBlock.position.z,
    };
    eventLog.push('sign', { pos, block: newBlock.name, text: parsedSign.text || '' });
    const parsed = parseWorldMessage(parsedSign.text || '', 'sign');
    if (parsed) {
      eventLog.push('coord', { ...parsed, via: 'sign', pos });
      if (parsed.from && parsed.from !== 'sign' && parsed.x != null) {
        peers.note(parsed.from, parsed, 'sign');
      }
    }
  });

  bot.on('health', () => {
    if (bot !== instance || !bot.entity) return;
    if (bot.entity.position.y < config.voidY + 2) {
      log('void danger — stopping movement');
      stopAll(bot).catch(() => {});
    }
  });

  bot.on('death', () => {
    if (bot !== instance) return;
    log('died');
    pushChat('[system] died');
    eventLog.push('death', {});
    abortCurrentJob('death').catch(() => {});
  });

  bot.on('kicked', (reason) => {
    if (bot !== instance) return;
    lastError = `kicked: ${reason}`;
    log('kicked', reason);
    abortCurrentJob('kicked').catch(() => {});
    requestReconnect('kicked');
  });

  bot.on('end', (reason) => {
    if (bot !== instance) return;
    log('disconnected', reason || '');
    abortCurrentJob('disconnected').catch(() => {});
    requestReconnect(reason || 'end');
  });

  bot.on('error', (err) => {
    if (bot !== instance) return;
    lastError = err.message;
    log('error', err.message);
  });
}

// ---------- Unix socket (primary control plane) ----------
function fullStatus(detail) {
  const base = buildStatus(statusCtx(), detail || []);
  return {
    ...base,
    soul: {
      name: soul.name,
      speech_style: soul.speech_style,
      drives: soul.drives,
      modes: soul.modes,
      gait: soul.gait,
      safety: soul.safety,
    },
    goal: modeRunner.getGoal(),
    socket: socketPath,
    events_latest: eventLog.seq,
    peers: peers.list(),
    auth: authState,
  };
}

const socketApi = createSocketServer(socketPath, {
  async ping() {
    return { pong: true, bot: config.botName };
  },
  async health() {
    return {
      bot: config.botName,
      connected,
      starting,
      mc: { host: config.host, port: config.mcPort, version: config.version },
      job: jobSnapshot(),
      socket: socketPath,
      goal: modeRunner.getGoal(),
      auth: authState,
      uptime_s: Math.floor(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  },
  async status(req) {
    const detail = req.detail
      ? String(req.detail).split(',').map((s) => s.trim())
      : [];
    return fullStatus(detail);
  },
  async events(req) {
    return eventLog.since(req.since, req.limit || 50);
  },
  async job() {
    return { job: jobSnapshot() };
  },
  async auth_status() {
    return { auth: authState, required: authRequired, username: config.botName };
  },
  async auth() {
    if (!bot) {
      const err = new Error('not connected');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    pendingToken = null;
    await finishAuth(bot);
    return { auth: authState };
  },
  async do(req) {
    // {"op":"do","type":"move_to","x":1,...}  or {"op":"do","action":{...}}
    if (rateLimited()) {
      const err = new Error('rate limited');
      err.code = 'RATE_LIMIT';
      throw err;
    }
    let payload;
    if (req.action && typeof req.action === 'object') {
      payload = { ...req.action };
    } else {
      payload = { ...req };
      delete payload.op;
      delete payload.id;
      delete payload.cmd;
    }
    if (!payload.type) {
      const err = new Error('do requires type (e.g. move_to, chat, dig)');
      err.code = 'BAD_ARGS';
      throw err;
    }
    return acceptAction(payload);
  },
  async stop() {
    return { ok: true, job: await abortCurrentJob('stop') };
  },
  async say(req) {
    const text = req.text || req.message || req.body;
    return acceptAction({ type: 'chat', message: text });
  },
  async skill(req) {
    // skill name: prefer explicit skill field so `name` can mean place/player/item
    const skillName = req.skill || req.skill_name || req.name;
    if (!skillName || skillName === 'help') {
      return { skills: SKILL_DOCS };
    }
    if (isBusy()) {
      const err = new Error('busy');
      err.code = 'BUSY';
      throw err;
    }
    const args = { ...(req.args && typeof req.args === 'object' ? req.args : {}) };
    // merge top-level params commonly used by CLI
    for (const k of [
      'item', 'block', 'player', 'text', 'message', 'body', 'count', 'range',
      'x', 'y', 'z', 'title', 'author', 'pages', 'note', 'duration_ms',
      'timeout_ms', 'seconds', 'distance', 'depth', 'sign', 'place', 'label',
      'dx', 'dy', 'dz', 'face', 'to', 'mob', 'entity',
      'tool', 'target', 'seed', 'index', 'id', 'need', 'give', 'tag',
      'deliver', 'note', 'chest', 'kind', 'emote',
    ]) {
      if (req[k] !== undefined) args[k] = req[k];
    }
    // if skill was in req.skill, req.name is a parameter (place/player)
    if (req.skill && req.name) args.name = req.name;
    else if (req.place) args.name = req.place;

    // Mark body busy so modes / concurrent do don't interleave mid-skill
    const jobId = `skill_${++jobCounter}_${Date.now()}`;
    const abortController = new AbortController();
    currentJob = {
      id: jobId,
      type: `skill:${skillName}`,
      state: 'running',
      target: args.block || args.item || args.player || args.name || null,
      message: null,
      startedAt: Date.now(),
      abortController,
    };

    const run = (body) => executeAction(bot, config, body, abortController.signal);
    skillInFlight = true;
    try {
      const result = await runSkill(
        skillName,
        {
          bot,
          runAction: run,
          config,
          places: placeBook,
          peers,
          soul,
          sense,
          signal: abortController.signal,
        },
        args
      );
      if (currentJob && currentJob.id === jobId && currentJob.state === 'running') {
        finishJob(jobId, 'done', result?.message || 'skill_done', 3000);
      }
      eventLog.push('skill', { skill: skillName, result });
      diary('skill', { skill: skillName, result: result?.message });
      return result;
    } catch (e) {
      if (currentJob && currentJob.id === jobId && currentJob.state === 'running') {
        if (e.code === 'ABORTED' || abortController.signal.aborted) {
          finishJob(jobId, 'aborted', e.message, 5000);
        } else {
          finishJob(jobId, 'error', e.message, 5000);
        }
      }
      throw e;
    } finally {
      skillInFlight = false;
    }
  },
  async skills() {
    return { skills: SKILL_DOCS };
  },
  async places() {
    return { places: placeBook.list() };
  },
  async goal(req) {
    const text = req.text || req.goal || null;
    modeRunner.setGoal(text);
    diary('goal', { text });
    return { goal: text };
  },
  async soul() {
    return soul;
  },
  async modes(req) {
    if (req.enable === false) {
      modeRunner.enabled = false;
      return { enabled: false };
    }
    if (req.enable === true) {
      modeRunner.enabled = true;
      return { enabled: true };
    }
    return { enabled: modeRunner.enabled, modes: soul.modes, goal: modeRunner.getGoal() };
  },
  async quit() {
    setTimeout(() => process.exit(0), 200);
    quitting = true;
    modeRunner.stop();
    await abortCurrentJob('quit');
    try {
      bot?.quit?.('quit');
    } catch {
      /* */
    }
    return { ok: true };
  },
});

log(`Unix socket: ${socketPath}`);

// ---------- HTTP (legacy, opt-in) ----------
function startHttp() {
if (!config.httpPort) {
  log('HTTP disabled (set --http-port to enable legacy API)');
  return;
}
const app = express();
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Bot-Name', config.botName);
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    bot: config.botName,
    port: config.httpPort,
    socket: socketPath,
    connected,
    starting,
    mc: { host: config.host, port: config.mcPort, version: config.version },
    job: jobSnapshot(),
    uptime_s: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});


app.get('/status', (req, res) => {
  const detail = req.query.detail
    ? String(req.query.detail).split(',').map((s) => s.trim())
    : [];
  res.json(buildStatus(statusCtx(), detail));
});

app.get('/inventory', (_req, res) => {
  if (!bot?.inventory) {
    return res.status(503).json({ error: 'not_connected', items: [] });
  }
  res.json({
    bot: config.botName,
    held: bot.heldItem
      ? { name: bot.heldItem.name, count: bot.heldItem.count }
      : null,
    items: inventoryDetail(bot),
  });
});

app.get('/blocks', (req, res) => {
  if (!bot?.entity) {
    return res.status(503).json({ error: 'not_connected', blocks: [] });
  }
  const radius = Math.min(4, Math.max(1, Number(req.query.radius || 2)));
  res.json({ bot: config.botName, radius, blocks: sampleBlocks(bot, radius) });
});

app.get('/job', (_req, res) => {
  res.json({ job: jobSnapshot() });
});

app.post('/action', async (req, res) => {
  try {
    if (rateLimited()) {
      return res.status(429).json({
        error: 'rate_limited',
        message: `Max ${config.actionRateLimit} actions per ${config.actionRateWindowMs}ms`,
      });
    }
    const body = req.body || {};
    const result = await acceptAction(body);
    res.json(result);
  } catch (e) {
    const code = e.code || 'ERROR';
    const status =
      code === 'BUSY' ? 409 :
      code === 'BAD_ARGS' ? 400 :
      code === 'NOT_FOUND' || code === 'NO_PATH' ? 404 :
      code === 'TIMEOUT' ? 504 :
      code === 'NOT_CONNECTED' ? 503 :
      500;
    res.status(status).json({
      error: code,
      message: e.message,
      job: e.job || jobSnapshot(),
    });
  }
});

app.post('/stop', async (_req, res) => {
  const snap = await abortCurrentJob('stop');
  res.json({ ok: true, message: 'stopped', job: snap });
});

app.post('/config', (req, res) => {
  const body = req.body || {};
  if (typeof body.auto_eat === 'boolean') {
    config.autoEat = body.auto_eat;
    try {
      if (bot?.autoEat) {
        if (config.autoEat) bot.autoEat.enable();
        else bot.autoEat.disable();
      }
    } catch {
      /* ignore */
    }
  }
  if (typeof body.auto_reconnect === 'boolean') {
    config.autoReconnect = body.auto_reconnect;
  }
  if (typeof body.entity_range === 'number') {
    config.entityRange = body.entity_range;
  }
  if (typeof body.player_range === 'number') {
    config.playerRange = body.player_range;
  }
  res.json({
    ok: true,
    config: {
      auto_eat: config.autoEat,
      auto_reconnect: config.autoReconnect,
      entity_range: config.entityRange,
      player_range: config.playerRange,
      action_rate_limit: config.actionRateLimit,
    },
  });
});

app.post('/quit', async (_req, res) => {
  res.json({ ok: true, message: 'quitting' });
  quitting = true;
  clearReconnect();
  await abortCurrentJob('quit');
  try {
    bot?.quit?.('quit via API');
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 300);
});

// 404
app.use((_req, res) => {
  res.status(404).json({
    error: 'not_found',
    endpoints: [
      'GET /health',
      'GET /status?detail=entities,blocks,inventory',
      'GET /inventory',
      'GET /blocks?radius=2',
      'GET /job',
      'POST /action',
      'POST /stop',
      'POST /config',
      'POST /quit',
    ],
  });
});

// ---------- Start ----------
  app.listen(config.httpPort, '127.0.0.1', () => {
    log(`HTTP listening on http://127.0.0.1:${config.httpPort} (legacy)`);
  });
}

startHttp();
createBot();

process.on('SIGINT', async () => {
  log('SIGINT');
  quitting = true;
  modeRunner.stop();
  clearReconnect();
  await abortCurrentJob('sigint');
  try {
    bot?.quit?.('SIGINT');
  } catch {
    /* ignore */
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('SIGTERM');
  quitting = true;
  modeRunner.stop();
  clearReconnect();
  await abortCurrentJob('sigterm');
  try {
    bot?.quit?.('SIGTERM');
  } catch {
    /* ignore */
  }
  process.exit(0);
});

