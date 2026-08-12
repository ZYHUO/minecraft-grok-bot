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
    return { kind: 'coords', from, text: t, ...coords, raw: t };
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
  return `[meet] x=${Math.floor(pos.x)} y=${Math.floor(pos.y)} z=${Math.floor(pos.z)}`;
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
  return `[here] x=${Math.floor(pos.x)} y=${Math.floor(pos.y)} z=${Math.floor(pos.z)}`;
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
