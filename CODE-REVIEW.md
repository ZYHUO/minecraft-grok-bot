# Code Review — minecraft-grok-bot

**Scope:** `/root/minecraft-grok-bot` (Paper + Mineflayer HTTP control)  
**Date:** 2026-08-12  
**Purpose:** Handoff notes for Grok Bot debugging. No code changes in this review.

## Overall

Architecture matches the revised plan: thin sensor/actuator, no LLM layer, one process per player, async long jobs, slim `/status`. Suitable for Grok Bot curl control.

**Verdict:** Good enough to start E2E debugging. Fix or watch the **bugs** below first; the rest is polish.

> **Update 2026-08-12:** Issues **#1–#6**, chat dedupe, craft timeout, item match, CLI `-h` are **fixed in code**. Re-verify in live E2E.

---

## Strengths

- Clear module split: `player-bot.js` (HTTP/lifecycle), `actions.js` (execution), `status.js` (observe), `config.js` (knobs).
- Long actions (`move_to`/`dig`/`place`/`craft`/`follow_player`) are async with `job_id`; short actions sync.
- HTTP bound to `127.0.0.1` only — appropriate for shared cloud box.
- Rate limit, reconnect, void emergency stop, auto_eat toggle via `/config`.
- Offline Paper props (`online-mode=false`, `enforce-secure-profile=false`, low view-distance).
- README-GrokBot has usable curl contracts.

---

## Issues

### Issue 1 — Severity: bug
- **File:** `start-server.sh:65-79`
- **Description:** Background loop is a bash subshell; `PID_FILE` stores the **subshell** PID, not the Java process. `kill $(cat logs/server.pid)` often leaves `java -jar paper.jar` running as an orphan. Auto-restart also makes “stop” ambiguous.
- **Suggestion:** Use `setsid` / process group and `kill -- -$PGID`, or write Java’s PID (`$!` right after starting java in fg wrapper), or use a small process manager. Document a reliable stop: `pkill -f 'paper.jar'` as temporary workaround.
- **Status:** fixed (use `./start-server.sh --stop`; tracks `server-java.pid` + wrapper)
- **Debug tip for Grok Bot:** After start, run `./start-server.sh --status` or `pgrep -af paper.jar`.

### Issue 2 — Severity: bug
- **File:** `player-bot/actions.js` (`move_to` / `navigateTo`)
- **Description:** Arrival check requires `bot.entity.onGround`. In water, lava, ladders, mid-jump, or pathfinder final step off edge, bot can be at target but never “on ground” → false **TIMEOUT** after 90s.
- **Suggestion:** Use distance-only (or `d <= range + 0.5`), optionally listen to pathfinder `goal_reached`. Drop hard `onGround` requirement.
- **Status:** fixed (pathfinder.goto + distance-only fallback; no onGround)

### Issue 3 — Severity: bug
- **File:** `player-bot/actions.js` (`navigateTo`)
- **Description:** Path failure is not observed. If no path exists, pathfinder stops but `waitUntil` keeps polling until timeout. Wastes up to 90s and looks like a hang.
- **Suggestion:** Prefer `bot.pathfinder.goto(goal)` (promise API) or listen for pathfinder events (`path_update` / empty path). Map failure to `error: NO_PATH` quickly.
- **Status:** fixed (goto errors + path_update noPath → `NO_PATH`)

### Issue 4 — Severity: bug
- **File:** `player-bot/player-bot.js` (`createBot` reconnect)
- **Description:** On reconnect, `bot = instance` replaces the reference but the **old** bot is not quit/destroyed, listeners not removed. Jobs started on the old bot can still run while HTTP talks to the new bot. Double `end`+`kicked` can schedule multiple reconnects (partially gated by `starting`).
- **Suggestion:** Before create: `oldBot.removeAllListeners(); oldBot.quit()`. On reconnect, `abortCurrentJob('reconnect')`. Keep a single reconnect timer (already mostly done).
- **Status:** fixed (cleanup old bot; single reconnectScheduled per instance; abort on disconnect)

### Issue 5 — Severity: bug
- **File:** `player-bot/actions.js` (`place`)
- **Description:** `bot.placeBlock(refBlock, facePos.minus(refBlock.position))` assumes the vector is a **unit face vector** on one axis. If `facePos` is not an adjacent air cell (or floats), place throws obscure errors. First-choice “block below” fails for placing against walls / ceilings without solid below.
- **Suggestion:** Normalize face to axis-aligned unit vector; validate target is air; consider pathfinder `GoalPlaceBlock` or explicit `face` field in API (`{face:"up"}`).
- **Status:** fixed (unit face vector; target must be air; optional `face` field)

### Issue 6 — Severity: bug
- **File:** `player-bot/player-bot.js` job handlers
- **Description:** `abortCurrentJob` sets `currentJob = null` immediately. In-flight async job’s catch sees `currentJob.id !== jobId` and **does not** record aborted/error for the poller. Race: Grok Bot may see `job: null` while bot still pathing until `stopAll` finishes.
- **Suggestion:** Keep terminal job state (`aborted`/`done`/`error`) for 3–5s after abort too; only clear after that. Or set a `last_job` field always visible in `/status`.
- **Status:** fixed (finishJob/scheduleClearJob keeps terminal state ~3–5s)

### Issue 7 — Severity: suggestion
- **File:** `player-bot/player-bot.js` chat handlers
- **Description:** Both `messagestr` and `chat` push into `chat_recent` → likely **duplicate** lines for the same chat message.
- **Suggestion:** Keep only `chat` (player messages) + optional system via `messagestr` filtered, or dedupe consecutive identical lines.
- **Status:** fixed (chat for players; messagestr skips chat position; pushChat dedupe)

### Issue 8 — Severity: suggestion
- **File:** `player-bot/actions.js` craft
- **Description:** `craftTimeoutMs` is defined but never applied; craft can hang on open window / missing table.
- **Suggestion:** Wrap `bot.craft` with timeout + abort like dig.
- **Status:** fixed (`withAbortAndTimeout` + craftTimeoutMs)

### Issue 9 — Severity: suggestion
- **File:** `player-bot/actions.js` (`findItemByName`)
- **Description:** Partial match `i.name.includes(lower)` can pick wrong item (`"log"` → first of oak_log / stripped_oak_log / etc.).
- **Suggestion:** Exact match first; only then prefix/includes; return error if multiple matches.
- **Status:** fixed (exact → unique partial → ambiguous error)

### Issue 10 — Severity: suggestion
- **File:** `player-bot/actions.js` dig/place move-closer blocks
- **Description:** Nested pathfinding inside dig/place does not check `signal` during path wait consistently after path (does check abort before dig). place’s move-closer has no try/catch stopAll on failure.
- **Suggestion:** Shared `navigateTo(pos, range, signal)` helper with always cleanup.
- **Status:** open

### Issue 11 — Severity: suggestion
- **File:** `start-server.sh` / first boot
- **Description:** First Paper run downloads vanilla jar, generates world — can take minutes. Player bots will reconnect-loop with `ECONNREFUSED` / kick until ready. No readiness probe script.
- **Suggestion:** Add `wait-for-server.sh` that greps `Done` in log or TCPs 25565 before starting players. README already says wait; automate it.
- **Status:** open

### Issue 12 — Severity: suggestion
- **File:** `player-bot` packages
- **Description:** `mineflayer-collectblock` is loaded but never exposed via HTTP (`collect` action missing). Dead weight unless Grok uses bot API directly (it won’t).
- **Suggestion:** Either add `{type:"collect", block:"oak_log", count:8}` or remove plugin load.
- **Status:** open

### Issue 13 — Severity: nit
- **File:** `status.js:270-271`
- **Description:** Dead code: `const r = detailSet.has('all') ? 2 : 2`.
- **Suggestion:** Use query radius or different radii for `all` vs `blocks`.
- **Status:** open

### Issue 14 — Severity: nit
- **File:** `player-bot.js` CLI `-h` for host
- **Description:** `-h` is host, not help; `--help` works but users may expect `-h` = help.
- **Suggestion:** Use `--host` only; reserve `-h` for help.
- **Status:** open

### Issue 15 — Severity: nit
- **File:** security model
- **Description:** No auth on HTTP. Fine for localhost-only Grok Bot VM; **unsafe** if port is forwarded or bound to 0.0.0.0 later.
- **Suggestion:** Keep 127.0.0.1; if expose, add shared token header.
- **Status:** open

---

## API contract notes (for Grok Bot operators)

| Action | Sync? | Busy while running? | Typical failure codes |
|--------|-------|---------------------|------------------------|
| chat, look_at, equip, attack, toss, set_control | sync | yes (briefly) | BAD_ARGS, NOT_FOUND, NOT_CONNECTED |
| move_to, dig, place, craft, follow_player | async | until done/stop | TIMEOUT, NOT_FOUND, ABORTED |
| stop | sync | clears busy | — |

**Must remember:**

1. Poll `/status` or `/job` after async accept; do not fire another long action until `job` is null or `state != running` (or POST `/stop` first).
2. 409 `BUSY` means stop first.
3. 429 rate limit: max 8 actions / 1000ms default.
4. Default status has **no** entity list — use `?detail=entities` or `/blocks`.

---

## Recommended debug checklist (Grok Bot)

```bash
# 0. Env
java -version
node -v
cd /root/minecraft-grok-bot

# 1. Server
./start-server.sh
sleep 5
pgrep -af 'paper.jar|java.*paper'
tail -f logs/server.log   # wait for "Done"

# 2. One player
./start-player.sh Miner1 3001
curl -s http://127.0.0.1:3001/health | jq .
# connected should become true after spawn

# 3. Status shape
curl -s http://127.0.0.1:3001/status | jq '{connected,pos,health,food,job,danger}'

# 4. Chat (sync)
curl -s -X POST http://127.0.0.1:3001/action \
  -H 'Content-Type: application/json' \
  -d '{"type":"chat","message":"hello from Miner1"}'

# 5. Move (async) — then poll
curl -s -X POST http://127.0.0.1:3001/action \
  -H 'Content-Type: application/json' \
  -d '{"type":"move_to","x":10,"y":64,"z":10,"range":2}'
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s http://127.0.0.1:3001/job | jq .
  sleep 2
done

# 6. Stop mid-move
curl -s -X POST http://127.0.0.1:3001/stop | jq .

# 7. Second bot
./start-player.sh Builder1 3002
curl -s http://127.0.0.1:3001/status | jq .nearby_players
```

**If stuck:**

| Symptom | Likely issue # |
|---------|----------------|
| Server won’t die after kill pid file | #1 |
| move_to Timeout near target | #2 |
| move_to always 90s then fail | #3 (no path) or #2 |
| Actions after reconnect weird | #4 |
| place fails with obscure error | #5 |
| job vanishes after stop | #6 |
| Duplicate chat lines | #7 |
| First join fails for minutes | #11 (world gen) |

---

## Risk ranking for first E2E day

1. **Server lifecycle (#1)** — ops pain  
2. **move_to correctness (#2, #3)** — core loop  
3. **Reconnect hygiene (#4)** — multi-hour stability  
4. **place reliability (#5)** — building role  
5. Rest — iterate during play

---

## Files reviewed

- `player-bot/player-bot.js`
- `player-bot/actions.js`
- `player-bot/status.js`
- `player-bot/config.js`
- `player-bot/package.json`
- `start-server.sh`, `start-player.sh`
- `server/server.properties`, `server/download-paper.sh`
- `README-GrokBot.md`

Not fully exercised in-game in this review pass (Java now present; full spawn E2E left for debug session).
