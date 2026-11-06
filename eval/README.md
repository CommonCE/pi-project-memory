# M4 离线合成评测子集

这里是[完整评测设计](../docs/next/m4-quality-evaluation.md)的部分实现，**不是 M4 验收通过报告**。
不安装依赖，不调用模型，不运行科学软件。提炼 runner 不写文件；集成 runner 经用户授权，
仅在新建 OS 临时沙箱内初始化包和 `.pi-root`，结束或失败后清理；仓库和真实项目不创建标记。
复用实际提炼、存储、候选审核、检索和工作上下文 API，不复制其领域逻辑。
B1 修复已定点修改 v2 的有界 excerpt 和上下文组装；schema、CLI 参数及存储格式不变。

## 计算化学主目标与纵向样例

主目标已更新为 [计算化学记忆生成与续接](../docs/next/m4-chemistry-goal.md)，矩阵不是唯一效果指标。
`timeout 15s node eval/m4-chemistry-generation.mjs` 使用固定响应适配器，经实际提炼 API、pending/批准、检索及新 Node 进程恢复。
10 项金标在候选、发布内容、查询摘录和上下文四层检查；工作状态不复制来源答案。
单独测试：`timeout 15s node --test test/m4-chemistry-generation.test.mjs`。
合法但只选助手建议的负例必须失败；grounding 和人工批准不能保证任务记忆有用。
新增 `timeout 15s node eval/m4-chemistry-scenarios.mjs` 执行准备未运行（49 项）及方法修改后独立重跑（90 项）。
测试：`timeout 15s node --test test/m4-chemistry-scenarios.test.mjs`；误导标题和错误 run 引用负例应被质量门槛拒绝。
独立运行锚点由夹具显式创建，活动身份现在同时指定共享体系 + 当前 run；不测试自然语言实体识别，不实际重跑。
此设置复现了旧/新能量互串（88 项中 4 项失败），现通过活动 run 优先知识搜索和明确外来 run 筛选修复。
`test/v2-working-run-scope.test.mjs` 另覆盖同名体系、共享背景、多 run、前八项拥挤、result.runId 优先级和真实零值/未知科学状态；search API 仍宽检索，工作历史不重写。
新增 missing-run 合法负例：上下文不能推断缺失关联，因此质量门槛必须失败，而不是隐瞒此生成缺口。
提炼 envelope 新增可选实体 context（最多 800 UTF-16 code units、background-only、敏感过滤先于截断）。此前只有同名标题/UUID，固定适配器预知 ID 会掩盖歧义。
重跑适配器现仅消费实体背景定位身份，不再将金标 ID 用作正例响应的选择来源；改造后先观察到 90 项中 21 项失败，补背景后 90/90。金标 ID 只用于判定，错/漏关联负例仍失败。
`test/v2-extraction-context.test.mjs` 覆盖背景不能 grounding/复制成新事实、隐私、类型/源上限、身份及任务优先、Unicode/JSON 总预算和显式选定 current 记录；不是实际模型质量评测。
新 runner 均尚未接入下方 49 案例统一门槛；报告 `fixedResponseContractPassed` 与未评估的模型选择质量分开。
它不是真实模型选择或实际 Pi 会话验证，不据此宣布 M4 完成；摘要仅覆盖明确列出的源码。

### 恢复建议的来源与运行关联

`timeout 15s node eval/m4-chemistry-followup.mjs` 重建独立主记录与后续建议的合成响应，经实际提炼 API、pending/批准、宽查询/按 run 查询和新 Node 进程恢复。准备未运行 **55 项**、原失败运行 **46 项**，不执行模型或科学软件，不接入旧 49 案例门槛。
`test/m4-chemistry-followup.test.mjs` 另覆盖 `omitted`、`unlinked`、`swapped`：漏选建议、已选但未关联、错误关联到另一运行必须分别失败；未关联负例的原建议仍可在候选、发布记录及宽查询中找到。CLI 拒绝所有额外参数；负例仅由测试调用导出函数。
生产提示要求运行专属建议共同 grounding 原运行证据并关联其身份；含糊时不猜测，不在解析或存储层补 ID，不升级已采纳/已运行状态。提示占用现有输入预算，不增加上限；最小 2048 预算仍有测试。
此前 5 次真实模型合成小样本严格通过 2/5，其中两次恢复建议已选但未关联；这批调用已耗尽独立授权额度。详情见 `docs/next/m4-chemistry-goal.md`。新提示未再次调用真实模型验证，离线固定响应通过不代表模型已改善。

## 统一验收入口

优先使用 `m4-suite.mjs`；场景映射和剩余要求集中在 `m4-matrix.mjs`，不再凭各 runner 的绿色结果判断 M4 完成。
这些脚本仅用于仓库开发；未改安装入口、版本号或打包清单。

```bash
node eval/m4-suite.mjs --plan                  # 仅输出清单，不创建沙箱
timeout 30s node eval/m4-suite.mjs             # 顺序执行三个 runner，JSON 只写 stdout
timeout 30s node eval/m4-suite.mjs --require-complete
```

默认模式退出码 0 只表示本次执行的离线检查通过。`--require-complete` 还要求完整计划覆盖，
**当前明确返回 1**；它不会授权真实模型调用、自动安排人工审阅或启动发布。非法参数返回 2。
报告显式区分 `offlineChecksPassed`、`plannedCoverageComplete`、`m4AcceptancePassed` 和 `qualityVerdict`。
当前实际结果为 `true / false / false / unassessed`，不能把默认退出码 0 当成完整验收通过。

统一入口验证 runner 身份、摘要、所有预期案例/顺序、金标分母、子检查 actual/expected 和沙箱清理。
缺失、重复、跳过、非有限数值、伪造父级通过状态或缩减分母均不能使结果变绿。
这是对本地报告的确定性一致性检查，不是签名认证、安全边界或通用科学裁判。
报告包含原始合成子报告、清单摘要及明确列出的源码摘要；不会写真实数据或持久化运行报告。

本轮实际执行 49 个离线案例全部通过；13 行最小矩阵中 **7 行仅在固定夹具范围内覆盖，6 行仍为 partial**。
缺项逐行记录，包括 P1 多来源计划/建议/采纳对照、跨方法数值负例、逐运行路径及未知状态、
真正的离线 Pi 会话续接质量，以及进一步预算/顺序变体。
独立语义审阅、完整跨版本生命周期对照、文档去本地化和经授权真实小样本另列要求，不混进离线通过率。
覆盖分类是显式维护的清单声明，必须随夹具和证据一起审阅，不由脚本自动理解科学语义。

E2 方法修订及 Q2 unresolved 补齐后，`test/m4-suite.test.mjs` **13/13**、`test/m4-integration-evaluation.test.mjs` **8/8** 通过，无失败/跳过。
此前统一入口阶段与其他 M4 和有界摘录测试合计 **39/39** 是历史结果，本轮未重跑该组合。
本轮只改开发评测/文档，未重跑完整软件回归；上一 B1 阶段的 270/270 记录仍是历史验证。

## 文件与运行

- `m4-fixtures.mjs`：8 组人工合成来源、固定候选选择与保真金标；独立版本 `m4-extraction-1`。
- `m4-extraction.mjs`：金标自检、3 种顺序变体、单/多来源候选保真及来源身份/顺序判分；JSON 报告只写 stdout。
- `../test/m4-evaluation.test.mjs`：判分器自检及负对照，区别于实际评测案例。

```bash
node --check eval/m4-fixtures.mjs
node --check eval/m4-extraction.mjs
node --check test/m4-evaluation.test.mjs
timeout 20s node --test test/m4-evaluation.test.mjs
timeout 10s node eval/m4-extraction.mjs
```

CLI 不接受参数，错误参数退出码为 2；保真检查失败退出码为 1。
评测失败案例保留原分母，不因候选缺失、异常或错误而减少必需事实数。
调用方若保存 stdout，应自行选择新的输出文件，不能覆盖既有结果。

## 当前实际结果

Node.js v26.3.0；本轮七个变更 JS 模块语法检查通过；提炼定向单测 **12/12**。
提炼 runner **24 个案例，45/45 个事实保真检查通过**，`preservationPassed=true`。
与扩展/统一门槛测试合跑 **32/32**，无失败或跳过。
报告明确返回 `qualityVerdict=unassessed`、`modelUsage=not-applicable` 及 12 类未评估项。
CLI 错误参数实际返回 2；仓库仍无 `.pi-root`。未重跑完整软件回归。

这里的 45 项是 15 个夹具事实在 3 种顺序下的重复检查，不是 45 个独立科学结论。
P2 在原工具观察前加入矛盾的助手成功声明，两者必须保留各自来源与顺序；
反转 grounding 数组仍按来源流顺序恢复，交换来源标签或只选助手成功声明均不能通过夹具判分。
固定响应由夹具指定，不让系统自行选择候选；因此测到的是保真和校验，而非模型选择能力。
报告包含夹具/金标 SHA-256、Node 版本、逐例错误、输入长度与耗时；未记录完整代码身份，
不能仅用夹具摘要复现全部运行条件，复核时还需保留所用代码及工作树差异。
`inputChars` 含系统提示及序列化 envelope，单位是 UTF-16 code units；
`envelopeBytes` 仅是序列化 envelope 的 UTF-8 字节数，不含系统提示，不是注入上下文长度。
延迟包含内存准备、解析和判分，不代表宿主端到端延迟或模型性能。

## 判分边界与负对照

检查完整来源片段、来源标签与定位/正文绑定、来源顺序、实体关联、固定标题/kind、reported/model-extraction 身份，
并核对每项金标的完整限定语句。按单候选归属判分，不在拼接的全局文本中捞关键词。
这些精确文本规则只适用于本夹具，不是通用语义裁判；仍需独立人工语义审阅。

单测注入缺失候选、丢失失败限定、误导标题、错误方法关联、来源标签改变和验证状态提升，
确认它们不能靠保留部分关键词通过；另验证虚构引文被生产 parser 拒绝。
其中 `converged` 可作为 `not converged` 的子串合法 grounded，却是误导标题：
该负对照明确展示文本 grounding 不等于语义正确，不能因此宣称所有误导都能自动识别。

`before/after` 仅改变无关工具片段的位置。P1 来源本身是最新用户消息，
其 before 干扰按生产规则被排除出当前回合；该变体不是“同回合前置干扰”能力证据。
两个同标题方法分别测试实体关联，没有测试跨候选组合、排序或知识召回。

## 集成子集：存储、审核、召回与续接

新增 `m4-integration-fixtures.mjs` 和 `m4-integration.mjs`；判分器单测位于
`../test/m4-integration-evaluation.test.mjs`。仅接受有限的内置场景/顺序，不接受既有项目或输出目录。

```bash
node --check eval/m4-integration-fixtures.mjs
node --check eval/m4-integration.mjs
node --check test/m4-integration-evaluation.test.mjs
timeout 25s node --test test/m4-integration-evaluation.test.mjs
timeout 10s node eval/m4-integration.mjs
```

每例使用独立沙箱，`initializeV2(..., {nested:true})` 不接管祖先包；在 finally 中清理。
Q1 人工注入“批准意图落盘后、规范知识发布前”的 scope-changed 失败，不修改真实配置或输出。
C1/C2 用绝对 Node 可执行文件启动只读子进程，cwd 限于沙箱；单次上限 5 秒、stdout 128 KiB，
无 shell、模型或科学软件。新进程恢复不等于实际 Pi session/compaction 验证。

| 场景 | 实际检查范围 |
|---|---|
| Q1 | pending/rejected/approved+publication pending 不入知识；同源工作观察仍可见且不算已发布知识 |
| Q2 | 重试恢复发布、幂等；reported/unresolved 及 unknown/unchecked 不升级；人工/auto 批准后 unresolved 查询和知识上下文仍标待核实；superseded/archived 默认不召回 |
| E1 | 同标题方法及运行不合并；含糊查询可返回两者，显式实体过滤及活动方法上下文不串线 |
| E2 | 同标题体系/方法独立；显式 r1→r2 后只召回 current，旧版仍可审计；活动上下文排除旧版和无替代关系的同名实体 |
| R1 | 同方法失败/成功运行及其显式数值记录分别归属；能量定义、单位、失败/收敛/有效性状态均核对 |
| C1 | 新进程恢复合成计算的体系/方法/位置、失败证据、假设、阻塞和待办，保留未验证与无执行授权限制 |
| C2 | 新进程恢复软件模块、实际检查的通过/失败/跳过/未运行范围、阻塞和下一步 |

R1 仅用显式保存接口写人工给定的数值，引用文件确实在沙箱内生成；没有自动数值提炼或科学有效性认证。
C1/C2 的用户状态和已同意下一步由夹具显式注入，不测试从自然对话自动推断用户承诺。

每场景运行 plain/before/after 三种顺序：before 提前插入一条无查询词的无关知识；
after 在完整场景后插入同类记录，再检查默认上下文知识身份未变化且无无关内容。
after 不是全部场景操作的重新执行，也不是带重合关键词的困难负例测试。

实际结果：Node.js v26.3.0，定向集成单测 **8/8** 通过；其中 runner **21/21 案例、296/296 项检查通过**，
所有案例均确认沙箱已移除。语法检查及错误 CLI 参数退出码 2 已验证。
检查数包括操作状态、知识身份、文本/限定保留、预算和清理断言，不是 296 个独立科研事实。
报告 `syntheticContractPassed=true`，仍为 `qualityVerdict=unassessed`，不调用模型。
报告包含金标摘要及明确列出的 runner/相关源码文件摘要；不是完整依赖锁定或真实宿主复现清单。

## 扩展子集：边界、auto 和 v1/v2 共同任务对照

`m4-offline.mjs` 复用相同临时沙箱保护，覆盖 I1、B1、A1 和共同任务对照。
`withSandbox` 现支持 Promise，在异步工作完成或拒绝后清理；原有同步行为保留。
异步 auto 使用纯本地固定响应函数，设 1000 ms 超时；不接宿主或远程 provider。

```bash
node --check eval/m4-offline.mjs
node --check test/m4-offline-evaluation.test.mjs
timeout 30s node --test test/m4-evaluation.test.mjs test/m4-integration-evaluation.test.mjs test/m4-offline-evaluation.test.mjs
timeout 15s node eval/m4-offline.mjs
```

扩展评测初次运行时，4 组场景、82 项检查中的 B1 有 2 项关键限制恢复失败，
当时如实返回 `syntheticContractPassed=false` 和 CLI 退出码 1；不是已通过的负对照。
B1 修复后保留原金标，4/4 组、82/82 项通过，CLI 返回 0，但 `qualityVerdict` 仍为 unassessed。
三组 M4 软件自检仍为 **23/23**；另增 **5 项**摘录回归。与存储/工作记录一起定向测试 **61/61**，
随后指定已安装宿主的完整离线 `timeout 90s npm test` **270/270 通过**，无失败/跳过，约 11.1 秒。

| 场景 | 实际结果与边界 |
|---|---|
| I1 | 当前项目不读另一项目哨兵；无标记/撤销标记后重解析禁用；合成敏感哨兵在截断前过滤且显式保存拒绝。不是完整隐私保证，也不覆盖所有旧对象撤权路径 |
| B1 | 原金标下完全重复去重、短互补内容、长记录身份、证据截断标记和两条长文本尾部限制恢复均通过；仅对固定夹具成立 |
| A1 | 固定响应 auto 发布、幂等、reported/unknown/unchecked 保留、完整否定保留，以及不推翻人工拒绝通过；不是宿主 auto 或真实模型质量 |
| COMPARE | 8 组相同显式正文/查询（含 P2 多来源文本），两版各恢复 15/15 项事实；无新版整体优越性结论 |

对照使用独立 v1/v2 项目；v1 home、vault、config 全部位于自有沙箱，`env:{}` 不读取真实配置。
相同正文包含来源和“未验证”说明；v1 的 active 仅表示可检索，不能映射成已验证事实。
两版都限 top-4 搜索与 12000 UTF-16 code units 上下文，并报告实际覆盖、长度和阶段耗时。
v2 走默认上下文组装；v1 走 search+brief；v2 的类型化实体/修订/state API 列为不支持项，
不伪造 v1 接口、不比较两种表示的原始相等性，也不声称抽取、审核或续接生命周期已对照。

B1 的最小复现是两条同来源长记录：共享长前缀，分别以失败有效性限制和“尚未重跑”结尾。
原实现保留两个身份，但前缀 excerpt 和按字符截断 JSON 丢失了尾部限制。
修复：`src/v2-domain.mjs` 提供保留首尾、显式截断标记及 Unicode 安全的 `boundedExcerpt`；
`src/v2-store.mjs` 在原 1400 字符上限内使用它；`src/v2-working.mjs` 仅缩减 excerpt，并计入 JSON 转义开销，不截断科学元数据。
后续准备未运行纵向样例发现 929 字符摘录加来源/运行元数据后为 1719；现仅对 model-extraction 将单项 JSON 预算从 1600 调到 2048（均为 UTF-16 code units）。
其他来源仍为 1600，总上下文预算不变，无存储迁移；更大单项可能减少后续项可用空间。元数据本身放不下时仍输出明确省略说明。
字段/状态/单位不被补全或升级；超大元数据不会以残缺 JSON 冒充已恢复信息。
这不是任意位置事实全覆盖：非 model-extraction 检索仍基于至多七条匹配/回退行；提炼记录基于完整正文有界摘录，有界首尾也可能丢失中部信息。
极小预算或其他未命中片段仍需检查原记录，不得把命中标签当成全文已恢复。

## 未完成及授权边界

各 runner 的 `unassessed` 只描述自身覆盖，不是仓库整体状态。
B1 已按原夹具修复；仍未完成完整场景矩阵、独立人工语义/科研审阅、Pi 宿主质量续接、
完整跨版本生命周期对照、隐私专项全面验证及真实模型选择评测。
本次已重跑完整离线软件回归；未改变 CLI/工具参数、schema 或存储格式。
可观察变化为有界摘录保留首尾并标记截断，知识上下文提供完整 JSON 或明确省略说明。

当时仅定点检索 M1/M2/M3 使用文档、M4 设计、下一版入口和本说明中的本机路径、用户名及环境特征，
未命中所选特征；这不是全文隐私审阅、
全仓去本地化或发布审计，不因未命中少量模式宣称文档已完成清理。

临时标记权限仅限上述全新沙箱；仓库和真实项目仍不得创建标记或写入真实数据。
真实模型小样本、真实科研评测、文档隐私清理及发布需另行授权。
