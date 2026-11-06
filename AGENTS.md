# pi-project-memory Agent Instructions

改动代码、测试或维护文档前，先读 [开发规则](.agents/DEVELOPMENT.md) 并遵守其中的适用条款。
详细规则写在那份文件里；本文件只保留每次会话都必须生效的入口与硬性上限。

## 上下文预算（硬性，优先于"先读全文件再动手"的习惯）

1. 读取前先估体量：`wc -c <file>` 或 `find . -type f -printf '%s %p\n' | sort -rn | head`。
2. 单次 `read` **最多 200 行或 8 KB**，必须显式传 `limit`（必要时 `offset` 分段）。
   超过 8 KB 的文件禁止整篇读入，无论看起来多重要。
3. 需要"整体认识"时先取结构，不取正文：Markdown 用
   `grep -n '^#\{1,3\} ' f.md`，代码用
   `rg -n '^(export |function |class |const [A-Z_]+ ?=)' f.mjs`，再只读命中的行区间。
4. 查定义/调用点用 `rg -n -C 3 '<symbol>' <dir>`，不要为了找一个符号读整个文件。
5. **不读** `node_modules/**`、Pi 宿主包源码
   (`<Pi 宿主安装目录>/**`)
   与 `test/fixtures/` 大文件。需要 Pi 行为时先读宿主 `docs/*.md` 与
   `examples/`；文档确实不足时才对该包做单文件定点 `rg`，并在报告中说明为什么必须看源码。
6. 默认不重复读取已注入规则或已读区间；仅文件变更、上下文缺失或需核验精确文本时定点重读。
   不复述大段 diff/日志。单条 bash 输出最多 **80 行 / 8 KB**，取较小者；缩小查询而非反复翻页。
7. 只读了部分内容时，在回答里说明覆盖范围，不要把局部阅读当成全文结论。
8. 每轮探索累计正文上限 **64 KB / 16 个不同文件，先到者停**（所有工具合计，分段/并行不重置）。
   每 **3 次探索工具调用**检查是否已足够编辑/回答；超预算前说明缺口并取得用户确认。
   详细口径见开发规则 2.5；不能用预算省略上级要求的阅读，不足时先申请扩展。
9. 只为当前问题读取。业务改动不默认查 Pi；仅改规则/文档不读业务实现、不跑全量测试。
   找到实现、调用点、相关测试后停止无关探索；不遍历文档链接或宿主源码。
10. 独立新目标或压缩/重复调查出现时建议新开对话，交接摘要最多 **30 行**（格式见开发规则 2.6）。
    不自动落盘、写记忆或创建 `.pi-root`；这些规则不是运行时限流，不能清除已有上下文。

已知大文件（必须定点读取）：`src/core.mjs` 32 KB、`README.md` 27 KB、
`src/v2-store.mjs` 23 KB、`test/lifecycle.test.mjs` 22 KB、`index.ts` 21 KB、
`src/v2-working.mjs` 19 KB、`test/v2-store.test.mjs` 19 KB、`docs/testing.md` > 32 KB（持续增长，读取前重新估量）。

## 项目事实

- Node.js >= 22.19，ESM。生产代码是 `src/*.mjs`；TypeScript 仅用于 Pi 扩展入口
  `index.ts`（0.3.0 默认插件）与 `v2.ts`（M1/M2 新版），由宿主 jiti 加载，无构建步骤。
  `index.ts` 与 `v2.ts` 不同时加载，不要合并两者。
- 依赖：TypeBox 与 Pi API 由宿主提供；不要安装重复的宿主包，不要引入构建链或无关依赖。
- 文档用中文，标识符/代码注释/提交信息用英文；引用上游原文保持原样。
- 本仓库当前没有 `.pi-root`，因此记忆工具读不到内容，也不要为此创建标记
  （见 `docs/decisions/0002-require-pi-root.md`）。

## 验证

按任务选择最小检查，不要跳级：

```bash
npm run check                    # node --check，语法级
node --test test/<file>.test.mjs  # 定向单测
PI_TEST_HOST_PACKAGE="${PI_TEST_HOST_PACKAGE:?Set PI_TEST_HOST_PACKAGE to the host package.json}" npm test
```

测试 provider 在 `test/fixtures/offline-provider.ts`，只用于隔离测试。宿主/TUI 测试按
[.agents/DEVELOPMENT.md](.agents/DEVELOPMENT.md) 的授权要求执行。报告里写清实际跑了什么、
通过/跳过/未验证的部分。

## 边界

- 不提交、不推送、不重写历史、不改版本号，除非用户明确要求。
- 不修改 `~/.pi`、`~/.bashrc`、用户真实记忆包或已有计算/测试产物；测试写入新建临时目录。
- 不加载真实付费模型、不安装依赖、不把测试 fixture 加载进正常工作会话。
- 不确定接口、格式或存储契约时先看实际代码与 `docs/decisions/`，不要猜。
