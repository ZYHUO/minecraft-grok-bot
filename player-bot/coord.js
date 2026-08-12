'use strict';

/**
 * Diegetic multi-bot protocol — parsed from Minecraft chat / signs / books.
 * Software never assigns tasks. Grok decides whether to answer.
 *
 * Tags (first token):
 *   [meet]  x=10 y=64 z=-3
 *   [trade] need:oak_log give:cobblestone
 *   [need]  iron_ingot 8
 *   [have]  bread 12
 *   [help]  creepers at spawn
 *   [claim] Andy 的坑 别挖
 *   [mail]  To:Miner
 *   [here]  (I'm here — often with coords)
 *   [night] 谁守夜
 *   [forge] 炉子在
 */

const TAG_RE = /^\[(meet|trade|need|have|help|claim|mail|here|night|forge|sign)\]\s*(.*)$/i;

function parseWhisper(text, original) {
  const t = String(text || '').trim();
  const translate = original?.translate || '';
  if (/message\.display\.incoming|msg_command_incoming|commands\.message/i.test(translate)) {
    const withs = original.with || [];
    const from =
      withs[0]?.text ||
      withs[0]?.insertion ||
      (typeof withs[0] === 'string' ? withs[0] : null) ||
      withs[0]?.toString?.() ||
      null;
    const body =
      withs[1]?.text ||
      (typeof withs[1] === 'string' ? withs[1] : null) ||
      withs.slice(1).map((w) => (typeof w === 'string' ? w : w?.text || w?.toString?.() || '')).join(' ') ||
      t;
    if (from) return { from: String(from).replace(/[<>]/g, ''), text: String(body || '').trim() };
  }
  let m = t.match(/^(\w{1,16}) whispers(?: to you)?:?\s*(.*)$/i);
  if (m) return { from: m[1], text: m[2] };
  m = t.match(/^\[(\w{1,16}) -> \w+\s?\]\s*(.*)$/);
  if (m) return { from: m[1], text: m[2] };
  m = t.match(/^(\w{1,16})\s*(?:悄悄地)?对你(?:低语|说)\s*[:：]\s*(.*)$/);
  if (m) return { from: m[1], text: m[2] };
  return null;
}

function parseCoords(s) {
  const text = String(s || '');
  let m = text.match(
    /x\s*[:=]\s*(-?\d+(?:\.\d+)?)(?:[^\d-]+y\s*[:=]\s*(-?\d+(?:\.\d+)?))?[^\d-]+z\s*[:=]\s*(-?\d+(?:\.\d+)?)/i
  );
  if (m) {
    return {
      x: Number(m[1]),
      y: m[2] !== undefined ? Number(m[2]) : undefined,
      z: Number(m[3]),
    };
  }
  m = text.match(
    /(?:我在|过来|来找我|坐标|这边|附近|到|来)\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)(?:[,\s]+(-?\d+(?:\.\d+)?))?/
  );
  if (m) {
    if (m[3] !== undefined) return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
    return { x: Number(m[1]), z: Number(m[2]) };
  }
  m = text.match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  return null;
}

function parseNeedGive(rest) {
  const need = rest.match(/need\s*[:=]\s*([^\s]+)/i);
  const give = rest.match(/give\s*[:=]\s*([^\s]+)/i);
  const count = rest.match(/(?:count|x)\s*[:=]\s*(\d+)/i);
  const parts = String(rest || '').trim().split(/\s+/);
  const out = {
    need: need ? need[1] : undefined,
    give: give ? give[1] : undefined,
    count: count ? Number(count[1]) : undefined,
  };
  if (!out.need && parts[0] && !parts[0].includes('=')) out.need = parts[0];
  if (!out.give && parts[1] && !/^\d+$/.test(parts[1]) && !parts[1].includes('=')) out.give = parts[1];
  if (out.count == null && parts.some((p) => /^\d+$/.test(p))) {
    out.count = Number(parts.find((p) => /^\d+$/.test(p)));
  }
  return out;
}

function parseWorldMessage(text, from = null) {
  let t = String(text || '').trim();
  const prefixed = t.match(/^<([^>]+)>\s*(.*)$/);
  if (prefixed) {
    from = from || prefixed[1];
    t = prefixed[2];
  }
  const tag = t.match(TAG_RE);
  const coords = parseCoords(t);
  if (!tag && !coords) return null;
  if (!tag) {
    const informal = /我在|过来|来找我|坐标|这边|附近/.test(t);
    return { kind: informal ? 'here' : 'coords', from, text: t, ...coords, raw: t };
  }
  const kind = tag[1].toLowerCase();
  const rest = tag[2] || '';
  const extra = kind === 'trade' || kind === 'need' || kind === 'have' ? parseNeedGive(rest) : {};
  const restCoords = parseCoords(rest) || coords;
  return {
    kind,
    from,
    text: rest,
    ...extra,
    ...(restCoords || {}),
    raw: t,
  };
}

function formatMeet(pos) {
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const z = Math.floor(pos.z);
  const lines = [
    `我在 ${x} ${y} ${z} 附近，过来找我`,
    `这边 ${x} ${y} ${z}，看见了喊一声`,
    `[meet] ${x} ${y} ${z} 我在这晃`,
    `来 ${x} ${z} 一带（y=${y}）`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

function formatTrade(need, give, count) {
  const c = count ? ` count=${count}` : '';
  return `[trade] need:${need} give:${give}${c}`;
}

function formatNeed(item, count) {
  return `[need] ${item}${count ? ` ${count}` : ''}`;
}

function formatHave(item, count) {
  return `[have] ${item}${count ? ` ${count}` : ''}`;
}

function formatHere(pos) {
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const z = Math.floor(pos.z);
  const lines = [
    `我在 ${x} ${y} ${z}`,
    `[here] ${x} ${y} ${z}`,
    `人在 ${x} ${z}，高度 ${y}`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

function formatClaim(name, note) {
  return `[claim] ${name}${note ? ` ${note}` : ''}`;
}

function formatHelp(note) {
  return `[help] ${note || '来帮忙'}`;
}

function mailTitle(to) {
  return `To:${to || 'anyone'}`;
}

function isMailFor(title, username) {
  const t = String(title || '');
  const m = t.match(/^To:\s*(.+)$/i);
  if (!m) return false;
  const who = m[1].trim().toLowerCase();
  if (who === 'anyone' || who === 'all' || who === '*') return true;
  return who === String(username || '').toLowerCase();
}

module.exports = {
  parseWorldMessage,
  parseWhisper,
  parseCoords,
  formatMeet,
  formatTrade,
  formatNeed,
  formatHave,
  formatHere,
  formatClaim,
  formatHelp,
  mailTitle,
  isMailFor,
};
