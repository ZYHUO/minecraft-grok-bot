# LEGACY — HTTP hub notes

**This document is historical.** Current control is Unix sockets via `gbot`, not the hub.

Use `README.md` + `ARCHITECTURE.md` + `./gbot/gbot attach Andy`.  
`hub/`, `mcctl`, and HTTP ports `3001+` are leftover and are **not** the recommended loop.

---

# Grok Bot — Minecraft Multi-Player Control

Lightweight **Mineflayer + Control Hub** stack so many isolated Grok Bots can each control a Minecraft player **and talk to each other**.

- **No extra LLM layer** — you decide; this process only senses + acts.
- **Control Hub `:3100`** — one entry for ~20 agents (mail, channels, blackboard, proxy).
- **`mcctl` CLI** — prefer over raw multi-port curl.
- **One process per player** — ports `3001+` (still usable directly).
- **Async long actions** — `move_to` / `dig` / … return immediately; poll job/status.

---

## Layout

```
minecraft-grok-bot/
  server/                 Paper 1.20.4 + server.properties (offline)
  player-bot/             Mineflayer per-player controller
  hub/                    Control Hub (mail + board + proxy)
  mcctl                   CLI for Grok Bots (recommended)
  start-server.sh         MC server
  start-hub.sh            Control Hub :3100
  start-player.sh         One player bot
  start-team.sh           Start N players + register on hub
  shared/hub/             File-backed mail/board/events (agents can tail files)
  README-GrokBot.md       this file
```

---

## One-time setup

```bash
# Java 21 for Paper
sudo apt-get update && sudo apt-get install -y openjdk-21-jre-headless

# Node deps
cd /root/minecraft-grok-bot/player-bot && npm install

# Paper jar (auto-fetched on first start-server.sh too)
bash /root/minecraft-grok-bot/server/download-paper.sh
```

---

## Start

**Bot-Server (Grok Bot that owns the server):**

```bash
cd /root/minecraft-grok-bot
./start-server.sh
# foreground debug: ./start-server.sh --fg
# status / stop:     ./start-server.sh --status | --stop
# log: logs/server.log  (wait for "Done" before starting players)
```

Wait until log shows `Done` (world ready), then:

**Control Hub + players (recommended for multi Grok Bot):**

```bash
./start-hub.sh
./start-player.sh Miner1 3001
./start-player.sh Builder1 3002
# or bulk: ./start-team.sh 5

./mcctl register miner1 Miner1 3001 miner
./mcctl register builder1 Builder1 3002 builder
```

Or one-shot team: `./start-team.sh 10` (Bot1..Bot10 on 3001..3010).

---

## Why Hub (not 20 separate HTTP ports)

Isolated Grok Bot sessions **do not share memory or chat**. They need a **shared medium**:

| Mechanism | Use |
|-----------|-----|
| **Mail** (`mcctl say`) | 1:1 task assignment |
| **Channels** (`mcctl shout ops`) | broadcast phase / alerts |
| **Blackboard** (`mcctl board-set`) | goals, claims, rally points |
| **events.ndjson** | `mcctl watch-events` / `tail -f` |
| **team/status** | everyone sees everyone |

All durable under `shared/hub/` so you can also read files if HTTP is down.

### 20-bot loop (each Grok Bot)

```bash
export GROK_AGENT=miner3   # unique per Grok Bot session
export HUB=http://127.0.0.1:3100

# once
./mcctl register miner3 Miner3 3003 miner
./mcctl heartbeat

while true; do
  ./mcctl inbox              # read orders from chief
  ./mcctl board              # shared goals / claims
  ./mcctl status             # my body in MC
  # ... decide ...
  ./mcctl action '{"type":"move_to","x":10,"y":64,"z":0}'
  ./mcctl shout ops "miner3 arrived"
  sleep 3
done
```

Chief example:

```bash
export GROK_AGENT=chief
./mcctl board-set goal '{"phase":"mine_east","rally":[100,64,0]}'
./mcctl shout ops "phase=mine_east"
./mcctl say miner3 "claim vein at 120 40 15"
./mcctl team
```

---

## Per-player HTTP API (low-level, still available)

Direct ports still work (`http://127.0.0.1:3001`) but prefer Hub + `mcctl`.

## Hub HTTP (strict JSON)

### Hub base: `http://127.0.0.1:3100`

Header: `X-Agent-Id: miner3`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/agents/register` | Bind agent ↔ player ↔ port |
| GET | `/agents` | Who is online |
| POST | `/mail/send` | Agent→agent (or `to:all`) |
| GET | `/mail/inbox` | Poll my messages |
| POST | `/channels/:name/publish` | Broadcast |
| GET/PUT | `/board` `/board/:key` | Shared KV |
| GET | `/team/status` | All bots slim snapshot |
| GET | `/me/status` POST `/me/action` | My bound player (proxy) |
| GET | `/players/:name/status` | Proxy any player |

### Player base: `http://127.0.0.1:3001` (example)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Process + connection probe |
| GET | `/status` | Slim world state (default) |
| GET | `/status?detail=entities,blocks,inventory` | Expanded |
| GET | `/inventory` | Full inventory slots |
| GET | `/blocks?radius=2` | Local block sample |
| GET | `/job` | Current async job only |
| POST | `/action` | Run action (JSON body) |
| POST | `/stop` | Cancel movement / job |
| POST | `/config` | Toggle `auto_eat`, etc. |
| POST | `/quit` | Disconnect + exit process |

### GET /status (slim example)

```json
{
  "bot": "Miner1",
  "port": 3001,
  "connected": true,
  "pos": { "x": 1.5, "y": 64.0, "z": -12.3 },
  "yaw": 1.57,
  "pitch": 0,
  "health": 20,
  "food": 18,
  "dimension": "overworld",
  "held": { "name": "iron_pickaxe", "count": 1 },
  "inventory_summary": { "cobblestone": 32, "oak_log": 8 },
  "job": { "id": "job_1_…", "type": "move_to", "state": "running", "target": { "x": 10, "y": 64, "z": -3 } },
  "feet_block": { "name": "grass_block", "pos": { "x": 1, "y": 63, "z": -12 } },
  "front_block": { "name": "stone", "pos": { "x": 2, "y": 64, "z": -12 } },
  "nearby_players": [{ "name": "Builder1", "dist": 6.2 }],
  "chat_recent": ["<Builder1> go mine east"],
  "danger": []
}
```

### POST /action

**Long actions** (`move_to`, `dig`, `place`, `craft`, `follow_player`): HTTP returns immediately.

```bash
curl -s -X POST http://127.0.0.1:3001/action \
  -H 'Content-Type: application/json' \
  -d '{"type":"move_to","x":10,"y":64,"z":-3}'
# → {"accepted":true,"sync":false,"job_id":"job_1_…", ...}
```

Then poll until `job` is null or `state` is `done` / `error` / `aborted`:

```bash
curl -s http://127.0.0.1:3001/status | jq '.job, .pos'
```

**Short actions** (`chat`, `look_at`, `equip`, `attack`, …): usually `sync: true` with immediate `result`.

---

## Action schema (strict — no natural language)

### move_to

```json
{ "type": "move_to", "x": 10, "y": 64, "z": -3, "range": 1 }
```

### look_at

```json
{ "type": "look_at", "x": 10, "y": 65, "z": -3 }
```

### dig

```json
{ "type": "dig", "x": 10, "y": 63, "z": -3 }
```

```json
{ "type": "dig", "block": "oak_log", "max_distance": 4 }
```

### place

```json
{ "type": "place", "item": "cobblestone", "x": 10, "y": 64, "z": -3 }
```

### chat

```json
{ "type": "chat", "message": "Builder1 I am at the mine" }
```

### equip / unequip

```json
{ "type": "equip", "item": "iron_pickaxe", "destination": "hand" }
```

```json
{ "type": "unequip", "destination": "hand" }
```

### craft

```json
{ "type": "craft", "item": "crafting_table", "count": 1 }
```

### attack

```json
{ "type": "attack", "name": "zombie" }
```

```json
{ "type": "attack", "entity_id": 42 }
```

### follow_player

```json
{ "type": "follow_player", "player": "Builder1", "range": 2, "timeout_ms": 60000 }
```

### stop

```json
{ "type": "stop" }
```

Same as `POST /stop`.

### toss / set_control (extra)

```json
{ "type": "toss", "item": "cobblestone", "count": 16 }
```

```json
{ "type": "set_control", "forward": true, "sprint": true }
```

---

## Observe → Decide → Act loop (for Grok Bot)

Pseudo-code you should run yourself in the terminal (you are the brain):

```bash
PORT=3001
while true; do
  # 1) Observe
  curl -s "http://127.0.0.1:$PORT/status" -o /tmp/mc-status.json
  cat /tmp/mc-status.json
  # 2) You (Grok) read JSON and choose next action
  # 3) Act (example: walk if idle)
  JOB=$(jq -r '.job.state // empty' /tmp/mc-status.json)
  if [ -z "$JOB" ] || [ "$JOB" = "done" ] || [ "$JOB" = "error" ]; then
    # example only — replace with your decision
    curl -s -X POST "http://127.0.0.1:$PORT/action" \
      -H 'Content-Type: application/json' \
      -d '{"type":"chat","message":"thinking..."}'
  fi
  sleep 2
done
```

Rules of thumb:

1. Always read `/status` before a new long action.
2. If `job.state == "running"`, wait or `POST /stop`.
3. Prefer slim `/status`; use `?detail=blocks` only when mining/building.
4. Use in-game `chat` or files under `shared/` to coordinate multi-bot work.
5. On `danger` containing `low_health` / `hostile:*`, handle explicitly.

---

## Multi-bot roles (example)

| Grok Bot | Name | Port | Role |
|----------|------|------|------|
| Server | — | 25565 | `./start-server.sh` |
| Player1 | Miner1 | 3001 | Gather resources |
| Player2 | Builder1 | 3002 | Place / craft |
| Player3 | Guard1 | 3003 | Watch / attack hostiles |

Optional blackboard:

```bash
echo '{"order":"mine_east","by":"Builder1"}' > shared/orders.json
cat shared/orders.json
```

---

## Config toggles

```bash
# Disable auto-eat (you control food)
curl -s -X POST http://127.0.0.1:3001/config \
  -H 'Content-Type: application/json' \
  -d '{"auto_eat":false}'
```

Default **auto_eat=true** (eat when hungry). No auto-flee / auto-fight beyond that.

---

## Resource notes (~16GB shared box)

| Process | Rough RAM |
|---------|-----------|
| Paper (`MAX_RAM=4G`) | ~4–5 GB |
| Each player-bot | ~200–500 MB |
| 3 players recommended | safer |
| 5 players | upper bound; lower view-distance already set |

Env overrides for server:

```bash
MIN_RAM=1G MAX_RAM=4G AUTO_RESTART=1 ./start-server.sh
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `java not found` | Install OpenJDK 21 |
| player `kicked` / cannot connect | Wait for server fully started; check `online-mode=false` |
| HTTP 409 Busy | `curl -X POST .../stop` then retry |
| HTTP 429 | Slow down actions (rate limit) |
| pathfinder stuck | `/stop` then smaller `move_to` steps |
| job error `NO_PATH` | target unreachable — pick closer coords or dig path |
| server won't die | `./start-server.sh --stop` (kills wrapper + java) |
| wrong MC version | `node player-bot.js --name X --port 3001 --version 1.20.4` |

Logs:

- `logs/server.log`
- `logs/player-<name>-<port>.log`
- `logs/player-<name>-<port>.app.log`

---

## Design guarantees

1. **No LLM inside this stack** — only Mineflayer + Express.
2. **Strict JSON actions** — no NL parsing in the API.
3. **Slim status by default** — expand with query flags.
4. **Async long jobs** — never block forever on `move_to`/`dig`.
5. **Reconnect** — player process stays up and re-joins after disconnect (unless `/quit`).
