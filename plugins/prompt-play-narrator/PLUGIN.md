---
name: prompt-play-narrator
displayName:
  zh: 直玩叙事
  en: Prompt Play Narrator
description:
  zh: 把世界lore原文（一份现成文游 Prompt）不加框架包装地直接交给模型主持，专为 Prompt Play 透传模式设计。
  en: Hands the world lore verbatim (a ready-to-play text prompt) to the model with minimal framing — the passthrough narrative engine for Prompt Play.
pluginType: plugin
stage: narrative
model: story
timeoutMs: 240000
callTimeoutMs: 120000
outputKind: story
capabilities: [narrative, prompt-play, narrative-engine]
tags:
  - role:narrator
  - cost:llm
trigger:
  type: auto
relations:
  provides:
    - narrative-engine
  conflicts:
    - narrator
    - chat-mode-narrator
---

{{ world.lore }}
