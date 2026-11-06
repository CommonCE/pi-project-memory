# M2：工作记录、当前状态与 Pi 接入

本页说明 M2 工作层；其中“不调用学习模型”描述的是工作记录本身。当前 v2 已完成 M3，长期提炼默认 review，可产生一次额外宿主模型请求；开关、审核和边界以 [M3 文档](m3-usage.md) 为准。

状态：已实现独立 v2 扩展与工作记忆闭环。M3 的自动长期知识提炼/审核尚未实现。
M1 的显式知识存储契约继续适用，见 [M1 使用说明](m1-usage.md)。

## 1. 如何启用

当前包的默认扩展仍是旧 `index.ts`。新版入口为 **`v2.ts`**，不要同时加载两者：它们有相同命令和工具名称。
先在新的试验项目中临时加载：

```bash
cd /path/to/new-test-project
command pi --no-extensions -e "$PACKAGE_ROOT/v2.ts"
```

PACKAGE_ROOT 是实际源码/包目录；此命令不会改用户 Pi 设置。`--no-extensions` 禁用自动发现扩展，但保留显式 `-e`；若有其他必要扩展，请核对后逐个显式加载。
不要把测试用 offline provider 加到正常工作会话。

在 Pi 中：

```text
/memory-init 我的计算与软件项目
/memory status
```

初始化只建标记、配置和目录，不扫描源码或日志，不调用模型、不自动修改 ignore 规则。
旧项目配置会冲突，不覆盖、不迁移、不删除旧记忆。请自行审查并忽略 `.pi-memory/`，避免把私有记忆提交到公开仓库。
本阶段不更改仓库/包名称，也不进行 GitHub 发布。

## 2. 本阶段解决什么

```text
正常任务中的用户目标与完整工具观察
  → 本地、敏感过滤后的有界工作片段
  → 不可变 work 事件 + journal 视图
  → 当前 state 视图
  → 下次用户回合默认加载状态/概览，再检索相关知识
```

没有额外 curator 模型调用、远程记忆服务或后台任务。
用户新会话说“继续”时，不必依靠这两个字命中 BM25：最近实质目标、任务状态和观察会作为有界底座注入。

**不是科学结论自动认证，也不是完整对话归档**。M2 用确定性文本片段而非模型摘要；长输出仍可能丢失中间内容，实际归纳质量和真实任务效果需后续评测。

## 3. 三种内容的边界

- **用户请求**：表示目标/约束，不表示设置已采纳或任务已完成。
- **工具观察**：表示工具实际返回的有界文本；工具完成不等于计算收敛或结果有效。
- **助手陈述**：始终位于 `Assistant claims / unverified` 区域，不提升为长期知识或已验证结果。

主模型 error/aborted/length 或取消信号下，不采纳残缺助手陈述；已经完整返回的工具观察仍可保存。
无工具观察且助手文本不足 100 字符的普通回合不生成记录，避免简单寒暄。该规则只是启发式，不保证识别全部无用内容。
“继续”等短提示不替换最近的实质用户目标。

跳过 thinking、图片、工具参数、自身记忆工具返回、记忆注入消息和前一用户回合。
敏感过滤在截断前执行；含疑似秘密的整个文本片段可能被丢弃。过滤不是完备 DLP，也可能误报。
M2 不主动解析输入/输出、猜测结构、电荷、磁态或能量单位，更不执行任何任务。

## 4. overview 和显式任务状态

自动记录提供最近观察，但不会凭助手建议推断“用户已约定的下一步”。
项目概览和结构化任务状态可通过显式工具或 CLI 更新；两者都有独立 CAS 修订号，初始为 0。

CLI 格式示例（仅为合成开发项目演示，不是真实计算结论）：

```bash
printf '%s\n' '{"expectedRevision":0,"value":{"content":"合成解析器项目；入口 src/parser.mjs，测试夹具位于 fixtures/。"}}' \
  | pi-project-memory v2 overview
printf '%s\n' '{"expectedRevision":0,"value":{"goal":"完善解析器的失败输出处理","blockers":["缺少截断输出夹具"],"artifacts":["src/parser.mjs"],"notes":["尚未验证真实计算软件兼容性"]}}' \
  | pi-project-memory v2 state
pi-project-memory v2 work
pi-project-memory v2 context 继续
```

state 字段：goal（必需）、blockers、nextSteps、artifacts、notes、entities、provenance、evidence。
- goal 最多 1200 字符；blockers/nextSteps/notes 各最多 8 项，各最多 500 字符；artifacts/evidence 各最多 10 项。
- entities 最多 20 个同库已存在知识实体 UUID。
- provenance 默认为 assistant-claim，可为 user-confirmation 或 tool-observation。
- nextSteps 非空时，必须声明真实的 user-confirmation 和非空 evidence。此校验不能证明用户实际确认过；视图明确标注 caller-attributed。
- 更新是完整状态快照，不是 patch；必须给当前 expectedRevision。

Pi 工具 `project_memory_save` 的新接口：
- `target: knowledge`，entry 使用 M1 契约；修订提供 id 和 expectedRevision。
- `target: state`，提供 state 和 expectedRevision。
- `target: overview`，提供 content 和 expectedRevision。
- requestId 为可选 UUID，可安全重试相同请求。不同内容复用同一 requestId 会报冲突。

`project_memory_search` 返回关键词知识命中及有界 overview/state、它们的修订号。
显式 state/overview 存储并不表示用户授予运行、提交或删除权限。

## 5. 控制和默认预算

Pi 命令：

| 命令 | 作用 |
|---|---|
| `/memory status` | 状态、工作记录开关、默认上下文能力；当前 longTermCurator 取决于 M3 有效策略和宿主模型 |
| `/memory state` / `/memory overview` | 查看当前视图与修订号 |
| `/memory search <query>` | 查询当前知识 |
| `/memory get <uuid>` | 查看显式知识记录 |
| `/memory learn off` / `/memory learn on` | 当前会话关闭/开启自动工作记录；新会话/reload 重置 |
| `/memory review` | M3 已接入：列出待审核候选；可查看 UUID 并显式 approve/reject，不升级验证等级 |

项目配置新增可选字段：

```json
{"learningMode":"off","handoffEnabled":false}
```

必须合并进原 v2 配置，保留 schemaVersion/id/name/memoryPath/enabled，不用此片段覆盖整个文件。
- learningMode 默认为 on；off 同时停止自动 journal/state 和压缩交接，不影响显式保存与读取已有记忆。
- handoffEnabled 默认为 true；false 仅关闭压缩交接。
- enabled:false 关闭整个项目的记忆访问。
- 每次回合/写入重查边界；会话/目标切换会撤销捕获作用域。

自动上下文上限 12000 字符：优先状态摘要（最多 5500），概览（最多 2500），剩余用于最多 4 条相关知识（每条最多 1600，含整体预算限制）。
小预算优先保留任务状态，而不是让大概览挤掉目标。
查询结合当前提示和有限的当前目标，不跨项目；reported/unresolved 命中显式标记 requires verification。

## 6. 压缩与恢复

压缩前只取 Pi 的 canonical `messagesToSummarize`、`turnPrefixMessages` 和 previousSummary。
不从 `branchEntries` 复活已省略/替换的原始内容，不改变宿主压缩结果。
split-turn 可能只投影用户目标：只保存该目标，不补造助手回答。宿主仍保留的最新内容不一定出现在交接记录中。
相同投影和边界重试去重；压缩之后失败/取消也可能留下之前已完整保存的交接事件。

权威 work 事件位于 `.pi-memory/.internal/work/<sha256>.md`，保存序列和前一事件摘要；journal、state.md、overview.md 是派生视图。
工作事件和知识记录共用项目写锁。M2 工作事件独立上限为 10000 个目录项、50 MiB，总量不含另有界限的 M1 知识记录；单事件最多 100000 字节。
超过上限停止写入并报告，不自动清理或归档。

```bash
pi-project-memory v2 rebuild-work
```

此命令重建缺失或精确匹配旧事件投影的陈旧视图；手工编辑的根视图会报 view-conflict。
journal 手工编辑同样不会被覆盖；遇到记录已提交、投影失败，返回 projection pending，优先用同一请求重试或显式恢复。
崩溃遗留锁必须先确认没有写进程，再由用户显式处理；代码不自动抢锁。
初始化锁为 `.pi/memory-v2-init.lock/`，工作/知识共用锁为 `.pi-memory/.internal/write.lock/`。
不承诺断电耐久性或跨设备同步，不支持强制覆盖手工编辑。

## 7. 验证与剩余限制

使用临时隔离项目、确定性离线 provider 和真实 Pi JSON/print/RPC 验证，不调用远程模型或运行科学计算。
测试覆盖新会话续接、错误/取消、隐私过滤、off/重置、custom 回合、同一用户范围内低层重试、压缩投影、并发和崩溃恢复。
这些测试证明软件路径，不证明真实项目知识覆盖率、远程模型质量或科学有效性。

M3 现已实现长期提炼、候选审核及实体召回，详见 [M3 契约](m3-usage.md)。自动 journal 仍不会自动变成已验证知识，默认安装入口也未更改。
