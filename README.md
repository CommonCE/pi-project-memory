# pi-project-memory

面向当前 `@earendil-works/pi-coding-agent` 的**项目原生、本地 Markdown 记忆插件**。

本项目只负责记忆，不接管 Pi 启动，不配置代理、模型或认证，也不提供 shell 启动包装。用户按自己的环境启动 Pi 后，在插件内使用记忆功能；外部 CLI 仅作为可选的记忆管理与离线维护接口。

> **下一版开发中：M1 存储、M2 工作记忆与 M3 长期提炼/审核/实体召回已实现。** 新格式使用项目内 `.pi-memory/`；独立 `v2.ts` 支持工作记录、状态、上下文和交接，并默认以 review 模式有界调用当前宿主模型提炼候选，auto 须显式开启。提炼与批准不升级科学验证；不需额外模型调用时设置 `longTermMode: "off"`。默认安装入口仍是旧 `index.ts`，**不要同时加载两套扩展**。旧配置不迁移、不覆盖。见 [M3 使用与边界](docs/next/m3-usage.md)、[M2 工作记忆](docs/next/m2-usage.md)、[M1 存储](docs/next/m1-usage.md) 和 [开发计划](docs/next/README.md)。下文仍说明旧版插件行为。

0.2.0 增加回合结束自动学习、候选审核队列、压缩前交接快照和显式初始化命令，按实际项目工作流替代 pi-memctx，不追求完整复刻。沿用旧插件的分类目录、frontmatter 与 Obsidian wikilinks 思路，独立实现，不依赖旧插件，也不自动接管旧配置。

0.2.1 将未绑定项目的默认 pack 改为 `项目根/pi-memory/packs/<目录名的安全 slug>/`，包括低层 init；已有显式配置和注册绑定保持不变。中央 vault 默认只保存项目注册索引。兼容旧 writer 为非拉丁标题生成的 `.md` 文件：仅接受有效笔记 type/title，仍排除其他隐藏文件、隐藏目录、符号链接和敏感内容。

## v2 M5：文件夹作用域（显式入口）

M5 已实现并通过本地隔离契约测试；真实项目/真实模型的目录续接效果未验证。
仅适用于显式加载的 `v2.ts`，不改变下文 v1 默认入口、版本号或旧 pack。

- `scope: {path, inherit}`：相对项目根 POSIX 路径，根为 `.`，inherit 默认 true。
  无 scope 的旧记录按根消费，不回写；缺失 inherit 保留 path。新知识默认归当前真实 cwd，修订默认保留原 scope。
- 默认召回仅当前目录及可继承祖先；兄弟目录需 `allFolders` / `--all-folders`，或显式实体引用。
  命中包含 scope/scopeRank；BM25 只在过滤后语料计算，不直接比较不同目录的分数。
- 允许内部空格、中文及常见标点；根内链接按真实路径解析，拒绝根外逃逸。
  历史目录可不存在，不自动迁移改名后的目录。`folder list` 标出 missing。
- 每 session 首轮简报 ≤1200 字符，上下文总计 ≤12000 字符；显示运行四轴原值、未闭合项、待审核数和权限边界。
  “继续”不授权提交或重跑；审核不会提升科学验证等级。
- 目录页与索引为只读派生视图，不参与 grounding；显式 rebuild 生成，手改冲突默认拒绝覆盖。

```bash
pi-project-memory v2 folder list
pi-project-memory v2 folder rebuild
pi-project-memory v2 folder show '01 opt'
pi-project-memory v2 search 'SCF' --folder '01 opt'
pi-project-memory v2 search 'SCF' --all-folders
# 仅显式授权覆盖手改派生页时使用 v2 folder rebuild --force
```

`project_memory_search` 增加 folder/allFolders；`project_memory_save` 增加 folder/inherit。
Node API 直接构建简报用 `buildWorkingContext(project, prompt, {firstTurn: true})`；扩展负责 session 去重。
工作状态修订号仍为全局序列；自动提炼候选与审核发布保留目录，不让模型猜 scope。
建议自行将 `.pi-memory/` 加入项目 `.gitignore`（不会自动改写）。详见
[M5 设计与验收](docs/next/m5-folder-scope.md)、[ADR 0006](docs/decisions/0006-folder-scoped-memory.md)、[测试报告](docs/testing.md)。

## 0.3.0：Pi 1.2 与计算化学项目

已对 npm 最新发布的 **Pi 1.2.0** 做离线宿主集成验证。兼容 `before_agent_start` 的 user/custom 联合事件；custom 消息启动的回合不检索、不重新学习上一用户回合。仍使用宿主 TypeBox 与 `ctx.modelRegistry.streamSimple()`，不复制 Pi 依赖。

### 推荐配置（不改写已有记忆）

新项目可以在 Pi 内初始化时直接设置 profile，无需再手改 JSON：

```text
/memory-init 我的计算项目 --profile qchem
# 不提供名称也可以
/memory-init --profile qchem
```

可选外部 CLI 的 `pi-memory-init [name] --profile qchem` 提供相同初始化能力，见下文「可选 CLI」。

支持 `--profile default|qchem`、`--profile=qchem` 和选项置前；`pi-project-memory setup` 同样支持。CLI 名称含空格需加引号，Pi 命令名称可直接含空格或加引号。未指定 profile 时沿用原行为；指定值会写入新项目配置。已有配置不重写：相同生效 profile 可重复初始化，不同 profile 明确报错，需要自行修改现有配置；已有注册 pack 没有项目配置时仅新建 profile 字段，不重绑定或覆盖笔记。初始化仍只建目录与配置，不扫描计算文件或生成知识笔记。

在**目标计算项目**运行 `/memory-init`（已有记忆项目无需重复初始化），在该项目现有 `.pi/project-memory.json` 中**合并**下面字段，保留原来的 `id/name/packPath`：

```json
{"profile":"qchem","learningMode":"suggest"}
```

完整新项目示例见 `examples/qchem-project-memory.json`，不要用示例覆盖已有绑定配置。插件每轮读取配置，下一轮即生效；更新插件代码后需要 `/reload`。

| 容量 | default（保持旧默认） | qchem |
|---|---:|---:|
| 自动注入/未指定 limit 的搜索条数上限 | 4 | 8 |
| 注入字符预算 | 8000 | 16000 |
| 学习输入字符预算 | 24000 | 48000 |
| 每个工具输出字符上限 | 2000 | 8000 |
| 每轮候选上限 | 4 | 8 |
| 学习输出 token 上限 | 3000 | 6000 |

这些都是**上限，不是条数配额**。qchem 扩大已有可见证据的窗口，尤其适合计算日志与 codemode 批量输出；不会主动读日志、更不会运行计算。长输出仍有首尾截断，需先在主任务中提取关键行/表格，不能假设中间内容完整保存。最新用户目标/约束优先保留，避免被工具输出挤出学习预算。更大窗口可能增加模型费用和延迟。

学习优先把有证据的独立知识分为体系定义、确定的方法及理由、已检查的结果、可复用排错流程、明确约定的后续验证行动；不会按每个参数拆条或把计划当结果。qchem 检索增加小型中英文**主题词**扩展（如盆积分 ↔ Bader、基组 ↔ basis、自洽 ↔ SCF），笔记 tags 也参与索引。不是语义搜索，也不代表方法/物理量等价；原有状态、作用域及隐私过滤不放宽。

排查“记忆少/用不上”先运行：

```text
/memory status
/memory stats
/memory review
/memory review show <id>
/memory review approve <id>
```

`stats` 区分已保存总数、可默认检索、未核实、被替代、交接和待审核。系统 manifest 不计入笔记总数，状态分类与 handoff 分类可能重叠；扫描有上限，`truncated` 为 true 时不是全库精确统计。**待审核候选不参与检索**；批准也不会将 unverified 改为 active。

若你愿意接受模型误归纳风险，可将项目配置的 `learningMode` 改为 `auto`，或用 `/memory learn auto` 仅在当前会话自动保存。默认仍推荐 suggest，不会自动批准旧 pending 候选。也可以直接请求 Pi“把已核实的体系、方法、结果和下一步分别记入项目记忆”，用显式保存工具及时保存。

以上数值字段现在均允许项目级覆盖。优先级：内置默认 → 生效 profile → 显式全局数值 → 显式项目数值；profile 为项目优先于全局。`learningToolChars` 范围 500–16000，`learningOutputTokens` 范围 1000–12000。用 `/memory status` 检查实际值；手动选择项目时采用目标项目配置。

## 特性与边界

- 从真实 cwd 向上查找最近的 `.pi-root` **文件**；找不到就进入 `NO-MEMORY`，不读项目配置、注册表或 pack，不注入、不自动保存。同名目录不算标记。
- 标记只用于定位，不执行其内容。`.git`（含 worktree 文件）、JSON、旧注册记录或手动选择不能替代标记。每次操作重新检查标记，删除标记会撤销旧句柄；不会清除已有会话历史。
- 子目录归属最近标记根；嵌套 `.pi-root` 建立独立边界。默认 id 为目录名 + 真实路径 SHA-256 前 12 位，符号链接访问同一根得到相同 id。固定 id 可显式共享 checkout 记忆。
- 检索使用本地中英文关键词/BM25，无数据库或嵌入依赖。不支持 semantic/deep、跨语言语义召回或 Gateway 充分性判定；中文分词仍以双字组合为主，单字查询有召回限制。
- 自动注入有限长度的相关参考片段；没有命中就不注入，不强制限制模型检查源文件。记忆不是指令，当前源码/实时状态优先。
- 笔记总是新建，不覆盖已有结果。自动候选与压缩重试使用确定性去重文件名。
- 回合结束调用当前 Pi 模型提取候选，默认人工审核；压缩前交接纯本地，不额外调用模型。
- 旧 Markdown pack 可原地接入。工具名不同于旧插件；**不建议同时启用两套自动注入/学习**。

## 安装与显式初始化

```bash
# 设置为当前 checkout 的绝对路径；后续命令可在目标项目目录执行
export PI_PROJECT_MEMORY_REPO="/path/to/pi-project-memory"

# 临时加载，不修改 Pi 配置
command pi -e "$PI_PROJECT_MEMORY_REPO/index.ts"

# 验收后永久安装本地包
command pi install "$PI_PROJECT_MEMORY_REPO"
```

先通过 `command pi config` 禁用旧 pi-memctx 扩展资源，保留旧记忆。运行目录应是目标项目，而非多个项目的共同父目录。

Pi 中显式启用：

```text
/memory-init 我的项目
/memory status
```

无需修改 `.bashrc` 或接入项目提供的启动函数。代理、认证和已有 shell 集成由用户自行管理；本插件不修改或清除它们。旧插件切换仅涉及扩展加载和记忆绑定，见 [迁移说明](docs/migration.md)。可选的外部记忆管理接口见下文「可选 CLI」。

`/memory-init [name]`、CLI `setup [name]` 是用户明确授权的启用动作，可创建 `.pi-root`、`.pi/project-memory.json` 和项目内 `pi-memory/packs/<name>/`。普通启动、学习和交接不会创建标记。已有配置/绑定保留，不自动重绑定；从子目录执行时沿用最近祖先标记。

旧 `pi-init` 创建的单个 pack 会被绑定并补充缺少的目录/manifest，不覆盖旧笔记；多个旧 pack 需给出匹配名称或显式 `adopt`。不改写 `.gitignore`，建议自行添加 `pi-memory/`，不要公开提交会话记忆或审核证据。

原有低层初始化也保留，新建未绑定项目同样使用项目内 pack，不再默认把正文放进中央 vault：

```bash
touch .pi-root
```

```text
/memory init
```

无标记时，除显式初始化外，保存、接入、审核、列出项目和手动选择均被拒绝；搜索返回空。无记忆目录仍可正常使用 Pi。

## Pi 命令

| 命令 | 作用 |
|---|---|
| `/memory-init [name] [--profile default\|qchem]` | 显式启用并初始化项目，可选择配置档 |
| `/memory` / `/memory status` | 显示根、id、pack、学习模式、交接开关和待审核数 |
| `/memory stats` | 有界笔记清单统计：保存/可检索/未核实/替代/交接/待审核 |
| `/memory init` | 已有标记项目的低层初始化；不扫描源码或调用模型 |
| `/memory projects` | 列出注册项目 |
| `/memory use <id>` | 当前 cwd 和目标项目均有标记时，手动切换目标 |
| `/memory auto` | 返回 cwd 自动归属 |
| `/memory search <query>` | 搜索当前目标 pack 的 active、非交接笔记 |
| `/memory search --all <query>` | 显式包含未核实、被替代和交接笔记；显示状态、身份及时间 |
| `/memory adopt <path>` | 注册已有单个 pack，不修改旧 pack |
| `/memory learn off\|suggest\|auto` | 当前会话学习模式；新会话/reload 重置 |
| `/memory review` / `/memory review all` | 列出待审核 / 全部历史候选 |
| `/memory review show <id>` | 查看候选、原文证据与来源 |
| `/memory review approve <id>` | 批准生成新笔记；保留笔记状态，unverified 不自动变 active |
| `/memory review reject <id>` | 拒绝，不生成笔记，保留决定记录 |

`<id>` 支持至少 8 位唯一十六进制前缀，不使用容易变化的列表序号。手动选择只在当前会话有效；`session_start` 会恢复自动归属。普通提示词中的项目名不会触发跨项目切换。

## 自动学习与审核

默认 `learningMode: "suggest"`。成功的 `agent_end` 读取最近用户回合的有限文本证据，调用当前 Pi 模型提取最多 4 个候选。输出必须包含匹配输入证据的原文引用。无证据、非法 JSON、明显敏感内容或非法笔记会被丢弃；失败、取消或输出截断的回合不学习。无标记、尚未 `init` / `adopt` 的项目不学习。

- `suggest`：候选进入隐藏队列，**未批准候选不参与检索/注入**。
- `auto`：通过基本校验的候选直接批准保存，同时保留候选和决定记录。原文匹配不保证推论真实，需接受误归纳风险。
- `off`：没有学习模型调用；不影响显式保存或交接快照。

候选和审核决定均独占创建；决定不可反转、不删除历史。同项目相同规范化笔记去重（类型/标题/正文/标签及非默认状态、替代路径、来源定位等元数据）。无新字段的旧候选 identity 保持不变，旧队列无需迁移。批准保存后、决定写入前若中断，重试会复用同一笔记。默认最多 200 条待审核；队列满后先审核。崩溃可能留下 `.learning/.lock`，确认没有并发进程后才可人工清理，不会自动抢占锁。

通常每个成功回合增加一次模型调用：默认最多等待 **60 秒**（源码 `DEFAULTS.learningTimeoutMs = 60000`），证据约 24000 字符，输出最多 3000 tokens。调用使用当前 provider 和认证，**增加延迟、token 和费用**。返回 usage 保存在 `project-memory-usage` 会话自定义记录，目前不会自动计入 Pi 内置汇总费用。超时或失败不改变主回合结果，也不会启动额外后台进程。

候选提取优先用户明确确认的项目约定、已确定的方法及原因、本轮可见证据支持的结果/排错、影响后续工作的明确决策。允许零候选，跳过寒暄、重复信息、临时命令、一次性进度及准备尝试的参数。计算化学结论必须限定体系/任务/方法，区分模型问题与程序执行问题，保留单位与定义；期望结果、助手建议和对话原文引用都不能证明计算成功或收敛。未核实内容只有确需长期保留时才使用 `unverified`，一般临时推测直接跳过。不新增科学语义验证器；0.3.0 的 qchem profile 扩大预算，但不以条数代替质量。

新候选用 `grounding: [{"id":"m0","quote":"原文引用"}]` 保存对话定位与精确引用校验，用可选 `evidence: ["文件定位：说明"]` 保存笔记来源定位。仍兼容旧候选 `evidence` 中的引用对象；队列记录原有原文引用字段及审核流程不变。两种引用都只提供来源，不证明科学正确性。`suggest` 人工批准与 `auto` 保存均不会将笔记 `unverified` 改成 `active`。

学习和交接只写 cwd 自动归属项目。`/memory use` 手动选择期间暂停自动写入，避免当前对话误存到另一项目；显式搜索、保存和审核仍可使用手动目标。会话/目标切换取消未完成学习，持久化前重新核对作用域和标记。

## 压缩前交接

`session_before_compact` 在正式压缩前保存 `80-sessions/` 快照，包含即将压缩的**已投影消息片段**中的最近目标、助手状态/下一步、部分工具结果和前次摘要。不读取被省略/替换的原始分支消息，不保存 thinking、图片、工具参数或完整对话。

新快照标记 `handoff: true`，默认搜索及自动注入排除；用 `/memory search --all <query>` 或搜索工具的 `includeHandoffs: true` 显式查询，返回 `handoff` 身份、`created`（若有）及 `updated` 时间。插件自己生成的旧快照以 source、session 类型、精确标题、专用标签和正文签名联合识别，不改写它们；普通 session 笔记或 `80-sessions/` 下的其它文件不会被一概排除。

这是本地抽取的**有界快照，不是额外 LLM 摘要**；助手陈述标记为待核实。不会被压缩的最近保留消息不一定出现在快照里。相同压缩重试去重；不改变 Pi 的摘要、保留边界或压缩策略。保存失败也继续正常压缩；后续压缩取消/失败仍可能留下已保存快照。可用 `handoffEnabled: false` 关闭。

## 模型工具

### `project_memory_search`

```json
{"query":"部署流程","limit":5}
```

未指定 limit 时使用生效 maxItems（default 4、qchem 8），显式 limit 上限 20；返回路径、标题、状态（`status` 是有效检索状态，`declaredStatus` 是文件声明状态）、替代关系、来源定位、交接身份、创建时间（若有）、文件更新时间、相关片段、评分、扫描截断状态及 `diagnostics`。评分不是事实正确性/覆盖率判断。

默认只检索 active、非交接笔记；显式检查全部历史：

```json
{"query":"Mn oxide 设置","limit":10,"includeInactive":true,"includeHandoffs":true}
```

两个开关独立：只包含未核实/被替代笔记用 `includeInactive`，只包含 active 交接笔记用 `includeHandoffs`；如交接笔记被另行标为 unverified，也需同时启用 `includeInactive`。显式历史搜索结果不等于可以自动注入。

### `project_memory_save`

```json
{"type":"runbook","title":"发布前检查","content":"运行项目测试；生产发布需要人工批准。","tags":["release"]}
```

类型：`context`、`action`、`decision`、`observation`、`runbook`、`session`。直接保存长期知识，不经过候选队列；需要先初始化。不提供任意项目选择参数。相关新可选字段和计算化学示例见下一节。

## 笔记状态、来源定位与计算化学示例

- `status`：`active`（默认）、`unverified`、`superseded`。无字段的旧笔记按 active 保持原有可检索行为；**active 只表示默认检索资格，不代表科学验证**。未知/无效状态按 unverified 排除并给出诊断。
- `supersedes`：被替代笔记的 **当前 pack 内相对 Markdown 文件路径**，不是项目路径或 wikilink。新 active、非交接笔记的有效引用使目标在默认检索中视为 superseded，旧文件不改写；同名标题不会触发替代。unverified 或已声明 superseded 的笔记不能使其它笔记失效。
- 新保存时拒绝越界、绝对路径、反斜杠、隐藏目录、非 Markdown、不存在目标或后代符号链接；pack 根本身原有的符号链接支持不变。读取已有笔记时，自引用、循环、进入异常链的关系及不可用目标被忽略并返回诊断，不静默隐藏正常笔记。关系只对当前 pack 的有界、安全可读清单生效；扫描截断、文件过大或敏感过滤可能使目标不可用，此时不推断失效。
- `evidence`：最多 10 个非空单行字符串，每项最多 500 字符，保存定位和说明，沿用敏感过滤。不读取定位文件、不执行字符串中的命令、不搜索项目外部文件。优先项目相对路径；不编造路径、行号、结果或用户确认事实。source 保留原语义，新 writer 仍写 `source: pi-project-memory`。
- `handoff`：可选布尔标记，压缩前新快照自动设为 true。普通笔记无需设置。
- 字段写入普通 frontmatter（字符串列表写成 JSON 数组，亦是合法 YAML）；读取 evidence 也支持缩进的逐行字符串列表。不是完整 YAML 引擎，不执行 YAML 标签/别名。

所有更新仍新建笔记，不提供撤销审核、恢复旧版本或原地状态编辑。旧笔记不批量分类，不补写 evidence，不调用模型重审。体系、方法、电荷、多重度、磁态和单位写在正文中。

以下为**虚构的格式示例，不是本项目真实设置或结果，也不是通用计算建议**；只有实际证据成立时才保存。

### 示例 1：计算设置更新，显式替代旧设置

先搜索核对旧笔记的 `relativePath`，再以用户实际确认的新设置新建笔记；下面路径仅为示例：

```json
{
  "type":"decision",
  "title":"Mn oxide slab 静态计算设置更新",
  "status":"active",
  "supersedes":"50-decisions/mn-oxide-old-settings.md",
  "content":"适用范围：本项目 Mn oxide slab 的 VASP 静态计算。用户已明确确认 Mn 3d 使用 Dudarev Ueff=4 eV；其它参数沿用已核对的项目输入。替代旧设置；此选择的理由是与本项目参考模型保持一致，不能泛化为其它 Mn 体系的通用 U 值。",
  "evidence":["用户明确确认：本项目 Mn 3d 使用 Ueff=4 eV"]
}
```

### 示例 2：有来源文件定位的计算结论

```json
{
  "type":"observation",
  "title":"体系 A 静态计算及 Bader 结果",
  "status":"active",
  "content":"适用范围：体系 A 的本轮 VASP 静态计算，PBE/PAW-D3(BJ)，中性、自旋极化。已检查该运行的电子收敛记录；该步 OUTCAR 的 TOTEN=-123.456 eV，指该设置下的总能量，不是吸附能。原子 1 的 Bader 净电荷为 +0.42 e，定义为实际 PAW ZVAL 减去盆积分电子数。软件版本、完整参数及 ZVAL 来源以对应运行记录为准，缺失信息需补核，不由定位字符串推断。",
  "evidence":["calc/static/OUTCAR：对应步 TOTEN 及电子收敛记录","analysis/bader_summary.csv：原子 1 的盆积分及净电荷定义"]
}
```

若仅有助手转述、尚未检查对应输出，应跳过临时猜测；确需长期跟踪时改用 `status: "unverified"` 并在正文明确未核实项。即便审核批准，该笔记仍不参加默认检索。

## 存储与接管旧记忆

默认注册索引：`~/.pi/agent/project-memory/projects/<id>.json`。新建、未绑定项目的正文默认留在项目根：

```text
<project-root>/
  .pi-root
  .pi/project-memory.json           # 显式 setup 的项目配置（可选）
  pi-memory/packs/<project-slug>/
    00-system/pi-agent/memory-manifest.md
    00-system/pi-agent/.learning/
        candidates/<id>.json        # 原候选与有限原文证据
        <id>.json                   # 不可变审核决定
    00-system/indexes/              # 预留，暂不维护动态索引
    20-context/
    40-actions/
    50-decisions/
    60-observations/
    70-runbooks/
    80-sessions/
```

显式 `memory-init` 和未绑定项目的低层 init 均默认建立**项目内 pack**，注册仍在中央 vault；已有显式绑定不会迁移。新笔记包含 `type/project/pack/title/created/updated/tags/source/status` frontmatter，可选 `supersedes/evidence/handoff`，链接到 manifest。不合并或改写同名旧笔记；更新通过新笔记的显式替代关系完成。

旧 Markdown 有无 frontmatter 均可搜索；未宣称满足旧插件全部校验器。先备份记忆、禁用旧插件，再在有标记的目标项目执行：

```text
/memory adopt /absolute/path/to/vault/packs/project-name
/memory status
/memory search 项目约定
```

`adopt` 无需先 init，只写注册记录，原 pack 不变；后续保存/学习会直接写入该 pack。显式 init 可补齐目录/manifest，但不覆盖旧文件。已有 id 绑定别处时拒绝覆盖；请核对后使用新的明确 id。未实现只读接入，也不自动解释旧 `workspace-map.json` 或 `MEMCTX_*`。真实旧包映射需自行确认。

## 配置

可选全局文件 `~/.config/pi-project-memory/config.json`：

```json
{
  "enabled": true,
  "vaultPath": "~/.pi/agent/project-memory",
  "maxItems": 4,
  "contextChars": 8000,
  "maxFiles": 1000,
  "maxBytes": 8000000,
  "learningMode": "suggest",
  "learningTimeoutMs": 60000,
  "learningInputChars": 24000,
  "learningMaxCandidates": 4,
  "queueMaxItems": 200,
  "handoffEnabled": true,
  "handoffChars": 10000
}
```

自动学习默认超时为 60 秒，适用于响应较慢的模型或代理；全局 `learningTimeoutMs` 可覆盖该默认值（范围 100–120000 ms）。超时会中止本轮学习，不影响主任务，但延长时限不能修复网络断连。`/memory status` 显示实际全局配置路径及生效超时。

项目 `.pi/project-memory.json`：

```json
{"id":"my-service","name":"我的服务","enabled":true,"learningMode":"suggest","handoffEnabled":true}
```

- `enabled: false` 禁止该项目的记忆读写；`enabled: true` 不能绕过标记。
- 固定 id 可保持迁移后的身份，多个 checkout 使用同一已注册 id 会共享 pack。
- `packPath` 支持绝对路径、`~/` 或相对项目根路径，例如 `pi-memory/packs/my-service`；不能填多个 pack 的父目录。
- 归属顺序：最近 `.pi-root` → 会话手动选择 / 根内配置 / 注册绑定 / 推导 id。没有标记就不进入后续解析。非法配置明确报错，不默默切换 pack。
- 学习模式：会话 `/memory learn` > 项目配置 > 全局配置；交接开关为项目配置 > 全局配置。
- `contextChars`、`learningInputChars`、`handoffChars` 是字符，不是 tokenizer tokens。
- `maxFiles` 限制遍历条目数（含目录），`maxBytes` 限制 Markdown 总量。单文件 >200 KB、隐藏条目、后代符号链接、>12 层目录跳过；只有带有效 type/title 的旧 `.md` 普通文件例外。pack 根本身允许符号链接。
- `PI_PROJECT_MEMORY_HOME` 覆盖 vault；`PI_PROJECT_MEMORY_CONFIG` 指定全局配置文件。

## 可选 CLI

普通使用以 Pi 内命令和工具为主，无需 shell 集成。现有 CLI 保留为可选的记忆管理、诊断与离线维护接口，不负责启动 Pi。本地 `pi install` 不保证将包内 CLI 加入 PATH，可直接调用 Node 脚本。

下列命令沿用安装节设置的 `PI_PROJECT_MEMORY_REPO`；先进入需要操作的目标项目目录。

```bash
node "$PI_PROJECT_MEMORY_REPO/bin/pi-memory-init.mjs" "我的项目"
node "$PI_PROJECT_MEMORY_REPO/bin/pi-project-memory.mjs" status
node "$PI_PROJECT_MEMORY_REPO/bin/pi-project-memory.mjs" search 部署
node "$PI_PROJECT_MEMORY_REPO/bin/pi-project-memory.mjs" search --all 计算设置
node "$PI_PROJECT_MEMORY_REPO/bin/pi-project-memory.mjs" review
node "$PI_PROJECT_MEMORY_REPO/bin/pi-project-memory.mjs" review approve <id>
printf '%s\n' '{"type":"context","title":"技术栈","content":"项目使用 PostgreSQL。"}' \
  | node "$PI_PROJECT_MEMORY_REPO/bin/pi-project-memory.mjs" save
```

`pi-project-memory setup [name]` 等价于 `pi-memory-init [name]`。CLI 使用 cwd 自动归属，不沿用 Pi 会话手动选择。错误退出码 1。

## 安全边界

- 不执行笔记中的命令、不主动扫描源码、不启动后台任务。搜索与交接本地；学习会向当前模型 provider 发送过滤后的有界回合证据。
- 明显私钥、API key、JWT、密码赋值和 URL 凭据会被拒绝或跳过，过滤发生在截断前。不保存 thinking、图片或工具参数。
- **启发式过滤不能识别全部秘密、个人信息或客户数据**，也可能误报。审核证据同样可能敏感，保存/同步前须检查。敏感项目可设置 `learningMode: "off"` 和 `handoffEnabled: false`。
- 原文引用校验不是语义验证，自动保存不保证科学/技术结论正确；默认建议审核。交接助手状态是待核实快照，不是事实认证。
- 注入声明参考/非指令，但不是完整 prompt-injection 沙箱。
- 新文件先写完整的隐藏临时文件，再用同目录 hard link 原子发布；已有目标触发 EEXIST，不覆盖。新目录/文件请求 0700/0600，原权限不改。文件系统须支持 hard link；不支持时明确失败，不降级为非原子覆盖。进程崩溃可能留下隐藏临时文件/队列锁，不自动清理；不承诺断电耐久性。目录检查适合正常本地使用，不抵抗拥有同用户文件系统写权限的恶意并发攻击。
- 开发不会自动安装、改用户 settings/.bashrc、删除旧插件或迁移旧记忆；切换由用户显式执行。

## 开发与验证

Node.js >=22.19（与 Pi 1.2.0 一致）；TypeBox 和 Pi API 由宿主提供，不安装重复 host 包。
宿主相关检查须由调用者将 `PI_TEST_HOST_PACKAGE` 设置为实际 Pi 安装的 `package.json` 绝对路径，先确认文件存在；不假定全局 npm 安装布局。下列命令是复现说明，不代表本轮已执行。

```bash
npm run check
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" npm test
```

覆盖旧笔记默认 active、新状态/显式历史搜索、替代关系/异常诊断/不改写旧文件、evidence 限制及不访问定位文件、交接识别/排除、旧候选 identity/去重兼容、项目隔离、检索/显式保存、真实 Jiti/TypeBox、学习三种模式、审核/去重/中断恢复、超时/取消、初始化/CLI，以及真实 Pi RPC/JSON/print 子进程、会话重启恢复、多进程读写和规模测试。模型由确定性、本地离线 provider 提供，不调用远程模型；未设置宿主变量时跳过宿主集成测试。

Linux 上另有真实交互 TUI 的 PTY 验收：

```bash
python test/tui-smoke.py --host "${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}"
```

只使用 Python 标准库，测试初始化、学习、审核、批准、正常压缩和 `/reload`。具体结果与复现步骤见 [测试报告](docs/testing.md)。尚未验证远程 provider 的真实归纳质量、用户旧包映射或 TypeScript 静态类型检查。

MIT。
