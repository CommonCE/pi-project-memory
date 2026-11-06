# M5 交接与开发提示词

> 历史开发交接：保留当时的技术结论、验证范围与后续设想，不代表当前计划或执行授权。

- 项目：`当前仓库`；M1–M3 已完成，M4 不扩展，M5 T1→T9 已实现（本地隔离验收），真实项目续接未验证。
- 本轮实现：domain/store/working/cli、`v2.ts`、新 `src/v2-folders.mjs`；最小扩展 `src/v2-extraction.mjs`，候选模块现有 normalizeEntry 已能保留 scope，无需修改。
- 最终验证：`npm run check`、新模块单独语法检查通过；M5 定向 12/12，存储/边界回归 30/30，带宿主路径的 timeout 300s 全量 340/340，通过、无跳过；细节见 `docs/testing.md`。
- 风险：`v2.ts`、`src/v2-*.mjs`、`eval/`、`docs/next/` 与 21 个测试文件未纳入 Git；`.pi-memory` 未进 `.gitignore`。开始编码前先确认基线归属。
- 已定语义：字符集 A；仅缺 inherit 保留 path；根内链接真实路径解析，拒绝根外逃逸；显式历史目录允许不存在但检查现存祖先；兄弟目录需 allFolders/显式实体引用。
- 已执行顺序：`m5-folder-scope.md` 第 8 节 T1→T9，逐任务失败测试→实现→定向验证，T3/T4 后全量回归；发现回归后补定向修复验证。
- 改动面：v2 领域/存储/工作/CLI/提炼、独立目录渲染模块、`v2.ts`、对应测试及文档；bin 复用现有 v2 路由，无新增修改；未改 v1 `index.ts`、package 默认入口/版本/打包字段。
- 关键约束：`schemaVersion` 保持 2，不迁移记录；派生页面只读；预算 12000 字符硬上限；缺 `scope` 必须当根，漏一处就是历史记忆丢失。
- 不提交、不推送、不改默认入口/版本/打包字段；不创建真实项目 `.pi-root`；不扫描真实计算目录；不调用远程/付费模型；不安装依赖。
- 真实模型复测、真实 Pi 会话续接、人工语义审阅与发布都在 M8，需单独授权。
- 已验证：隔离宿主/模拟上下文中的 session cwd、单次首轮注入与目录交接；含空格/中文目录派生页；并发/撤销/历史链篡改。未验证：真实项目/模型续接、大小写不敏感文件系统、跨挂载点及规模性能。

下一 session 入口：见 [M5 → M6 交接与可复制提示词](m6-handoff.md) 和 [M6 卡片设计起点](m6-card-plan.md)。先确认 M6 契约，不直接把规划当成已批准 schema。

## 原始开发提示词（历史，不代表当前未实现）

```text
继续 当前仓库 的 M5（文件夹作用域记忆）。先读 AGENTS.md、.agents/DEVELOPMENT.md，
再读 docs/next/roadmap-v2.md、docs/next/m5-folder-scope.md、docs/decisions/0006-folder-scoped-memory.md
和 docs/next/m5-handoff.md。先跑 git status，保留全部未提交/未跟踪文件：v2.ts 与 src/v2-*.mjs 尚未纳入 Git。

目标：按 m5 文档实现 scope {path, inherit}、祖先链召回、目录页与首轮简报，schemaVersion 保持 2，
旧记录缺省视为根目录。严格按第 8 节 T1→T9，每个任务先写失败测试再实现，不提前做 M6 卡片或重做 M4 矩阵。

范围：src/v2-domain.mjs、src/v2-store.mjs、src/v2-working.mjs、src/v2-cli.mjs、v2.ts、bin/* 与对应测试；
不改 v1 index.ts，不重构无关模块，不改默认入口/版本/打包字段。

验证：npm run check；node --test test/v2-scope*.test.mjs 等定向测试；最后
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}"
timeout 300s npm test。

授权：只读检查、临时目录内创建/清理、本地单测。不提交、不推送；不创建真实项目 .pi-root；
不扫描真实计算目录；不调用远程/付费模型；不安装依赖；不执行计算或提交作业。

若作用域语义、段字符集或召回默认与文档冲突，或需要扩大授权，停下来说明并询问。
交付：改动文件、实际执行的命令与结果、失败/跳过/未验证项、下一步。
```
