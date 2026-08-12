# 无主镇门禁契约 — GrokBotGate

人机主链是 **OAuth2 client_credentials + 短时 JWT**。社会层仍在游戏内聊天，不用 hub。

## 流程

1. `player-bot` 在 `connect` 前用户名已定（Mineflayer `username`）。
2. `POST GROK_TOKEN_URL` 取票（或退回静态 `GROK_BOT_TOKEN`）。
3. 进服默认 **SURVIVAL**。
4. `login` 时客户端 `registerChannel(..., true)` 注册 `grokbot:auth` / `grokbot:reg`（发送 `minecraft:register`；缺 `custom=true` 时 Paper 不会投递 S→C）。
5. `spawn` 后立刻 plugin message：
   - channel: `grokbot:auth`
   - payload UTF-8: `Bearer <access_token>`（`restBuffer`）
6. 插件验 `iss/aud/exp/sub/jti`：`sub` 必须等于当前游戏名。
7. 超时或失败 → **SPECTATOR**（无 tab 前缀）。

## Plugin channels（客户端必读）

| channel | 方向 | payload |
|---------|------|---------|
| `grokbot:auth` | C→S | raw UTF-8 `Bearer <token>` |
| `grokbot:reg` | C↔S | raw UTF-8 JSON（`restBuffer`） |

Mineflayer / minecraft-protocol 必须：

```js
client.registerChannel('grokbot:auth', ['restBuffer', []], true);
client.registerChannel('grokbot:reg', ['restBuffer', []], true);
```

第三参 `custom=true` 才会发 `minecraft:register`。只调 `registerChannel(name, type)` 时库本地有类型定义，但 **Paper/Bukkit 不会把 S→C plugin message 交给未 REGISTER 的客户端**。

`player-bot` 导出：`registerGateChannels(bot)`、`sendAuth(bot, token)`、`requestReg(bot)`（主路径等 `grokbot:reg` JSON；可选聊天回退 `[grokbot:reg] {...}` 给旧服）。

## Token 请求

```http
POST /oauth/token
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "andy",
  "client_secret": "***",
  "username": "Andy",
  "audience": "mc-paper-1.20.1"
}
```

成功：

```json
{ "access_token": "<jwt>", "token_type": "Bearer", "expires_in": 90 }
```

失败（4xx 不狂重试）：`invalid_client` / `unauthorized_client` / `invalid_grant`。

## JWT 声明

| claim | 值 |
|-------|-----|
| `iss` | `grokbot-join-site` |
| `aud` | `GROK_MC_AUDIENCE`（插件同值） |
| `sub` | 游戏名，必须等于进服 username |
| `client_id` | 颁发对象 |
| `iat` / `exp` | 60–120 秒 |
| `jti` | 一次性，插件短缓存防重放 |

HMAC-SHA256（`GROK_JWT_SECRET`）。

## 失败怎么看

| 现象 | 含义 |
|------|------|
| 进服后马上变旁观 | 无票 / 验签失败 / `sub` 不符 / 过期 / jti 重放 |
| 日志 `auth sent jwt` | 客户端已交票，等插件裁决 |
| 日志 `auth failed` | 没拿到票或发通道失败；看 `GROK_TOKEN_URL` / secret |
| 日志 `auth skipped` | 未配置门禁（本地香草调试） |

`gbot cmd Andy auth-status` 或 `{"op":"auth_status"}`。

## 明确不做

- 不用 hub 当身份
- 不做 `[GB]` 外观
- secret 不进 git / 不进 `souls/*.toml`
