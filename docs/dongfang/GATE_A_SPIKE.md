# Gate A — Covel Prompt Passthrough Spike（实验说明与 A/B 手册）

> 分支：`dongfang/gate-a-passthrough`（基于锁定 commit `15f009d50d73ca985852bdb00322dcc721f56b6e`，即 covel v0.0.27）
> 状态：实现完成、本地可运行验证通过；**A/B 真实模型对比由 Owner 执行**（付费边界），数据回来后填 Gate 报告。
> 边界：不抽取、不改写、不摘要 Prompt；不做 World Import / provenance / 品牌换皮 / Gemini 原生 adapter；不迁移 ST 代码；失败不打补丁。

## 一、本 spike 改了什么（全部改动清单）

| 文件 | 改动 | 作用 |
|---|---|---|
| `plugins/prompt-play-narrator/`（新增） | 透传叙事引擎：`provides: narrative-engine`、`conflicts: [narrator, chat-mode-narrator]`，**无任何工具、无 postHistory 输出要求**，正文只有 `{{ world.lore }}` 一行 | 用 capability 冲突机制替换默认 narrator（同 haruka 切换 chat-mode-narrator 的官方先例），system prompt = 用户 Prompt 原文 |
| `plugins/prompt-play-lite/`（新增） | `PreSchedule` 钩子：透传回合把主循环收窄到 `outputKind === "story"` 的运行时（即叙事本体） | 剔除 character-tracker / guide / codex / npc-graph 等全部后台 agent（setup 阶段由框架强制保留，不归它管） |
| `worlds/prompt-play/`（新增） | 透传世界包：`requiredPlugins: [prompt-play-narrator, prompt-play-lite]`、excluded 全部非必要 agent、最小 `characterAttributes`（走 schema-gen 的声明直写零 LLM 路径）、**`WORLD.zh.md` = 《凡人修仙人生模拟器》原文（37894 字节，未动一字）** | 承载样本；世界声明本身触发各 setup 插件的零 LLM 路径 |
| `plugins/char-creator/runtimes/player-init/guard.js` | 新增 Branch 0：世界 `requiredPlugins` 含 `prompt-play-narrator` → 直接 `skip + preGameDone`（无 LLM、无创角表单） | 创角由透传 Prompt 自己主持；不新增 manifest 字段（strict schema 不动） |
| `apps/server/src/routes/api/bootstrap.ts` | `COVEL_MEMORY_UPDATES=off` → 不装配 memorySystem | Memory 关闭档：核心记忆块不注入（段 2 为空）、每轮不再有记忆重写 LLM 调用；保存/恢复不依赖 memory 系统。默认（不设或 `on`）保持 covel 原行为，供开/关对照 |
| `scripts/dongfang/turn-stats.mjs`（新增） | 只读 SQLite 统计：每回合 LLM 调用数、叙事 vs 后台各自动输入/输出 token、最慢运行时延迟 | 对比数据采集 |

未改：covel 框架核心（runtime/context/store/调度器）、三个旗舰世界、其他任何插件。预期行为：非透传世界的一切保持 covel 原样。

预期透传会话的每回合调用：**1 次**（直玩叙事）+ 0 次后台（memory off 档）；memory on 档 = 2 次（+记忆重写）+ 超长对话偶发 Compactor。

## 二、B 路径运行步骤（Owner：一键启动器）

只需要一个命令（PowerShell，在 `covel-spike` 目录下）：

```powershell
.\scripts\dongfang\start-gate-a.ps1              # Memory OFF 局（默认）
.\scripts\dongfang\start-gate-a.ps1 -Memory on   # Memory ON 对照局
```

启动器自动完成：残留端口清理 → 首次运行时引导你填 `llm.toml`（story slot 选**与 A 路径相同的模型**）和 `.env.llm`（只填 key，不进 Git）→ 按档设置 `COVEL_MEMORY_UPDATES` → 启动服务并探活 → 自动打开浏览器。

你要做的：

1. 浏览器里选世界 **直玩（提示词透传）** → 开始。
2. 预期：**不出现 covel 创角表单**，直接进入叙事；发「开始」后《凡人修仙人生模拟器》按其自身规则主持（出身/灵根等由 Prompt 流程决定）。
3. 自由游玩 ≥5 自然回合（不用固定台词、不为通过而 reroll）。
4. 保存/退出/恢复：直接关浏览器 → 重开 <http://localhost:5173> → 从会话列表继续同一局。
5. 回到启动器窗口**按回车**——自动按 session 采集调用/token/延迟到 `gate-results\`；两档（off/on）各跑一局。

若出现创角表单或明显框架化输出，保留 session id——那是 spike 的失败证据，不要绕。

## 三、A 路径（Owner）

把 `worlds/prompt-play/WORLD.zh.md` 全文原样粘贴到同一个模型的普通 Chat（Gemini/ChatGPT 网页或 API playground），发「开始」，同样自由玩 ≥5 回合。两路径用**同一模型、同一 temperature 相关设置尽量对齐**（普通 Chat 端用什么默认值，llm.toml 的 story slot 就配什么）。

## 四、数据采集

**启动器已自动采集**：每次按回车，本次运行创建的 session 统计自动写入 `gate-results\memory-<off|on>-<时间戳>\<sessionId>.txt`（含每回合调用数、叙事 vs 后台 token、延迟）。

手动备用（单独补采某个 session）：

```powershell
node scripts\dongfang\turn-stats.mjs <sessionId> [可选 db 路径]
```

输出每回合：LLM 调用数、直玩叙事 vs 后台的输入/输出 token、最慢运行时毫秒。dev 模式 SQLite 位于 `apps\server\data\covel.db`（找不到就把 db 路径作为第二个参数传入）。

## 五、Gate 报告（模板——实测后填写）

| 对比项 | A：普通 Chat | B：Covel passthrough（memory off） | B'（memory on，可选） |
|---|---|---|---|
| 按 Prompt 启动创角/游戏 | ☐ | ☐ | ☐ |
| 额外 covel 指令干扰（主观） | — | ☐ | ☐ |
| 数轮后主持风格变化 | ☐ | ☐ | ☐ |
| Prompt 规则持续有效 | ☐ | ☐ | ☐ |
| 保存/退出/恢复正常 | — | ☐ | ☐ |
| 每回合 LLM 调用次数 | 1 | （脚本数） | （脚本数） |
| 叙事调用 in/out token | （Chat 页面估算） | （脚本数） | （脚本数） |
| 后台调用 in/out token | 0 | （脚本数） | （脚本数） |
| 首轮/普通回合延迟 | （秒表） | （脚本数） | （脚本数） |
| Memory 开关体验差异 | — | ☐ | ☐ |

**判定（PM 规则）**：PASS = B 体验不明显劣于 A 且额外调用/Token 可接受 → 停止，等 PM 确认 covel 为产品主仓。FAIL = 需保留大量框架 Prompt / 明显主持风格污染 / 连续性需付出不合理后台成本 → 停止，报告根因，不围绕 covel 打补丁。

## 六、已知边界（实测时留意）

- 框架前言（[LANGUAGE]/[COMPLETION] runtime-done 工具契约）是 agent 循环的机制性存在，透传插件无法去除——它对主持风格的实际影响正是本轮要测的。
- lore 是否被 token 预算裁剪：37KB ≈ 1.9 万 token，常见模型窗口足够；若 stats 显示叙事输入 token 明显小于 Prompt 体量，说明发生裁剪，属失败证据。
- covel 历史注入为全量+预算丢弃（保最近 2 个玩家回合），与普通 Chat 的窗口行为接近但不完全等同。
