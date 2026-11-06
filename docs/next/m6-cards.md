# M6 计算化学卡片：契约与分阶段实现

## 状态与边界

用户已确认设计并授权按任务开发。T1–T6 的本地契约、固定可读渲染、入口适配及合成纵向已完成；定向 114/114、隔离全量 378/378，详见测试报告。默认入口仍是 v1；真实模型选择、真实项目续接、逐卡片真实 Pi 交互及人工科学审阅未验证，不从本地测试外推质量。决策见 [ADR 0007](../decisions/0007-computational-chemistry-cards.md)。

权威记录仍位于 `.internal/records`，不新增事实库、不迁移旧数据、不扫描真实计算目录。没有创建本项目 `.pi-root`。卡片不是计算执行、科学认证或重跑授权。

## 1. 兼容决策

- `schemaVersion` 保持 2；新增可选 `entry.card`，卡片格式为 `version: 1`。
- 旧记录无 card 时保持原字段、规范化次序、字节和摘要；读取不补卡片，历史不回写。
- 这是新代码读取旧数据的兼容。旧插件严格拒绝未知字段，不能保证旧代码读取新增卡片，也不承诺写卡片后的直接降级。
- 未知 card.version、未知字段、null、非有限数值拒绝；不把缺失转成 0、false、空串或科学默认值。
- 已有卡片不可通过省略 card 降级成文本；修订需携带完整卡片。
- 现有内容、provenance、verification、lifecycle、entities、scope 均保留；出处或 approve 不代表科学有效。

## 2. 结构

```text
entry.card = {
  version: 1,
  fields: { <按 kind 限定的字段>: <状态描述> },
  limitations: [<限制说明>],
  support?: { <现有权威字段路径>: [<来源>] }
}
```

描述状态：

- known：`{state: "known", value, sources: [...]}`；必须有值和来源，不允许 reason。
- unknown：`{state: "unknown", reason}`；不得有 value 或 sources。
- not-applicable：`{state: "not-applicable", reason, sources: [...]}`；不适用须说明依据，不得有 value。

来源：`{locator, quote, source}`。locator 必须存在于 entry.evidence；quote 保留原样、不 trim；source 为 user-statement/tool-observation/assistant-claim。此处校验结构和定位符关联，不访问文件、不验证摘录真实性、不提升 entry 的 verification。显式来源仍可能只是可追溯声明。

规范化以固定键序生成独立副本，不修改输入。文本长度按 UTF-16 code units；来源每字段最多 4 条、quote 最多 500、locator 最多 500；普通卡片文本最多 2000；列表最多 20 项；限制最多 10 条、每条最多 1000；性质限定最多 16 项。卡片自身不得超过现有单记录 250000 B，完整记录仍由存储上限约束。继续使用现有敏感内容保护。

结构校验器允许部分字段，用于测试/构建；存储发布和库存读取另行执行条件校验，不能用部分结构绕过发布。

## 3. 字段与条件

下列必填指必须明确声明 known/unknown/not-applicable，不表示必须猜出一个值。

### systems

必填：composition、structure、charge、spin、multiplicity、periodicity。

- composition/structure：来源表达文本，不推断化学式或结构身份。
- charge：有限数值，不默认整数或零。
- spin：`{quantity, value, unit?}`；quantity 为 total-spin/unpaired-electrons/magnetic-moment，不能混用。总自旋非负；非配对电子数为非负安全整数；磁矩允许符号但必须明确 unit。
- multiplicity：正安全整数；不从 spin 推导。
- periodicity：三个方向的布尔数组，不把 false 当缺失，不从软件名推断周期性。

不强制周期体系采用分子多重度，不执行电子结构一致性认证。

### methods

必填：model、basis、pseudopotential、dispersion、solvent、software、version、applicability，已知值为文本。

明确无色散不等于色散未知；真空不等于环境未知。通用方法卡可明确记录未知版本。不内置软件默认参数、基组兼容规则或单位转换。

### runs

必填：task、system、method、convergenceCriteria、validityScope；可选 outputAbsence。

system/method 的已知值是 `{id, revision}`，必须对应声明的实体引用及实际存在的正确 kind 修订。

不复制 entry.run 的四轴、软件、版本或输入输出。support 只允许 run.execution/termination/convergence/validity/software/version/input/output。已知轴和已提供的位置/软件字段必须有支持来源；unknown/unchecked 不自动变成成功。

- 非 unknown 的 termination 要求 execution=terminated。
- submitted/running/terminated 要求输入身份。
- terminated 要求输出位置，或已知 outputAbsence；两者不能同时声明。
- accepted-with-scope 要求已知 validityScope 和支持来源。
- 正常结束、收敛、科学有效互不推导；不存在通用的一维成功状态机。

实际重跑应创建不同 run；元信息修正可显式修订，既有结果继续固定到原修订。

### results

必填且必须 known：propertyKey、qualifiers、run。

- run 为 `{id, revision}`，id 必须等于 entry.result.runId，且实际历史修订必须存在。
- qualifiers 为字符串到字符串的有界映射；明确空对象表示没有限定项。保留 0 的字符串身份，不做自动转换或同义词归并。
- 仍以 entry.result 的 runId/property/value/unit/definition 为唯一权威。必须有有限数值、明确单位、定义及证据；无量纲也需显式单位表达。
- support 必须包含 result.property/value/unit/definition 的来源；必须有非空 limitations。
- 未知值/单位不能发布为结构化数值结果。失败运行的有限结果允许保留，但不因此获得收敛或有效性；来源 run 的四轴由固定引用保留。

固定来源在 run 后续更新后不回写。静态知识页展示固定来源四轴，不因来源更新自动改变；搜索、目录页和首轮简报的关键记忆可提示来源更新及固定来源限制。结果卡搜索项的 resultRun 为固定来源完整 run；sourceRun 保存固定修订四轴、latestRevision/updated，更新时另含 latestRun，不以最新成功声明替换原失败状态。旧无卡片记录的 resultRun 语义不变。

### diagnostics

必填：originalError、phase、originRun、hypotheses、confirmedCauses、parameterChanges、rerun。

- 原始错误与假设/确认结论分别保存；已知假设/结论为文本列表。字段来源不构成因果认证。
- parameterChanges：`{parameter, before, after, status}` 列表；before/after 仍为状态描述，已知值是 `{value, unit}`。值可为有限数值、布尔或文本；单位必须明确，不暗补旧值。
- status 为 proposed/adopted/applied；不等于已重跑。
- originRun 为固定运行引用，已知时须与声明的 run 实体匹配。
- rerun 已知值为 `{status: "not-rerun"|"planned"|"performed", run?}`。performed 必须提供实际存在的运行修订，并与已知 originRun 的 ID 不同；其他状态不允许指定已执行运行。

## 4. 引用、冲突与修订

固定引用解析完整不可变历史，不能只查 latest；引用缺失、错误 kind、自引用或实体不匹配拒绝。修订后仍可解析旧修订；历史记录本身也接受同样校验。

同 run 同性质的冲突在项目共享写锁内、全局 latest current 记录上检查，不使用目录筛选后的搜索结果：

- 两条结果卡以 propertyKey 与排序后的 qualifiers 定义身份；单位不参与分裂身份。
- 属性原名相同但 propertyKey 不同，保守视为身份歧义冲突。
- 涉及旧无卡片结果时，同 property 或对应 propertyKey 冲突保守拒绝，不猜限定项。
- 字符串身份不能识别所有科学同义词；M6 不进行语义合并或单位换算。
- 数值更正用原记录 ID 的 revise + expectedRevision；已有结果卡不能通过修订更换 run 或性质限定身份。
- 不新增跨记录 supersedes 图，不自动归档其他记录。显式归档/标记 superseded 后可另行发布；重新激活时再次查冲突。
- 旧版本已存在的重复记录保持可读。无卡片旧结果的纯元数据修订、且数值结构及 lifecycle 未变时不扩大冲突；新增、升级卡片或激活不能继续制造冲突。
- requestId 重试先识别已提交操作，不与自身冲突；并发新建不允许两条 current 同性质结果。

## 5. 发布入口与剩余工作

当前显式 Node API 与现有 v2 CLI JSON save/revise 通过同一存储校验链。候选入口拒绝卡片；候选不得修订已有卡片记录，审核阶段重新检查目标修订。自动提炼继续只选择有来源摘录，不生成结构化卡片、数值或科学状态。

T4 已完成：知识页在原 JSON+文本后增加固定卡片栏目、来源和限制；搜索索引包含权威 card，摘录优先保留数值、单位、来源四轴和限制。旧 JSON+文本生成页仍按完整历史输出精确识别；手改不覆盖。目录页继续用可校验所有权摘要保护。卡片渲染最多 40000 UTF-16 code units，保持既有派生页字节上限；来源摘录显示转义不改变权威原文。搜索摘录最多 1400，首轮简报最多 1200，上下文总量仍最多 12000 字符。单卡片上下文允许 2400 字符，超预算仍显示省略提示，不截断 JSON 元数据。

T5 已完成本地入口验收：v2.ts 的 Entry 开放可选 card；TypeBox 结构从同一字段/类型表生成，条件与引用仍由存储裁决。CLI save/revise/get、工具注册及 execute、人工/auto 候选保真均有隔离用例。工具适配器用宿主 TypeBox 和 Node 类型剥离加载隔离扩展副本，不激活真实设置/回调；它不是完整真实 Pi 卡片交互认证。

T6 已完成本地合成纵向及回归：共享体系/方法、失败运行和零值、未确认假设与尚未执行的参数建议、不同 ID 的重跑、旧/新结果分离、来源固定、目录隔离和续接预算。记录所示执行状态只是合成材料，没有实际计算。ADR 和开发入口已同步；不实现 M7/M8。合成夹具不是科学有效性或真实模型选择的证明。

## 6. 显式写入示例

下面只是 `project_memory_save` 的合成参数示例，不是实际体系信息，也未执行。只能在用户已授权、已显式初始化的项目中使用；不要为运行示例给本仓库创建标记。来源与值必须换成实际可追溯材料；未知信息继续明确 unknown。

```json
{
  "target": "knowledge",
  "entry": {
    "kind": "systems",
    "title": "Synthetic interface example",
    "content": "Interface fixture only; not a real molecule or calculation.",
    "provenance": "assistant-claim",
    "verification": "reported",
    "evidence": ["example:synthetic-charge"],
    "card": {
      "version": 1,
      "fields": {
        "composition": {"state": "unknown", "reason": "Not supplied."},
        "structure": {"state": "unknown", "reason": "Not supplied."},
        "charge": {
          "state": "known",
          "value": 0,
          "sources": [{
            "locator": "example:synthetic-charge",
            "quote": "This synthetic interface fixture explicitly records charge 0.",
            "source": "assistant-claim"
          }]
        },
        "spin": {"state": "unknown", "reason": "Not supplied."},
        "multiplicity": {"state": "unknown", "reason": "Not supplied."},
        "periodicity": {"state": "unknown", "reason": "Not supplied."}
      },
      "limitations": ["Synthetic fixture; no scientific validation."]
    }
  }
}
```

- CLI save 的 JSON 输入为 `{entry, requestId?}`，不包含工具的 target。
- CLI revise 输入为 `{id, expectedRevision, entry, requestId?}`；工具修订在上面的 knowledge 参数上增加 id/expectedRevision。先读取当前记录，携带完整卡片，不按标题找替代目标。
- Node API 为 `saveV2(project, entry, options)` / `reviseV2(project, id, expectedRevision, entry, options)`。
- 结果卡须先建立来源 run，明确 `fields.run={state:"known", value:{id,revision}, sources:[...]}`，并提供 propertyKey、qualifiers、权威 result 和对应 support。单位未知时不要编造数值结果。
- 字段引文检查只验证结构与定位符关联，不证明引文来自真实文件。approve 不会把文本候选转换成卡片；需要卡片时单独显式保存/修订。

实际命令与结果见 [测试报告](../testing.md)。不提交、不推送、不安装依赖，不改 v1/default/version/打包字段，不运行真实计算、调度器或远程模型。
