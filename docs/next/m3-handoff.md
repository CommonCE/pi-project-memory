# M3 完成交接

> 历史开发交接：保留当时的技术结论、验证范围与后续设想，不代表当前计划或执行授权。

- 项目：`当前仓库`；下一目标为 M4 质量评测与文档去本地化。
- M1/M2/M3 功能闭环已完成；默认入口仍是 `index.ts`，新版显式加载 `v2.ts`，不能同时加载。
- M3 契约：[使用文档](m3-usage.md)；计划：[memory-v2](memory-v2.md)；验证：[测试报告](../testing.md)。
- 核心：`src/v2-candidates.mjs`、`src/v2-extraction.mjs`；存储/领域/CLI/工作上下文沿用 `src/v2-*.mjs`。
- 宿主在 agent_before_settle 有界等待当前模型，每会话/用户范围至多一次自动尝试；失败不盲目重试。
- 项目默认 longTermMode=review，auto 须显式开启；extraction 可设更小预算；会话用 `/memory curate`。
- `/memory review [uuid [approve|reject]]`、`/memory extract` 已接通；人工审核不升级 verification。
- auto 同样保持 model-extraction/reported、run unknown、validity unchecked；不推翻人工拒绝。
- 只做抽取式文本 grounding，保存完整保留片段；不开放自由科学摘要或自动结构化数值。
- 实体/BM25、活动实体范围过滤、来源/完整内容去重均已接默认上下文；pending 不入知识召回。
- 审核决定、规范记录和视图是不同发布点；publication/projection pending 可恢复，不覆盖手工编辑。
- off/取消/作用域/策略变化在共享锁内和发布前复查；诊断及可用 usage 按会话/项目隔离。
- Node v26.3.0、Pi 1.4.0；完整离线回归 242/242 通过，无失败或跳过，约 10.7 秒。
- 已覆盖真实离线 JSON/print/RPC；M3 新增 69 项测试；语法/空白/链接/35 文件打包检查通过，未做 PTY/TUI、静态类型或真实科研质量评测。
- 本轮新增 `test/v2-m3.test.mjs` 和本交接；前两轮候选/提炼文件与既有用户 profile 改动均未提交。
- 读取默认已获用户授权改为累计 64 KB/16 文件；单次仍 200 行/8 KB，定点探索，不全仓扫描。
- 无 `.pi-root`，不要创建；不安装依赖、不调用远程模型、不动真实记忆/科学结果/用户设置。
- 未改版本、默认入口、仓库名或 Git 历史；公开前隐私清理与新历史发布仍待明确授权。

## 下一对话提示词

```text
继续 当前仓库 的 M4；M3 已完成，先读 AGENTS.md、.agents/DEVELOPMENT.md 和 docs/next/m3-handoff.md。
先看 git status，保留全部未提交改动，按预算定点读 docs/next/m3-usage.md、memory-v2.md 与 docs/testing.md。
先设计合成质量评测：计划/结果、失败/成功、同名多方法、多运行、pending 隔离、工作续接与召回覆盖；软件测试不等于科研质量。
上一轮完整离线测试 242/242；全测：PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" timeout 90s npm test。
不安装依赖、不调用远程模型、不创建 .pi-root、不改真实数据/用户设置、不提交推送；真实模型小样本、隐私清理与发布须另行授权。
```
