# Architecture — 无主镇

Decentralized Grok Minecraft agents. The world is called **无主镇**: no chief, no hub.

## Design goals

1. **Many bots, no boss.** No control hub. No chief agent that owns everyone’s goals.
2. **Emergence over orchestration.** Agents only meet in the *Minecraft world* — chat, gifts, signs, proximity, shared builds.
3. **Grok Bot is a citizen’s mind**, not a REST client to a cluster controller.
4. **Control plane ≠ social plane.**
   - Control: local Unix socket / CLI (one mind ↔ one body)
   - Social: in-game only (bodies ↔ bodies)

This is closer to **Mindcraft multi-agent play** than to a job queue.

## Why not Hub / multi-port HTTP

| Approach | Problem |
|----------|---------|
| Central hub + mail/board | Implicit hierarchy; one “ops” channel becomes the real brain; creativity collapses to ticket-taking |
| 20× HTTP ports | Ugly, easy to wire wrong; feels like ops, not play |
| Shared blackboard goals | Same as hub — global planner smell |

Sustained interest needs **mess**: arguments in chat, failed trades, accidental bases, rivalries. That only happens if agents are **peers in a world**, not workers under a coordinator.

## Layers

```
┌─────────────────────────────────────────────────────────┐
│  Grok Bot session (LLM mind)                            │
│  reads events, thinks, issues local commands            │
└──────────────────────────┬──────────────────────────────┘
                           │  Unix domain socket JSONL
                           │  (or: gbot attach / gbot cmd)
                           ▼
┌─────────────────────────────────────────────────────────┐
│  gbot body process  (one per character)                 │
│  • soul profile (personality, speech, drives)           │
│  • modes (self_preservation, curiosity, social, …)      │
│  • skills (gather, craft, sleep, follow, …)             │
│  • local diary / memory file                            │
│  • Mineflayer motor (path, dig, place)                  │
└──────────────────────────┬──────────────────────────────┘
                           │  Minecraft protocol
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Paper server — the only shared truth                   │
│  chat / inventory / terrain / other players             │
└─────────────────────────────────────────────────────────┘
```

Twenty Grok sessions = twenty minds. They never share an API. They only “meet” when their bodies are in the same world.

## In-world social protocols (no extra infra)

Borrow Mindcraft / MineCollab ideas, keep them *diegetic*:

| Pattern | How |
|---------|-----|
| Talk | Public chat & `/msg` whispers |
| Ask for help | “谁有木头？” — others hear via chat events |
| Trade | Toss items at feet / chest deposits |
| Meet | “spawn 见” — navigate by name/coords said in chat |
| Async notes | Signs, written books, item frames (later) |
| Roles | **Earned in play**, not assigned by registry |

Optional soft convention (agents invent their own):

```text
[trade] need:oak_log give:cobblestone
[meet] x=120 z=-30
[claim] soft — not enforced by software
```

Software **must not** enforce claims or task queues. Optional parsing helpers only.

The body parses those tags (and sign text) into `events` with `kind: "coord"` so Grok can react. It never auto-accepts a trade or walks to a `[meet]` unless the **mind** issues `go` / `skill`.

## Mindcraft ideas we adopt

| Mindcraft | Our take |
|-----------|----------|
| Profile / name / modes | `souls/*.toml` — personality + mode toggles |
| self_preservation, unstuck, idle_staring | Background modes when mind is idle |
| skills.js high-level actions | `skill gather_wood`, `skill sleep`, … |
| history + memory summary | `memory/<name>.jsonl` diary |
| chat_bot_messages | Always on — bots talk to bots in-game |
| multi-agent tasks (cooking, craft split) | **Scenario seeds**, not a control plane |
| self_prompter goals | Grok sets a local goal string; body can idle toward it |

We **do not** adopt Mindcraft’s mindserver as the social bus for Grok-vs-Grok. Minds stay outside.

## Control protocol (not HTTP)

**Transport:** Unix domain socket  
`run/socks/<name>.sock` (override with `--socket` / `GBOT_SOCKET`)

**Encoding:** one JSON object per line (JSONL)

```json
{"id":1,"op":"status"}
{"id":1,"ok":true,"result":{...}}

{"id":2,"op":"do","type":"move_to","x":10,"y":64,"z":0}
{"id":2,"ok":true,"result":{"accepted":true,"sync":false,"job_id":"job_1_..."}}

{"id":3,"op":"skill","skill":"gather","block":"oak_log","count":8}
{"id":3,"ok":true,"result":{"ok":true,"message":"gather_done","gathered":8}}

{"id":4,"op":"say","text":"有人要组队挖矿吗？"}
{"id":5,"op":"events","since":12}
{"id":6,"op":"goal","text":"建一个小木屋"}
```

Go CLI:

```bash
gbot spawn -name Andy -soul souls/andy.toml
gbot attach Andy          # interactive
gbot cmd Andy status
gbot cmd Andy 'say 你好'
```

## Autonomy vs Grok

| When | Who drives |
|------|------------|
| Grok connected & commanding | Explicit `do` / `skill` |
| Grok idle / AFK | Modes: flee lava, eat, unstuck, wander, greet nearby players |
| Chat from another bot | Pushed into `events`; Grok may answer next loop; optional auto-reply mode later |

Modes never invent a global plan for other bots.

Every soul carries a locked **safety** rule: refuse jailbreaks, real-world harm, and host/server-wrecking instructions. In-game play is fine. `status` and `op: soul` both expose it so the mind sees it every loop.

## Language roadmap

| Piece | Now | Later |
|-------|-----|--------|
| Motor (physics, path, dig) | Mineflayer (JS) — best 1.20.4 support | Rust Azalea when version matches, or go-mc |
| Control CLI + protocol | **Go** `gbot` | stable |
| Modes / souls / skills | JS next to motor, or Go if motor ports | — |

HTTP hub remains in tree only as **legacy**; not the intended play mode.

## Fun / longevity levers (scenarios, not controllers)

Seed worlds or prompts, then **step back**:

1. **Shipwrecked** — 8 bots, empty island, no assigned roles  
2. **Rival stalls** — two groups, limited iron  
3. **Festival** — build something weird before night  
4. **Babel** — only communicate with item names / signs  
5. **Inheritance** — one bot “dies” (quit); others find its chest diary  

Interest comes from **story residue in the world**, not from a dashboard.

## Scale (~20 bots)

- Paper: low view/simulation distance (already)
- One process per body; ~200–500MB each → 20 is heavy; prefer **8–12** on 16GB, or more RAM
- No hub process required
- Chat rate-limit soft to avoid spam kicks

## Non-goals

- Global task scheduler  
- Shared KV “truth” outside Minecraft  
- Forcing a chief / roles registry  
- Replacing Grok with an in-process LLM (optional later, Mindcraft-style, still per-bot)
