# pi-memctx 定向对比

## 证据与范围

本地项目基线：`package.json` 0.3.0，HEAD `c6b5b9b`，另有未提交的 profile 初始化改动。

本轮在已检查的本地包目录未找到 pi-memctx 源码，因此采用公共上游固定快照，不假定它就是用户过去实际运行的配置：

- 仓库：<https://github.com/weauratech/pi-memctx>
- commit：`18e838957c13af0b8c6fe3e2fbc3608935a60c6f`
- [package.json](https://github.com/weauratech/pi-memctx/blob/18e838957c13af0b8c6fe3e2fbc3608935a60c6f/package.json)：声明 0.13.1。
- [README](https://github.com/weauratech/pi-memctx/blob/18e838957c13af0b8c6fe3e2fbc3608935a60c6f/README.md)
- [index.ts](https://github.com/weauratech/pi-memctx/blob/18e838957c13af0b8c6fe3e2fbc3608935a60c6f/index.ts)

对比为源码检查，未安装或执行上游，未复现其基准测试。README 的性能数字不能移作本项目结果。
以下上游行号对应固定 commit，本项目以函数定位，避免工作区改动导致行号失效。

## 关键机制

| 方面 | pi-memctx 固定快照 | 当前项目 |
|---|---|---|
| 初始化 | README 描述工作区扫描与模型 enrichment；index.ts 的 collectRepoEvidence、enrichGeneratedPackWithLlm 实现相应路径 | setupProject / initialize 只建配置、目录、manifest，不建立初始项目知识 |
| 学习输入 | collectTurnSnippets（3358 起）遍历收到的消息，保留末尾 30 个 snippets；assistant 最多 12000 字符 | collectEvidence + agent_end 只取最新用户回合；assistant 单项最多 4000 字符，工具按 profile 限制 |
| 丰富回合 | richDiscovery 判断工具数量和内容信号；curator 丰富回合可给最多 10 项；不只靠数量限制 | 单次 curator；default 最多 4 项、qchem 最多 8 项 |
| 补充保存 | agent_end（5569 起）合并 structural candidates、确定性 fallback、最终答复扩充和 rich session snapshot；丰富路径最多处理 12 项 | 没有这些补充路径；无有效候选即不存知识 |
| 保存门槛 | auto 模式 confidence >= 0.78 直接保存，其余可排队；这是模型/规则置信度，不是科学验证 | 默认 suggest；所有自动候选均待批准，pending 不可检索 |
| 内容更新 | saveMemoryCandidate（3311 起）找相似笔记并追加 Update；同轮写入关联链接 | saveNote 总是新建；显式 supersedes 替代，不按相似标题更新 |
| 来源验证 | curator 提示证据约束；所检查路径没有当前项目这种逐条精确引用匹配要求 | parseCandidates 必须有 1–5 条匹配有界输入的原文引用 |
| 召回输入 | before_agent_start（4881 起）通过 promptWithRecentConversation 扩展查询，再构建 gateway context | 当前 prompt 前 4000 字符做 BM25；没有固定项目概览/当前状态底座 |
| 检索后端 | README 描述 qmd、grep fallback、coverage/gateway；并非只做基础关键词命中 | 本地 BM25、qchem 小型主题词扩展，无 embedding |
| 自动异步工作 | agent_end 启动 detached async 路径 | 等待有超时的模型调用；作用域变化取消并重查 |
| 项目边界 | 存在 prompt 触发 pack 切换和 workspace map | 最近 .pi-root 决定自动项目，模型不能指定任意目标 |

注意：两边最终收到的 event.messages 由各自宿主决定，不能仅凭遍历代码断言上游一定覆盖整个会话。
也没有证据证明上游维护了本方案提出的 overview/state 双视图；那是新设计，不是对上游的复述。

## 对“记忆偏少”的判断

### 源码支持的机制解释

1. 当前没有初始化知识，冷启动天然为空。
2. suggest 队列未批准前不能召回。
3. 最新回合与有界输入可能遗漏跨轮背景。
4. 缺少丰富会话/结构化 fallback；候选校验失败后没有近期工作记忆兜底。
5. 没有固定概览与状态，“继续上次任务”可能没有有效关键词。
6. 原子追加保护历史，但大量独立笔记难以表达唯一的当前状态。

### 尚未证实的实际原因

没有读取用户真实候选队列、学习诊断或记忆库，不能量化是提取少、批准少还是召回少。
也不能保证上游存得多就更准确；更多最终答复快照可能只是重复或未经核实的助手陈述。

## 借鉴与拒绝照搬

借鉴：
- 一个丰富任务可以形成互补的系统、方法、运行、结果、排错和开发记录。
- 保存能独立复用的细节，保留已有文件定位；不把事实压成泛泛总结。
- 支持知识更新与关联，检索结合近期任务上下文。
- 给学习、排队、拒绝和召回提供可解释诊断。

不照搬：
- 不以最终答复、模型 confidence 或人工批准证明收敛和科学真实性。
- 不按相似标题自动合并不同体系、运行或方法。
- 不因提示词提及其他项目而切换写入目标。
- 不把 bash 调用本身当作发生修改或计算成功的证据。
- 不在初始化中默认启动源码扫描、模型调用或后台任务。
- 不限制正常查阅源文件来追求少工具调用。
- 第一阶段不引入 qmd、数据库或新模型 SDK。

结论：下一版补的是“工作记录—当前状态—长期知识—召回”闭环，不是单纯把候选上限调到上游数量。
