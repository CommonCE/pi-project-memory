# M3：长期提炼、审核与实体召回

M3 功能闭环已实现：当前宿主模型的有界抽取式提炼、review/auto、候选审核和恢复、显式修订、实体/BM25 召回、安全诊断。**功能验证不等于真实记忆质量或科学有效性验证**；真实模型质量评测属于 M4。

## 1. 启用与行为变化

仍须显式加载 `v2.ts`，不能与默认旧入口 `index.ts` 同时加载。项目必须已显式初始化；普通启动、检索、学习都不会创建 `.pi-root`。不迁移旧配置或记忆，不改全局设置。

与 M2 不同：现在 v2 的长期提炼默认为 **review**。有可用工作信号且主任务完整结束时，最多额外调用一次当前宿主模型；journal/state 仍是确定性本地流程。若不希望增加模型调用，设置项目 `longTermMode: "off"`，或本会话执行 `/memory curate off`。默认安装的旧入口不受此默认值影响。

自动提炼在 `agent_before_settle` 等待执行，不脱离生命周期后台运行，不添加主任务续跑。`agent_end` 只保留工作观察；同一用户范围内多个低层结束不会各调用学习模型。自动提炼每个会话/用户回合至多尝试一次，失败不盲目重试；失败、取消、截断的主任务不提炼残缺回答，但可保留完整工具观察。custom 回合和压缩交接不触发长期提炼。

## 2. 项目配置与会话控制

把可选字段合并进已有 `.pi/project-memory.json`，保留原 schemaVersion/id/name/memoryPath/enabled，**不要用下面片段覆盖整个文件**：

```json
{
  "longTermMode": "review",
  "extraction": {
    "maxChars": 48000,
    "toolChars": 8000,
    "outputTokens": 6000,
    "timeoutMs": 60000,
    "maxCandidates": 8
  }
}
```

- `longTermMode`：off / review / auto；缺省 review。auto 必须由用户显式开启，只改变发布策略，不提高验证等级。
- `extraction` 可省略或只提供更小预算；类型、未知字段和超上限值均拒绝。没有 SDK/数据库/embedding 新依赖。
- `enabled:false` 阻止项目记忆访问。
- 项目 `learningMode:off` 或 `longTermMode:off` 是长期提炼的硬边界；不能靠会话 curate auto 绕过，须显式修改项目配置。
- `/memory learn off` 停止本会话自动工作记录、交接及提炼；`learn on` 恢复会话工作记录。保留 M2 的工作记录显式覆盖行为，但不会解除项目对长期提炼的硬 off。
- `/memory curate off|review|auto` 仅控制本会话长期提炼，不关闭工作记录；新会话/reload 重置为项目策略。
- 显式保存、读取和人工审核不受 learning off 限制，但仍受标记、enabled 和项目作用域约束。

## 3. 命令与工具

| Pi 命令 | 作用 |
|---|---|
| `/memory status` | 有效策略、候选计数、预算和本会话/项目诊断及已报告 usage |
| `/memory review` | 最多 20 个 pending 或批准后尚未发布的候选摘要，附截断信息 |
| `/memory review <uuid>` | 查看候选、来源、审核状态；正文最多 10000 字符，截断时提示用 CLI 查看全文 |
| `/memory review <uuid> approve` | 人工采纳或恢复同一批准操作；不升级 verification |
| `/memory review <uuid> reject` | 拒绝；已有不可变决定不能反转 |
| `/memory extract` | 显式提炼当前分支最近用户回合；尊重 off，可重新请求一次模型，不增加主任务回合 |
| `/memory curate off\|review\|auto` | 本会话长期策略 |

保留两个模型工具名称。`project_memory_search` 新增可选 `entityId` 精确过滤；`project_memory_save` 保持显式保存/修订/状态更新，不增加让模型自行批准候选或切换 auto 的参数。

CLI 不调用模型；提供文件操作和实体精确过滤：

```bash
# 标准输入 JSON：{requestId, entry, target?}
pi-project-memory v2 propose < candidate.json
pi-project-memory v2 candidates
pi-project-memory v2 review <candidate-uuid> approve
pi-project-memory v2 review <candidate-uuid> reject
pi-project-memory v2 search --entity <entity-uuid> <query>
```

CLI `candidates` 返回完整候选，仅用于显式审核，不注入默认上下文。`search --entity` 可与 `--all` 组合；后者只包含 inactive 知识，仍不搜索候选队列。CLI status 不代表宿主正在运行；Pi status 才报告当前宿主提炼能力和会话策略。

## 4. 提炼与 grounding 契约

`src/v2-extraction.mjs` 提供 `buildExtractionEnvelope`、`parseExtractionResponse`、`extractCandidatesV2`；宿主适配器位于 `v2.ts`，通过当前 `ctx.modelRegistry.streamSimple(...).result()` 调用当前模型，不引入额外 SDK，也不给嵌套请求提供工具。

- 输入只包含最近用户回合的可见文本，不含 thinking、图片、工具参数、全部历史或记忆工具返回的回声；不会因文件定位读取文件或执行命令。
- 敏感过滤先于截断和发送；超长原文直接丢弃。用户约束优先，工具失败消息仍保留安全文本。
- 来源严格分为 user-statement / tool-observation / assistant-claim。用户文本不自动等于确认，工具 completed/failed 仅表示工具返回状态，不表示计算终止、收敛或有效。
- 只向模型提供当前显式任务实体对应的 current 记录，最多 20 个，不遍历额外计算文件。身份元数据不变，新增可选 `context: {source: 'background-only', text, truncated}`：由已存内容和已有 run 元数据构成，最多 800 UTF-16 code units，用于区分同名运行而非证明新事实。
- `buildExtractionEnvelope` 的实体输入可选 `context` 为字符串；输出才包装为上述带来源对象。缺失保持兼容，非字符串拒绝；完整源先做敏感过滤，再有界截取。过长源/敏感描述丢弃但可保留安全身份；路径只是文本，不触发读取。
- 原有本轮证据、全部可容纳身份和 state/overview 背景优先，最后才尝试装入实体描述；总序列化输入预算不变，装不下时省略描述并记 `entity-context-truncated`。state/overview 同样标为 background-only；实体 context/旧背景均不能 grounding，也不会被自动复制进候选正文或升级科学状态。
- 模型只选择 kind、标题、精确引文、已有实体和显式修订目标；不能生成自由正文、数值结果、provenance、verification 或 run 状态。
- 严格 JSON；每条最多 4 个来源，quote 必须为保留证据中的精确 12–500 字符片段，标题须来自引文。先校验整个输出批次，再入队；任一候选 grounding/schema 不合法，整批不写入。
- 程序保存**整个保留来源片段**，而非只保存模型选出的短句，保留否定、计划、建议和截断标识。turn 定位由项目/会话/回合身份摘要及片段 id 构成，对应候选中保存的文本，不代表文件内容已核验。

模型响应示例：

```json
{"candidates":[{"kind":"runs","title":"SCF did not converge","grounding":[{"id":"m1","quote":"SCF did not converge."}]}]}
```

这只证明文本 grounding，**不证明语义、数值或科学正确**。分类与标题仍可能不当，需结合完整保留片段检查。所有提炼候选均为 model-extraction / reported；run 字段保持 unknown、validity 为 unchecked。模型不能推断计划已执行、错误已修好或数值已收敛。结构化数值的自动 grounding 未开放；已有 M1 显式科学记录接口仍可由用户请求使用，不属于自动认证。

## 5. 候选生命周期与恢复

候选与决定分别是 `.internal/candidates/<uuid>.candidate.json` 和 `<uuid>.decision.json`，与 M1/M2 共用项目写锁、安全路径和独占原子发布。候选不进入知识清单，pending/rejected 不参与任何知识召回。

review 决定是否采纳；verification 表达证据性质。人工 approve 不等于用户确认候选事实。auto 使用相同发布路径，决定记录 `reviewer:auto`；人工操作为 user，旧决定缺省按 user 解释，不改旧文件。**两者均不升级验证或科学状态**。auto 遇到已拒绝候选会跳过，不覆盖拒绝。

新记录不按标题合并。修订须显式 `target:{id,expectedRevision}`，只能选择提供的记录及确切版本，发布时再查引用、kind 和当前版本；冲突报 revision-conflict，保留已有知识。

显式 propose 只接受 assistant-claim/model-extraction、reported/unresolved、current；默认 assistant-claim/reported。无数值 grounding 合约时拒绝结构化 result，run validity 只能为 unchecked。requestId 必须为 UUID v4；重试幂等，不同内容复用身份报 request-conflict。提炼器按项目/回合/候选内容生成稳定 UUID；显式重复 extract 仍会调用模型，但不会重复写同一候选。

批准决定先持久化，再幂等发布 M1 规范记录。中断、off 或冲突可能留下 approved + publication pending，这不是已发布知识；检查原因后可重复同一批准操作恢复，不能改成 reject。记录已提交但投影失败时遵循 M1 projection pending，可显式 `pi-project-memory v2 rebuild` 恢复缺失/精确匹配旧版的视图；手工编辑仍拒绝覆盖。publication committed 仅表示规范记录已存在，不代表所有视图已更新。

候选/决定合计上限 10000 个目录项、50 MiB，单文件 250000 字节；未发布临时文件不解析，但计入目录项上限。达到限制停止，不自动清理；崩溃锁不抢占，只能在确认写进程已退出后显式恢复。

## 6. 取消、预算与诊断

默认/硬上限：输入 48000 UTF-16 code units，含 JSON 元数据和系统提示，可缩至 2048；工具单项 8000（最小 80），用户/助手单项 4000；最多 2000 条消息、每条 256 个内容块，原文最多 250000 字符。输出最多 48000 字符、请求最多 6000 tokens、超时最多 60000 ms；每批最多 8 个候选。候选数是上限，不是配额。

新用户/custom 范围、会话切换/fork/reload/shutdown、learn/curate 变化会撤销作用域并 abort 请求；主任务 signal 也会转发。配置关闭或策略/预算变化在写入前再次检查。共享锁内、规范记录和投影视图发布前都有守卫。超时/取消后不采纳迟到响应；适配器须配合 signal，无法强行终止忽略信号的外部操作或阻塞事件循环的同步函数。

多候选写入不是整批事务；中途失效时保留已完整发布的 pending 候选或规范记录，返回 partial、准确数量和原因，不删除或回滚。规范记录先于 off 完成而投影尚未完成时，只报告已提交记录及 projection pending，不继续写视图。

`/memory status` 聚合本会话/项目的 modelCalls、attempted/accepted/queued/duplicates/published、准备输入/返回字符量和安全原因计数。usage 只记录适配器实际返回的非负整数 inputTokens/outputTokens，失败/截断响应有可用 usage 时也保留；缺失不补零、不推断费用，不声称已合并宿主总额。切换项目或会话不混入旧统计。

默认诊断不持久化原始 prompt、模型响应、provider 错误或路径值；仅候选按上述契约保留已过滤的引文来源片段。敏感过滤为启发式，不是完整 DLP 保证。内核无自动重试；同一自动回合失败后须新回合或用户显式 extract 才重新调用。

## 7. 实体召回与验收边界

显式 entityId 是精确过滤；API entityIds 是有界排序上下文。BM25 加实体匹配优先级；默认上下文采用 state 实体和提示中的显式 UUID，存在活动实体时不混入无关方法/运行。只读当前项目的 current 修订，排除 pending/superseded/archived；reported/unresolved 始终标注 requires verification。

按来源、kind、实体和完整内容摘要去重，避免相同来源反复占预算；不同实体或互补内容不合并，不能只比较截断摘要。概览/状态仍优先，总上下文默认不超过 12000 字符，无 embedding、跨项目或语义召回。

检索 excerpt 仍最多选七条匹配/回退行、1400 个 UTF-16 code units；超长摘录保留首尾并显示 `[... bounded excerpt ...]`，不保证中部或未选行信息完整。默认知识上下文每项最多 1600 个 code units，按 JSON 转义后的实际长度缩减 excerpt，保留完整的身份/来源/运行/结果元数据；元数据本身放不下时仅显示 `knowledge omitted: insufficient context budget; inspect source`，不注入残缺 JSON。小预算或截断情况下必须检查原记录，不能把知识路径出现当成相关事实完整恢复。

验收采用隔离临时项目、合成证据和本地确定性 provider，包括真实宿主 JSON/print/RPC。它验证软件路径，不证明远程模型表现或科研结论。完整命令和结果见 [测试报告](../testing.md)；未验证 PTY/TUI、TypeScript 静态类型和真实科学质量。下一阶段为 M4 质量评测与文档去本地化，发布/隐私清理/新历史仍需单独授权。
