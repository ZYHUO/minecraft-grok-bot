'use strict';

/** Small MC helpers ported from Mindcraft — no cheat / no hub. */

const HOSTILES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
  'drowned', 'husk', 'stray', 'phantom', 'pillager', 'vindicator',
  'ravager', 'blaze', 'ghast', 'magma_cube', 'slime', 'warden',
  'zoglin', 'hoglin', 'piglin_brute', 'cave_spider', 'guardian',
  'elder_guardian', 'wither', 'evoker', 'vex', 'illusioner', 'shulker',
  'wither_skeleton', 'piglin', 'endermite', 'silverfish',
]);

const HUNTABLE = new Set(['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep']);

/** Too dangerous to auto-melee. Modes flee even if self_defense is on. */
const FLEE_ALWAYS = new Set(['warden', 'wither']);

const MANUAL_FULL = new Set([
  'wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa',
  'sugar_cane', 'kelp', 'short_grass', 'fern', 'tall_grass', 'bamboo',
  'poppy', 'dandelion', 'lever', 'redstone_wire', 'lantern',
]);

const MANUAL_PART = [
  'sapling', 'torch', 'button', 'carpet', 'pressure_plate',
  'mushroom', 'tulip', 'bush', 'vines', 'fern',
];

const VILLAGER_PROFESSIONS = {
  0: 'unemployed',
  1: 'armorer',
  2: 'butcher',
  3: 'cartographer',
  4: 'cleric',
  5: 'farmer',
  6: 'fisherman',
  7: 'fletcher',
  8: 'leatherworker',
  9: 'librarian',
  10: 'mason',
  11: 'nitwit',
  12: 'shepherd',
  13: 'toolsmith',
  14: 'weaponsmith',
};

const SMELTABLE_MISC = new Set([
  'beef', 'chicken', 'cod', 'mutton', 'porkchop', 'rabbit', 'salmon',
  'tropical_fish', 'potato', 'kelp', 'sand', 'cobblestone', 'clay_ball',
]);

function mustCollectManually(blockName) {
  const n = String(blockName || '').toLowerCase();
  return MANUAL_FULL.has(n) || MANUAL_PART.some((p) => n.includes(p));
}

function expandBlockAlias(name) {
  const n = String(name || '').toLowerCase();
  const out = new Set([n]);
  const ores = ['coal', 'diamond', 'emerald', 'iron', 'gold', 'copper', 'lapis_lazuli', 'redstone'];
  if (ores.includes(n)) {
    const ore = n === 'lapis_lazuli' ? 'lapis_ore' : `${n}_ore`;
    out.add(ore);
    out.add(`deepslate_${ore}`);
  }
  if (n.endsWith('_ore') && !n.startsWith('deepslate_')) out.add(`deepslate_${n}`);
  if (n === 'dirt') out.add('grass_block');
  if (n === 'cobblestone') out.add('stone');
  if (n === 'log' || n === 'wood') {
    for (const w of ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry']) {
      out.add(`${w}_log`);
    }
  }
  if (n.endsWith('_log')) out.add(n.replace('_log', '_wood'));
  return [...out];
}

function isSmeltable(itemName) {
  const n = String(itemName || '').toLowerCase();
  return n.includes('raw') || n.includes('log') || SMELTABLE_MISC.has(n);
}

function getSmeltingFuel(bot) {
  const items = bot.inventory?.items() || [];
  return (
    items.find((i) => i.name === 'coal' || i.name === 'charcoal' || i.name === 'blaze_rod') ||
    items.find((i) => i.name.includes('log') || i.name.includes('planks')) ||
    items.find((i) => i.name === 'coal_block' || i.name === 'lava_bucket') ||
    null
  );
}

function fuelSmeltsPerUnit(fuelName) {
  if (fuelName === 'coal' || fuelName === 'charcoal') return 8;
  if (fuelName === 'blaze_rod') return 12;
  if (fuelName.includes('log') || fuelName.includes('planks')) return 1.5;
  if (fuelName === 'coal_block') return 80;
  if (fuelName === 'lava_bucket') return 100;
  return 0;
}

function emptySlotCount(bot) {
  if (!bot?.inventory) return 0;
  const start = bot.inventory.inventoryStart ?? 9;
  const end = bot.inventory.inventoryEnd ?? 44;
  let n = 0;
  for (let i = start; i <= end; i++) {
    if (!bot.inventory.slots[i]) n++;
  }
  return n;
}

function isHostileName(name) {
  return HOSTILES.has(String(name || '').toLowerCase());
}

function isHuntableName(name) {
  return HUNTABLE.has(String(name || '').toLowerCase());
}

function isFleeAlwaysName(name) {
  return FLEE_ALWAYS.has(String(name || '').toLowerCase());
}

function villagerProfession(entity) {
  if (!entity) return null;
  const md = entity.metadata;
  if (!md) return null;
  const slot = md[18];
  if (slot && typeof slot === 'object' && slot.villagerProfession !== undefined) {
    const name = VILLAGER_PROFESSIONS[slot.villagerProfession] || 'unknown';
    return `${name}_l${slot.level || 1}`;
  }
  if (typeof slot === 'number') return VILLAGER_PROFESSIONS[slot] || null;
  return null;
}

function timeOfDay(bot) {
  const t = bot.time?.timeOfDay;
  if (t == null) return null;
  if (t < 1000 || t >= 23000) return 'sunrise';
  if (t < 6000) return 'morning';
  if (t < 12000) return 'afternoon';
  if (t < 13000) return 'sunset';
  if (t < 18000) return 'night';
  return 'midnight';
}

function weatherOf(bot) {
  if (bot.isRaining && bot.thunderState) return 'thunder';
  if (bot.isRaining) return 'rain';
  return 'clear';
}

function wearing(bot) {
  if (!bot?.inventory) return {};
  const slots = bot.inventory.slots || [];
  const name = (i) => (slots[i] ? slots[i].name : null);
  return {
    head: name(5),
    chest: name(6),
    legs: name(7),
    feet: name(8),
    offhand: name(45) || null,
  };
}

function firstBlockAboveHead(bot) {
  if (!bot?.entity) return null;
  const p = bot.entity.position.floored();
  for (let y = 2; y <= 24; y++) {
    const b = bot.blockAt(p.offset(0, y, 0));
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
      return { name: b.name, y: b.position.y, dy: y };
    }
  }
  return { name: 'sky', y: null, dy: null };
}

function nearbyBlockTypes(bot, range = 8) {
  if (!bot?.entity) return [];
  const seen = new Map();
  const origin = bot.entity.position;
  const blocks = bot.findBlocks({
    matching: (b) => b && b.name !== 'air' && b.name !== 'cave_air',
    maxDistance: range,
    count: 200,
  });
  for (const pos of blocks) {
    const b = bot.blockAt(pos);
    if (!b) continue;
    let key = b.name;
    if (b.name === 'water' || b.name === 'lava') {
      key = `${b.name}:${b.metadata === 0 ? 'source' : 'flowing'}`;
    }
    if (!seen.has(key)) {
      seen.set(key, { name: key, dist: Number(origin.distanceTo(pos).toFixed(1)) });
    }
  }
  return [...seen.values()].sort((a, b) => a.dist - b.dist);
}

function ingredientsFromRecipe(bot, recipe) {
  const out = {};
  const items = bot.registry?.items || {};
  const delta = recipe.delta || [];
  for (const d of delta) {
    if (!d || d.count >= 0) continue;
    const name = items[d.id]?.name || String(d.id);
    out[name] = (out[name] || 0) + -d.count;
  }
  if (!Object.keys(out).length && recipe.ingredients) {
    for (const ing of recipe.ingredients) {
      if (!ing) continue;
      const name = items[ing.id]?.name || String(ing.id);
      out[name] = (out[name] || 0) + 1;
    }
  }
  return out;
}

function craftingPlan(bot, itemName, count = 1) {
  const want = String(itemName || '').toLowerCase();
  const itemsByName = bot.registry?.itemsByName || {};
  const item = itemsByName[want];
  if (!item) return { ok: false, error: `unknown item ${want}` };

  const inv = {};
  for (const it of bot.inventory?.items() || []) {
    inv[it.name] = (inv[it.name] || 0) + it.count;
  }
  const missing = {};
  const steps = [];

  function need(name, n, depth) {
    if (n <= 0) return;
    if (depth > 8) {
      missing[name] = (missing[name] || 0) + n;
      return;
    }
    const have = inv[name] || 0;
    if (have >= n) {
      inv[name] = have - n;
      return;
    }
    const still = n - have;
    inv[name] = 0;
    const id = itemsByName[name]?.id;
    if (id == null) {
      missing[name] = (missing[name] || 0) + still;
      return;
    }
    let recipes = [];
    try {
      recipes = bot.recipesAll?.(id, null, null) || bot.recipesFor(id, null, 1, true) || [];
    } catch {
      recipes = [];
    }
    if (!recipes.length) {
      missing[name] = (missing[name] || 0) + still;
      return;
    }
    const recipe = recipes[0];
    const per = recipe.result?.count || 1;
    const batches = Math.ceil(still / per);
    const ingredients = ingredientsFromRecipe(bot, recipe);
    steps.push({ item: name, batches, produces: batches * per, ingredients, table: Boolean(recipe.requiresTable) });
    for (const [ing, c] of Object.entries(ingredients)) {
      need(ing, c * batches, depth + 1);
    }
  }

  need(want, count, 0);
  return {
    ok: true,
    target: want,
    count,
    steps: steps.reverse(),
    missing,
    have: Object.fromEntries(
      Object.entries(invSummarySafe(bot)).filter(([k]) => k === want || steps.some((s) => s.ingredients[k]))
    ),
  };
}

function invSummarySafe(bot) {
  const counts = {};
  for (const it of bot.inventory?.items() || []) {
    counts[it.name] = (counts[it.name] || 0) + it.count;
  }
  return counts;
}

function listCraftable(bot, limit = 80) {
  const itemsByName = bot.registry?.itemsByName || {};
  const hasTable =
    Boolean(bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: 8 })) ||
    Boolean((bot.inventory?.items() || []).some((i) => i.name === 'crafting_table'));
  const out = [];
  for (const name of Object.keys(itemsByName)) {
    try {
      const id = itemsByName[name].id;
      const r = bot.recipesFor(id, null, 1, hasTable ? true : null);
      if (r && r.length) out.push(name);
      if (out.length >= limit) break;
    } catch {
      /* */
    }
  }
  return { items: out, used_table: hasTable };
}

function cropAge(block) {
  if (!block) return null;
  const props = block.getProperties?.() || {};
  if (props.age != null) return Number(props.age);
  if (block.metadata != null && ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart'].includes(block.name)) {
    return block.metadata;
  }
  return null;
}

function cropMaxAge(name) {
  if (name === 'beetroots' || name === 'nether_wart') return 3;
  return 7;
}

function isMatureCrop(block) {
  if (!block) return false;
  const age = cropAge(block);
  if (age == null) return false;
  return age >= cropMaxAge(block.name);
}

function seedName(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'wheat' || n === 'wheat_seed') return 'wheat_seeds';
  if (n.endsWith('seed') && !n.endsWith('seeds')) return `${n}s`;
  return n;
}

module.exports = {
  HOSTILES,
  HUNTABLE,
  FLEE_ALWAYS,
  mustCollectManually,
  expandBlockAlias,
  isSmeltable,
  getSmeltingFuel,
  fuelSmeltsPerUnit,
  emptySlotCount,
  isHostileName,
  isHuntableName,
  isFleeAlwaysName,
  villagerProfession,
  timeOfDay,
  weatherOf,
  wearing,
  firstBlockAboveHead,
  nearbyBlockTypes,
  craftingPlan,
  listCraftable,
  isMatureCrop,
  seedName,
  cropAge,
};
