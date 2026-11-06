# M1：v2 显式存储与领域模型

状态：本页记录已实现的 M1 基础存储契约。后续 M2 已提供独立 v2.ts 扩展、工作记录/压缩与 overview/state 默认上下文，见 [M2 使用说明](m2-usage.md)；长期模型提炼仍待 M3。
包版本仍为 0.3.0，不代表新机制已完成发布。不要把本阶段当成原插件的直接替换。

## 安全试用

仅在新的试验项目运行。已有旧 `.pi/project-memory.json` 会明确冲突，不会原地迁移。
示例中的命令要求包的 CLI 已在 PATH；也可以使用 `node "$PACKAGE_ROOT/bin/pi-project-memory.mjs"`，其中 PACKAGE_ROOT 是实际源码位置。

```bash
cd /path/to/new-test-project
pi-project-memory v2 init "我的计算与软件项目"
pi-project-memory v2 status
printf '%s\n' '{"entry":{"kind":"software","title":"解析器测试边界","content":"测试使用合成夹具，不代表实际计算软件兼容性。","provenance":"user-confirmation","verification":"user-confirmed","evidence":["用户明确确认：测试使用合成夹具"]}}' \
  | pi-project-memory v2 save
pi-project-memory v2 search 解析器
```

例子是格式演示，不是本项目已验证的科学结论。实际使用时只保存真实建立的来源。
初始化不扫描源码/日志、不调用模型、不读中央注册表/全局旧配置，也不修改 `.gitignore`。
建议自行将 `.pi-memory/` 加入项目忽略规则；发布仍应显式排除真实记忆。

## 根、配置与存储

- 初始化默认沿用最近 `.pi-root`；无祖先标记时当前目录成为根。
- 从子目录运行仍使用根目录记忆；`v2 init ["name"] --nested` 才在当前目录建立独立嵌套项目。
- 标记必须是普通文件，符号链接/同名目录均拒绝。
- 没有标记不读取项目配置或记忆。删除标记、改变最近边界、禁用配置或更换身份都会撤销旧句柄。
- 不迁移旧记忆。没有旧配置时可建立新库，旧 `pi-memory/` 保持不变。
- 旧插件和旧 CLI 明确拒绝 versioned 配置，避免把 v2 项目静默当旧 pack 使用。
- 新初始化后若原 Pi 扩展仍加载，会拒绝该项目的旧记忆操作；M2 使用独立 v2.ts，请先禁用旧入口，不能同时启用。

配置例子（由初始化自动生成 UUID，不要原样复制到真实项目）：

```json
{
  "schemaVersion": 2,
  "id": "<自动生成的 UUID v4>",
  "name": "项目名称",
  "memoryPath": ".pi-memory",
  "enabled": true
}
```

除这些基础字段外，M2 另支持可选 learningMode（on/off）与 handoffEnabled（布尔），详见 M2 文档。`memoryPath` 必须是安全项目相对目录；禁止越界、绝对路径、`.git`/`.pi` 等隐藏路径和后代符号链接。
自定义位置需在首次建库前明确配置；改变字段不会迁移已有库，也不构成接入任意目录的授权。
移动/复制项目不依赖旧绝对路径；复制后相同 UUID 不导致跨目录共享。

```text
.pi-memory/
  .store.json                         # schema/project 身份，不含绝对路径
  .internal/
    records/<uuid>.<revision>.md       # 权威：完整、不可变修订
    write.lock/                       # 只在写操作期间存在；崩溃可能遗留
    reviews/ diagnostics/ index/      # 预留，M1 不实现审核/诊断事件/索引缓存
  knowledge/<kind>/<uuid>.md           # 最新派生视图
  journal/                            # 预留，M2 接入工作记录
```

M1 初始化本身不创建 overview/state 空壳；M2 在有工作事件或显式概览/状态时生成相应视图。

## CLI 契约

| 命令 | 输入 / 副作用 |
|---|---|
| `v2 init ["name"] [--nested]` | 显式创建标记、配置和新目录；拒绝旧配置、未知非空目标及名称冲突 |
| `v2 status` | 只读，显示规范记录数量、实体数、容量及自动能力关闭状态 |
| `v2 save` | stdin JSON：`{"entry":{...},"requestId":"可选 UUID v4"}`；创建实体 revision 1 |
| `v2 revise` | stdin JSON：`{"id":"UUID","expectedRevision":1,"entry":{...},"requestId":"可选 UUID v4"}`；完整替换该实体的当前内容，保留旧修订 |
| `v2 get <uuid> [revision]` | 只读，默认最新，可读取指定旧修订 |
| `v2 search [--all] <query>` | 只读，默认只查 current；`--all` 包含 archived/superseded 的最新修订，不等于所有修订全文搜索 |
| `v2 rebuild` | 从规范记录重建缺失/陈旧的派生视图；手工编辑冲突时拒绝覆盖 |

标准输出为 JSON，失败退出码为 1。v2 不回显无效输入片段或原始系统错误。
stdin 上限 200000 字节；单规范记录 250000 字节，目录最多 10000 项（包括崩溃临时项），规范记录总量最多 50 MiB。
超过上限明确 `inventory-bounded`，不返回不完整修订历史的搜索结果，不自动删除文件。

`revise` 不是 patch：必须给完整 entry；省略的字段会恢复 entry 默认值，不自动沿用旧值。
已存在实体必须显式 UUID + expectedRevision；标题相同不会合并，kind 不可变。
若要保留旧实体作为当前参考，不要把 lifecycle 改成 archived/superseded。

## entry 契约

必需：`kind`、单行 `title`、非空 Markdown `content`。
kind：`systems | methods | runs | results | diagnostics | software | workflows | decisions`。

可选：
- `tags`：最多 20 项，各最多 80 字符。
- `verification`：reported（默认）/ evidence-backed / user-confirmed / unresolved。
- `provenance`：assistant-claim（默认）/ user-confirmation / tool-observation / model-extraction。
- `lifecycle`：current（默认）/ superseded / archived。
- `evidence`：最多 10 个单行定位字符串，各最多 500 字符；不读取定位目标、不执行命令。
- `sourceTurn`：可选单行来源标识，最多 200 字符。
- `entities`：最多 20 个 `{type,id}`，type 为 system/method/run/component，必须指向同库已存在的 systems/methods/runs/software 实体。
- `run`（只用于 runs）：execution、termination、convergence、validity 分离，缺省分别 unknown/unknown/unknown/unchecked；另可有 software/version/input/output 字符串。
- `result`（只用于 results）：必须同时有 runId/property/value/unit/definition，value 为有限数值，runId 指向已存在 runs，entry.evidence 非空。

未知字段、显式 null、非法枚举、空单位和非有限数值拒绝。未知结果不保存为 0；省略 result 即无结构化数值。
数值和单位属于调用者提供的证据性数据，本模块不自行解析日志或验证其科学正确性。
evidence-backed 要求来源定位；user-confirmed 另要求 user-confirmation provenance。**这些是格式约束，不是对引用或用户确认真实性的认证。**
正文同样可能包含未经核实的声明；verification 不授予执行权限。

## API

- `src/v2-domain.mjs`：领域校验、规范化、限制、MemoryError。
- `src/v2-store.mjs`：`initializeV2`、`resolveV2`、`saveV2`、`reviseV2`、`getV2`、`searchV2`、`statusV2`、`rebuildV2`。
- `src/v2-cli.mjs`：独立路由，不访问旧配置/注册表/模型。

保存 API 的 options 只接受 requestId；修订 API 的 id/expectedRevision 为独立必需参数。
searchV2 支持 limit 1–20（默认 8）、includeInactive、kind、entityId；BM25 同时索引正文、标题/tags 和结构化 run/result 字段。
搜索返回 reported/unresolved 的 requiresVerification 标记；result 命中返回来源 run 的独立状态，不推断收敛或有效性。
这里没有候选审核状态；显式保存直接生成规范记录，M3 才接长期提炼/审核。

## 原子性、幂等和恢复

- 规范记录复用现有 exclusive：临时文件完整写入后 hard link 独占发布，目标不能覆盖。
- UUID 文件名不使用标题，避免同名合并和超长 Unicode 文件名。
- 修订链保存前一修订摘要；缺失、格式损坏、跨项目身份错误均停止读取。
- 写操作用项目级锁 + expectedRevision。争抢显式 busy；旧版本更新显式 revision-conflict。
- requestId 作用域为当前本地库。相同请求重试复用规范记录，内容不同则 request-conflict；重试旧操作不会回滚最新视图。
- 返回 `projection: current` 表示该派生视图已更新；`pending` 表示规范记录已提交、视图待恢复。
- pending 后优先用 get/rebuild，或相同 requestId 重试；不要在没有幂等标识时盲目重复 save。
- rebuild 允许替换能精确对应某个旧规范修订的陈旧视图；不覆盖任何无法匹配的手工编辑。
- 手工编辑的显式导入工具尚未实现。先保留编辑文件，人工整理成 revise 请求；不得以 force rebuild 绕过保护。
- 崩溃可能遗留初始化锁、写锁及隐藏临时文件。先确认没有进程写入，再由用户显式处理遗留锁；代码不自动抢锁或清理。
- 首次初始化中断后可重跑 init；遇到无法证明归属的非空目录仍拒绝，不能保证所有中断窗口自动恢复。

不承诺断电耐久性、跨设备同步或对同用户恶意文件系统竞态的防护。hard link 不支持时明确失败。
不会修改计算输入、输出、restart 或任何科学结果。

## 验证边界

新增测试为隔离临时目录中的合成记录与多进程夹具；不调用远程模型、不运行计算。
它们验证存储契约，不验证计算软件版本兼容、科学结论或真实模型的归纳质量。
M2 补上了自动工作续接，但 M3 尚未实现；不能仅凭存储测试声称真实任务中的记忆数量/召回质量问题已解决。
