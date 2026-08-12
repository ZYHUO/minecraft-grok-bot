# Code Review — Skills / Signs / Books / Places / Control Plane

**Scope:** Recent skills, places, modes, Unix-socket control, and `gbot` CLI  
**Files reviewed:** `player-bot/skills.js`, `places.js`, `player-bot.js`, `actions.js` (exports used by skills), `modes.js`, `socket-server.js`, `gbot/main.go`, `ARCHITECTURE.md`, `SKILLS.md`  
**Date:** 2026-08-12  
**Mode:** Review then partial fixes applied (see “Post-review fixes”)

---

## Post-review fixes (applied)

| Issue | Fix |
|-------|-----|
| #1 skill not busy | Skills now create `currentJob` + AbortController |
| #2 60s timeout | gbot deadline 300s for skill/do |
| #3 dig_down fluid | Scan under dig target for fluid/drop |
| #4 lava flee BUSY | Panic uses direct control states, not job move_to |
| #5 CLI parse | goto/follow/dig_down/sign `\\n`/write_book title |
| #6 chest close | try/finally close container |
| #7 read_sign | use `sign.entity` fallback |
| #8 goto validation | require finite x,y,z |

Remaining open: async skill ack, scan_signs, multi-stack chest loops, craft planning, etc.

---

## Summary

The skills layer is a solid Mindcraft-inspired local toolkit: gather/chest/sign/book/places map cleanly to the decentralized design (in-world async notes, private waypoints, no hub). Chest open/deposit/withdraw and book write/sign call real mineflayer APIs correctly in the happy path.

The main gaps are **control-plane integration**: long skills do not participate in the job/busy/abort system, so modes and concurrent `do`/`stop` can race them; **client 60s socket deadline** will time out under long skills while the body keeps going; **CLI arg parsing** for several skills (`goto`, `follow`, `dig_down`, sign newlines) does not match what the body expects; and **dig_down** misses lava/fluid under the block being dug. Fix concurrency + CLI + dig safety before relying on multi-agent sign/book play at scale.

---

## Issues

### Issue 1 — Severity: bug
- **File:** `player-bot/player-bot.js:718-751` (skill op), `player-bot/modes.js:72-78`, `player-bot/player-bot.js:238-240`
- **Description:** `skill` checks `isBusy()` only at entry, then runs `runSkill` → `executeAction` **without** creating a `currentJob` or `AbortController`. `isBusy()` is solely `currentJob.state === 'running'`, so during a long skill (`gather`, `follow`, `go_place`, chest ops, etc.) the body reports idle. ModeRunner therefore continues: `unstuck` / `curiosity` / `social` can `move_to`, jump, or chat mid-skill. A second socket client can also accept `do` jobs. `stop` only aborts `currentJob` + `stopAll`; it does not cancel the in-flight skill promise (e.g. `follow_player` waits on a hanging promise until timeout even after pathfinder is cleared).
- **Suggestion:** Treat skills like long jobs: set `currentJob` with type `skill:<name>`, pass `abortController.signal` into skill `runAction` / `navigateTo`, make `isBusy()` true for the skill duration, and have `stop` abort that controller. Optionally make long skills async (`accepted` + poll `job`) like `do` move_to.
- **Status:** open

### Issue 2 — Severity: bug
- **File:** `gbot/main.go:51-58` (`call` deadline), `player-bot/player-bot.js:718-751`
- **Description:** Every gbot request uses `conn.SetDeadline(time.Now().Add(60 * time.Second))`. Skills are **synchronous** on the socket (handler awaits full `runSkill`). `gather` of many blocks, `follow` default 60s, long pathing, or slow chests routinely exceed 60s. Client gets a read error / failed op while the body **continues** the skill with no job id to poll or stop cleanly (see Issue 1).
- **Suggestion:** Either (a) async skills + short ack, poll `job`/`events`, or (b) raise/disable deadline for `skill`/`do` and document max duration, or (c) stream progress lines. Prefer (a) for Grok Bot loops.
- **Status:** open

### Issue 3 — Severity: bug
- **File:** `player-bot/skills.js:346-365` (`digDown`)
- **Description:** Fluid check only rejects if the **block being dug** is water/lava. It does **not** inspect the block under that target before digging. Digging a 1-thick floor over lava/water drops the bot into fluid. Drop/void heuristic only triggers when `deeper` is air and a block 3 below the dig face is also air — lava (non-air) skips the stop. No bedrock / `voidY` guard despite `config.voidY` existing for other safety.
- **Suggestion:** Before each dig, scan 1–3 blocks below the dig target for fluids (`lava`, `flowing_lava`, water variants) and refuse; stop on bedrock/barrier; optionally refuse when `below.y <= config.voidY + N`. After dig, wait until position settles before the next layer.
- **Status:** open

### Issue 4 — Severity: bug
- **File:** `player-bot/modes.js:72-76, 111-141` + `player-bot/player-bot.js:388-399`
- **Description:** `self_preservation` runs **before** the `isBusy()` gate (good intent), but lava/fire flee uses `runAction({ type: 'move_to', ... })`. `modeRunAction` **throws BUSY** for `move_to` when a Grok job is running; the catch swallows it. Result: while Grok has any running job, lava flee is a no-op (only a possible chat line if that path were reached — chat is attempted first, then move fails). Low-health branch only chats and returns `true` without moving or eating.
- **Suggestion:** Panic path should call `stopAll` + `executeAction` with a high-priority path that bypasses BUSY (or abort current job then flee). Low health: try `consume` / path away, not chat-only.
- **Status:** open

### Issue 5 — Severity: bug
- **File:** `gbot/main.go:228-291` (`parseDoLine` skill cases)
- **Description:** CLI skill argument mapping is incomplete vs `skills.js` / `SKILLS.md`:
  1. **`goto` / `go` as skill** — not handled; falls into `default` and sets `text`/`arg` only, so `skill goto 10 64 0` never sets `x,y,z` → body `BAD_ARGS` (“goto requires x,y,z”).
  2. **`follow`** shares the `give` case: `skill follow Steve 60000` sets `player=Steve`, `item="60000"`, not `duration_ms`. Follow always uses default 60s.
  3. **`dig_down`** depth not parsed (`skill dig_down 10` → `text="10"`, depth stays 3).
  4. **`write_sign` newlines** — `text` is joined fields; no unescaping of `\n`. Docs (`SKILLS.md`, attach banner) show `line1\nline2`, but interactive/attach input usually sends literal backslash+n, so signs get one line. Real newlines only if the shell injects them.
  5. **`read_sign` / `read_book` / `stay` / `surface` / coords for signs** — no structured fields beyond default `text` dump.
- **Suggestion:** Per-skill argv schema aligned with `SKILLS.md`; unescape `\n` (and `\t`) in sign/book text; parse `follow <player> [duration_ms]`; parse `goto x y z` and `dig_down [depth]`.
- **Status:** open

### Issue 6 — Severity: bug
- **File:** `player-bot/skills.js:441-482` (chest put/take)
- **Description:** `openNearestChest` opens a container; `putInChest` / `takeFromChest` / `viewChest` call `container.close()` only on success paths. If `deposit` / `withdraw` throws (full chest, race, wrong type), the window stays open and later inventory/dig/place actions misbehave. `takeFromChest` only withdraws from the **first** matching stack (`Math.min(count, found.count)`); requesting 64 when stacks are 16+16+… yields 16. `putInChest` same single-stack limit via `findItemByName`.
- **Suggestion:** `try/finally { container.close() }`. Loop withdraw/deposit until `count` satisfied or no more items/space. Surface partial counts in the result.
- **Status:** open

### Issue 7 — Severity: bug
- **File:** `player-bot/skills.js:551-579` (`readSign`)
- **Description:** Primary text source is `sign.signText` (OK when prismarine-block entity is loaded for 1.20 multi-side signs). Fallback uses `sign.blockEntity`, but mineflayer/prismarine-block expose tile NBT as **`block.entity`**, not `blockEntity`. Fallback never runs. If entity NBT is missing (chunk edge, not yet received), result is empty `text: ''` with `ok: true` — Grok may treat “blank sign” as success for multi-agent messaging.
- **Suggestion:** Use `sign.entity` / `getSignText()` if available; if empty, briefly wait for block update / re-fetch block; return a distinct code or `ok: false` when text unavailable vs truly empty. Optionally activate/open sign before read on 1.20+.
- **Status:** open

### Issue 8 — Severity: bug
- **File:** `player-bot/skills.js:152-162` (`goTo`)
- **Description:** Validates only `args.x === undefined`. Missing `y`/`z` still call `move_to`; `vecFromBody` then throws a generic “Requires x, y, z” from actions — confusing vs skill docs. Combined with Issue 5, CLI `skill goto …` fails even more opaquely.
- **Suggestion:** Require finite `x,y,z` in `goTo` before `runAction`; mirror validation message to SKILLS.md.
- **Status:** open

### Issue 9 — Severity: suggestion
- **File:** `player-bot/player-bot.js:718-751`, `socket-server.js:24-47`
- **Description:** No mutex across connections. Two `gbot cmd`/`attach` sessions can interleave skills and `do` jobs (exacerbated by Issue 1). Socket errors in the outer `data` catch omit request `id`, so multiplexed clients cannot correlate failures. Skills skip `rateLimited()` that `do` uses.
- **Suggestion:** Global “motor lock” for skill+do; always echo `id` on errors; apply same rate limit (or a skill-specific budget).
- **Status:** open

### Issue 10 — Severity: suggestion
- **File:** `player-bot/skills.js:92-113` (`gather`), `26-32` (`countItem`) vs `actions.js:36-54` (`findItemByName`)
- **Description:** `countItem` uses substring match (`name.includes(lower)`), so progress for `log` counts mixed log types, while dig uses exact block name. Early-exit `if (countItem === before && i > 1) break` can stop after two failed digs even if more of that block exists farther than the last dig radius. No inventory-full detection.
- **Suggestion:** Count with exact name (or same rules as dig); on dig NOT_FOUND, optionally expand search or stop with clear `reason`; detect full inventory.
- **Status:** open

### Issue 11 — Severity: suggestion
- **File:** `player-bot/skills.js:377-406` (`goToSurface`), overworld heuristic `y >= 62`
- **Description:** Surface detection is overworld-sea-level biased; wrong in Nether/End or high mountain starts. On path failure it digs the head block via raw `bot.dig` (no tool equip, no abort signal, no job). Can strand the bot or dig valuable blocks above.
- **Suggestion:** Use sky-light / heightmap if available; dimension-aware rules; route digs through `runAction` with tools; cap destructive attempts.
- **Status:** open

### Issue 12 — Severity: suggestion
- **File:** `player-bot/places.js:28-35`, `55-57`, `skills.js` places skills
- **Description:** `save()` failures are silent (empty catch). `get(name)` is case-sensitive with no normalization. `forget` exists on `PlaceBook` but is not exposed as a skill or socket op. Places are per-bot files under `memory/` — correct per ARCHITECTURE, but agents cannot discover each other’s places except via signs/chat (by design; worth documenting in skill results).
- **Suggestion:** Log save errors; expose `forget_place`; optional case-insensitive lookup; skill help text: “private to this body”.
- **Status:** open

### Issue 13 — Severity: suggestion
- **File:** `player-bot/skills.js:583-614` (`writeBook`), `617-634` (`readBook`)
- **Description:** Default `sign !== false` always signs into a written book (good for “leave a note”), but irreversible in-game without a new writable book — Grok may not realize. Page split on `\n\n` is fine; gbot always sends a single `text` string and hardcodes `title: "Note"` (no CLI title/author). `read_book` NBT path matches classic written-book pages; chat-component JSON pages will show raw JSON strings unless stripped. No skill to **give** a written book to another player (must compose `write_book` + `give`).
- **Suggestion:** Document default signing; CLI `skill write_book title|author|pages`; strip `§`/JSON to plain text on read; optional `give` convenience or example in SKILLS.md for portable multi-agent mail.
- **Status:** open

### Issue 14 — Severity: suggestion
- **File:** multi-agent async messaging (skills + architecture)
- **Description:** Sign/book skills enable diegetic messaging, but protocol ergonomics for Grok are thin:
  - No `scan_signs` / radius list of sign positions+text (only nearest or absolute x,y,z).
  - No event when a new sign appears in loaded chunks (must poll `read_sign`).
  - `write_sign` success does not prove other bots can read it (distance, chunk load).
  - Books only readable from **own inventory** — receiving a tossed book requires pickup + `read_book`; no “read book at feet/chest”.
  - `ender_chest` is included in chest skills; contents are **personal**, not shared — easy multi-agent footgun if Grok thinks chests are communal.
- **Suggestion:** Add `find_signs` (range → list `{pos,text}`); optional eventLog push on nearby sign edit if detectable; `take_chest`/`view_chest` note ender vs chest; skill recipe: `pickup` → `read_book` for mail; seed prompts in SCENARIOS for sign-post bases.
- **Status:** open

### Issue 15 — Severity: suggestion
- **File:** Mindcraft feature gaps (catalog vs Mindcraft)
- **Description:** Already covered well: gather, craft, chests, bed, places, dig_down, surface, follow, give, activate. Still missing or weak relative to Mindcraft / useful for Grok:
  - Auto-craft ingredients / craft path (craft fails if ingredients missing; no gather-then-craft).
  - Tool-aware collect (collectblock plugin loaded but unused by skills).
  - Shulker box as container; item frames as notes.
  - `sleep` returns `ok` with `bed_failed` on failure (daytime/monsters) — callers must read `message`, easy to miss.
  - No `wait_for_chat` / structured whisper helper (only raw `events`).
  - `craftable` samples first 400 registry names and stops at 40 hits — not a true “what can I craft now”.
- **Suggestion:** Prioritize: use collectblock in `gather`; fail `sleep` with non-ok or `code: BED_FAILED`; richer craftable via inventory-based recipe filter; shulker in chest list.
- **Status:** open

### Issue 16 — Severity: nit
- **File:** `player-bot/socket-server.js:52-57`, `gbot/main.go:85-147`
- **Description:** Socket chmod `0o666` is world-writable (fine on single-user sandbox, loose on shared hosts). `gbot spawn` does not refuse if a socket/pid already exists — second spawn can fight the same MC name / orphan the first process. ARCHITECTURE mentions `/tmp/gbot/` but implementation defaults to `run/socks/<name>.sock` (docs slightly drift).
- **Suggestion:** Detect live socket on spawn; document actual path only; tighten socket mode to `0o600` if multi-tenant.
- **Status:** open

### Issue 17 — Severity: nit
- **File:** `player-bot/player-bot.js:743-751` response shape
- **Description:** Socket wraps skill return as `{ ok: true, result: { ok: true, message, ... } }`. Double `ok` and nesting differ from `do` long-job shape (`accepted`, `job_id`). Grok Bot must special-case skill vs do.
- **Suggestion:** Unify: always `{ accepted, job_id?, result?, error? }` or document the two envelopes side-by-side in ARCHITECTURE.md / SKILLS.md.
- **Status:** open

---

## What looks correct (no issue filed)

- **Design split:** skills are local-only; places are per-bot files; chat/signs/books are the social plane — matches `ARCHITECTURE.md`.
- **`navigateTo` / dig / place** (post prior review): pathfinder.goto, no onGround gate, unit face vectors — skills reuse these safely when they call `runAction`/`navigateTo`.
- **`findItemByName`:** exact then unique partial; ambiguous → `BAD_ARGS` — good for Grok.
- **`write_sign` line packing:** `splitSignLines` enforces 4×45 and string form expected by `bot.updateSign`.
- **`write_book` / `signBook`:** slot + pages + author/title matches mineflayer `book.js` / examples.
- **`openChest`:** still aliased to `openContainer` in mineflayer 4.x; barrel/chest/ender_chest open path is valid.
- **Skill name aliases** (`collect` → gather, `go_to_place` → go_place, etc.) and `req.skill` vs `req.name` param merge in the skill socket op are thoughtful for CLI/JSONL.
- **ModeRunner** correctly avoids multi-bot task assignment; goal is local soft state only.

---

## Priority order (for implementers)

1. **Issue 1–2** — skill busy/job/abort + client timeout (otherwise all long skills are unsafe to automate)  
2. **Issue 3–4** — dig_down lava-under-floor + preservation vs busy  
3. **Issue 5–6** — CLI args + chest close/partial stacks  
4. **Issue 7** — reliable `read_sign` for multi-agent notes  
5. **Issues 9–15** — protocol ergonomics and Mindcraft gaps  

---

## Suggested Grok Bot debug probes (no code changes)

```bash
# Concurrency: skill running vs modes/do
gbot cmd Andy 'skill stay 30' &
sleep 2; gbot cmd Andy status   # expect busy if Issue 1 fixed; today job often null
gbot cmd Andy 'go 0 64 0'       # may interleave today

# dig_down fluid under floor (creative setup)
gbot cmd Andy 'skill dig_down 3'

# CLI goto / follow / sign newlines
gbot cmd Andy 'skill goto 10 64 0'
gbot cmd Andy 'skill follow SomePlayer 15000'
gbot cmd Andy 'skill write_sign line1\nline2'
gbot cmd Andy 'skill read_sign'

# Chest close-on-error: fill chest, put_chest until full, then dig
gbot cmd Andy 'skill view_chest'
```
