# prompt-play-lite

透传会话（Prompt Play）专用的回合守卫插件。

`PreSchedule` 钩子把透传回合的主循环收窄到 `outputKind === "story"` 的运行时
（即 `prompt-play-narrator` 本体），剔除 character-tracker、guide、codex、
npc-graph 抽取器等全部后台生成 agent——目的是让"一份现成文游 Prompt 直接玩"
的每回合 LLM 调用与 Token 成本贴近普通 AI Chat。

识别方式是 capability 形态的：只有当本回合触发集合中出现
`prompt-play-narrator` 时才收窄；其他任何世界/会话走 no-change 快路径，
行为与原版 Covel 完全一致。Setup 阶段由框架强制保留，不受本钩子影响
（透传世界依赖各 setup 运行时自身的零 LLM 路径）。

测试：`pnpm vitest run`（含真实 `HookPipeline` + bootstrap/plugin-entry 注册
形状的管线级用例）。
