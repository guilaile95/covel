# prompt-play-narrator

Prompt Play 透传叙事引擎：`narrative-engine` capability 的直玩实现。

正文只有一行 `{{ world.lore }}`——世界包的 lore 就是用户上传的现成文游
Prompt 原文（不抽取、不改写、不摘要），因此模型收到的叙事指令与"把同一份
文本直接发给普通 AI Chat"等价。无工具、无 postHistory 输出规则、无人称/
字数/互动节点要求。

与默认 `narrator` 互为 `conflicts`，经 Covel 官方的叙事引擎切换机制启用
（透传世界包 `worlds/prompt-play` 的 `requiredPlugins` 引用本插件）。

设计背景见 `docs/dongfang/GATE_A_SPIKE.md`。
