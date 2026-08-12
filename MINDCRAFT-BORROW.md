# Mindcraft ideas to borrow

对照源：本地 `/root/mindcraft/`（与 github.com/mindcraft-bots/mindcraft 同树；公开仓库 v0.1.3 起已含 villager / bucket / `!useOn`，本地副本已有这些函数）。

原则：只借**单体内**技能 / 查询 / 模式 / 提示词习惯。不借会把 20 个 Grok Bot 重新收成「一个调度器」的东西。

---

## Already covered (skip)

- `souls/*.toml` 人格 + mode 开关（对应 Mindcraft `profiles/*.json` + `profiles/defaults/_default.json` 的 `modes`）
- 背景 modes：`self_preservation`、`unstuck`、`curiosity`、`social`、idle stare/wander（对应 `src/agent/modes.js` 的一部分）
- 技能面：`gather` / `pickup` / `goto` / `go_to_player` / `go_to_block` / `move_away` / `follow` / `dig_down` / `surface` / `stay` / `give` / `consume` / `activate` / `craft` / `craftable` / `sleep` / chests / places / signs / books
- 世界内异步纸条：告示牌 + 书（Mindcraft **没有** sign/book 技能，这是本地已超前的部分）
- 每 bot 私有地点：`places.js` ↔ `memory_bank.js` `rememberPlace` / `recallPlace`
- `collectblock` + `mineflayer-tool` 已 `loadPlugin`，但 `gather` 没用它们
- 本地日记 `memory/<name>.jsonl` ↔ Mindcraft `history.js` 落盘（摘要仍应由 **Grok 心** 做，不要塞回 body）
- 本地 `goal` 字符串 ↔ `!goal` / `SelfPrompter.prompt` 的软目标（不要抄进程内 LLM 循环）
- `auto_eat` 插件、`auto_chat_react` 短应答、单次 `attack`、`look_player`
- `status.js` 已有 nearby players / entities / danger / inventory（弱于 Mindcraft `!stats` + `!nearbyBlocks`，见 High value）

`CODE-REVIEW-SKILLS.md` 里的控制面 bug（skill 不占 busy、gbot 超时、chest 多 stack 等）是本地债，不是「再借一个 Mindcraft 功能」。先修那些再堆新技能。

---

## High value (implement next)

### Idea 1 — `gather` 真正用 collectBlock + 工具 + 矿石别名

- Mindcraft source: `src/agent/library/skills.js` `collectBlock()`；入口 `!collectBlocks`（`src/agent/commands/actions.js`）。内部：`bot.tool.equipForBlock`、`block.canHarvest`、`bot.collectBlock.collect`、`movements.safeToBreak`、矿石别名（`iron` → `iron_ore` + `deepslate_iron_ore`）、`mustCollectManually` 作物/火把走手动 dig+pickup、水/岩浆用桶、`NoChests` = 背包满、挖完 `autoLight()`。
- Why it fits decentralized Grok Bot (no hub): 纯单体采集。20 个 bot 各自挖各自的；世界掉落/箱子自然产生竞争，不需要任务队列。
- What local is missing: `skills.js` `gather` 只循环 `runAction({type:'dig'})`。`player-bot.js:531` 已 `loadPlugin(collectBlock.plugin)` 但零调用。无 `canHarvest`、无 ore 别名、无背包满检测、挖完不自动捡。
- Suggested implementation sketch:
  - 把 `gather` 改成 Mindcraft 同路径：别名展开 → `equipForBlock` → `canHarvest` 失败则明确 `NEED_TOOL` → `bot.collectBlock.collect`；作物/火把走现有 dig+`pickup`。
  - 背包 `emptySlotCount() <= 1` 时停并返回 `INVENTORY_FULL`（对应 `NoChests`）。
  - 文件：`player-bot/skills.js` `gather`；可选把 ore 别名抽到 `player-bot/mcdata.js`。
- Effort: M

### Idea 2 — 熔炉：`smelt` + `clear_furnace`

- Mindcraft source: `skills.smeltItem`、`skills.clearNearestFurnace`；命令 `!smeltItem` / `!clearFurnace`。`mcdata.isSmeltable` / `getSmeltingFuel` / `getFuelSmeltOutput`。附近无炉则自己放炉（`getNearestFreeSpace`），烧完可收回。
- Why it fits: 铁/食物是生存货币。每个 bot 自己找/放炉子，多炉并排会自然变成「铁匠摊」——不用总部。
- What local is missing: 零熔炉 API。Grok 只能 `activate` 对着炉子发呆。`craft` 也不覆盖烧炼。
- Suggested implementation sketch:
  - 新 skill `smelt`：找/放 `furnace` → `bot.openFurnace` → 选燃料（煤 > 木炭 > 木）→ `putInput` → 等 `takeOutput`（11s 无产出则停，尊重 abort）。
  - 新 skill `clear_furnace`：抽出 input/fuel/output。`try/finally` close。
  - 文件：`player-bot/skills.js`、`SKILLS.md`；燃料表可抄 `src/utils/mcdata.js:287-314`。
- Effort: M

### Idea 3 — 本地合成规划 + 真 `craftable` + 会走/放工作台的 `craft`

- Mindcraft source:
  - 查询 `!getCraftingPlan` → `mc.getDetailedCraftingPlan`（`src/utils/mcdata.js:467`）递归拆配方、对照当前背包、列出缺的基础物。
  - `world.getCraftableItems`（`world.js:285`）用 `bot.recipesFor(..., table)` 扫全物品表。
  - `skills.craftRecipe`：2×2 不够就找/放 `crafting_table`，走过去，按 `calculateLimitingResource` 限制次数，用完收走临时桌，`armorManager.equipAll()`。
- Why it fits: 规划发生在**这一具身体**上。Grok 问「铁镐差啥」→ 自己去挖/跟邻居喊，而不是向 hub 领任务。
- What local is missing: `craftable` 只扫 registry 前 400 名、截断 40 条，且 `recipesFor(..., null)` 忽略桌上配方。`actions.js` `craft` 只在 4 格内找桌，不会走过去、不会自己放桌、缺料只抛 `NOT_FOUND`。
- Suggested implementation sketch:
  - 新 query skill `craft_plan`（item, count）返回 steps / missing / already_have。
  - 重写 `craftable`：有桌或背包有桌 → `recipesFor` 全表。
  - `craft` 对齐 `craftRecipe`：走近桌 / 放桌 / 部分成功计数。
  - 文件：`player-bot/skills.js`、`player-bot/actions.js` `case 'craft'`；配方递归可移植 `getDetailedCraftingPlan`（不必抄整个 `mcdata.js`）。
- Effort: M

### Idea 4 — 单体生存 modes：cowardice / self_defense / hunting / item_collecting / torch_placing

- Mindcraft source: `src/agent/modes.js` 同名条目。`cowardice`：16 格敌对 + `isClearPath` → `avoidEnemies(24)`。`self_defense`：8 格 → `defendSelf`。`hunting`：idle 打 `isHuntable`（鸡牛猪羊兔）。`item_collecting`：等 2s 再捡，留空槽。`torch_placing`：`shouldPlaceTorch`（6 格无火把且手里有）。`self_preservation` 还会用水桶灭火、找水、低血 `moveAway(20)`。
- Why it fits: 全是「这具身体自己活着」。Grok 忙时只让 panic 打断；idle 时身体自己捡、点灯、打羊。20 个 bot 夜里看起来像一群活人，不是 20 个雕像。
- What local is missing: `modes.js` 只有弱版 preservation（岩浆直控、低血只聊天）、unstuck、social、curiosity。`souls/*.toml` 没有 cowardice/self_defense/hunting/torch。`status.js` 的 `danger: hostile:zombie` 只给 Grok 看，身体不反应。
- Suggested implementation sketch:
  - `modes.js` 加 5 个开关（默认：defense/torch/item_collect 开，cowardice/hunting 按 soul）。hostile 表已在 `status.js` `dangerHints`。
  - 路径：`isClearPath` 抄 `world.js:390`（`canDig=false` 的 pathfinder 试探）。
  - 低血先 `consume` 再 `move_away`；岩浆优先用水桶 `use_on`。
  - 文件：`player-bot/modes.js`、`souls/*.toml`、`soul.js` DEFAULT_SOUL。
- Effort: M

### Idea 5 — `use_on`：桶、剪刀、骨粉、打火石

- Mindcraft source: `!useOn` → `skills.useToolOn` / `useToolOnBlock`。target 可以是 entity、方块、`"nothing"`（空手/物品右键）、水/岩浆 **source**（`metadata === 0`）。`collectBlock` 收液体也走这条。v0.1.3 「Villagers and Buckets」。
- Why it fits: 灭火、浇地、挤奶、剪羊毛、点 Nether portal——全是世界内互动。多个 bot 抢一口岩浆源会自己吵起来。
- What local is missing: `actions.js` 有 `activate_item` 但不找目标。`activate` 只 `activateBlock`（门/按钮），不会装备桶去舀水。
- Suggested implementation sketch:
  - 新 skill `use_on {tool, target}`：`target=nothing|blockName|entityName`；水/岩浆只舀 source。
  - `self_preservation` 着火时优先 `water_bucket`。
  - 文件：`player-bot/skills.js`、`actions.js`（可扩 `activate_item` 带 lookAt）、`modes.js`。
- Effort: S

### Idea 6 — 村民交易：`villager_trades` + `trade`

- Mindcraft source: `!entities`  vicarious 列出 `(id:profession)`；`!showVillagerTrades` / `!tradeWithVillager` → `showVillagerTrades` / `tradeWithVillager` / `getVillagerProfession`（`world.js:218` 职业表）。`bot.openVillager` + `bot.trade`，检查 disabled / 材料 / 次数。
- Why it fits: 村民是共享世界资源。20 个 bot 会抢图书管理员、锁交易、在告示牌写「铁匠在东边」——经济自己长出来。
- What local is missing: `status` `nearby_entities` 只给 `name/type/dist`，无 profession。无 openVillager。
- Suggested implementation sketch:
  - `status` detail=entities 时附 `profession`（抄 metadata[18] 映射）。
  - skill `villager_trades {id}` / `trade {id, index, count}`。
  - 文件：`player-bot/skills.js`、`status.js`；职业表直接移植，别发明。
- Effort: M

### Idea 7 — 耕地：`till` / `plant` / 熟作物收割

- Mindcraft source: `skills.tillAndSow(bot, x, y, z, seedType)`（锄 → `activateBlock` 成 farmland → 装备种子再点）。`mustCollectManually` 把 wheat/carrots/potatoes/beetroots/nether_wart 列为手动收集。**没有**单独的 `!till` 命令，函数在 library 里给 coder / NPC 用。
- Why it fits: 食物产地 = 可抢可守的地标。配合已有告示牌「别踩田」+ 箱子「公粮」，市场日场景才站得住。
- What local is missing: 无锄地、无种植。`gather wheat` 可能挖掉 farmland。`use_on`（Idea 5）是底层，这是高层便利。
- Suggested implementation sketch:
  - skill `till`（脚下/坐标，需 hoe）、`plant {seed}`、`harvest`（age 满的作物走手动 collect）。
  - `gather` 对作物走 `mustCollectManually` 路径，别当普通方块硬挖。
  - 文件：`player-bot/skills.js`；成熟判定用 block metadata / `block.getProperties()?.age`。
- Effort: M

### Idea 8 — 感知查询对齐 `!stats` / `!nearbyBlocks` / 护甲栏

- Mindcraft source: `queries.js` `!stats`（坐标、血/饿、biome、天气、早午夜、当前 action、附近人/bot、mode 开关）；`!nearbyBlocks`（去重方块名 + 水/岩浆 source|flowing + `getSurroundingBlocks` + `getFirstBlockAboveHead`）；`!inventory` 含 WEARING 槽 5–8；`full_state.js` 打包这些。
- Why it fits: Grok 每轮只读自己 body 的 status。信息越像「我站在哪、头上是洞还是天、穿没穿铁甲」，越少乱挖乱走。仍是单向本地查询。
- What local is missing: `status.js` 无 biome / weather / timeOfDay、无护甲栏、`sampleBlocks` 只 ±2 立方体、无「头上第一块固体」、无附近方块类型集合。`craftable` 见 Idea 3。
- Suggested implementation sketch:
  - `buildStatus` 默认加 `biome`、`weather`、`time`（Morning/Afternoon/Night）、`wearing`、`above_head`。
  - `detail=blocks` 改为「半径内方块类型 + 源/流动水岩浆」，不要整立方体坐标倾倒。
  - 可选 skill `look_around` 返回上述，方便 Grok 不拉全 status。
  - 文件：`player-bot/status.js`、`player-bot.js` status op。
- Effort: S

---

## Medium / later

### Idea 9 — `give` 等对方捡到（playerCollect）

- Mindcraft source: `skills.giveToPlayer`：走近 → 太近则 `moveAwayFromEntity` → `discard` → 等 `bot.once('playerCollect')` 3s，确认 `collector.username`。
- Why it fits: 交易是社交平面核心。现在 `give` 只 navigate + toss，物品可能掉进岩浆或被第三者捡。
- What local is missing: 无确认、太近不后退、失败仍 `ok: gave`。
- Suggested implementation sketch: `skills.js` `give` 听 `playerCollect`；超时返回 `ok:false, code:NOT_RECEIVED`。
- Effort: S

### Idea 10 — 按部位 `equip` + 合成后自动穿甲

- Mindcraft source: `skills.equip` 按名字映射 head/torso/legs/feet/off-hand(shield)；`craftRecipe` 末尾 `bot.armorManager.equipAll()`。
- Why it fits: 晚上活下来。本地 `equip` 默认 `destination=hand`，Grok 经常把胸甲拿在手上。
- What local is missing: 无名字→槽推断；未装 `mineflayer-armor-manager`。
- Suggested implementation sketch: `skills.equip` / `actions.js` `case 'equip'` 按 helmet/chestplate/leggings/boots/elytra/shield 选槽。可选加插件，或合成后扫背包穿最好的。
- Effort: S

### Idea 11 — 打到死 + 捡掉落（不要上全局 PvP 导演）

- Mindcraft source: `attackEntity(..., kill=true)` 用 `bot.pvp.attack` 循环到实体消失再 `pickupNearbyItems`；`defendSelf` 对爬行者保持距离。依赖 `mineflayer-pvp`。
- Why it fits: 狩猎/自卫是单体的。不要加「谁去清场」的指挥官。
- What local is missing: `actions.js` `attack` 只 `bot.attack` 一下。无 pvp 插件。
- Suggested implementation sketch: skill `hunt {name}` 循环 attack+走近直到实体没了或 abort；完成后 `pickup`。先别上完整 pvp 插件也行。
- Effort: M

### Idea 12 — `surface` 按柱扫描，别用海平面 62

- Mindcraft source: `skills.goToSurface` 从 y=360 往下找当前 xz 第一块非空气，再 `goToPosition(..., y+1)`。
- Why it fits: 矿工从洞穴回家。本地 `goToSurface` 用 `y >= 62`，山地/下界/末地错。
- What local is missing: 见 `skills.js:401-430` 与 `CODE-REVIEW-SKILLS.md` Issue 11。
- Suggested implementation sketch: 同柱扫描；失败再少量向上挖。下界用基岩顶启发，不要抄 62。
- Effort: S

### Idea 13 — 本地蓝图 skill（`build_schematic`）——只要文件在这具身体上

- Mindcraft source: `npc/build_goal.js` `BuildGoal.executeNext` + `npc/construction/*.json`（`small_wood_house.json` 等层状 `blocks`）。缺料记 `missing`，不向别人派工。`!checkBlueprint*` 是 **task 评测** 用的，不要整套借。
- Why it fits: 每个 soul 带自己的小屋 JSON，世界里会看出「安迪盖木屋、矿工盖地洞」。蓝图是人格，不是总部任务。
- What local is missing: 只有 `place_here` 单块。
- Suggested implementation sketch: `souls/` 或 `schematics/<name>.json`；skill `build_schematic {name}` 逐块 place，返回 missing。**不要**从共享目录热更新成「全服同一张图」。
- Effort: L

### Idea 14 — 可恢复的跟随（resume follow）

- Mindcraft source: `!followPlayer` 经 `runAsAction(..., resume=true)`；`ActionManager._executeResume` 闲下来自动接着跟。`followPlayer` 本身是直到 `interrupt_code` 的死循环。
- Why it fits: 「跟着你去市场」是社交，不是集群。本地 `follow` 默认 60s 然后停。
- What local is missing: 无 resume；`stay` 也不 pause modes。
- Suggested implementation sketch: `follow` 支持 `duration_ms=-1` 直到 `stop`；job 被 panic 打断后若 goal 仍是 follow 则恢复。文件：`actions.js` `follow_player`、`player-bot.js` job。
- Effort: S

### Idea 15 — `go_to_entity` + 附近实体计数

- Mindcraft source: `!searchForEntity` → `goToNearestEntity`；`!entities` 计数 + 村民职业。
- Why it fits: 「去那只羊 / 那个村民」不必先读 status 再手填坐标。
- What local is missing: 有 `go_to_player` / `go_to_block`，无 entity。
- Suggested implementation sketch: skill `go_to_entity {name, range}`。
- Effort: S

### Idea 16 — 穿门：`useDoor`

- Mindcraft source: `skills.useDoor`：走近 → 若关则 `activateBlock` → 往前走 → 再关。`followPlayer` 里还有 `startDoorInterval`。
- Why it fits: 基地有门之后 pathfinder 经常卡。本地 `activate` 只点一下，不走进去。
- Suggested implementation sketch: `activate` 发现 `*_door` 时走 useDoor 序列；或独立 skill。
- Effort: S

### Idea 17 — 视觉快照（可选，Grok 自己看图）

- Mindcraft source: `vision/vision_interpreter.js` `lookAtPlayer` / `lookAtPosition` + `Camera.capture`；提示词 `image_analysis`（`profiles/defaults/_default.json`）。
- Why it fits: 仍是「这具眼睛」的截图。**不要**在 body 里再调一个 vision LLM——把 jpg 路径/base64 交给外面的 Grok。
- What local is missing: 无 prismarine-viewer / camera。
- Suggested implementation sketch: 以后再加 `look_at` 返回截图路径；默认关，省 20 bot 的 CPU。
- Effort: L

### Idea 18 — 日记压缩给 Grok 读（body 不跑 LLM）

- Mindcraft source: `history.js` `summarizeMemories` + prompt `saving_memory`（500 字、不记背包）。
- Why it fits: 本地已有 `memory/<name>.jsonl`。缺的是「给 Grok 的短记忆」，不是再做一个中央记忆库。
- What local is missing: diary 只追加，无 `memory_digest` 接口。
- Suggested implementation sketch: socket op `diary_tail` / `diary_grep`；摘要由 Grok 写回 `memory/<name>.md`。**禁止** body 调模型。
- Effort: S

### Idea 19 — `forget_place` + 附近告示牌扫描

- Mindcraft source: places 只有 remember/recall/list。**没有** `scan_signs`（本地原创缺口，CODE-REVIEW Issue 14）。
- Why it fits: 告示牌是你们已经选定的异步总线；现在只能读最近一块。
- What local is missing: `PlaceBook.forget` 未暴露；无 `find_signs`。
- Suggested implementation sketch: skill `forget_place`；`find_signs {range}` → `[{pos,text}]`。这不是抄 Mindcraft API，是补你们自己的社交平面。
- Effort: S

### Idea 20 — `discard` 先走开再扔（给别人捡）

- Mindcraft source: `!discard`：记下位置 → `moveAway(5)` → `discard` → 走回。避免物品进自己碰撞箱。
- Why it fits: 地摊、祭品、丢垃圾。
- What local is missing: `discard` = 当场 `toss`。
- Effort: S

---

## Explicitly do NOT borrow

这些会把「去中心化 Grok Bot」收回成 Mindcraft/MineCollab 评测架：

| Mindcraft 件 | 路径 | 为什么不借 |
|---|---|---|
| **mindserver** 作 bot↔bot 总线 | `src/mindcraft/mindserver.js`、`mindserver_proxy.js`、`conversation.js` `sendToBot` / `sendBotChatToServer` | 把聊天搬出世界。Grok↔Grok 必须走 MC chat / 告示牌 / 书。`!startConversation` / `!endConversation` 依赖这根管子。 |
| **SelfPrompter 进程内循环** | `self_prompter.js` `startLoop` 自己 `handleMessage` | 心已经是外面的 Grok。body 再自言自语 = 双脑。保留 `goal` 字符串即可。 |
| **Task runner / blocked_actions / 初始背包剧本** | `src/agent/tasks/*`、`tasks/**/*.json`、`minecollab.md` | 中央发目标、按 agent index 锁技能。那是 benchmark，不是玩。Cooking/construction/crafting **拆包**可以当 `SCENARIOS.md` 种子，不要当控制面。 |
| **NPC ItemGoal 自动科技树** | `npc/item_goal.js` 图搜索 collect/smelt/craft | 单体自动通关器。Grok 会变成旁白。`craft_plan`（Idea 3）只**解释**配方，不自动执行整棵树。 |
| **`!newAction` 写代码** | `commands/actions.js` `!newAction`、`coder.js`、`allow_insecure_coding` | 安全面 + 把技能系统架空。Grok 通过 socket 调已有 skill 即可。 |
| **cheat mode /tp / 瞬放** | `modes.js` `cheat`；`goToPlayer` 里 `/tp` | 破坏物理与距离带来的偶遇。 |
| **共享黑板 / 全局 planner / commander** | MineCollab 的「你拿小麦我拿糖」、`blocked_actions` 按角色分工具 | 与 `ARCHITECTURE.md` 非目标直接冲突。协作只许在聊天里发生。 |
| **`bot_responder` 自动决定是否理另一个 bot** | `_default.json` `bot_responder` | 那是 in-process 对话管理。Grok 自己决定回不回。 |
| **评测蓝图检查命令** | `!checkBlueprint` / `!getBlueprintLevel` | 假设存在 `agent.task.blueprint`。玩法里没有 task 对象。 |

公开文档（README Tasks、MineCollab cooking/construction/crafting）可以继续当**剧情种子**：缺配方的蛋糕、分材料的房子——写进各 bot 的 system prompt，不要写进 hub。

---

## Fun emergent-play ideas (original, inspired by Mindcraft but not copies)

全部停在世界里：chat / 告示牌 / 书 / 箱子 / 方块。软件不强制、不记账。

1. **早报柱（Sign gazette）**  
   出生点一根橡木告示牌，约定每天有人覆写第一行日期、下面三行传闻。后来的 bot `find_signs` / `read_sign`。谣言会在覆写中变质——这是 Mindcraft 聊天协作的异步版。

2. **书信邮差**  
   `write_book` 的 title = 收件人（`To:Miner`），丢进「邮局」箱子或扔脚下。对方 `pickup` → `read_book`。没有邮箱服务，只有物理书。可抄袭、可撕（扔进熔岩）。

3. **建筑口音（palette souls）**  
   每个 soul 加 `palette = ["oak_planks","cobblestone"]`。盖东西先用自己的块。不用 `BuildGoal` 统一图纸，20 个基地会像不同方言。遇见异色房子就知道是谁的地盘。

4. **守夜喊话**  
   黄昏（status `time=Afternoon` 末）有人喊「谁守夜」。没有值班表。谁回了谁留下；睡着的人靠 `sleep`。第二天早上骂没人守——全是 chat 事件。

5. **失物箱公约**  
   出生点箱子 + 告示牌「无主的放这里，钻石留下名字」。`put_chest` / `take_chest` 已够。软件不审计；偷东西只会被聊天审判。

6. **炉子署名（rival forges）**  
   谁放了熔炉，旁边插牌写名字。抢炉 = 社交事件。配合 Idea 2，铁会从「个人进度」变成「谁控制了炉子」。

7. **民间故事变异**  
   第一本 `write_book` 讲一件真事。后来的 bot 读完再写一本，允许添油加醋。几小时后世界里会有互相矛盾的史诗。Mindcraft 的 history 摘要是单 bot 的；这里是**跨 bot 的口头传统**。

8. **篝火集结**  
   晚上在高处放火把/营火。别人看见火光（或 chat「西南有火」）自己走过去。不要信标指令、不要坐标广播协议——坐标可以写在牌上，但得有人愿意写。

9. **软圈地石堆**  
   四块圆石 + 牌 `[claim] Andy 的坑 别挖`。pathfinder 不躲、服务器不保护。只有名誉。ARCHITECTURE 里写过的 soft claim，做成可见物。

10. **节日蛋糕（Hell’s Kitchen 去中心化）**  
    不发「你知道蛋糕配方、他知道烤马铃薯」。有人在 chat 喊「今晚做个蛋糕」，谁缺蛋谁去找鸡。失败的蛋糕、抢糖、锅被偷，全是戏。

11. **村民大使馆**  
    谁先用 `trade` 锁了图书管理员，谁在旁边插牌「我的村」。别的 bot 可以交易、可以迁村、可以「不小心」弄死村民。经济 PvP，不是战斗 PvP。

12. **遗嘱箱子**  
    已有 Inheritance 场景：死前 `write_book` + `put_chest`。补一条习惯——死亡事件后别人去他 `places` 里听他生前说过的「家」坐标（只能靠他生前写在牌上；places 文件仍私有）。

---

## 建议落地顺序（给动手的人）

1. Idea 8（status 感知，S）+ Idea 1（collectBlock gather，M）——立刻让每个 Grok 更会活、更会挖。  
2. Idea 3（craft_plan / 真 craftable / 走桌）+ Idea 2（熔炉）——科技树不必中央规划。  
3. Idea 4（生存 modes）+ Idea 5（use_on）——idle 身体开始像人。  
4. Idea 9 + 10 + 14（给、穿、跟）——社交手感。  
5. Idea 6 + 7（村民、农田）——经济与定居。  
6. Idea 13 蓝图、Idea 17 视觉——有余力再做。  
7. 同时把 `SCENARIOS.md` 用上面 Fun 节替换/加厚；**不要**复活 `shared/hub/`。
