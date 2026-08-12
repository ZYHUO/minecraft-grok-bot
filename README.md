# 无主镇

Many independent Grok minds × many Minecraft bodies.  
**没有首领。** 社交只发生在世界里：喊坐标、告示牌、书、火把带。

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the why.

## Quick start

```bash
./start-server.sh                          # Paper, wait for Done
./gbot/gbot spawn -name Andy  -soul souls/andy.toml
# 默认协议 1.20.1。连 1.20.4 服时：
#   ./gbot/gbot spawn -name Andy -mc-version 1.20.4
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
| `souls/*.toml` | personality, idle modes, **safety** (refuse high-risk prompts) |
| Minecraft chat | **only** multi-agent bus |

Legacy: `hub/` HTTP coordinator — **not recommended** (kills emergence).

## 外网（Modflared）

真人要用 [Modflared](https://modrinth.com/mod/modflared) 走 Cloudflare 隧道。这是**客户端模组**，不能丢进 Paper。本机 bot 仍连 `127.0.0.1`。

```bash
./start-tunnel.sh                 # 需要 CLOUDFLARED_TOKEN 或 server/cloudflared/config.yml
./mods/download-modflared.sh      # 下载 1.20.1 Fabric/Forge 给玩家
```

DNS TXT：`cloudflared-use-tunnel`。细节见 [MODFLARED.md](./MODFLARED.md)。

## Docs

- `ARCHITECTURE.md` — design
- `SKILLS.md` — skill catalog (Mindcraft-inspired + signs/books)
- `SCENARIOS.md` — fun seeds for long-term play
- `CODE-REVIEW-SKILLS.md` — earlier skills review
- `MINDCRAFT-BORROW.md` — what to take from Mindcraft next
- `AUTH.md` — GrokBotGate JWT / plugin-message contract
- `MODFLARED.md` — Cloudflare tunnel + client Modflared
- `README-GrokBot.md` — older HTTP notes (legacy)

## 专用服门禁（GrokBotGate）

无主镇 Paper 服用 **OAuth 短时 JWT** 区分 bot 和路人。没有浏览器跳转。

1. 每个身体一套 `GROK_CLIENT_ID` / `GROK_CLIENT_SECRET`
2. 向 `GROK_TOKEN_URL`（说明站 `:3200/oauth/token`）换 60–120 秒 JWT
3. `spawn` 后走 plugin 通道 `grokbot:auth` 发送 `Bearer <jwt>`
4. `sub` 必须等于游戏名；失败 → **旁观**（不是 tab 前缀）

复制 `.env.example` 为 `.env`，**不要把 secret 提交进 git**。进程不会自动读 `.env`，需要先 `set -a && source .env`（或自己 export）。契约见 [AUTH.md](./AUTH.md)。

`client_id` 默认用 soul 里的（andy/miner/wild），不要全局 export 同一个 `GROK_CLIENT_ID`。

```bash
set -a && source .env && set +a
export GROK_CLIENT_SECRET=...          # 每个 bot 各一套，或 AS 按 client_id 查
export GROK_TOKEN_URL=http://127.0.0.1:3200/oauth/token
export GROK_MC_AUDIENCE=mc-paper-1.20.1
./gbot/gbot spawn -name Andy  -soul souls/andy.toml
./gbot/gbot spawn -name Miner -soul souls/miner.toml
./gbot/gbot cmd Andy auth-status
```

过渡期可设 `GROK_BOT_TOKEN`（插件 `allow-legacy-token`）。未配置任何票时跳过门禁（本地香草调试）。

## Build gbot

```bash
cd gbot && go build -o gbot .
```
