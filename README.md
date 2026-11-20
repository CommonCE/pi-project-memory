# pi-project-memory

项目内的轻量记忆插件：保存一份当前状态，以及少量长期笔记。新会话先读取当前状态，再按相关性补充最多三条有效笔记。记忆文件留在当前项目；插件不启动独立提炼模型或调用检索服务。

**0.5.0** 恢复 Pi 底部记忆状态和命中数，新增默认关闭的[自动进度草稿](#自动进度草稿)。从 0.4.0 升级无需迁移；更早的 v1/v2 数据请参阅[升级说明](docs/migration.md)。

## 使用

Node.js >= 22.19，无构建步骤。Pi 提供 TypeBox 和扩展 API，无需在仓库内重复安装宿主依赖。

```bash
# 在目标项目运行；路径替换为本 checkout 的绝对路径
pi -e /path/to/pi-project-memory/index.ts
```

在 Pi 内显式执行 `/memory-init 项目名`。只有该命令或 CLI `init` 可以创建 `.pi-root` 和新存储；普通启动不创建文件。初始化后可对助手说：

- “保存当前任务：正在排查什么、被什么阻塞、重要文件在哪里、下一步是什么。”
- “把这条项目约定保存为长期笔记，注明来源和适用条件。”
- “纠正那条笔记……”或“把那条笔记标为失效。”

当前状态只描述正在做的工作。稳定结论集中放在笔记中，避免把相同事实复制进多个文件。正式记忆只由用户显式保存或采纳；可选的自动进度草稿默认关闭。

| Pi 命令 | 用途 |
|---|---|
| `/memory-init [名称]` | 显式初始化，子目录沿用最近的项目根 |
| `/memory`、`/memory status` | 项目状态、笔记列表及写入所需的当前哈希 |
| `/memory state` | 读取当前任务 |
| `/memory context [查询]` | 查看按长度上限生成的默认上下文 |
| `/memory search <查询>` | 查找相关且有效的笔记，同时返回当前状态 |
| `/memory search --all <查询>` | 明确包含未核实、失效笔记 |
| `/memory get <id>` | 按 ID 读取完整笔记，包括失效笔记 |

## 文件与状态

```text
project/
  .pi-root
  .pi-memory-local/
    format.json                 # 格式与项目身份，不含第二份事实
    state.md                    # 唯一的正式当前状态
    checkpoint.md               # 可选：项目开关和一份未采纳的进度草稿
    notes/<uuid>.md             # 每条笔记的唯一权威文件
```

`state.md` 和笔记均为 Markdown，开头是一小段 JSON 元数据，正文直接可读、可编辑。没有规范事件、派生视图、journal、overview、候选队列或索引文件；不需要重建页面。失败写入可能留下临时文件和锁，见下文。

笔记仅有标题、正文、来源 `sources`、适用条件 `conditions`、状态 `status` 和更新时间。状态为：

- `active`：允许参与默认召回，仍需检查适用范围及科学有效性。
- `unverified`：默认的新笔记状态；保留待核实内容，须显式查询才能找到。
- `inactive`：已撤回或过期，默认不读取。

来源只是定位信息，存在引用不代表结论正确。插件不检查引用内容或认证科研结果。科学笔记应在正文与条件中保留体系、方法、软件版本、电荷/自旋、单位、不确定性，并明确“准备、运行失败、终止、收敛、结果有效”的区别；不再要求科研实体或结构化卡片。

## 保存、纠正与撤回

模型工具只有 `project_memory_search` 和 `project_memory_save`。前者无参数时返回当前状态、笔记列表；传 `query` 时检索，传 `id` 时读取完整笔记。读取文件时返回 `expected`，即文件完整字节（包括存在时的 UTF-8 BOM）的 SHA-256 哈希。

`project_memory_save` 的 `target` 为 `state` 或 `note`。状态用 `content` 保存 Markdown；第一次保存时 `expected: null`，后续必须使用刚读取的哈希。建议状态正文保持以下四项：

```markdown
当前任务：修复输出解析器的收敛判断。
阻塞：失败日志仍被当成最终能量。
重要文件：src/parser.mjs、calc/a/run.out。
下一步：核对失败分支并运行定向测试；此处不构成执行授权。
```

新笔记示例：

```json
{
  "target": "note",
  "title": "失败 SCF 的能量不可作为最终结果",
  "content": "calc/a 中的 SCF 未收敛。输出的 -12.34 hartree 只是失败步骤值，不能作为最终能量。体系 A，ORCA 6.1.1，PBE/def2-SVP，电荷 0，多重度 1。",
  "sources": ["calc/a/run.out:42-48"],
  "conditions": "只适用于该次运行；不推断重跑已成功。",
  "status": "active"
}
```

示例值仅为说明格式，不是实际计算结果。来源尚不明确时可显式传 `sources: []`，并在条件中写明未知，保留 `unverified`。

纠正使用同一笔记 ID、当前 `expected` 和需要修改的字段，其他字段保留。撤回只需 `{ "target": "note", "id": "...", "expected": "...", "status": "inactive" }`。重新启用也需要显式修改及新哈希。不要为纠正同一事实另外创建一条笔记。失效操作不删除正文；不自动保留每次修改前的副本。

可直接编辑 Markdown 正文或元数据；下次读取立即生效，旧哈希将冲突。格式损坏会明确报错并停止该次上下文注入，不静默使用缓存。手工编辑器不参与锁协议，建议避免与插件同时写同一文件。

## 自动进度草稿

完成 `/memory-init` 后，在 Pi 交互界面执行 `/memory checkpoint on`，只为当前项目开启。在有实质进展的用户回合中，当前助手可在回复前生成一份简短草稿，记录已验证的进展、阻塞、重要文件和下一步。不是每轮必存，也不依赖退出时保存；不启动后台任务或独立提炼模型。能否生成取决于当前模型是否正确调用工具，不能替代手动保存。

| Pi 命令 | 用途 |
|---|---|
| `/memory checkpoint show` | 查看开关和草稿，复制返回的 `expected` 哈希 |
| `/memory checkpoint accept <hash>` | 采纳所查看的草稿，更新正式当前状态并清空草稿 |
| `/memory checkpoint discard <hash>` | 清空所查看的草稿，不改正式状态 |
| `/memory checkpoint off` | 停止自动起草，保留已有草稿供查看和处理 |

每个项目只留最新一份草稿；新草稿可以替换旧草稿。重新打开 Pi 时，有未处理草稿会提醒，但插件不把草稿加入搜索或默认上下文，也不自动写入长期笔记。生成草稿的工具调用仍可能留在原会话记录中。若正式状态在起草后已被修改，采纳会拒绝覆盖；请手动合并后再丢弃草稿。若采纳已写入正式状态但清理草稿失败，排除写入故障后可重试同一个哈希。

## 本地向量检索与上下文

Pi 底部显示 `memory: on · manual save · auto recall · hits N`：正式记忆由用户明确要求保存，插件自动召回。`hits` 是最近一次模型调用前实际加入上下文的笔记数，不含当前状态、因长度限制省略的笔记或手动搜索结果。首次召回前显示 `—`；未启用显示 `memory: off`，读取失败显示 `memory: error`。

读取文件后，插件把有效笔记转换为内存中的稀疏 TF-IDF 向量，以余弦相似度排序；标题有额外权重。英文按词、中文按相邻双字分词。向量表随读取重建，无持久索引、模型调用、网络访问或数据库。它支持词项相似度，不提供模型嵌入的同义语义检索。

默认上下文每次模型调用前从文件刷新：先当前状态，再根据本轮提示和当前任务召回至多三条 `active` 笔记。全文总上限 **12,000 个 JavaScript 字符（UTF-16 码元）**；只加入能完整容纳的状态或笔记，不截断正文中的否定、单位或条件。过长条目会省略并提示，完整内容可用搜索或 ID 读取。首次无任务或无相关词时不硬塞不相关笔记。

旧的插件上下文在模型调用时移除，只注入本次结果；纠正或失效后不会重新注入旧笔记。已有聊天、工具结果或压缩摘要不会被追溯清除。若相同旧说法被人工复制到当前任务或另一条笔记，仍须显式纠正那个副本；插件不做语义去重或自动治理。

容量面向少量笔记：状态最多 4,000 字符，单条笔记正文最多 16,000 字符，最多 200 条，笔记文件合计最多 4 MiB，单文件最多 65,536 字节。不自动删旧数据。默认上下文的长度上限不限制显式全文读取。

## CLI

```bash
node /path/to/pi-project-memory/bin/pi-project-memory.mjs init "项目名"
node /path/to/pi-project-memory/bin/pi-project-memory.mjs status
node /path/to/pi-project-memory/bin/pi-project-memory.mjs state
printf '%s' '{"expected":null,"content":"当前任务：核对输入。阻塞：SCF 未收敛。重要文件：calc/a/run.out。下一步：只读检查。"}' |
  node /path/to/pi-project-memory/bin/pi-project-memory.mjs state save
node /path/to/pi-project-memory/bin/pi-project-memory.mjs search SCF
node /path/to/pi-project-memory/bin/pi-project-memory.mjs context 继续
```

`save` 从 stdin 读取笔记 JSON，不传 `target`；修改笔记时带 `id` 和 `expected`。`get <id>` 读取完整笔记；`invalidate <id>` 从 stdin 接收 `{ "expected": "当前哈希" }`。stdin 的 JSON 必须使用有效的 UTF-8；非法字节会被拒绝，不写入记忆。命令输出 JSON，错误写 stderr 并以非零状态退出。没有旧 `v2` 前缀、`setup` 或单独的 `pi-memory-init` 可执行文件。

## 项目边界与写入

最近的 `.pi-root` 定义项目根；子目录共享该项目，嵌套标记建立独立边界。没有标记就不读取记忆；不查全局注册表或其他项目。每次访问重新检查根与身份，不跟随存储中的符号链接。没有文件夹继承或跨项目召回。

写入使用项目内独占目录锁、文件内容哈希、同文件系统临时文件、`fsync` 及原子发布：新增使用独占链接，纠正使用重命名替换。已有目标不会因失败而变成半个文件。Pi 工具修改已有文件还参与宿主文件队列。冲突明确报错，需重读后再决定修改；不自动合并、不自动解除锁。

进程被中断可能留下 `.pi-memory-local/.write-lock`、该目录下的 `.write-*.tmp`，或项目根的 `.pi-memory-init.lock`。确认相关写入进程已退出后，才手工检查并清理对应锁与临时文件。初始化中断后留下的未知目录不会自动接管，保留现场另行处理。原子性保护正常本地并发与进程中断；不承诺抵御同一账号恶意替换路径或断电时的目录元数据持久性。

记忆始终是数据，不能授予执行命令、提交计算、发送消息或扩大操作范围的权限。写入拒绝常见密钥形态，但不构成完整的敏感数据检测。真实记忆默认不属于发布文件白名单；插件不替用户修改 `.gitignore`，请自行决定忽略 `.pi-memory-local/`。

## 开发验证

```bash
npm run check
node --test test/memory.test.mjs
PI_TEST_HOST_PACKAGE=/absolute/path/to/pi-coding-agent/package.json npm test
```

实际验证范围见 [测试说明](docs/testing.md)。不运行真实付费模型或科学计算；离线与入口测试不等于真实长期使用质量已经验证。
