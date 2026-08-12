# Play scenarios (no hub, no assigned boss)

Seed a situation. Let bots invent the rest through **in-game chat** and bodies.

## How to run N independent minds

```bash
./start-server.sh          # wait Done
./gbot/gbot spawn -name Andy  -soul souls/andy.toml
./gbot/gbot spawn -name Miner -soul souls/miner.toml
./gbot/gbot spawn -name Wild  -soul souls/wild.toml
# each Grok session:
./gbot/gbot attach Andy
```

Each Grok only attaches **its own** body. Social = watch `events` / chat.

## Scenario seeds (for Grok system prompts)

### 1. Shipwrecked
You washed up with strangers. No leader. Survive the first night. You may ally, steal, or leave.

### 2. Market day
You want to open a stall. Convince others to trade via chat. No shared spreadsheet — only chests and words.

### 3. Rival forges
Two or more bots want iron. Negotiate, race, or sabotage. Claims are **social only**.

### 4. Babel
You may only communicate with item names and signs for 20 minutes. Then free chat.

### 5. Festival
Before nightfall, the group should have *something* weird built. Who organizes is emergent.

### 6. Inheritance
One bot quits after writing a book/chest note. Others find it. Drama optional.

## Grok loop (peer, not worker)

```text
events  →  think  →  say / go / dig / skill  →  events
```

Never wait for a chief mail. If lonely, **shout in chat**.

## Mindcraft parallels

| Mindcraft | Here |
|-----------|------|
| multi-agent cooking/craft split inventory | let them discover “you take wheat, I take sugar” in chat |
| profiles + modes | `souls/*.toml` |
| skills | see `SKILLS.md` (gather, chest, bed, places, …) |
| conversation manager | Minecraft chat + local `events` |
| async notes | **signs** at bases, **books** tossed/chested |

## Sign-post culture (emergent mail)

```text
Bot A: skill write_sign 食物在箱子\n别拿钻石
Bot B (later, walking by): skill read_sign
Bot B: skill take_chest bread 8
```

No hub. No ticket system. Just the world.

## Coordination loop (20 peers)

```text
events          →  see chat + coord + sign
shout_meet     →  "我在 10 64 -3 附近，过来找我"
go_find Andy   →  sight first, else last heard coords; walk loose
peers          →  who said they were where
```

Do **not** wait for a hub mail. If nobody answers `[meet]`, go build alone or shout again.

### Extra seeds

- **早报柱** — one oak sign at spawn; overwrite the date + three rumors.
- **书信邮差** — `mail To:Miner` then chest/toss; recipient `read_mail`.
- **炉子署名** — `bulletin forge` next to a furnace you placed.
- **守夜** — dusk: `say [night] 谁守夜` — no roster, only chat.
- **软圈地** — four cobble + `[claim]` sign. Pathfinder does not honor it.
