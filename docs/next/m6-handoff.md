# M5 → M6 交接与下一 session 提示词

> 历史开发交接：保留当时的技术结论、验证范围与后续设想，不代表当前计划或执行授权。

- 项目：`当前仓库`；M5 已完成本地隔离验收，M6 尚未实现。
- 历史验证：语法通过；M5 定向 12/12，存储/边界 30/30，隔离宿主全量 340/340，失败/跳过均 0；见 [测试报告](../testing.md)。本轮只写文档，未重跑。
- 已定 M5：schemaVersion 2；缺 scope 按根消费，缺 inherit 保留 path；字符集 A；根内链接取真实路径、拒绝逃逸；祖先召回与兄弟隔离。
- 原有实现与新增 v2 文件仍大量未跟踪；先看 git status，保留全部用户工作，不创建真实项目标记。
- 入口：[M6 设计起点](m6-card-plan.md)、[路线图](roadmap-v2.md)、[M5 契约](m5-folder-scope.md)、[ADR 0006](../decisions/0006-folder-scoped-memory.md)。
- 建议新开 session，只加载本摘要和下一步所需区间，不重复调查 M4；当前交接不授权提交、发布或真实模型验证。

## 可直接复制的提示词

```text
继续 当前仓库 的下一步 M6（计算化学卡片），先做契约设计，不立即编码。
先跑 git status --short，保留全部未提交/未跟踪文件；v2.ts 与 src/v2-*.mjs 仍未纳入 Git。
遵守 AGENTS.md 与 .agents/DEVELOPMENT.md 的读取预算；已注入规则不重读，读取前估体量，定点查符号。
先读 docs/next/m6-handoff.md、docs/next/m6-card-plan.md，再定点读 roadmap-v2.md 的 M6、m5-folder-scope.md 和 docs/testing.md 的 M5 节。
M5 上轮语法通过、定向 12/12、存储/边界 30/30、隔离宿主全量 340/340；这些是历史结果，不是本 session 验证。
目标：为 systems/methods/runs/results/diagnostics 设计可校验、带来源和限制的卡片，不只美化文本。
先按符号核对 v2-domain/store/working/folders、候选审核/提炼、CLI/工具与对应测试；不广读源码或重做 M4 矩阵。
先产出 M6 详细设计、拟改文件及测试顺序，解决旧记录兼容、schemaVersion 2 可保留性、unknown 与条件必填、运行引用、同性质冲突及显式替代。
现有 v2.run/result/实体引用/修订机制优先复用；不发明新接口、不自动迁移旧数据、不擅自决定科学字段默认值。
设计中的存储/兼容或科学语义决策请列出建议并等待我确认；确认后才逐任务失败测试→最小实现→定向回归。
必须保留 M5 的作用域隔离、目录页冲突保护、候选发布保真、首轮简报与 12000 字符预算；不改 v1 index.ts 或默认入口/版本/打包字段。
允许只读检查、文档编写；设计确认后允许约定范围的代码修改及隔离临时目录内本地单测。
不提交、不推送、不安装依赖，不修改 ~/.pi 或真实记忆包，不创建真实项目 .pi-root，不扫描真实计算目录，不调用远程/付费模型，不计算或提交作业。
实现验证：npm run check；新模块单独 node --check；M6 定向测试及 M5 回归；最后 PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" timeout 300s npm test。
不提前做 M7 迁移/整理或 M8 发布。若需扩大文件/操作授权，或契约与文档冲突，停下来说明并询问。
交付改动文件、实际命令和结果、失败/跳过/未验证项与下一步；合成夹具不证明科学有效性。
```
