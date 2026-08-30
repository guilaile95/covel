---
name: prompt-play-lite
displayName:
  zh: 直玩轻编队
  en: Prompt Play Lite
description:
  zh: 透传会话专用的回合守卫——主循环只保留叙事引擎本体，剔除全部后台生成 agent，降低每回合调用与 Token 成本。
  en: Turn guard for passthrough sessions — keeps only the narrative engine in the main loop and drops all background agents to cut per-turn calls and tokens.
pluginType: plugin
outputKind: system
capabilities: [prompt-play-lite]
tags:
  - role:framework-lite
  - cost:function
entry: ./server/index.js
---

# Prompt Play Lite

仅当本回合的调度集合里出现 `prompt-play-narrator`（即透传世界）时生效：通过
`PreSchedule` 钩子把主循环收窄到 `outputKind === "story"` 的运行时（透传会话中
即直玩叙事本体）。Setup 阶段由框架强制保留，不受本钩子影响——透传世界的 setup
各运行时自身走零 LLM 路径（pregame 为纯函数、schema-gen 命中世界声明直写、
player-init 被 passthrough 守卫跳过）。

非透传会话不包含该叙事引擎，钩子直接放行（no-change fast path）。
