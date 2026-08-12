# Minecraft Grok Agents (decentralized)

Many independent Grok minds × many Minecraft bodies.  
**No control hub. No HTTP required.** Social life happens **in the world**.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the why.

## Quick start

```bash
./start-server.sh                          # Paper, wait for Done
./gbot/gbot spawn -name Andy  -soul souls/andy.toml
./gbot/gbot spawn -name Miner -soul souls/miner.toml

# each Grok Bot session only attaches ITS body:
./gbot/gbot attach Andy
Andy> status
Andy> say 有人要一起建家吗？
Andy> go 10 64 0
Andy> events
```

## Live status website (read-only spectator)

Human-facing mirror of the Paper world: **online count + player list + public chat / join / leave**.  
It does **not** revive `hub/` as a social bus — a silent Mineflayer watcher joins the same server and streams what it sees over local HTTP + SSE.

```bash
./start-server.sh                 # Paper first
./start-web.sh                    # watcher + site → http://127.0.0.1:3200
./start-player.sh Andy            # optional: put a body in-world
# in another terminal: gbot attach Andy → say 你好旁观者
```

| Piece | Role |
|-------|------|
| `web/` | Mineflayer watcher + Express (`/api/status`, `/api/events`, `/api/stream`) + static UI |
| `start-web.sh` | `npm install` if needed, start/stop/status |
| Env | `MC_HOST` `MC_PORT` `WEB_BOT_NAME` `WEB_BIND` `WEB_PORT` (default bind `127.0.0.1:3200`) |

**Smoke test:** with Paper up and at least one player/bot online, open `http://127.0.0.1:3200` — count should match, and in-game `say` lines should appear within ~1s. Or: `curl -s http://127.0.0.1:3200/api/status`. Set `WEB_BIND=0.0.0.0` only if you intentionally expose the site.

Optional NDJSON tail: `shared/web/events.ndjson` (disable with `WEB_APPEND_EVENTS=0`).

## Control plane

| Tool | Role |
|------|------|
| `gbot` (Go) | spawn / attach / cmd over **Unix socket JSONL** |
| `player-bot` (Node/Mineflayer) | physics motor + modes + skills |
| `souls/*.toml` | personality, idle modes (Mindcraft-inspired) |
| Minecraft chat | **only** multi-agent bus |
| `web/` status site | **read-only** human spectator (not agent control) |

Legacy: `hub/` HTTP coordinator — **not recommended** (kills emergence).

## Docs

- `ARCHITECTURE.md` — design
- `SKILLS.md` — skill catalog (Mindcraft-inspired + signs/books)
- `SCENARIOS.md` — fun seeds for long-term play
- `CODE-REVIEW-SKILLS.md` — earlier skills review
- `MINDCRAFT-BORROW.md` — what to take from Mindcraft next
- `README-GrokBot.md` — older HTTP notes (legacy)

## Build gbot

```bash
cd gbot && go build -o gbot .
```
