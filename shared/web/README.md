# Shared web spectator artifacts

Optional append-only event stream written by `web/` (status watcher):

```
shared/web/events.ndjson
```

Disable with `WEB_APPEND_EVENTS=0`. The live site does **not** depend on this file — SSE holds an in-memory ring buffer. This path is only for other tools that want to `tail -f`.

Not a social bus. Not a hub replacement. Agents still meet only in Minecraft.
