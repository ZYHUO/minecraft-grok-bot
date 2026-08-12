'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal TOML-ish loader for soul profiles (no external dep).
 * Supports: key = "str" | true | false | number
 *           key = ["a","b"]
 *           [section] then nested keys
 */
function parseSimpleToml(text) {
  const root = {};
  let cur = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const name = sec[1].trim();
      root[name] = root[name] || {};
      cur = root[name];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val === 'true') cur[key] = true;
    else if (val === 'false') cur[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) cur[key] = Number(val);
    else if (val.startsWith('[')) {
      try {
        cur[key] = JSON.parse(val.replace(/'/g, '"'));
      } catch {
        cur[key] = val;
      }
    } else {
      cur[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return root;
}

const DEFAULT_SOUL = {
  name: 'Bot',
  speech_style: 'neutral',
  greeting: '',
  drives: [],
  language: 'zh',
  modes: {
    self_preservation: true,
    unstuck: true,
    auto_eat: true,
    curiosity: true,
    social: true,
    auto_chat_react: false,
    cowardice: false,
    self_defense: true,
    hunting: false,
    item_collecting: true,
    torch_placing: true,
  },
  idle: {
    wander_chance: 0.05,
    wander_radius: 10,
    greet_chance: 0.1,
    stare_players: true,
  },
};

function loadSoul(filePath) {
  const soul = JSON.parse(JSON.stringify(DEFAULT_SOUL));
  if (!filePath) return soul;
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.warn(`[soul] file not found: ${abs}, using defaults`);
    return soul;
  }
  const text = fs.readFileSync(abs, 'utf8');
  let parsed;
  if (abs.endsWith('.json')) parsed = JSON.parse(text);
  else parsed = parseSimpleToml(text);

  Object.assign(soul, parsed);
  if (parsed.modes) soul.modes = { ...soul.modes, ...parsed.modes };
  if (parsed.idle) soul.idle = { ...soul.idle, ...parsed.idle };
  if (parsed.name) soul.name = parsed.name;
  return soul;
}

module.exports = { loadSoul, DEFAULT_SOUL, parseSimpleToml };
