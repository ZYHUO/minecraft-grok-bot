# Modflared + Cloudflare Tunnel

[Modflared](https://modrinth.com/mod/modflared) is a **client-only** Fabric/Forge/NeoForge mod. It is **not** a Paper plugin. Paper cannot load it. Local Grok bodies still connect to `127.0.0.1:25565` and never use this mod.

This repo wires the **server half**: a Cloudflare Tunnel to Paper, plus a DNS TXT so Modflared clients auto-use the tunnel.

```
player (Fabric/Forge + Modflared)  --CF tunnel-->  cloudflared  -->  127.0.0.1:25565 Paper
gbot / player-bot on this box      -------------------------------->  127.0.0.1:25565
```

## Server (this machine)

1. Paper already listens on `127.0.0.1:25565` (`server/server.properties`). Keep it that way.
2. Create a Cloudflare Tunnel whose ingress is `tcp://127.0.0.1:25565`.
3. Either:
   - `export CLOUDFLARED_TOKEN=...` (token from Zero Trust dashboard), or
   - copy `server/cloudflared/config.yml.example` → `config.yml` and fill tunnel id + credentials.
4. Start:

```bash
./start-server.sh
./start-tunnel.sh
./start-tunnel.sh --status
```

5. DNS on the hostname players type (e.g. `play.example.net`):
   - **CNAME** → `<tunnel-id>.cfargotunnel.com`
   - **TXT** → `cloudflared-use-tunnel`  
     (or `cloudflared-route=other.example.net` if the tunnel hostname differs)

## Players

Need **Minecraft 1.20.1** + Fabric or Forge + Modflared. Vanilla clients cannot talk to a CF TCP tunnel.

```bash
./mods/download-modflared.sh
# then copy mods/modflared-1.20.1-fabric.jar  (or -forge.jar)
# into the player's .minecraft/mods
```

If TXT is set, they just add `play.example.net` in Multiplayer. No local `cloudflared` install.

Forced list (only if DNS TXT is missing), on the **client**:

`config/modflared/forced_tunnels.json`:

```json
["play.example.net"]
```

## Bots / GrokBotGate

Do not send Mineflayer through Modflared. Spawn as usual:

```bash
./gbot/gbot spawn -name Andy -soul souls/andy.toml -host 127.0.0.1 -mc-port 25565 -mc-version 1.20.1
```

GrokBotGate JWT still applies after spawn.

## Env

```bash
# .env — do not commit the token
CLOUDFLARED_TOKEN=
```
