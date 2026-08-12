# Modflared + Cloudflare Tunnel

[Modflared](https://modrinth.com/mod/modflared) is a **client-only** Fabric/Forge/NeoForge mod. Paper cannot load it. Mineflayer cannot load it either.

This repo ports the **same client behavior** into `player-bot` so a remote Grok bot can join a CF-tunnelled server the way a Modflared player would:

1. Look up DNS **TXT** on the hostname you type
2. If it is `cloudflared-use-tunnel` or `cloudflared-route=<host>`, start  
   `cloudflared access tcp --hostname <host> --url 127.0.0.1:<freePort>`
3. Point Mineflayer at that local port

```
human (Fabric/Forge + Modflared)  --CF tunnel-->  cloudflared  -->  Paper :25565
remote gbot / player-bot          --same TXT + local cloudflared access tcp-->
local gbot on the Paper box       -------------------------------->  127.0.0.1:25565
```

Local bodies stay on `127.0.0.1`. Auto mode never starts a tunnel for loopback / RFC1918.

## Remote Grok bot (this is the port)

On the machine that runs the *other* bot:

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Point at the public join name (the same name Modflared players type):

```bash
# TXT on play.example.net is cloudflared-use-tunnel  →  auto
export MC_HOST=play.example.net
export MC_PORT=25565
export MC_TUNNEL=auto          # default
export MC_VERSION=1.20.1
# Zero Trust Access (only if the hostname is behind an Access app):
# export TUNNEL_SERVICE_TOKEN_ID=...
# export TUNNEL_SERVICE_TOKEN_SECRET=...

./gbot/gbot spawn -name Andy -soul souls/andy.toml -host play.example.net
```

Force the tunnel hostname (same as Modflared `forced_tunnels.json`) when TXT is missing:

```bash
./gbot/gbot spawn -name Andy -host play.example.net -tunnel on
# or a different CF hostname than the join name:
./gbot/gbot spawn -name Andy -host play.example.net -tunnel-host inner.example.net
```

`gbot health` / `status` shows `mc.tunnel.via = modflared` when the sidecar is up.

Need `cloudflared` on PATH, or `CLOUDFLARED_BIN=/usr/local/bin/cloudflared`.

## Server (the Paper box)

1. Paper listens on `127.0.0.1:25565` (`server/server.properties`).
2. Cloudflare Tunnel ingress: `tcp://127.0.0.1:25565`.
3. `CLOUDFLARED_TOKEN=...` or `server/cloudflared/config.yml`.
4. Start:

```bash
./start-server.sh
./start-tunnel.sh
./start-tunnel.sh --status
```

5. DNS on the hostname players / remote bots type (e.g. `play.example.net`):
   - **CNAME** → `<tunnel-id>.cfargotunnel.com`
   - **TXT** → `cloudflared-use-tunnel`  
     (or `cloudflared-route=other.example.net` if the tunnel hostname differs)

## Human players

Need **Minecraft 1.20.1** + Fabric or Forge + Modflared. Vanilla cannot talk to a CF TCP tunnel.

```bash
./mods/download-modflared.sh
# copy mods/modflared-1.20.1-fabric.jar  (or -forge.jar)
# into the player's .minecraft/mods
```

If TXT is set, they add `play.example.net` in Multiplayer. No local `cloudflared`.

Forced list (only if DNS TXT is missing), on the **game client**:

`config/modflared/forced_tunnels.json`:

```json
["play.example.net"]
```

## Flags / env

| Flag / env | Meaning |
|---|---|
| `-tunnel` / `MC_TUNNEL` | `auto` (default): TXT then tunnel; skip loopback. `on`: always. `off`: direct |
| `-tunnel-host` / `MC_TUNNEL_HOST` | Force CF `--hostname` (skip TXT) |
| `CLOUDFLARED_BIN` | Path to `cloudflared` |
| `TUNNEL_SERVICE_TOKEN_ID` / `TUNNEL_SERVICE_TOKEN_SECRET` | Cloudflare Access service token |
| `CLOUDFLARED_TOKEN` | Server-side named tunnel token (this box only) |
