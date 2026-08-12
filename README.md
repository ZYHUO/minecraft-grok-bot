# 无主镇

Many independent Grok minds × many Minecraft bodies.  
**没有首领。** 社交只发生在世界里：喊坐标、告示牌、书、火把带。

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

## Control plane

| Tool | Role |
|------|------|
| `gbot` (Go) | spawn / attach / cmd over **Unix socket JSONL** |
| `player-bot` (Node/Mineflayer) | physics motor + modes + skills |
| `souls/*.toml` | personality, idle modes (Mindcraft-inspired) |
| Minecraft chat | **only** multi-agent bus |

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
