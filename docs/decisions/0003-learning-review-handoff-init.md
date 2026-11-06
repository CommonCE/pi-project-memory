# 0003 — 项目内学习、审核与交接，不完整复刻 pi-memctx

状态：已实现于 0.2.0。扩展 0001 的第一版范围，并为 0002 的“不自动创建标记”增加用户显式初始化命令；普通启动/自动学习仍不能创建标记。

本页保留 0.2.0 的历史决策与验证。第 8 项的 Bash 集成已在公开前清理中移除：本项目只负责记忆，不接管 Pi 启动、代理或 shell 环境；外部记忆管理 CLI 保留。历史验证命令不是当前复现指引。

## 用户需求

替代旧记忆插件的回合结束自动学习和候选审核、压缩前交接，并提供显式启用命令。不要求 qmd/Gateway 或旧工具名称完整兼容。

## 决策与理由

1. `agent_end` 使用当前 Pi modelRegistry.streamSimple，沿用 provider 认证，不读取/复制密钥，不添加模型 SDK 依赖。默认 suggest，用户审核后发布；可显式 auto/off。
2. 模型输入为最近用户回合的有界文本证据；忽略 thinking、图片、工具参数和 custom memory messages。明显秘密过滤先于截断。候选需原文引用精确匹配，但不把引用匹配视为语义验证。
3. 队列在 pack 的隐藏 .learning 目录，用候选内容 hash 去重；候选/审核决定独占创建。审核决定不可变；批准笔记用确定性文件名，保存与决定之间中断可重试，旧笔记不覆盖。跨进程锁显式报忙，不自动抢占崩溃锁。
4. 所有自动写入仅限 cwd 自动作用域，手动 use 时暂停。会话/目标/学习模式变化取消未完成请求；保存前核对代际、项目身份、pack 和标记。不得让跨项目切换迁移当前对话。
5. 学习设输入、候选数量、队列容量、输出 tokens、等待时间边界。超时/取消/非法响应不影响主回合。返回 usage 记录为会话 custom entry；没有 lifecycle usage 汇总槽，暂不进入 Pi 内置费用总计。
6. `session_before_compact` 保存有界本地快照，不增加模型调用。只用 canonical preparation 和已有 previousSummary，不复活原始分支里被省略/替换的尝试；不返回 compaction replacement 或 cancel。
7. `/memory-init [name]` 和 pi-memory-init 是用户明确授权的标记创建入口，默认项目内 pi-memory/packs。保留原配置/注册绑定；单个旧 pack 原位复用，多个旧 pack 不猜测。低层 /memory init 仍要求已有标记。
8. Bash 示例额外提供 pi-memory-init/pi-memory/pi-project，不自动修改 .bashrc 或停用旧插件。旧 pi() 仍依赖旧目录检查，正式迁移必须显式切换加载资源和启动函数。

## 非目标与风险

不实现 semantic/deep/qmd、Gateway 充分性预算、旧命令别名、全局兜底记忆或自动合并旧笔记。DLP 是启发式，不能保障识别全部私人/客户数据；auto 存在模型误归纳风险。快照含有限原文摘录，助手状态必须验证。尚未真实 provider/TUI 端到端验收，也未迁移用户真实旧包。

## 验证

- npm run check：通过。
- bash -n examples/bashrc.sh：通过。
- 使用本机 Pi 1.1.0 的 Jiti/TypeBox：61/61 tests 通过，0 skipped；模型为 mock。
- npm pack --dry-run --json：新入口、模块、配置、Bash 示例与迁移文档在包中；未写 tarball。
- git diff --check：通过。

所有测试使用临时目录；未安装依赖、发起真实模型/量化计算、修改用户 settings/.bashrc、覆盖旧记忆或 Git 提交。
