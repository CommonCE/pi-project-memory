# M4 开发交接（尚未完整验收）

> 历史开发交接：保留当时的技术结论、验证范围与后续设想，不代表当前计划或执行授权。

- 项目：`当前仓库`；M1/M2/M3 已完成，M4 正在开发，不能宣布全部完成。
- 开工先看 `git status`，读 `AGENTS.md`、`.agents/DEVELOPMENT.md`；保留全部既有修改，代码/文档/测试均未提交。
- 按累计 64 KB/16 文件预算定点读；单次最多 200 行/8 KB，不整读大文件、不重复调查宿主源码。
- 主目标已更新：先读 `docs/next/m4-chemistry-goal.md`；计算化学自动生成/续接质量优先，矩阵不是唯一完成标准。其他依据：`docs/next/m4-quality-evaluation.md`、`eval/README.md`、`eval/m4-matrix.mjs`；历史验证见 `docs/testing.md`。
- M4 新增 `eval/m4-{fixtures,extraction,integration-fixtures,integration,offline,matrix,suite}.mjs` 与四个 `test/m4*.test.mjs`。
- 原三个 runner：提炼保真 24 案例/45 项；集成 21 案例/296 项；扩展 4 组/82 项；均为合成离线材料。
- 统一入口：`node eval/m4-suite.mjs --plan` 只列清单；`timeout 30s node eval/m4-suite.mjs` 顺序执行三个 runner。
- 当前统一执行 49 案例通过；13 行矩阵中 7 行固定夹具覆盖、6 行 partial；逐项证据与缺口以 matrix 文件为准。
- `offlineChecksPassed=true`；`plannedCoverageComplete=false`、`m4AcceptancePassed=false`、`qualityVerdict=unassessed`。
- `timeout 30s node eval/m4-suite.mjs --require-complete` 当前应返回 1：完整计划未覆盖，不是执行故障；默认返回 0 不等于 M4 完成。
- 统一门槛检查案例身份/顺序、分母、子检查 actual/expected、清理及非有限值；它不是安全认证或科学裁判。
- B1 原缺陷已修复：`src/v2-domain.mjs:boundedExcerpt`、`src/v2-store.mjs:searchV2`、`src/v2-working.mjs:buildWorkingContext`。
- 修复保留首尾、显示截断标记；excerpt 上限 1400、知识项 model-extraction 2048/其他 1600（UTF-16 code units）；准备样例 929 摘录加元数据为 1719，已据此调整单项预算，总预算不变，计入 JSON 转义，元数据不够则明确省略。
- B1 原失败金标保留且通过；新增 `test/v2-excerpts.test.mjs` 5 项；仍不保证任意中部或未选行完整，不自动升级验证/运行状态。
- 最新验证：Node v26.3.0；followup/实体背景/extraction/双场景 45/45，评测/统一门槛/原纵向/运行隔离 36/36；变更/新增 JS 语法检查通过。原 35/35、24/24、33/33、39/39 为历史组合结果。
- 上一 B1 阶段完整离线回归 270/270、约 11.1 秒；随后新增统一入口的 11 项测试，仅跑定向检查，未再次跑全量。
- 全测如需执行：设置 `PI_TEST_HOST_PACKAGE` 为已安装宿主的 package.json，再 `timeout 90s npm test`；不可加载付费/远程模型。
- 首个纵向 runner `eval/m4-chemistry-generation.mjs`（独立于统一门槛）已覆盖实际提炼 API→审核→存储→新 Node 进程；正例 56 项通过，assistant-only 合法负例被质量门槛拒绝，非真实模型或 Pi 会话验证。
- 已修复纵向发现的窄查询丢失：model-extraction 对完整正文作有界摘录；其他来源筛行不变。提示词补化学优先级，效果未由真实模型验证。`eval/m4-chemistry-scenarios.mjs` 已补准备未运行 49 项、方法修改后独立重跑现 90 项；误导标题/错误 run 引用负例失败，均为固定响应、显式身份锚点。现重跑 state 含体系+run，发现并修复 4 项串线失败：知识上下文优先活动 run，排除明确外来 run；搜索仍宽、历史不改。新增 6 项隔离回归及 missing-run 负例（缺失关联不能自动修复）。提炼实体 context 已补 800 字符背景，先脱敏再截断、background-only 不可 grounding；正例按背景而非预知 ID 选择（先 21 项失败，后 90/90），仍非真实模型评测。E2、Q2、P2 缺口已补。
- 有界真实模型合成测试已执行 5 次（另有 1 次请求前失败计额），额度耗尽；low、串行、30 秒/次、150 秒/批，总 42.328 秒。严格 2/5；引文 29/30、按 run 27/30；run-A 建议已选但未关联，详见目标文档，不是 Pi 续接或科学审阅。
- 新增 `eval/m4-chemistry-followup.mjs`、对应测试；准备 55 项、原失败运行 46 项，漏选/未关联/错关联负例有效。提示要求建议+原运行证据共同 grounding 并关联原运行；不猜 ID、不自动补关联或升级状态。提示后模型效果仍未测，下一步须新授权；先按目标文档，不重复宿主认证调查。
- C1/C2 目前只验证新 Node 进程恢复，未做实际离线 Pi 会话续接质量；涉及宿主行为时先按规则读对应宿主文档。
- v1/v2 对照仅同样显式写入的 8 组文本、共同 top-4/12000 字符预算，各恢复 15/15；不是抽取/生命周期等价或新版优越性结论。
- 独立人工语义审阅、完整负例/矩阵、文档去本地化仍未完成；追加真实模型/真实任务须重新授权，不以软件测试代替科研质量。
- 已获用户许可：仅在全新、结束后清理的临时沙箱内创建 `.pi-root`；仓库无该标记，不得创建或改真实项目标记。
- 不安装依赖、不改真实数据/用户设置、不提交推送、不改版本/默认入口/打包清单；真实评测、隐私清理与发布须独立授权。
- 默认仍是 `index.ts`；新版显式加载 `v2.ts`，不能同时加载；评测脚本是仓库开发用途，未纳入打包清单。
- 下一 session 提示：继续 M4，先按新目标文档选一个计算化学纵向生成/续接问题；matrix 用于回归，不为变绿扩展无关夹具，不重新做全仓探索或重复跑已完成评测。
