# Skills (Mindcraft-inspired)

High-level body actions. **Local only** — never assign work to other bots.

```bash
gbot attach Andy
Andy> skill help
Andy> skill gather oak_log 8
Andy> skill write_sign 仓库→\n东边红床\n欢迎拿走食物
Andy> skill remember_here base
```

Or JSONL:

```json
{"op":"skill","skill":"gather","block":"oak_log","count":8}
{"op":"skill","skill":"write_sign","text":"有人吗？\n来交易"}
{"op":"skill","skill":"write_book","text":"第一页\n\n第二页","title":"日记","author":"Andy"}
```

## Catalog

| Skill | Args | Notes |
|-------|------|--------|
| `gather` | block, count | collectBlock + tools + ore aliases; `INVENTORY_FULL` / `NEED_TOOL` |
| `pickup` | range | walk over drops |
| `craft` | item, count | walks to / places a crafting table |
| `craft_plan` | item, count | steps + missing ingredients |
| `smelt` / `clear_furnace` | item, count | nearby or placed furnace |
| `use_on` | tool, target | `nothing` / block / entity / source water\|lava |
| `till` / `plant` / `harvest` | seed / pos | farmland + mature crops |
| `goto` | x,y,z | pathfind |
| `go_to_player` / **`go_find`** | player | sight / last coords / torch·dig traces; gait from soul; world interrupts; miss-shout; stand in a loose circle |
| `emote` | jump / sneak / wave / point | body language; `point` looks at a block and says 这个 |
| `peers` | | last seen / heard positions |
| `go_to_block` | block, range | |
| `go_to_entity` | name | villager / mob / item |
| `move_away` | distance | |
| `follow` | player, duration_ms | |
| `give` | player, item, count | approach + toss |
| `equip` / `discard` / `consume` | item | |
| `attack` | name/player | one swing. `kill=true` → hunt |
| **`hunt`** | name, count, range | walk in, melee until dead, pickup. creeper keeps 4–6 格 |
| **`defend`** | range | clear hostiles in range (same loop as hunt) |
| `sleep` | | nearest bed; `ok:false` / `BED_FAILED` if daytime or monsters |
| `stay` | seconds | abortable via `stop` |
| `place_here` | item, dx,dy,dz | |
| `dig_down` | depth | stops on fluid/drop |
| `surface` | | column scan, then climb |
| `view_chest` | | nearest chest/barrel |
| `put_chest` / `take_chest` | item, count | loops stacks; returns `moved` / `remaining` |
| **`write_sign` / `read_sign` / `find_signs` / `bulletin`** | text / pos / range / tag | **async public notes** |
| `mail` / `read_mail` | to, text | book titled `To:Name` |
| `whisper` | player, text | private /msg |
| `shout_meet` / `shout_trade` / `shout_need` / `shout_have` / `shout_help` / `shout_here` | | tagged public chat |
| `villager_trades` / `trade` | id, index, count | shared-world economy |
| `look_around` | | biome / weather / time / armor / nearby block types |
| **`write_book` / `read_book`** | text/pages, title | **portable notes** (sign default; irreversible) |
| **`remember_here` / `go_place` / `forget_place` / `places`** | name | private waypoints |
| `activate` | block/x,y,z | door/button |
| `look_player` | player | |
| `inventory` / `craftable` / `say` | | |

## Async messaging (no hub)

| Medium | Who sees it | When |
|--------|-------------|------|
| Chat | everyone online | realtime |
| **Sign** | whoever walks by later | durable in world |
| **Book** | whoever holds/reads item | portable; can toss/chest |
| Places | only this bot’s memory file | private |

Emergent pattern: leave a sign at spawn; others `read_sign` / `find_signs` when they pass — no chief required.

## In-world coordination (no hub)

Bots only meet in Minecraft. Tagged chat and signs are parsed into `events` (`kind: coord`). Software does **not** assign work.

| Tag | Example | Meaning |
|-----|---------|---------|
| `[meet]` | `[meet] x=10 y=64 z=-3` | come here |
| `[trade]` | `[trade] need:oak_log give:cobblestone` | barter offer |
| `[need]` / `[have]` | `[need] bread 8` | ask / advertise |
| `[help]` | `[help] creepers` | distress |
| `[here]` | `[here] x=…` | I am here |
| `[claim]` | `[claim] Andy 的坑` | social only |
| `[forge]` | `[forge] Miner` | furnace ownership note |
| `[mail]` / book title `To:Miner` | portable letter |

```bash
Andy> skill shout_meet
Andy> skill shout_trade oak_log cobblestone
Andy> skill bulletin claim 别挖我的坑
Andy> skill mail Miner 炉子在东边箱子
Miner> events          # see kind=coord / kind=sign
Miner> skill find_signs 24
Miner> skill read_mail
```

## Mindcraft mapping

| Mindcraft | Ours |
|-----------|------|
| !collectBlocks | gather |
| !smeltItem / !clearFurnace | smelt / clear_furnace |
| !getCraftingPlan | craft_plan |
| !useOn | use_on |
| !showVillagerTrades / !tradeWithVillager | villager_trades / trade |
| !craftRecipe | craft |
| !goToPlayer / !followPlayer | go_to_player / follow |
| !givePlayer | give |
| !putInChest / !takeFromChest / !viewChest | put_chest / take_chest / view_chest |
| !goToBed | sleep |
| !rememberHere / !goToRememberedPlace | remember_here / go_place |
| !digDown / !goToSurface | dig_down / surface |
| !stay / !moveAway | stay / move_away |
| !searchForBlock | go_to_block |
| signs/books | write_sign, write_book (extra for async lore) |
