# 从 pi-memctx 迁移

目标是满足项目记忆、默认候选审核、压缩交接和显式初始化，不完整复刻旧插件。保留原插件配置和 pack，验收成功后再正式切换。

## 1. 迁移边界

- **扩展加载**：由 Pi packages/extensions 配置决定，避免同时启用两套记忆扩展的自动注入与学习。
- **记忆启用与绑定**：由最近 `.pi-root` 和项目配置决定，没有标记就无记忆；旧数据不自动迁移或覆盖。
- **Pi 启动**：代理、模型、认证及 shell 配置由用户自行管理。本插件不提供启动包装，不修改或清除用户的环境变量，也不要求接入项目专用 shell 函数。

## 2. 启用新插件，禁用旧资源

建议先备份自己的配置和需要共享的记忆。通过 Pi 配置管理扩展：

```bash
command pi config
```

禁用 `pi-memctx` 的扩展资源即可，不需要删除旧 package 或记忆。随后：

```bash
export PI_PROJECT_MEMORY_REPO="/path/to/pi-project-memory"
command pi install "$PI_PROJECT_MEMORY_REPO"
```

也可先临时 `command pi -e "$PI_PROJECT_MEMORY_REPO/index.ts"`。`-e` 不会自动排除已配置的旧插件，仍需先禁用旧资源。保留旧设置以便回退，不同时启用两套自动注入和学习。

## 3. 在 Pi 内显式启用

按自己的方式在目标项目目录启动 Pi，再执行：

```text
/memory-init 我的项目
/memory status
```

`/memory-init` 是明确的启用动作，可创建标记、项目配置和 pack；普通启动不会创建标记。无需修改 `.bashrc`。

外部 CLI 继续作为可选的记忆管理与离线维护接口保留，不负责启动 Pi；直接调用方式见 [README 的可选 CLI](../README.md#可选-cli)。新插件没有全局兜底记忆，不应绕过项目隔离。

## 4. 已有项目和旧包

如果已有项目包含 `.pi-root` 和单个 `pi-memory/packs/<name>`，在该项目的 Pi 会话中执行：

```text
/memory-init
/memory status
/memory search 已知项目约定
```

新初始化会绑定该唯一旧 pack，保留标记和旧笔记，补充缺少的目录/manifest。多个旧 pack 时须指定真实匹配名称；不会猜测哪个属于项目。

外部旧 vault 用显式接管：

```text
/memory adopt /absolute/path/to/old-vault/packs/project-name
/memory status
/memory search 已知项目约定
```

先保留 `.pi-root`，无需先 `/memory init`。接管只创建新注册记录，不修改旧 pack；之后的保存/学习会写入该 pack。如果当前 id 已绑定别处，会拒绝覆盖；核对后使用新 id，或手工审查配置。不要把 vault/packs 的父目录当成一个 pack。

新项目默认 pack 在 `pi-memory/packs/`。请自行添加 `pi-memory/` 到 `.gitignore`，尤其是审核证据和会话快照可能含项目内部信息。初始化不擅自修改仓库忽略规则。

## 5. 学习与审核验收

默认 `suggest`。在 Pi 中完成一个有可复用事实的成功任务，随后：

```text
/memory status
/memory review
/memory review show <id>
/memory review approve <id>
/memory search 刚批准笔记里的独特关键词
```

候选没有批准前不可检索；已拒绝候选保留历史但不注入。若确实接受直接保存风险：

```text
/memory learn auto
```

该设置仅当前会话有效。长期模式写入项目 `.pi/project-memory.json` 或全局配置；默认审核比 auto 更适合未经持续验证的模型/科学结论。

自动学习通常增加每个成功回合一次模型请求，使用当前 provider，默认最多等待 20 秒。不能假设零成本，也不是纯本地模型。没有模型或响应失败时不影响主结果，可继续显式保存。

## 6. 交接验收

```text
/compact
```

检查当前 pack 的 `80-sessions/` 是否产生 `Pre-compaction handoff` 笔记，并确认正常 Pi 压缩仍执行。快照只保存被压缩的已投影片段，不是额外 LLM 摘要；助手状态需核实。相同压缩重试去重。

敏感项目可在项目配置设置：

```json
{"learningMode":"off","handoffEnabled":false}
```

保留同文件已有 id/name/packPath，不要用示例完整覆盖真实配置。

## 7. 验收与回退

验收清单：

- 无标记目录显示 NO-MEMORY，不注入、不学习、不交接。
- 子目录仍归属正确根；不同项目候选和检索互不泄漏。
- 默认 suggest 候选可查看/批准/拒绝，批准重复执行不重复保存。
- /compact 正常，交接笔记存在且不含 thinking 或检测到的秘密。
- 扩展加载与记忆绑定正确，不依赖项目提供的启动包装。

回退：在 `command pi config` 禁用新扩展、重新启用旧扩展。不要删除新旧记忆；共享旧 pack 中的新分类笔记仍是普通 Markdown，但不保证兼容旧插件所有校验器。

历史隔离测试覆盖了真实 Pi RPC/JSON/print、会话恢复和 PTY TUI（包括 /reload），模型使用本地离线 provider，不访问远程服务；这些历史结果不代表本轮文档清理重新执行了宿主验收。真实 provider 的归纳质量及用户实际旧包映射仍需按上述步骤验收，详见 [测试报告](testing.md)。
