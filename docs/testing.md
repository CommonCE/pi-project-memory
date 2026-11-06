# 测试报告

以下按阶段保留历史验证记录，不代表公开前清理会话重跑了这些检查；本轮清理结果见
[公开前审计](next/publication-audit.md)。文中的个人安装路径已通用化：复现前将
`PI_TEST_HOST_PACKAGE` 设置为已确认存在的 Pi 宿主 `package.json` 绝对路径，
`PI_PROJECT_MEMORY_REPO` 设置为当前 checkout 的绝对路径；原测试版本、结果与限制保持不变。

## P1：小规模隔离验收与局部缺陷收敛

本轮仅 P1：新增 `test/p1-acceptance.test.mjs` 三条短流程，复用既有保存/候选/审核/搜索/上下文/修订，不扩展 M4。计划、指标、问题优先级及限制见 [P1 验收](next/p1-acceptance.md)。P0 历史结果没有当成本轮通过证据；当前代码定点核对并重跑简报/卡片集成基线 12 通过、0 失败、1 宿主适配跳过，未发现阻塞本地 P1 的缺口。

先失败后修复：开发和集群流程各缺失 1 项完整适用条件（3/4）。`src/v2-working.mjs` 的 `contextState` 在简报截短 blocker 后仍仅引用简报，导致完整状态信息未注入。最小修复在简报无法容纳 blocker 时补回有界状态详情，未提高上下文预算。初始 kind/nextSteps 来源与 scope 设置错误属于夹具问题，已按既有契约修正，不作为产品缺陷。

最终指标：科研恢复 6/6，注入/简报 4487/559；开发 4/4，1878/368；集群 4/4，1952/377（均为 UTF-16 code units）。科研低预算上下文 982/1000，有省略提示且结果 JSON 未注入，检索已命中，明确归为上下文省略。开发/集群各 3 个候选、1 次幂等重试、3 次审核、1 拒绝、0 待审；语义重复率及人工阅读耗时未测。模型调用成本/token 未测，不记零。

实际执行（Node.js v26.12.1；未设置 `PI_TEST_HOST_PACKAGE`）：

```bash
# 基线
node --test test/v2-brief.test.mjs test/v2-card-integration.test.mjs
# 新用例先运行失败，随后最小修复并定向回归
node --test test/p1-acceptance.test.mjs
node --check src/v2-working.mjs
node --check test/p1-acceptance.test.mjs
node --test test/p1-acceptance.test.mjs test/v2-brief.test.mjs test/v2-scope-context.test.mjs test/v2-working-run-scope.test.mjs test/v2-card-integration.test.mjs test/v2-candidates.test.mjs
```

最终 **44 项：43 通过、0 失败、1 跳过**；两项语法检查通过。跳过为 M6 TypeBox 宿主适配器；未跑全量、宿主进程、TUI、P0 生命周期适配或真实会话。测试包写入新临时目录并清理，测试日志保留在新 `/tmp/pi-p1-*` 目录，不改真实记忆/科学产物或本仓库标记。没有安装依赖、计算、提交作业、Git 提交或推送。

验证层次：确定性夹具本轮通过；本地宿主适配跳过；真实 Pi 会话、真实模型、真实项目与人工科学审阅均未验证。合成磁盘重载不是 Pi 跨会话，人工构造候选不是模型提炼；无科学有效性结论。授权范围内 P1 完成，不具备以真实使用证据进入 P2 的依据，不自动启动后续阶段或发布。

## P0 / M7 收尾：Pi 简报、身份资格与合成续接（历史阶段）

本轮仅完成 T1–T3，不开展 P1–P4。`v2.ts` 新增 `/memory brief`，复用共享只读生成器；简报资格由仅 session 改为 session、项目 ID/root/memory、规范化 cwd，未启用项目时清除旧资格。保留 1200 / 12000 UTF-16 code units、固定来源、单位、未知/失败限制、候选发布和手改保护；未修改 schema、v1 默认入口、版本或打包字段。

测试先行：先观察手动命令不存在、目录/项目身份切换及离开项目再切回漏简报的失败，再做最小实现。最初两项无简报断言误假设空上下文必有 message，已修正为接受 undefined；不把这类夹具错误当产品缺陷。取消 switch/fork、失败后重试首轮资格核对已通过，无需另改。T3 复用已有写入/检索/修订能力，新增合成闭环断言，未为了测试人为修改已有正确行为。

新增 6 项生命周期测试覆盖：手动 brief 与生成器一致、UI/非 UI 返回、禁用/拒绝参数/零写入/首轮资格；目录/项目切换和切回、规范化别名、离开项目再返回；取消 switch/fork 与成功 new/resume/fork 后重置；生成失败后重试；旧目录轮次不写新目录与 compaction 归属；保存体系/方法/失败运行/带 eV 单位的实际零值→检索→模拟新会话继续→显式纠正到修订 2，固定失败 run 修订及所有旧权威记录字节不变。

新增 1 项真实离线宿主测试：Print 与 RPC 命令分派到 `/memory brief`，确认 JSON 内容、1200 上限、无模型请求及包内容不变。宿主 API 依据本机 `docs/extensions.md` 的 registerCommand、sendMessage、ctx.hasUI、before_agent_start 和 session 生命周期章节，并核对 `examples/extensions/pirate.ts`、`confirm-destructive.ts`；未读宿主源码。

实际执行（均为本轮，不借用下面历史结果）：

```bash
# 先失败、后最小实现通过；亦运行过身份切换单项失败检查
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" node --test test/v2-lifecycle.test.mjs
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" node --test --test-name-pattern='M7 real' test/v2-host.test.mjs
npm run check
node --check test/v2-lifecycle.test.mjs
node --check test/v2-host.test.mjs
# 最终受影响定向回归
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" node --test test/v2-lifecycle.test.mjs test/v2-host.test.mjs test/v2-brief.test.mjs test/v2-scope-context.test.mjs test/v2-working-run-scope.test.mjs test/v2-card-integration.test.mjs test/v2-candidates.test.mjs
```

结果：语法检查通过；最终定向回归 **66 通过、0 失败、0 跳过**（含本轮新增 7 项）。卡片集成重跑了固定来源、候选保真和手改保护。因实现仅涉及 v2 宿主装配和简报资格，未扩大到全量测试。宿主进程使用临时 HOME/agent 和隔离 offline provider，不连接真实模型；工具回调夹具使用宿主 jiti/TypeBox 加载，但不是完整 TUI 验收。

未验证：真实 TUI 目录切换/取消事件时序、真实项目续接质量、真实模型输出及人工科学有效性。未执行计算、提交作业、安装依赖、提交或推送；未创建本仓库 `.pi-root`，不修改真实记忆包、`~/.pi` 或计算产物。仅在新临时目录测试并清理。P0 本地完成不等于真实使用验收通过，后续需另行授权。

## 简化 M7 T1：共享简报入口与 CLI（历史阶段记录，已由上节收尾）

按简化路线先补最小只读入口，不开发迁移、审核过滤或冲突管理。新增 `readBriefV2` 与 CLI `v2 brief [--folder <rel>]`，复用首轮 `folderBrief` 生成器；自动注入行为不变。Pi `/memory brief`、目录身份修正及完整续接闭环尚未完成。

新增 `test/v2-brief.test.mjs` 的 5 项先观察缺失函数/命令失败，再通过最小实现。覆盖与首轮内容一致、继承和兄弟隔离、历史目录、空项目、禁用不初始化、非法参数/根外链接、Unicode 预算及文件清单/内容不变。

实际执行：

```bash
node --check src/v2-working.mjs
node --check src/v2-cli.mjs
node --check test/v2-brief.test.mjs
node --test test/v2-brief.test.mjs test/v2-scope-context.test.mjs test/v2-working-run-scope.test.mjs
node --test test/v2-card-integration.test.mjs
```

结果：目标语法通过；简报及作用域定向 **14/14 通过**；卡片集成 **7 通过、1 跳过**（未设置 `PI_TEST_HOST_PACKAGE`，宿主 TypeBox 适配器未执行），均无失败。测试只使用临时目录。未跑全量、真实 Pi/TUI、真实模型、真实项目或科学有效性验收；没有创建本项目标记、操作真实记忆包或迁移数据。


## M6 T4–T6：渲染、入口适配与合成纵向（本地契约完成）

在 T1–T3 的基础上新增 `src/v2-card-views.mjs` 和 8 个集成用例；更新 store/folders/working 的派生视图和摘要，以及 v2.ts 的可选卡片参数。TypeBox 结构由同一字段/类型表生成，最终发布条件仍由存储裁决。契约、兼容与使用示例见 [M6 卡片](next/m6-cards.md)，决策见 [ADR 0007](decisions/0007-computational-chemistry-cards.md)。

测试先行：首先观察新渲染模块缺失；接入 T4 后观察工具 schema 未包含 card 的失败，再补 TypeBox 参数。旧生成页升级与手改保护、固定失败来源与后续来源更新、目录页摘要、上下文预算、CLI 及保存工具适配器均通过。T6 增加共享体系/方法→失败零值→未确认假设/未运行建议→不同 ID 重跑→旧新结果与目录隔离的合成纵向；没有执行实际计算。新增 M6 用例累计 38 个。

实际执行：

```bash
npm run check
node --check src/v2-cards.mjs
node --check src/v2-card-publication.mjs
node --check src/v2-card-views.mjs
node --check src/v2-folders.mjs
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" node --test test/v2-card*.test.mjs test/v2-excerpts.test.mjs test/v2-store.test.mjs test/v2-boundaries.test.mjs test/v2-concurrency.test.mjs test/v2-candidates.test.mjs test/v2-scope*.test.mjs test/v2-folder-views.test.mjs
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" timeout 300s npm test
```

结果：语法检查通过；M6/摘录/存储/候选/M5 定向 **114/114 通过，失败 0、跳过 0**；隔离全量 **378/378 通过，失败 0、跳过 0**，约 13.9 秒。无卡片旧视图保持原输出；旧卡片 JSON+文本页可升级，手改页拒绝覆盖。卡片结果的 resultRun 固定到来源修订，sourceRun.latestRun 另示更新；旧无卡片结果的 resultRun 语义不变。

证据层次：工具用例使用宿主实际 TypeBox、Node 类型剥离加载的临时扩展副本和本地注册捕获器，执行真实 save 工具函数并验证共享错误；这不是实际 Pi 工具参数验证器的完整逐卡片对话。全量仍运行既有离线宿主用例，但不能外推新增卡片在真实 Pi 会话的交互质量。合成纵向只证明存储/关联/限制/召回保真，不证明引文真实性、科学有效性或模型来源选择。

未验证：真实模型选择、真实项目续接、逐卡片真实 Pi 交互、TUI 人工可读性、人工科学审阅及大规模性能。没有安装依赖、修改真实设置或记忆包、创建本项目标记、提交/推送、调用远程模型或执行计算/调度器。最后仅同步文档，不为纯文档更新重跑全量。

## M6 T1–T3：卡片结构、条件与存储保护（阶段历史）

范围：新增 `src/v2-cards.mjs`、`src/v2-card-publication.mjs`；在 domain/store/candidates 接入可选 card、条件校验、固定修订引用、全局同性质冲突、显式修订及候选防降级。契约见 [M6 卡片](next/m6-cards.md)。schemaVersion 保持 2，旧无 card 记录不补字段、不回写；不保证旧代码读取新卡片。本阶段验收时 T4–T6 尚未完成，当时不能声称固定卡片渲染、来源更新警告或 Pi 工具参数已可用；后续结果见上节。

测试先行：T1 和 T2 分别先观察新增模块缺失的失败；T3 接入前新增存储测试 9 失败、1 通过，主要失败为 entry.card 尚未获支持，再接入最小实现。新增测试最终为 30 个（结构 12、条件 6、存储 12）。

覆盖：五类字段、unknown/not-applicable/省略/null、零值与非有限值、精确摘录保留、来源定位符归属、来源不等于科学认证、UTF-8 字节上限、不可变旧历史、引用缺失/错误 kind/不存在修订、实际旧重复记录保留、单位不能绕过冲突、兄弟目录全局冲突、生命周期激活、幂等重试、并发写入、卡片不可隐式删除及候选禁止覆盖卡片。所有写入均在新建临时目录。

实际执行：

```bash
npm run check
node --check src/v2-cards.mjs
node --check src/v2-card-publication.mjs
node --test test/v2-cards.test.mjs test/v2-card-conditions.test.mjs test/v2-card-store.test.mjs
node --test test/v2-card*.test.mjs test/v2-store.test.mjs test/v2-boundaries.test.mjs test/v2-concurrency.test.mjs test/v2-candidates.test.mjs test/v2-scope*.test.mjs test/v2-folder-views.test.mjs
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" timeout 300s npm test
```

结果：语法检查通过；最终新增测试及存储/候选/M5 定向回归 **99/99 通过，失败 0、跳过 0**。隔离宿主全量 **370/370 通过，失败 0、跳过 0**，约 14.3 秒。全量涵盖新增 30 个用例及原有 340 个用例，不把 M5 历史通过数当成本轮结果。测试报告最后补写不影响运行代码，未为纯文档追加重跑全量。

未验证/限制：T4 的可读渲染和来源更新提示、T5 的 TypeBox 卡片参数与完整入口验收、T6 的 M6 合成化学纵向；真实模型选择、真实项目续接、TUI 人工审阅与科学有效性均未验证。来源检查不访问定位文件、不证明引文真实；性质身份使用显式字符串，不识别所有科学同义词。未提交/推送、未安装依赖、未修改用户设置或真实记忆包、未创建真实项目标记、未执行真实计算或调度器操作。

## M5：文件夹作用域与首轮简报

范围：T1→T9；scope 校验/真实路径、祖先链过滤及局部 df、目录排序、工作事件/最近目录 state、首轮简报与预算、hash 目录页/缓存重建/冲突、CLI/工具、自动候选提炼及审核作用域、化学合成纵向、并发和历史链篡改。schemaVersion 保持 2，无旧记录回写，不改默认入口。

测试先行记录：各任务先观察缺函数/缺字段/未过滤/路径逃逸等失败，再实现。T9 文档契约先失败再同步。
T3 后全量 328/328、T4 修正后全量 330/330、T6 初步集成全量 333/333；均使用隔离的本地 provider，不访问真实模型。
T4 回归曾发现预算挤压下的部分 JSON/尾部丢失问题，已修复；T6 首轮简报暴露离线 provider 将注入参考消息误当用户请求的问题，测试 provider 已修正请求选择。

已执行命令（完整输出仅保存在临时日志，不作为项目事实源）：

```bash
npm run check
node --check src/v2-folders.mjs
node --test test/v2-scope*.test.mjs test/v2-folder-views.test.mjs
node --test test/v2-boundaries.test.mjs test/v2-concurrency.test.mjs
node --test test/v2-store.test.mjs test/v2-boundaries.test.mjs
node --test test/v2-scope-extraction.test.mjs test/v2-extraction.test.mjs test/v2-candidates.test.mjs
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" node --test test/cli-e2e.test.mjs test/v2-lifecycle.test.mjs
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" timeout 300s npm test
```

最终验证：`npm run check` 与新渲染模块单独 `node --check` 均通过；M5 定向 12/12；存储/边界回归 30/30；带宿主路径的 `timeout 300s npm test` 为 **340/340 通过，失败 0、跳过 0**，约 13.6 秒。最终全量曾检出无标记 save 的错误码回归（invalid-scope 替代 scope-changed），已在目录解析前恢复项目有效性检查，并重跑上述回归与全量通过。

局限：真实模型选择、真实项目续接、TUI 人工可读性审查、大小写不敏感文件系统、跨挂载点与大规模性能未验证。合成化学记录只验证目录隔离、四轴原值/单位与零值保真，不证明计算有效。未进行 Git 提交/推送、依赖安装、真实项目标记创建、真实计算目录扫描或计算/调度器操作。

## M4 恢复建议：区分漏选与已选但未关联

本轮真实模型小样本（改提示前）为 `openai / gpt-6.1-sol`、`openai-responses`、`low`：5 次合成输入均返回 HTTP 200，严格通过 2/5；引文覆盖 29/30，按运行作用域覆盖 27/30。另一次请求前失败也计入额度，当前已无剩余额度。仅验证低层选择，不是 Pi 续接或科学计算。
准备场景漏选建议限定一次；失败运行的恢复建议两次均已选出但未关联原运行，不能将后者记成文本遗漏。详细范围与耗时见 `docs/next/m4-chemistry-goal.md`。

生产改动仅加强 `EXTRACTION_PROMPT`：保留未采纳/未运行及权限限定，运行专属建议与显式原运行证据共同 grounding、关联原运行，不猜测新运行；身份含糊仍保留空引用。无 schema/CLI/存储契约变更，不自动绑定或提升科学状态。
新 `eval/m4-chemistry-followup.mjs` 使用重建的合成固定响应，经实际提炼 API→pending→批准→宽/按 run 查询→新 Node 进程恢复。准备正例 **55 项**、原失败运行正例 **46 项**；漏选、未关联、错误关联均通过文本校验/审核但被质量门槛拒绝。未关联负例的候选/知识/宽查询仍保留建议，单独暴露作用域缺口。

实际执行（Node v26.3.0）：
- `node --check`：`src/v2-extraction.mjs`、新 runner、新测试及 `test/v2-extraction-context.test.mjs` 通过。
- `timeout 30s node --test --test-reporter=dot test/m4-chemistry-followup.test.mjs test/v2-extraction-context.test.mjs test/v2-extraction.test.mjs test/m4-chemistry-scenarios.test.mjs`：**45/45 通过**。
- `timeout 45s node --test --test-reporter=tap test/m4-evaluation.test.mjs test/m4-suite.test.mjs test/m4-chemistry-generation.test.mjs test/v2-working-run-scope.test.mjs`：**36/36 通过**，无跳过。
- 首次小检查曾因新“含糊建议”测试缺少最新用户回合而失败；补上不提供运行身份的用户回合及正确消息索引后，以上定向检查通过，未改生产过滤规则。

本轮开发没有追加真实模型请求；没有执行全量测试、真实宿主/TUI、真实记忆写入或科学计算。提示后的模型改善仍未验证，固定响应/提示文字不能替代该层。新 runner 不计入旧 49 案例矩阵，也不提升 M4 完成状态。

## M4 提炼实体背景：移除同名运行正例的预知 ID 依赖

- 确认生产缺口：提炼实体原来只有 id/revision/kind/title，同名 run 无法仅凭这些字段与材料路径对应；固定适配器事先知道金标 ID，不能证明真实输入足够区分。
- 将重跑适配器改为消费实体 context 选择 run，金标 ID 只用于核对、不作为正例响应选择来源。增加两项背景可区分性检查后为 90 项；补生产背景前 **21 项失败**，补充后 **90/90**，未删旧事实或降低限制。
- `src/v2-extraction.mjs` 为显式选定 current 实体提供可选 context，由已有正文及 run 元数据生成，最多 **800 UTF-16 code units**，标记 background-only/truncated；不读引用路径或额外文件。未选实体不发送。
- 身份元数据兼容原格式；`buildExtractionEnvelope` 的可选输入 context 为字符串，输出为带 source/text/truncated 的对象。持久化 schema/CLI/默认入口不变，提炼 envelope 多一个可选字段。
- 敏感检查先覆盖完整源再截断；敏感/超长描述可省略并保留安全身份。非字符串不静默强转；总序列化预算不变，原有证据、身份和任务背景先占预算，省略/截短描述有 entity-context-truncated 计数。
- 实体 context 不属于 evidence：不能用实体 ID 或当前 m0 冒充背景引文，也不能从背景借标题、复制正文、结构化运行状态或数值结果。提示仅作身份选择指导，不是模型行为保证。
- 新增 `test/v2-extraction-context.test.mjs` **5 项**：同名背景区分及 grounding 隔离、截断前隐私、严格类型/源上限、Unicode/JSON/身份与任务预算优先级、实际提炼 API 的当前显式记录与未知科学状态。错/漏 run 引用负例仍须失败。
- 四个变更/新增 JS 模块语法检查通过。
- `timeout 30s node --test test/v2-extraction-context.test.mjs test/v2-extraction.test.mjs test/m4-chemistry-scenarios.test.mjs`：**35/35**，无失败/跳过。
- `timeout 30s node --test test/m4-suite.test.mjs test/m4-chemistry-generation.test.mjs test/v2-working-run-scope.test.mjs`：**24/24**，无失败/跳过；保留旧统一门槛，准备样例仍 49 项。
- 仅证明固定消费者看到足够身份线索和背景不自动成为新证据；未测真实模型自动关联、实际 Pi 会话或真实科学材料，未跑全量回归。无科学计算/提交、依赖安装或用户设置修改；M4 仍未验收完成。

## M4 活动运行隔离：体系/方法与 run 混合状态

- 加强现有重跑纵向样例：两个诊断共享体系身份，活动 state 同时提供体系 + 当前 run；不再用仅 run ID 的状态绕过宽实体召回。
- 复现：原 88 项检查中 4 项失败，分别为两个运行的外来能量/记录排除；候选、批准、显式查询及其他事实仍通过，未降低金标。
- 修复 `src/v2-working.mjs`：识别显式选定的已知 run，额外执行一次限 8 项的 run 优先搜索，与原宽检索合并去重，防止同体系历史占满候选窗口；仍最多纳入 4 项，字符预算不变。
- 知识筛选以 run 记录自身 id、数值的 result.runId 为准，其余按显式 run 引用判断。明确属于其他 run 的记录排除；共享背景、多个显式选定 run 及包含活动 run 的跨运行诊断仍可入选。没有选 run 时保持宽召回。
- 显式 search CLI/API、schema、存储和科学状态不变；只改变知识上下文选择顺序/范围，不改工作历史或推断未提供的实体关系。同名实体不自动视为同一实体。
- 新增 `test/v2-working-run-scope.test.mjs` 6 项：混合活动实体与共享背景、权威 run/result 关联、同名体系、多 run/体系宽查询、16 条历史挤占前八项、显式跨 run 诊断；包含数值 0、Ha、unknown/unchecked、完整 JSON、预算及旧记录不变检查。数值证据文件均在临时沙箱实际创建。
- 新增 missing-run 合法负例：模型只关联体系而漏掉 run 时，grounding/批准仍可通过，但关联、查询和上下文金标必须失败；不能将召回修复宣称为生成关联已自动可靠。
- 四个变更/新增 JS 模块语法检查通过。
- `timeout 30s node --test test/v2-working-run-scope.test.mjs test/m4-chemistry-scenarios.test.mjs`：**14/14**，无失败/跳过；纵向正例准备 **49/49**、混合状态重跑 **88/88** 检查通过。
- `timeout 30s node --test test/v2-working.test.mjs test/v2-excerpts.test.mjs test/m4-chemistry-generation.test.mjs test/m4-suite.test.mjs`：**38/38**，无失败/跳过，含原 49 案例及 strict 门槛。
- 未跑全量回归、真实模型或实际 Pi 会话质量；原矩阵仍 7 行固定夹具/6 行 partial、M4 未完成。全程合成材料、新临时目录与固定响应，无科学计算/提交或用户配置修改。

## M4 纵向扩展：准备未运行与修改方法后独立重跑

新增 `eval/m4-chemistry-scenarios-fixtures.mjs`、`eval/m4-chemistry-scenarios.mjs` 与 7 项测试，复用原纵向 runner 的有界新进程恢复函数。
- 准备场景：8 项来源事实在候选/发布/查询/上下文四层核对；输入写入不升级执行、收敛、有效性或用户权限；结构化 run 保持 unknown/unchecked，无 result，也不生成 output.log。
- 方法重跑：旧失败与新报告经两个独立回合提炼，同标题记录不合并；核对方法变更、各自路径/能量/单位/失败或有效性限制、旧记录完整不变、显式 run 关联及活动上下文排除另一运行。
- 独立运行锚点及活动身份由夹具明确提供，不验证模型自动识别实体。科学状态和数值保留为带来源文本，不生成结构化 result，也未执行真实重跑。
- 两个合法负例：从“No calculation has run”取肯定子串标题；交换已提供 run 引用。均可 grounding/批准，但必须被质量门槛拒绝；不是生产语义校验已能自动拒绝它们。
- 首轮准备正例失败：摘录 929 UTF-16 code units，加来源/运行元数据后 JSON 为 1719，超过单项 1600，丢失 7 项上下文事实。保持金标不变，修复后准备 **49/49**、重跑 **88/88** 项通过。
- 生产调整 `src/v2-working.mjs`：仅 model-extraction 的单项 JSON 上限改为 **2048**；其他来源 **1600**、excerpt **1400**、最多四项及总上下文预算不变。较大项可能挤占后续项；预算不足仍截断或明确省略，无 schema/存储迁移。
- 新增回归覆盖完整短摘录、普通来源仍 1600、1000–12000 总预算、完整 JSON 及 unknown/unchecked 保留。
- 六个变更/新增 JS 模块语法检查通过。
- `timeout 30s node --test test/m4-chemistry-scenarios.test.mjs test/v2-excerpts.test.mjs test/m4-chemistry-generation.test.mjs`：**19/19**，无失败/跳过。
- `timeout 30s node --test test/v2-working.test.mjs test/m4-suite.test.mjs`：**26/26**，无失败/跳过；含旧 49 案例及 strict CLI 返回 1。
- 新场景独立于旧矩阵入口，不改变其 7 行固定夹具/6 行 partial 分类或 M4 未完成状态。未跑全量、真实模型或实际 Pi 会话质量；仅新建清理临时沙箱，无提交/计算/用户设置修改。

## M4 目标调整：计算化学生成与续接纵向样例

主目标及验收层次见 [M4 开发目标](next/m4-chemistry-goal.md)，不再以矩阵变绿代表实际记忆质量改善。
- 新增 `eval/m4-chemistry-generation.mjs` 和 5 项单测：实际提炼 API → pending → 批准 → 查询 → 新 Node 进程恢复；固定响应，不调用真实模型。
- 10 项独立来源事实在候选、发布知识、查询和上下文四层核对；状态只写最小继续目标，不复制金标答案。合法 assistant-only 响应仍可入队/批准，但质量门槛必须失败。
- 首次检查失败：SCF 窄查询遗漏恢复假设、40→80 参数、未采纳/未重跑及下一步限制。修复后保留原金标，正例 56 项通过，负例仍失败，沙箱均清理。
- 生产修复：`model-extraction` 记录按完整正文构造有界 excerpt，避免先按关键词/七行过滤掉互补来源；其他来源保持原筛选。1400 UTF-16 code units、截断标记及上下文预算不变，仍不保证长正文所有中部事实。
- 提炼提示新增化学来源选择优先级（体系/方法/软件版本、电荷/自旋、路径、单位、失败能量限制及未执行建议）；不改变 JSON/schema，也不表示真实模型效果已经验证。
- 五个变更/新增 JS 模块 `node --check` 通过。
- `timeout 30s node --test test/m4-chemistry-generation.test.mjs test/v2-excerpts.test.mjs test/v2-extraction.test.mjs`：**33/33**，无失败/跳过。
- `timeout 30s node --test test/v2-store.test.mjs test/m4-suite.test.mjs`：**33/33**，无失败/跳过；含旧 49 案例统一执行与 strict CLI 返回 1。
- 新纵向 runner 独立于原矩阵门槛；原矩阵仍 7 行固定夹具覆盖、6 行 partial，M4 未完整验收。报告提供夹具和明确源码摘要，不是完整依赖锁定。
- 未跑全量回归、实际 Pi 会话续接质量或真实模型选择评测；默认仍旧入口，没有扫描真实计算目录、安装依赖或运行/提交科学计算。下方保留历史结果。

## M4 阶段：P2 多来源成功声明对照

本轮仅补 P2 的矛盾助手声明/工具输入写入对照，未改生产代码或公共契约。
- 保留原工具正文与 unknown 限定金标，新增前置助手成功声明及独立来源金标；固定候选引用两者。
- 判分新增完整来源与定位/正文绑定、来源顺序检查；反转 grounding 数组仍恢复原顺序，交换来源标签或仅选择助手成功声明均被判分器拒绝。
- 来源事实可显式指定 sourceIndex；越界、空值或事实不属于指定来源时拒绝金标。默认仍关联主来源。
- 首轮统一测试失败：共享 v1/v2 对照仍只装配单来源正文，遗漏新增助手事实。修复为两版显式写入相同完整多来源文本；未删除金标或放宽断言。
- 七个变更 JS 模块的 `node --check` 通过。
- `timeout 30s node --test test/m4-evaluation.test.mjs test/m4-offline-evaluation.test.mjs test/m4-suite.test.mjs`：**32/32**，无失败/跳过。
- 提炼 **24 案例 / 45 项**；显式文本 v1/v2 对照各恢复 **15/15**；统一测试含 49 案例执行及 strict CLI 返回 1。
- 矩阵现为 **7 行固定夹具覆盖、6 行 partial**；M4 完整覆盖和验收仍 false，质量 unassessed。
- 这是固定响应保真测试，不验证模型能自行选择正确材料或判断科学有效性。未跑全量回归、真实模型或宿主会话质量；下方保留历史记录。

## M4 阶段：Q2 unresolved 发布标记

本轮仅补 Q2 的 unresolved 缺口，不改生产代码或公共契约。
- 在原 reported/恢复发布/归档场景后，分别以 user 和 auto 批准独立 unresolved 候选；核对发布记录、查询身份、来源和 unknown/unchecked 运行状态。
- 查询保留 `verification=unresolved` 及 `requiresVerification=true`；知识上下文按身份选中记录并保留待核实标签，覆盖 plain/before/after。
- 统一门槛新增 16 项具名检查；改名隐藏任一 reviewer 的上下文标签会使门槛失败。
- 五个变更 JS 模块的 `node --check` 通过。
- `timeout 25s node --test test/m4-integration-evaluation.test.mjs`：**8/8**，runner **21 案例 / 296 项**。
- `timeout 30s node --test test/m4-suite.test.mjs`：**13/13**；包含 49 案例统一执行及 strict CLI 返回 1；均无失败/跳过。
- 矩阵现为 **6 行固定夹具覆盖、7 行 partial**；完整覆盖与 M4 验收仍 false，质量 unassessed。
- auto 仅指直接调用批准接口的 reviewer，不是实际自动提炼/宿主会话质量验证。未跑全量回归、模型或科学计算；沙箱均新建并清理。下方保留历史记录。

## M4 阶段：E2 方法修订固定夹具

本轮只补 matrix 的 E2 方法修订缺口，不改生产接口、schema、安装入口或打包清单。
- 同标题方法 A 显式 r1→r2，方法 B 无替代关系；普通查询保留 A/B 身份，A 仅返回 current r2，r1 可显式审计。
- 活动方法上下文恢复 r2，排除 r1 与 B；plain/before/after 均检查，after 仍只追加无关项后核对上下文身份，不是完整重放。
- 金标在运行前新增；统一门槛要求八项具名方法检查，新增改名负对照防止仅靠填充分母通过。
- Node.js v26.3.0，五个变更评测/测试模块的 `node --check` 通过。
- `timeout 25s node --test test/m4-integration-evaluation.test.mjs`：**7/7**，runner **21 案例 / 248 项**。
- `timeout 30s node --test test/m4-suite.test.mjs`：**12/12**；含统一执行 49 案例和 strict CLI 返回 1 的检查；均无失败/跳过。
- 矩阵现为 **5 行固定夹具覆盖、8 行 partial**；离线检查通过，完整覆盖及 M4 验收仍为 false，质量仍 unassessed。
- 未跑全量回归、真实 Pi 会话质量或模型/科学计算；所有写入限于新建且清理的临时沙箱。下方记录保留为历史结果。

## M4 阶段：统一离线入口与完整性门槛

新增 `eval/m4-matrix.mjs`、`eval/m4-suite.mjs` 及 `test/m4-suite.test.mjs`；不改生产模块、安装入口或打包清单。

- Node.js v26.3.0，新增文件语法检查通过；统一入口门槛单测 **11/11**，连同其他 M4/有界摘录定向测试 **39/39**，无失败/跳过。
- 三个 runner 顺序执行共 **49 个案例**，离线检查全部通过；13 行设计矩阵中 **4 行固定夹具覆盖、9 行 partial**，逐项证据/缺项见清单。
- 缺失/重复/跳过案例、子检查失败或 actual/expected 不符、缩减分母、非有限值、未清理沙箱均使离线门槛失败。
- 默认模式仅以已执行检查决定退出码；实际 `--require-complete` 返回 **1**，因为完整计划未覆盖，并非一次执行故障。`--plan` 不初始化沙箱；未知参数返回 2。
- 报告明确 `offlineChecksPassed=true`、`plannedCoverageComplete=false`、`m4AcceptancePassed=false`、`qualityVerdict=unassessed`；没有人工或真实科学质量验收结论。
- 本轮仅开发评测/文档改动，未重跑全量；下面 270/270 保留为上一 B1 阶段的历史结果。只使用新建临时沙箱，没有远程模型、依赖安装、真实数据/用户设置改动或提交/推送。

## M4 阶段：B1 有界摘录与知识上下文修复

M4 尚未完整验收。本阶段修复合成评测发现的尾部限制丢失，不把软件回归当作科研质量认证。

- `src/v2-domain.mjs` 新增 Unicode 安全、保留首尾和显式截断标记的 `boundedExcerpt`。
- `src/v2-store.mjs` 的 excerpt 仍上限 1400 个 UTF-16 code units；不再只取超长文本前缀。
- `src/v2-working.mjs` 保持每项 1600 的预算，计入 JSON 转义，只缩 excerpt；元数据放不下则显式省略，不截断运行状态/单位等字段。
- `test/v2-excerpts.test.mjs` 新增 5 项；M4 原失败金标不变，相关测试改为要求 B1 恢复成功。
- 实际环境 Node.js v26.3.0。定点 `node --check` 通过；6 个定向测试文件 **61/61** 通过。
- 指定已安装宿主的 `PI_TEST_HOST_PACKAGE=<host-package.json> timeout 90s npm test`：**270/270 通过，0 失败、0 跳过，约 11.1 秒**。包含离线宿主装配检查，不是远程模型测试。
- 扩展合成 runner `eval/m4-offline.mjs`：**4/4 组、82/82 项通过**，B1 两条尾部限制按原金标恢复；CLI 返回 0，`qualityVerdict` 仍为 unassessed。
- 所有写入仅在新建临时测试沙箱；未运行科学软件、远程模型、依赖安装或真实数据修改，未提交/推送，仓库无 `.pi-root`。

CLI/工具参数、JSON 字段及存储格式不变；excerpt 内容和默认知识上下文的截断表现有变化，见 [M3 召回契约](next/m3-usage.md#7-实体召回与验收边界)。
检索仍选择至多七条匹配/回退行，有界首尾不能保证任意中部/未选行完整；超大元数据会被省略而不是认证。M4 其余矩阵、独立语义审阅、真实模型质量及文档去本地化仍未完成。

## M3 完成：宿主提炼、review/auto、审核与实体召回

完成 `v2.ts` 的当前宿主模型适配器和 agent_before_settle 生命周期；新增项目 longTermMode/extraction 配置、会话 curate 控制、显式 extract/review 命令、候选审核者标记、auto 幂等发布、实体优先/BM25 和完整内容去重，以及会话/项目隔离的安全诊断及已报告 usage。M1/M2 的显式接口和规范文件不自动迁移；默认入口仍是旧 index.ts。

实际环境：Node.js v26.3.0、Pi 1.4.0、Linux。实际通过：

- `npm run check`：全部现有脚本目标和新增模块的语法检查，不是 TypeScript 静态检查。
- 指定已安装宿主的完整 `timeout 90s npm test`：**242/242 通过，0 失败、0 跳过**，最终约 10.7 秒。
- `git diff --check`、22 个相关文件的空白/本地 Markdown 链接检查通过；交接文档 30 行，仓库仍无 `.pi-root`。
- `npm pack --dry-run --json`：35 个文件，包含 M3 模块、使用文档和交接，不包含测试/provider，未生成 tarball；没有改版本或打包清单。
- 本完成阶段新增 **28 项**：`test/v2-m3.test.mjs` 25 项配置/存储/召回/真实 Jiti 扩展生命周期测试，以及 `test/v2-host.test.mjs` 3 项真实离线 JSON/RPC 用例。加上前两阶段的 41 项候选/提炼测试，M3 共新增 69 项。
- 真实宿主 JSON：默认 review 只额外调用一次本地 curator；无嵌套工具；人工批准不增加请求且不升级 verification。真实 auto 使用同一路径发布 reported 记录。
- 真实 RPC：会话 auto/off、new_session 恢复项目 review、拒绝审核和原生 compaction 不触发额外提炼；既有 JSON/print/RPC 和所有旧版回归继续通过。
- 生命周期桩：取消、超时、迟到响应、会话切换/fork/shutdown、新用户/custom 范围、项目 off、策略/预算变化、主任务不完整以及锁内失效均阻止旧作用域自动发布。
- 自动批准决定发布后、M1 扫描之后、规范记录及投影视图提交前分别复查 off；已提交记录与 projection pending 分开报告，不覆盖手工编辑。候选拒绝不被 auto 推翻。
- 实体/BM25：同名方法/运行独立，活动实体限制自动召回；按来源/实体/完整内容摘要去重，不因相同截断摘要丢失互补内容。

实现契约见 [M3 使用文档](next/m3-usage.md)，后续入口见 [交接](next/m3-handoff.md)。M3 采用抽取式文本 grounding，不开放模型自由生成科学正文或结构化数值；批准和 auto 均不认证事实。质量覆盖、语义/科学有效性和真实模型评测属于 M4。

所有新增执行均使用隔离临时目录、离线 provider 或进程内桩；没有远程模型、真实科研计算、依赖安装、真实记忆/结果/用户设置改动、提交或推送。未执行 PTY/TUI、TypeScript 静态类型检查或真实科研质量评测。以下阶段记录保留为历史，不代表当前仍缺少宿主接入。

## M3 第二阶段：证据 envelope 与可取消提炼内核

新增 `src/v2-extraction.mjs`、`test/v2-extraction.test.mjs`；复用 `src/learning.mjs` 的可见文本解析/过滤片段助手，候选写入增加锁内生命周期守卫。扩充 [M3 契约](next/m3-usage.md)，并把新模块加入语法检查。经用户授权，`AGENTS.md` 和 `.agents/DEVELOPMENT.md` 的默认累计读取预算同步从 24 KB/8 文件提高到 64 KB/16 文件；单次读取和输出限制不变。

实际环境：Node.js v26.3.0、已安装 Pi 1.4.0、Linux。实际通过：

- `npm run check`：包含新增提炼模块的语法检查，不是 TypeScript 静态检查。
- `timeout 30s node --test test/v2-extraction.test.mjs test/v2-candidates.test.mjs`：**41/41 通过**，其中新增提炼测试 **22 项**。
- `PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" timeout 90s npm test`：**214/214 通过，0 失败、0 跳过**，约 7.8 秒；包含既有真实离线 JSON/print/RPC 回归，但没有新增宿主模型适配器。
- 新测试覆盖最近用户回合隔离、可见文本/畸形块、失败助手丢弃、失败工具保留、截断前敏感过滤、含 JSON 转义的输入预算、精确引文/标题校验、完整来源语境、结构化科学字段拒绝、实体和修订 grounding、候选幂等、诊断脱敏及适配器实际调用次数统计。
- 离线桩覆盖超时、主任务取消、迟到响应、off/作用域变化/标记撤销、共享锁内再次失效、批次中途失效的 partial 报告；不会把模型提炼自动发布成知识。

这里的模型接口仅由确定性本地回调验证，没有宿主/远程模型调用。文本 grounding 不证明语义、数值或科学有效性；提炼内容仍为 model-extraction/reported，运行状态不从文本猜测。尚未实现宿主适配器、生产自动触发、review/auto 模式、Pi 审核命令或真实科研质量评测。未跑 PTY/TUI 或静态类型检查；没有安装依赖、创建提交、修改真实记忆、用户全局设置或科研结果。

## M3 第一阶段：显式候选审核与 CLI 实体过滤

新增 `src/v2-candidates.mjs`、`test/v2-candidates.test.mjs` 和 [M3 契约](next/m3-usage.md)。共享 M1 写锁内的知识发布能力，增加独立候选/决定存储、显式 approve/reject、幂等恢复和 CLI 实体过滤。没有接自动模型提炼、auto 模式或 Pi `/memory review`；不宣称完整 M3 已完成。

实际环境：Node.js v26.3.0、已安装 Pi 1.4.0、Linux。实际通过：

- 新模块 `node --check`；`npm run check` 已补入候选模块。
- 定向存储/工作/候选回归曾通过 48/48；随后候选测试补至 **19 项**，最终由完整回归覆盖。
- `PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" timeout 90s npm test`：**192/192 通过，0 失败、0 跳过**，约 9.5 秒。包含既有真实离线 JSON/print/RPC 测试，但新候选接口仅接 CLI/API，不代表已验证 Pi 审核命令。
- 候选测试覆盖 pending/rejected 不进入知识、审核不升级 verification/provenance/运行有效性、同名独立、显式修订/CAS、旧批准重试不回退视图、手工编辑保护、身份冲突、off 下显式请求、禁用/标记撤销/作用域切换、符号链接、损坏记录、敏感内容和容量限制。
- 每阶段最多 4 个临时子进程验证并发导入/批准只发布一条知识；真实子进程在决定原子发布后退出，确认退出后只清理夹具锁，再恢复发布，未产生重复知识。

所有写入都在新建临时目录；没有修改用户设置、真实记忆或科研结果，没有安装依赖、调用远程模型或执行计算。未重新运行 PTY/TUI、TypeScript 静态检查或真实科研质量评测；数值 grounding 与自动提炼质量仍未验证。

## M2：工作记录、当前状态与新 Pi 入口

本轮新增 `src/v2-working.mjs` 和独立 `v2.ts` 扩展；通过受检存储能力复用 M1 的作用域、写锁、原子发布和视图保护。新增显式 state/overview、不可变工作事件、默认上下文、原生压缩交接，以及相应 CLI。默认安装入口仍是旧 index.ts，不能同时加载两套扩展。使用方法见 [M2 文档](next/m2-usage.md)。

实际环境：Node.js v26.3.0，Pi 1.4.0，Linux。最终实际通过：

- `npm run check`：包含 v2-working.mjs 与 v2.ts 的原生语法检查；**不是 TypeScript 静态类型检查**。
- `bash -n examples/bashrc.sh`、`git diff --check`，新增文件空白与文档链接检查。
- 指定已安装 Pi 宿主的完整 `npm test`：**173/173 通过，0 失败、0 跳过**，最终约 7.1 秒；保留全部 M1 和旧实现回归。
- 新增 **31 项 M2 测试**：13 项工作记忆/CLI、11 项宿主 Jiti/TypeBox 生命周期、3 项真实宿主 JSON/print/RPC、4 项多进程/恢复。
- 真实新入口测试验证：显式初始化没有 provider 调用；跨独立进程的 JSON 会话在“继续”时收到工作上下文；真实工具循环执行新搜索工具；RPC 原生压缩成功且生成 handoff；learning off 不写记录，新会话恢复项目默认值。没有 curator 调用；主任务和原生压缩的 provider 均为本地确定性夹具。
- Unicode 边界检查：显式字段拒绝未配对代理字符；自动片段截断后修复 UTF-16 对，避免写出的视图与规范事件发生自冲突。
- 工作并发测试验证同一回合去重、状态 CAS、进程在规范事件发布后/根视图更新前真正退出、显式确认退出后清理夹具锁并重试。4 项工作并发测试连续 **3 轮通过**。
- 真实压缩首次测试暴露 split-turn 只投影用户目标的情况：最初因为没有助手/工具片段而跳过 handoff。现已允许保存该投影目标，不从原始分支补造或复活助手回答；新增专用单测，并保持真实 RPC 的原生压缩验证。
- `npm pack --dry-run --json`：**31 个文件**，包含 v2.ts、v2-working.mjs 和 M2 使用文档，不包含测试 provider 或 test 文件；未生成 tarball。

所有自动工作记录均为本地确定性有界片段，不增加学习模型请求。失败、取消和截断回合只保留完整工具观察，不采纳残缺助手断言；助手建议不自动成为用户承诺或有效科学结论。测试覆盖截断前敏感过滤、custom 回合排除、scope 撤销、预算、手工视图冲突及同一用户范围内多个低层 agent_end 的保留/去重。

限制：未重新运行 PTY/TUI、TypeScript 静态检查、远程模型或真实科研任务评测；未实现长期自动提炼/审核、自动归档、强制覆盖或手工编辑导入。M2 不保证真实记忆质量，只验证续接机制和安全边界。没有修改真实记忆/科学结果/用户设置、安装依赖、创建提交、操作 GitHub 或执行计算。

## M1：v2 显式存储与领域模型

本轮新增 `src/v2-domain.mjs`、`src/v2-store.mjs`、`src/v2-cli.mjs` 和独立 `pi-project-memory v2` 路由。旧操作拒绝 versioned 配置，避免误写旧 pack；保留原工作区的 profile 初始化改动。使用契约见 [M1 文档](next/m1-usage.md)。

实际环境：Node.js v26.3.0，已安装 Pi 1.4.0，Linux。实际通过：

- `npm run check`（已加入三个新模块）、`bash -n examples/bashrc.sh`、`git diff --check`。
- 指定已安装 Pi 宿主的完整 `npm test`：**142/142 通过，0 失败、0 跳过**，最终运行约 6.8 秒。包括既有真实 Pi RPC/JSON/print 离线测试；这些宿主测试仍验证旧路径，不代表 v2 已接入宿主自动行为。
- 新增 **35 项 v2 测试**：根/嵌套/子目录、旧数据保护、配置和标记撤销、领域字段/数值/单位、类型化引用、不可变修订/CAS、幂等、同名隔离、最新修订 BM25、手工视图冲突、派生目录重建、移动/复制、符号链接、损坏修订链、容量限制和 CLI 错误脱敏。
- 多进程测试包括并发初始化/保存/修订、半文件不可见、规范记录发布前后真正退出子进程、显式确认退出后清理夹具锁并恢复，以及 projection pending 的幂等重试。最终 **7 项并发测试连续运行 5 轮通过**。
- 回归期间曾发现初始化竞争：配置在锁外读取，可能将另一进程刚创建的存储误报为 `store-conflict`。现已把配置与目标归属检查一起放入初始化锁；未放宽测试预期，仍只允许成功或显式 busy。
- `npm pack --dry-run --json`：28 个文件，包含三个 v2 模块和阶段文档，不包含 test 文件，未生成 tarball。
- 新增阶段文档的本地链接和空白检查通过。

所有新测试只使用临时隔离目录、合成数据和有界本地子进程；目录条数上限用桩模拟，单文件/UTF-8 字节限制实际验证。没有扫描真实旧记忆、修改用户设置、安装依赖、调用远程模型、运行科学计算、提交或推送 Git 历史。

范围限制：v2 仅显式存储/API；未接入自动学习、journal、overview/state、默认上下文或审核。未重新运行 PTY/TUI、TypeScript 静态检查、真实模型质量评测或其他文件系统验证。缺失的派生视图可重建，手工编辑不会覆盖，但显式导入编辑尚未实现。不宣称已解决真实任务中的记忆数量/召回质量问题。原有测试的历史结果仍保留在下文。

## 初始化 profile 参数补充

`pi-memory-init`、`/memory-init` 和 CLI `setup` 新增 `--profile default|qchem`，共享参数解析；不指定时保留原行为，已有配置不静默覆盖。

实际通过：`npm run check`、`git diff --check`、指定 Pi 1.2.0 宿主的完整 `npm test` **107/107 通过，0 失败、0 跳过**。新增 5 项测试覆盖参数顺序/等号/空格名称/非法参数、新项目持久化、重复调用不改写、profile 冲突、已有 pack 绑定保留和两个 CLI 入口；已有真实 RPC 端到端测试改为 `/memory-init 离线项目 --profile qchem` 并核对持久化结果。

测试仅使用临时目录和离线 provider；没有修改用户配置或真实记忆。此小改动未重新运行 PTY/TUI 或 TypeScript 静态检查。

## 0.3.0：Pi 1.2.0 / qchem profile

在已有未提交的轻量元数据改进上增量修改，未撤销原改动。npm registry `/@earendil-works/pi-coding-agent/latest` 核对为 1.2.0，本地宿主亦为 1.2.0；阅读宿主扩展文档及实际事件类型后，修复 custom-triggered 回合无 prompt 的兼容问题，并禁止该类回合重学上一用户回合。

本轮实际通过：

- `npm run check`；`bash -n examples/bashrc.sh`；`git diff --check`。
- 指定已安装 Pi 宿主的 `npm test`：**102/102 通过，0 失败、0 跳过**，包含真实 RPC、JSON、print 离线集成。
- 新增 10 项测试：qchem profile/全局和项目数值优先级/非法配置/目标项目配置；主题别名与 tags；笔记统计/扫描边界/标记撤销；长工具输出/用户约束预留/截断前敏感过滤；custom 回合；扩展端实际预算/搜索/统计；真实 Pi RPC 的 qchem 配置及审核前后统计。
- `python test/tui-smoke.py --host "${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}"`：真实 Linux PTY 的初始化、学习、审核、批准、交接、原生压缩、reload 和模式覆盖重置通过。curator 2 次，远程模型 0 次。
- `npm pack --dry-run --json`：0.3.0，20 个发布文件，包含 qchem 配置示例，不包含 test provider；未生成 tarball。

所有测试使用临时隔离目录/确定性离线 provider。未安装依赖、未修改用户 settings/.bashrc、真实计算文件或旧记忆、未启动计算、未创建 Git commit。普通 profile 的默认容量和 suggest 模式不变；qchem 需显式配置启用。

限制：未验证真实远程模型的提取质量/成本、真实项目召回改善或未来未发布 Pi main；没有 TypeScript 静态类型检查。更大窗口和提示词只能减少证据丢失，不保证候选数量、科学真实性或语义召回。本文其它章节保留历史结果，不能视为本轮对历史平台的重复验证。

## 计算化学轻量元数据改进回归

本轮在 0.2.1 上扩展可选 status/supersedes/evidence 和 handoff 标记，没有改变学习触发时机、默认配置或存储架构。开始时工作区干净；仓库及上级目录未找到 AGENTS.md。已阅读源码、README 和相关测试后实施。

实际运行并通过：

- `npm run check`：现有源码/CLI 语法检查。
- `bash -n examples/bashrc.sh`：Bash 语法检查；没有修改或加载用户 shell 配置。
- `git diff --check`：无空白错误。
- 指定已安装 Pi 宿主的 `npm test`：**92/92 通过，0 失败、0 跳过**。包括旧笔记、状态过滤/显式搜索、替代关系/异常链、路径/符号链接、来源定位不触发文件读取、交接新旧识别、旧候选 hash/去重兼容、三种学习模式、审核、项目隔离及真实 Pi RPC/JSON/print 离线集成。
- `python test/tui-smoke.py --host "${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}"`：真实 Linux PTY 初始化、学习、审核/批准、交接、原生压缩、reload 和学习覆盖重置通过；本地 curator 调用 2 次，远程模型调用 0 次。
- `npm pack --dry-run --json`：打包清单检查通过，19 个文件，测试 provider/test 文件不进入包；没有生成 tarball 或安装插件。

新增 12 项核心元数据测试和 3 项生命周期集成测试；所有数据在新建临时目录中。旧文件不改写、旧队列 identity 与审核决定兼容均用合成夹具验证，没有读取或更改真实用户记忆。

未验证：真实远程模型的候选质量（提示词不是科学语义验证器）、真实用户旧记忆映射、OneDrive 跨设备一致性、Windows/NAS 文件系统或 TypeScript 静态类型检查。未做批量分类/迁移、额外模型重审、数据库/embedding/MCP 或版本恢复系统；本轮要求内无暂缓项。

下文保留先前版本的历史测试结果，不代表本轮重复执行所有历史平台测试。

## 0.2.1 补充回归

本地版本新增项目内默认 pack、有效旧 `.md` 笔记兼容与并发夹具独立标记修复。完整宿主 Node 测试 **74/74 通过**（0 失败、0 跳过）；在 WSL DrvFS/9p 同挂载执行的 6 项针对性回归通过；Linux PTY TUI 包括 reload 再次通过。所有 provider 调用均离线确定性响应。

源码/脚本语法、diff whitespace 与包 dry-run 通过，test provider 不进入发布包。没有验证远程模型归纳质量或 OneDrive 跨设备一致性。夹具修复后使用独立临时项目隔离；原有 Markdown 文件集合和 SHA-256 复核一致。详见 [0005 决策](decisions/0005-project-local-default-and-legacy-dot-notes.md)。

下文保留 0.2.0 当时的测试记录与单次测量，数字不是 0.2.1 的规模性能承诺。

# 0.2.0 历史测试报告

## 环境与结果

- 被测项目：pi-project-memory 0.2.0。
- 实际宿主：Pi 1.1.0，Node.js v26.3.0，Linux。
- Python PTY 测试仅使用标准库，使用现有 agent Python 环境，没有安装依赖。
- 完整 Node 测试：**72/72 通过，0 失败，0 跳过**；本轮约 4.53 秒。
- 不指定宿主：52 通过、20 项宿主测试按设计跳过，0 失败。
- Node 语法、Bash 语法、git diff --check、npm pack dry-run 均通过。
- 发布文件中不包含测试 provider 或其他 test/ 文件；没有生成 tarball。

## 实际宿主测试，不只是模拟 ExtensionAPI

测试会启动真实 Pi 子进程，使用独立 HOME/agentDir/settings、临时项目和确定性离线 provider。没有用户认证信息、旧插件、MCP、远程模型调用或真实模型费用。

| 场景 | 验证 |
|---|---|
| RPC 命令注册 | memory / memory-init 实际可发现和执行 |
| 无标记项目 | 不创建记忆、不学习、不交接 |
| 显式初始化 | 中文名称、空格路径、项目内 pack 正常 |
| 实际工具执行 | 真实 agent 工具循环执行 project_memory_search |
| suggest 学习 | 回合结束真实事件产生候选；批准前不可检索 |
| 审核/批准 | 真实命令发布笔记，重复批准不重复生成 |
| 注入 | 后续真实模型请求包含已批准的相关笔记 |
| 正常压缩 | 原生 compact 成功，独立交接笔记保存；没有额外 curator 调用 |
| new_session | 会话学习覆盖重置为配置默认值 |
| 持久会话重启 | 恢复同一 session 与 pending queue；学习覆盖不跨会话延续 |
| 设置更新 | 两个回合之间更新项目学习/交接开关，下一回合生效 |
| JSON / print | 协议 stdout 为 JSONL；auto 发布笔记；print 初始化不调用 provider |

Pi 原生压缩在 split-turn 时可能分别生成历史摘要和前缀摘要，即一次或两次 compact provider 调用。这是 Pi 正常行为，不是交接快照增加模型调用。

## 真实交互 TUI

`test/tui-smoke.py` 用 Linux PTY 启动真实 Pi TUI，不模拟 UI API。

已通过：初始化 → 正常回合 → 学习候选 → /memory review → 批准 → /compact → 交接笔记与原生压缩。

基础链路连续运行 3 次通过。扩展测试也验证：`/memory learn off` 后不学习，`/reload` 后恢复 suggest，再次成功学习；包括最终回归在内，扩展链路已运行 2 次通过。所有 provider 响应均本地确定性生成，远程调用 0。

## 并发和实际进程中断

新增 4 项多进程测试：

1. 写候选 JSON 到一半时暂停，另一进程读取队列。
2. 8 个进程同时加入相同候选，仅一条记录；其他进程显式 busy 或去重。
3. 8 个进程批准相同候选，仅一条笔记和一个不可变决定。
4. 真正退出写入进程，模拟笔记完成而审核决定未发布；确认进程退出、显式清理遗留锁后重试，笔记字节不变且不重复生成。

第 1 项最初复现失败：

```text
SyntaxError: Unterminated string in JSON at position 197 (line 7 column 10)
```

原因：wx 保证不覆盖，却不能阻止读者观察半文件。已修复 `src/core.mjs` 的 exclusive()：同目录隐藏临时文件写完并关闭后，用 hard link 原子发布。目标已存在仍报 EEXIST，不使用覆盖式 rename。修复后 4/4 并发测试通过，全部回归通过。

此方案要求文件系统支持 hard link。进程崩溃可能留下隐藏临时文件/锁；不自动抢锁或删除，且不承诺断电耐久性。详见 [0004 — 原子发布](decisions/0004-atomic-exclusive-publication.md)。

## 合成规模测试

300 条已发布笔记 + 满额 200 条 pending 候选：

| 本轮单次测量 | 耗时 |
|---|---:|
| 创建 300 条笔记 | 49 ms |
| 填充 200 条候选 | 1097 ms |
| 单次精确关键词搜索 | 20 ms |

确认：唯一关键词准确命中；pending 内容不可检索；第 201 条待审核候选被拒绝；扫描上限能正确标记 truncated。这是临时本地目录里的合成单次测量，不是跨文件系统或真实大库性能保证。

## 复现（0.2.0 历史快照）

以下保留当时的复现命令；其中 Bash 示例现已移除，不再作为当前检查要求。当前定向检查见公开前审计。

```bash
cd "${PI_PROJECT_MEMORY_REPO:?Set PI_PROJECT_MEMORY_REPO to the checkout directory}"
npm run check
bash -n examples/bashrc.sh
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" npm test
python test/tui-smoke.py --host "${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}"
node --test test/concurrency.test.mjs
npm pack --dry-run --json
```

测试 provider 在 `test/fixtures/offline-provider.ts`，只供上述隔离测试。不要加载到正常工作会话。

## 未验证与操作记录

尚未验证：远程 provider 对真实任务的归纳质量/速率限制、用户实际旧记忆包映射、Windows/NAS/不支持 hard link 的文件系统，以及 TypeScript 静态检查。中文单字召回、无 semantic/deep、启发式敏感信息过滤和 usage 不自动计入 Pi 汇总等既有限制未改变。

没有修改用户 `.bashrc`、Pi settings、实际记忆包；没有安装依赖、调用付费模型、提交量化计算或创建 Git commit。改动仅为测试、原子发布修复与仓库文档，派生测试数据在新建临时目录内并于结束清理。
