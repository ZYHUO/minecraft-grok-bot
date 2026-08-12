'use strict';

/**
 * Silent Mineflayer spectator — joins the Paper world only to observe
 * chat / join / leave and the online player set. Never chats or acts.
 * This is a human-facing mirror, not an agent mind or hub.
 */

const mineflayer = require('mineflayer');

function createWatcher(config, eventLog, hooks = {}) {
  let bot = null;
  let starting = false;
  let connected = false;
  let reconnectTimer = null;
  let lastError = null;
  let startedAt = Date.now();
  let spawnAt = null;

  const log = (...parts) => {
    if (typeof hooks.log === 'function') hooks.log(...parts);
    else console.log('[watcher]', ...parts.map(String));
  };

  function playerNames() {
    if (!bot || !bot.players) return [];
    return Object.keys(bot.players)
      .filter((n) => n && typeof n === 'string')
      .sort((a, b) => a.localeCompare(b, 'zh'));
  }

  function snapshot() {
    const players = playerNames();
    return {
      online: players.length,
      players,
      connected,
      starting,
      lastError,
      watcher: config.botName,
      server: {
        host: config.host,
        port: config.mcPort,
        version: config.version,
        auth: config.auth,
      },
      uptime_ms: Date.now() - startedAt,
      spawn_at: spawnAt,
      now: Date.now(),
    };
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(why) {
    if (!config.autoReconnect) return;
    if (reconnectTimer) return;
    const delay = config.reconnectDelayMs || 5000;
    log(`reconnect in ${delay}ms (${why || 'end'})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      start();
    }, delay);
  }

  function pushDedupedChat(kind, data) {
    const text = String(data.text || '').slice(0, 400);
    if (!text) return;
    const recent = eventLog.recent(3);
    for (const prev of recent) {
      if (prev.kind === kind && prev.text === text && prev.username === data.username) {
        if (Date.now() - prev.ts < 800) return;
      }
    }
    eventLog.push(kind, { ...data, text });
  }

  function wire(instance) {
    instance.once('login', () => {
      if (bot !== instance) return;
      log('login as', instance.username);
    });

    instance.once('spawn', () => {
      if (bot !== instance) return;
      starting = false;
      connected = true;
      lastError = null;
      spawnAt = Date.now();
      log('spawned — watching world');
      eventLog.push('system', {
        text: `旁观者 ${config.botName} 已进入世界`,
        username: null,
      });
      // Emit a status-friendly join for the watcher itself is optional; players refresh via SSE status.
      if (typeof hooks.onStatus === 'function') hooks.onStatus(snapshot());
    });

    instance.on('chat', (username, message) => {
      if (bot !== instance) return;
      // Include all public chat, including our own if anything ever spoke
      pushDedupedChat('chat', {
        username,
        text: String(message),
      });
    });

    // Non-chat system lines (join/leave announcements sometimes appear here depending on server)
    instance.on('messagestr', (msg, position) => {
      if (bot !== instance) return;
      const line = String(msg || '').trim();
      if (!line) return;
      if (position === 'chat') return;
      if (/^<[^>]+>\s/.test(line)) return;
      // Skip noisy tab-list / scoreboard spam
      if (line.length > 280) return;
      pushDedupedChat('system', { username: null, text: line });
    });

    instance.on('playerJoined', (player) => {
      if (bot !== instance) return;
      const name = player?.username;
      if (!name) return;
      eventLog.push('join', {
        username: name,
        text: `${name} 加入了游戏`,
      });
      if (typeof hooks.onStatus === 'function') hooks.onStatus(snapshot());
    });

    instance.on('playerLeft', (player) => {
      if (bot !== instance) return;
      const name = player?.username;
      if (!name) return;
      eventLog.push('leave', {
        username: name,
        text: `${name} 离开了游戏`,
      });
      if (typeof hooks.onStatus === 'function') hooks.onStatus(snapshot());
    });

    instance.on('kicked', (reason) => {
      if (bot !== instance) return;
      lastError = `kicked: ${reason}`;
      connected = false;
      log('kicked', reason);
      eventLog.push('system', { username: null, text: `旁观者被踢出: ${reason}` });
      scheduleReconnect('kicked');
    });

    instance.on('end', (reason) => {
      if (bot !== instance) return;
      connected = false;
      starting = false;
      log('disconnected', reason || '');
      eventLog.push('system', {
        username: null,
        text: `旁观者断线${reason ? `: ${reason}` : ''}`,
      });
      if (typeof hooks.onStatus === 'function') hooks.onStatus(snapshot());
      scheduleReconnect(reason || 'end');
    });

    instance.on('error', (err) => {
      if (bot !== instance) return;
      lastError = err.message;
      log('error', err.message);
    });
  }

  function start() {
    if (starting && bot) return;
    clearReconnect();
    starting = true;
    connected = false;

    if (bot) {
      try {
        bot.removeAllListeners();
        bot.quit('restart');
      } catch {
        /* */
      }
      bot = null;
    }

    log(`connecting ${config.host}:${config.mcPort} as ${config.botName} (${config.version})`);
    let instance;
    try {
      instance = mineflayer.createBot({
        host: config.host,
        port: config.mcPort,
        username: config.botName,
        version: config.version,
        auth: config.auth,
        hideErrors: true,
      });
    } catch (e) {
      lastError = e.message;
      starting = false;
      log('createBot failed', e.message);
      scheduleReconnect('createBot');
      return;
    }

    bot = instance;
    wire(instance);
  }

  function stop() {
    config.autoReconnect = false;
    clearReconnect();
    if (bot) {
      try {
        bot.quit('shutdown');
      } catch {
        /* */
      }
      bot = null;
    }
    connected = false;
    starting = false;
  }

  return { start, stop, snapshot, get connected() { return connected; } };
}

module.exports = { createWatcher };
