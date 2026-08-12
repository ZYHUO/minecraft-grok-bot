'use strict';

const mc = require('./mcdata');

/**
 * Structured status collectors for Grok Bot.
 * Keep default payload small; expand only when detail flags are set.
 */

function round(n, d = 1) {
  if (typeof n !== 'number' || Number.isNaN(n)) return n;
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function inventorySummary(bot) {
  const counts = {};
  if (!bot.inventory) return counts;
  for (const item of bot.inventory.items()) {
    const name = item.name;
    counts[name] = (counts[name] || 0) + item.count;
  }
  return counts;
}

function inventoryDetail(bot) {
  if (!bot.inventory) return [];
  return bot.inventory.items().map((item) => ({
    slot: item.slot,
    name: item.name,
    count: item.count,
    displayName: item.displayName,
  }));
}

function heldItem(bot) {
  const item = bot.heldItem;
  if (!item) return null;
  return { name: item.name, count: item.count };
}

function frontBlock(bot) {
  try {
    const block = bot.blockAtCursor?.(4) || null;
    if (!block || block.name === 'air') {
      // fallback: block one step ahead at eye height
      const yaw = bot.entity.yaw;
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);
      const pos = bot.entity.position.offset(dx, 0, dz);
      const b = bot.blockAt(pos.floored());
      if (!b || b.name === 'air') return null;
      return {
        name: b.name,
        pos: { x: b.position.x, y: b.position.y, z: b.position.z },
      };
    }
    return {
      name: block.name,
      pos: { x: block.position.x, y: block.position.y, z: block.position.z },
    };
  } catch {
    return null;
  }
}

function feetBlock(bot) {
  try {
    const p = bot.entity.position.offset(0, -1, 0).floored();
    const b = bot.blockAt(p);
    if (!b) return null;
    return {
      name: b.name,
      pos: { x: b.position.x, y: b.position.y, z: b.position.z },
    };
  } catch {
    return null;
  }
}

function nearbyPlayers(bot, range, maxN) {
  const me = bot.entity?.position;
  if (!me) return [];
  const out = [];
  for (const name of Object.keys(bot.players)) {
    if (name === bot.username) continue;
    const p = bot.players[name]?.entity;
    if (!p?.position) continue;
    const dist = me.distanceTo(p.position);
    if (dist > range) continue;
    out.push({
      name,
      dist: round(dist, 1),
      pos: {
        x: round(p.position.x, 1),
        y: round(p.position.y, 1),
        z: round(p.position.z, 1),
      },
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, maxN);
}

function nearbyEntities(bot, range, maxN) {
  const me = bot.entity?.position;
  if (!me) return [];
  const out = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e === bot.entity) continue;
    // skip other players here (covered by nearby_players)
    if (e.type === 'player') continue;
    if (!e.position) continue;
    const dist = me.distanceTo(e.position);
    if (dist > range) continue;
    out.push({
      id: e.id,
      name: e.name || e.displayName || e.username || e.kind || e.type || 'unknown',
      type: e.type,
      profession: e.name === 'villager' ? mc.villagerProfession(e) : undefined,
      dist: round(dist, 1),
      pos: {
        x: round(e.position.x, 1),
        y: round(e.position.y, 1),
        z: round(e.position.z, 1),
      },
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, maxN);
}

/**
 * Sample blocks in a small cube around the bot (for detail=blocks).
 */
function sampleBlocks(bot, radius = 2) {
  const me = bot.entity?.position?.floored?.();
  if (!me) return [];
  const out = [];
  const r = Math.min(Math.max(1, radius), 4);
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = me.offset(dx, dy, dz);
        const b = bot.blockAt(p);
        if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
        out.push({
          name: b.name,
          x: p.x,
          y: p.y,
          z: p.z,
        });
      }
    }
  }
  return out;
}

function dangerHints(bot, config) {
  const hints = [];
  if (!bot.entity) return hints;
  if (bot.health !== undefined && bot.health <= 6) hints.push('low_health');
  if (bot.food !== undefined && bot.food <= 6) hints.push('low_food');
  if (bot.entity.position.y < (config.voidY ?? -64) + 5) hints.push('near_void');
  if (bot.entity.isInLava) hints.push('in_lava');
  if (bot.entity.isInWater) hints.push('in_water');
  // nearby hostile mobs (simple name heuristic)
  const hostiles = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
    'drowned', 'husk', 'stray', 'phantom', 'pillager', 'vindicator',
    'ravager', 'blaze', 'ghast', 'magma_cube', 'slime', 'warden',
  ]);
  try {
    const me = bot.entity.position;
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (!e?.position || e === bot.entity) continue;
      const n = (e.name || '').toLowerCase();
      if (!hostiles.has(n)) continue;
      if (me.distanceTo(e.position) <= 8) {
        hints.push(`hostile:${n}`);
        break;
      }
    }
  } catch {
    /* ignore */
  }
  return hints;
}

/**
 * Build slim or detailed status object.
 * @param {object} ctx
 * @param {import('mineflayer').Bot|null} ctx.bot
 * @param {object} ctx.config
 * @param {object|null} ctx.job
 * @param {string[]} ctx.chatRecent
 * @param {object} ctx.meta  { botName, httpPort, connected, starting }
 * @param {string[]} [detail]  e.g. ['entities','blocks','inventory']
 */
function buildStatus(ctx, detail = []) {
  const detailSet = new Set(
    (Array.isArray(detail) ? detail : String(detail || '').split(','))
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
  );

  const { bot, config, job, chatRecent, meta } = ctx;
  const base = {
    bot: meta.botName,
    port: meta.httpPort,
    connected: Boolean(meta.connected && bot?.entity),
    starting: Boolean(meta.starting),
    username: bot?.username || meta.botName,
    ts: Date.now(),
  };

  if (!bot?.entity) {
    return {
      ...base,
      job: job || null,
      chat_recent: chatRecent.slice(-config.chatHistoryLimit),
      error: meta.lastError || null,
    };
  }

  const pos = bot.entity.position;
  const status = {
    ...base,
    pos: { x: round(pos.x, 2), y: round(pos.y, 2), z: round(pos.z, 2) },
    yaw: round(bot.entity.yaw, 3),
    pitch: round(bot.entity.pitch, 3),
    on_ground: Boolean(bot.entity.onGround),
    health: bot.health,
    food: bot.food,
    oxygen: bot.oxygenLevel,
    xp: bot.experience?.level ?? 0,
    gamemode: bot.game?.gameMode,
    dimension: bot.game?.dimension,
    held: heldItem(bot),
    inventory_summary: inventorySummary(bot),
    job: job
      ? {
          id: job.id,
          type: job.type,
          state: job.state,
          target: job.target || null,
          message: job.message || null,
          started_at: job.started_at || job.startedAt,
        }
      : null,
    feet_block: feetBlock(bot),
    front_block: frontBlock(bot),
    nearby_players: nearbyPlayers(bot, config.playerRange, config.maxNearbyPlayers),
    chat_recent: chatRecent.slice(-config.chatHistoryLimit),
    danger: dangerHints(bot, config),
    biome: bot.blockAt(pos)?.biome?.name || null,
    weather: mc.weatherOf(bot),
    time: mc.timeOfDay(bot),
    wearing: mc.wearing(bot),
    above_head: mc.firstBlockAboveHead(bot),
    config: {
      auto_eat: Boolean(config.autoEat),
      auto_reconnect: Boolean(config.autoReconnect),
    },
  };

  if (detailSet.has('entities') || detailSet.has('all')) {
    status.nearby_entities = nearbyEntities(
      bot,
      config.entityRange,
      config.maxNearbyEntities
    );
  }

  if (detailSet.has('blocks') || detailSet.has('all')) {
    status.nearby_blocks = mc.nearbyBlockTypes(bot, 8);
    status.blocks = sampleBlocks(bot, detailSet.has('all') ? 3 : 2);
  }

  if (detailSet.has('inventory') || detailSet.has('all')) {
    status.inventory = inventoryDetail(bot);
  }

  return status;
}

module.exports = {
  buildStatus,
  inventorySummary,
  inventoryDetail,
  nearbyPlayers,
  nearbyEntities,
  sampleBlocks,
  dangerHints,
};
