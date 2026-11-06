# M5：文件夹作用域记忆与首屏简报

状态：已实现（本地隔离验收）。依据 [ADR 0006](../decisions/0006-folder-scoped-memory.md) 与 [v2 路线图](roadmap-v2.md)。T1→T9 已按测试先行推进；真实模型的目录理解、真实项目续接与大小写不敏感文件系统未验证。实际命令与结果见 [测试报告](../testing.md)。默认入口仍为 v1，v2 需显式加载。

## 1. 目标与完成标准

在单个 `.pi-root` 项目内，让记忆按当前工作目录归属：

1. 在 `calc/neb-01/` 中保存或检索时，只看到该项目根、`calc/`、`calc/neb-01/` 的记忆；兄弟目录 `calc/opt-02/` 默认不可见。
2. 在根目录保存的方法、软件、体系记忆，所有子目录可见；子目录的运行与结果不回流到兄弟目录。
3. 新会话第一轮（用户只说"继续"）能看到当前目录、上次活动、最近运行四轴状态、未闭合项和待审核数。
4. 每个目录有可读的派生页与总索引，可删除重建；权威记录不变。
5. 既有记录、CLI 与工具调用无需迁移即可继续工作。

完成标准：第 9 节验收全部有测试或可重复手工证据；跨兄弟目录泄漏为 0；祖先记忆丢失为 0；上下文仍受 12000 字符硬上限约束。

## 2. 非目标

- 不改变 `.pi-root` 必需性与项目边界；不跨根检索。
- 不自动创建嵌套项目、不自动迁移目录、不自动合并记录。
- 不做目录页的双向编辑；页面只读，手工修改报冲突。
- 不改 v1 `index.ts` 的存储或行为。
- 不在本阶段切换默认入口、改版本号或打包清单。

## 3. 作用域模型

### 3.1 字段

```json
"scope": { "path": "calc/neb-01", "inherit": true }
```

- `path`：相对项目根的 POSIX 路径；根为 `"."`；段间用 `/`；不得为空串。
- `inherit`：布尔，默认 `true`；`false` 表示记录只在其 `path` 目录可见，不向子目录继承。
- 读取时缺失整个 `scope` 按 `{path: ".", inherit: true}` 消费，不做回写；缺失 `inherit` 时保留 `path` 并补 `true`。权威记录、摘要校验与底层原始读取保留旧字段形状，检索/工作上下文等消费方补默认值。

### 3.2 校验规则（`normalizeScope`，纯函数，不访问文件系统）

- 必须是普通对象，只允许 `path`、`inherit` 两个键；`null` 不是"未提供"。
- `path` 为字符串，长度 1–400 UTF-16 code units，最多 32 段。
- 拒绝：绝对路径、`` `\` ``、NUL 与控制字符、空段、`.`/`..` 段、段首尾空白、以 `/` 结尾。
- 已采用 A：允许内部空格、中文与常见标点；拒绝控制字符（含 C1）、反斜杠、绝对/驱动器路径、越界段、段首尾空白及非良构 Unicode。不做 NFC/NFKC 清洗。真实目录名不直接进入派生文件路径，页面使用 hash。
- `inherit` 必须为布尔（允许缺省）。

### 3.3 解析与祖先链（`scopeFor(project, cwd)`）

- 对 `cwd` 取 `realpath`，要求是目录且位于 `project.root` 之下（按路径段比较，不用字符串前缀）。
- 计算 `path.relative(root, cwd)`，把 `path.sep` 换成 `/`；根目录得到 `""`，规范化为 `"."`。
- 不得解析到根之外；允许根内符号链接并取真实路径，若真实路径在根外则拒绝（`scope-outside`）。无法解析或不是目录报 `invalid-scope`。显式历史目录允许不存在，但必须检查最近现存祖先，不能借缺失的子目录绕过链接逃逸检查。
- 祖先链：`["." , "calc", "calc/neb-01"]`；按段生成，不依赖目录当前是否存在（目录可能已被清理）。
- `scopeFor` 只读，不创建目录、不写标记。

### 3.4 未知与旧数据

- 旧记录无 `scope`：读取即视为根，`inherit: true`。
- 旧工作事件无 `scope`：同样视为根。
- 不提供"未知作用域"状态：缺省就是根，避免三态歧义；若需要"不属于任何目录"，用根表达。

## 4. 存储与派生视图

### 4.1 权威记录

保持 `.internal/records/<uuid>.<revision>.md` 不变，只在记录的 JSON 主体（`entry`）中增加 `scope` 字段。修订、账本校验、写锁和原子发布逻辑不改。记录一旦写入，`scope` 不随目录移动自动变化。

### 4.2 索引与页面

```text
.pi-memory/
  FOLDERS.md                    # 目录树总索引（派生）
  folders/<hash12>.md           # 每个目录一页（派生）
  .internal/index/folders.json  # 可重建缓存
```

- `hash12 = sha256(scope.path).slice(0,12)`；索引保存 `hash → path` 映射，避免真实目录名进入派生路径导致校验失败。
- `folders.json` 字段：`{schemaVersion: 1, generated, folders: [{path, hash, records, current, byKind, latest}]}`；损坏时可删除重建，不作为事实来源。
- 目录页内容：只读声明、目录路径、父级链、各 kind 当前记录（标题、verification、lifecycle、run 四轴、链接到 `knowledge/<kind>/<id>.md`）、未闭合诊断、生成时间。
- `FOLDERS.md`：缩进树，列出目录、记录数、最近活动；根目录排最前。

### 4.3 生成与冲突

- 本阶段采用显式命令（`v2 folder rebuild`），不在写入或启动时全量重写。页面生成时间取已记录活动的最近时间（空包为固定 epoch），保证同一权威历史的重建稳定。
- 页面使用"写临时文件 + 原子发布"；页首保存页面正文的所有权摘要，独立于可丢弃索引。手改页面导致摘要不一致时，Node API 返回 `conflicts`，CLI 报 `conflict`、退出 1，保留用户文件；仅显式 `--force` 覆盖冲突派生页。索引损坏可直接重建。
- 页面不得被当作 grounding 来源；`searchV2` 只读记录，不读页面。
- 页面写入 `.pi-memory` 内，是否纳入 Git 由用户决定；默认建议加入 `.gitignore`，但不自动改写。

## 5. 召回

### 5.1 过滤

`searchV2(project, query, { folder, allFolders = false, … })`：

- `folder` 缺省用 `scopeFor(project, project.cwd)`。
- 记录可见条件：
  - `allFolders === true`：全部当前记录（仍遵守 lifecycle/kind/entity 过滤）。
  - 否则：`record.scope.path` 在祖先链中，且 `record.scope.inherit === true` 或 `record.scope.path === folder`。
- 明确不可见：祖先目录中 `inherit:false` 的记录；兄弟目录的任何记录。
- 实体过滤仍全局：显式传入的 `entityId(s)` 不受目录限制，但结果需标注目录，避免把兄弟目录的 run 当作当前 run。

### 5.2 语料与打分

- BM25 的文档频率在**过滤后的语料**上计算，使分数在同一作用域内可比；跨作用域分数不可直接比较，文档需注明。
- 片段选择逻辑（model-extraction 用完整正文、其他用命中行）不变。
- 结果 `hit` 增加 `scope: {path, inherit}` 与 `scopeRank`（当前目录 2、祖先 1、根 0、跨目录 -1）。

### 5.3 排序

保持"实体匹配优先"不变，其次按 `scopeRank` 降序，再按 BM25 分数与 id。不得让相邻目录的高分词条压过当前目录弱命中；已有活动 run 优先逻辑继续保留。

### 5.4 预算

`buildWorkingContext` 仍受 12000 字符硬上限：简报 ≤1200、state ≤4300、overview ≤2500、知识最多 4 项（单项沿用 2048/1600）。超预算时按"知识项 → overview → state → 简报"顺序收缩；任何省略必须显式写出 `[omitted: …]`，不得静默丢弃。

## 6. 工作记忆与跨会话简报

### 6.1 工作事件

- `collectWorkTurn`/工作事件 payload 增加 `scope`；缺省为根。
- 事件可见性规则与知识一致（祖先 + 自身；`inherit:false` 除外）。
- 历史事件不改写；读取时补默认值。

### 6.2 状态选择

- 显式 state 事件：优先当前目录，其次最近祖先，最后根。
- overview 仍只取根级，代表项目全貌。
- 目录页展示该目录自己的最近事件摘要，不复制根 state。

### 6.3 简报结构（首轮，≤1200 字符）

```text
Folder: calc/neb-01 (parent chain: ., calc)
Last activity: <ISO8601> (<相对时间>)
Last run: <标题> exec=… term=… conv=… validity=…
Open loops: <最多 3 条，来源 state/journal 的未闭合项>
Pending review: <N> (review 命令，不自动批准)
Key memory: <最多 3 条，标题 + verification + 目录>
Boundary: "继续" does not authorize submitting or rerunning calculations; unknown fields are not defaults.
```

- 无历史时输出 `No prior memory for this folder.`，不伪造。
- 只陈述已记录事实；助手声明标 `assistant_claim`，工具观察标 `tool observation`。
- 最近运行必须显示四轴原值，`unknown` 原样保留；不得补成 `normal`/`converged`。

### 6.4 注入时机

- 每个 session 首轮 `before_agent_start` 注入简报；同 session 后续轮次不重复，改用常规 state/knowledge 注入。
- 压缩交接（`session_before_compact`）生成的 handoff 事件带目录作用域；新会话恢复时按当前目录链选取。
- 简报与常规状态重复的段落只保留一次。

## 7. 接口契约

### 7.1 Node API

| 函数 | 变更 |
|---|---|
| `normalizeScope(value)` | 新增，纯校验 |
| `scopeFor(project, cwd)` | 新增，返回 `{path, chain}` |
| `searchV2(project, query, opts)` | 新增 `folder`, `allFolders`；命中增加 `scope`, `scopeRank` |
| `buildWorkingContext(project, prompt, opts)` | 按 `project.cwd` 过滤；`firstTurn: true` 生成首轮简报，默认 false，返回 `brief` |
| `foldersV2(project)` | 新增，返回目录清单 |
| `renderFolderViews(project, opts)` | 新增，写索引与页面，返回冲突 |

参数名与字段一旦进入测试即视为契约；改名需同步 CLI、工具描述、README 与本文。

### 7.2 CLI

```bash
pi-project-memory v2 folder list
pi-project-memory v2 folder show [<rel>]        # 缺省当前目录；先 rebuild 生成页面
pi-project-memory v2 folder rebuild [--force]   # --force 才覆盖冲突页面；默认拒绝
pi-project-memory v2 search <query> [--folder <rel>] [--all-folders]
```

- 默认 `v2 search` 使用 cwd 作用域；`--folder` 用于指定其他目录（只读场景），选项可在 query 前后。`--all` 仍仅控制 lifecycle，不等于 `--all-folders`。不改变现有默认 v1 CLI 路由。
- 新知识默认保存到当前真实 cwd；显式 `entry.scope` 可指定历史目录。未指定 scope 的修订保留旧 scope。CLI `record`/`state` 默认当前目录、overview 默认根；底层无 scope 的旧工作 payload 仍视为根。修订号保持原有全局序列，不新增目录级并行修订契约。
- 自动提炼在本地附加目录作用域，候选模型不能指定目录；目标修订保留原目录，人工/自动审核不丢 scope。跨目录召回去重键包含 scope，不合并兄弟目录的同源内容。
- 退出码沿用 0/1；错误走既有 `MemoryError`，不新增异常族。

### 7.3 工具

- `project_memory_search`：增加可选 `folder`（字符串）、`allFolders`（布尔，默认 false）。描述注明"默认仅当前目录及祖先；兄弟目录需显式开启"。
- `project_memory_save`：增加可选 `folder`、`inherit`（默认 true）。不提供"猜目录"。
- 不新增工具，避免扩大模型可写面。

## 8. 任务分解（按顺序，测试先行）

| # | 任务 | 主要文件 | 测试 |
|---|---|---|---|
| T1 | `scope` 校验、默认值与旧记录读取 | `src/v2-domain.mjs` | `test/v2-scope.test.mjs` |
| T2 | 真实路径解析、祖先链、越界/符号链接拒绝 | `src/v2-store.mjs`（`scopeFor`） | 同上 |
| T3 | 召回过滤、df 作用域、排序与标注 | `src/v2-store.mjs`（`searchV2`） | `test/v2-scope-search.test.mjs` |
| T4 | 工作事件作用域、状态选择、简报与预算 | `src/v2-working.mjs` | `test/v2-scope-context.test.mjs` |
| T5 | 目录索引、页面生成、重建与冲突 | `src/v2-store.mjs` + 新渲染模块 | `test/v2-folder-views.test.mjs` |
| T6 | CLI 与工具参数、描述 | `src/v2-cli.mjs`、`v2.ts`、`bin/*` | 扩展 `test/cli-e2e.test.mjs` |
| T7 | 化学纵向：根方法 + 两运行目录，失败诊断不串线 | 夹具 + 测试 | `test/v2-scope-chemistry.test.mjs` |
| T8 | 并发、作用域撤销、账本篡改 | 既有并发/边界测试 | 扩展 `test/v2-concurrency.test.mjs`、`test/v2-boundaries.test.mjs` |
| T9 | 文档同步（README、m5 状态、testing 记录） | `README.md`、`docs/` | 人工核对 |

每个任务完成后跑定向测试；T3、T4 完成后再跑一次全量，避免长反馈环。

## 9. 验收清单

必须全部有自动化测试：

1. 根记录在子目录可见；子目录记录不回流根目录的默认检索。
2. 兄弟目录互不可见；`allFolders` 打开后可见且标注各自目录。
3. `inherit:false`：祖先记录对子目录不可见，对自身目录可见。
4. 缺失 `scope` 的旧记录按根处理，读取、检索、上下文均不丢失。
5. 越界 cwd、`..` 路径、符号链接逃逸被拒绝，错误码稳定。
6. 目录名为空格/中文时，索引与页面仍可生成（按 A 方案）。
7. 目录页与 `FOLDERS.md` 可删除重建，重建结果内容稳定；手工修改页面触发冲突，不覆盖。
8. 简报 ≤1200 字符，含目录、最近运行四轴、未闭合项、待审核数、边界声明；无历史时明确说明。
9. 上下文总计 ≤12000 字符，省略显式标注。
10. 首轮简报只注入一次；后续轮次不重复。
11. 化学纵向：`opt/` 与 `neb/` 的 run、能量、诊断不串线；根方法两边可见。
12. 搜索结果带 `scope`，实体过滤仍可跨目录显式取用。

负例（必须拒绝或明确降级，不能静默通过）：

- 用 `scope` 指向根外或符号链接目录。
- 页面被手改后仍被覆盖。
- 缺失 `scope` 时被当作"不可见"而丢历史。
- 简报把 `unknown` 补成 `converged`。
- 兄弟目录记录凭 BM25 高分进入当前上下文。

## 10. 风险与未决问题

- **目录改名**：作用域字符串陈旧导致召回减少；M5 不做自动修复，只在 `folder list` 标出"目录不存在"的历史作用域。
- **大小写与 Unicode**：以真实路径字节为准，不做 NFC 归一；在大小写不敏感文件系统上的行为需单独测试，未验证前不得宣称。
- **入口差异**：Pi 会话 cwd 与 Node 进程 cwd 可能不同，`scopeFor` 必须用会话工作目录，测试需覆盖。
- **性能**：每次检索都扫描并过滤；记录上限 10000，暂不做目录索引加速，若实测退化再评估。
- **派生页面体积**：目录多时 `FOLDERS.md` 可能过长，需要上限与截断提示。
- **已定**：字符集采用 A；`inherit` 默认 true；允许显式历史 folder 不存在；根内符号链接按真实路径解析，根外链接拒绝。目录页生成独立实现于 `src/v2-folders.mjs`，仍经既有存储读写保护。
- **未验证**：真实模型/真实项目续接、大小写不敏感文件系统、跨挂载点及大规模性能。离线合成夹具只证明实现契约，不证明科学有效性。

## 11. 授权边界

- 只在新建临时目录中创建 `.pi-root` 与记忆，结束后清理；不创建仓库内标记。
- 不扫描真实计算目录、不读取真实用户记忆、不修改 `~/.pi` 与用户设置。
- 不提交、不推送、不改默认入口/版本/打包字段；真实模型、真实 Pi 会话与发布验证须单独授权。
- 测试不得调用远程/付费模型，不得执行计算或提交调度器作业。
