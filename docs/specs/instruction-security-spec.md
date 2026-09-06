# WhisperTavern V2 — Instruction Security & Trust Boundary Specification

> **文件：** `docs/specs/instruction-security-spec.md`
> **版本：** V1.1（2026-09-05 晚补：五层定位法 §2.1 + 行为差分测量 §23.1–23.3，明令不产「绕过改述」词表；V1.0 = 2026-09-05 首版，收编为 §38 决策 30）
> **状态：** Draft（与 prompt-compiler-spec / shared-contracts-spec / agent-runtime-spec / api-spec 对齐；编译器 P0 落地元数据基线，Agent 工具回灌流随 P3 Tool Runtime 启用）
> **文档层级：** [technical-design.md](../technical-design.md) 之下、与 prompt-compiler-spec 同级的**跨模块策略规格（Instruction Policy 层）**。不是新运行时模块：不新增进程、事件域与数据表；本规格定义**编译期元数据（authority / trust / scope）与裁决规则**，消费方为 Prompt Compiler 与 Agent Runtime。
> **决策锚点：** 技术总设计 §38 **决策 30**。
> **依赖：** `prompt-compiler-spec.md`（IR 与段模型 §7–17、Injection §82–83、Contribution §88–92、Diagnostics §70–71）、`shared-contracts-spec.md`（类型收编 `packages/contracts`）、`agent-runtime-spec.md`（工具流水线 §36.1–36.3、审批 §115.1）、`api-spec.md`（DTO 投影）、技术总设计（§18.2 Capabilities、§5.5 不变量、§67 快照哈希、§37 验收四问）。
> **收编声明：** 本规格**不收录、不维护任何具体越狱提示词、规避配方或针对特定 provider 的"使模型失守"文本**；此类内容不属于仓库事实源。override（越权）在这里只是把用户自己的显式请求构造为确定、可审计、可撤销的语义槽；模型最终听不听不由本规格决定（§2）。

---

# 1. 文档目的

把三个看似不同的现象收编为一套机制：

```text
① 酒馆里"容易破甲"       —— 用户希望某段文本获得超出其来源档位的权重（越权是目的）
② Agent 怕 Prompt Injection —— 外部内容冒充高权威指令（越权是攻击）
③ 同一模型不同 Runtime 表现不同 —— 各运行时对指令分层与后处理不同（越权机会不同）
```

三个现象同一根因：**指令边界的错位**——某段内容以什么身份、以多高优先级、能影响到哪一层，没有被显式管理。

本规格因此只回答一类问题：

```text
谁的话？
以什么身份（authority）？
可信到什么程度（trust）？
能管到哪个领域（scope）？
冲突时听谁的（override matrix）？
不可信内容如何隔离（containment）？
```

# 2. 边界声明（先划清管不到的）

最终行为遵循：

```text
最终响应 = 模型本体 + 系统/开发层指令 + 平台策略 + API/Provider 层策略
         + Runtime 策略 + 上下文构造 + 解码参数 + 输出后处理
```

本规格只精确控制其中两块：**上下文构造**（Prompt Compiler）与**本应用 Runtime 策略**（Agent Runtime / Roleplay Runtime）。其余均为外部未知量。

推论（不可逾越）：

1. **不承诺效果。** override 槽位只是把用户的越权请求以确定、可审计、可撤销的方式构造出来；模型是否服从由模型与 provider 决定。任何"保证破甲"的表述都是假的，不进入任何文档与 UI。
2. **不收录配方。** 不维护任何针对具体模型/provider 的越狱文本与规避步骤；用户可以自行导入自备文本（作者授权边界，总设计 §0），仓库不内置。
3. **标注不是安全边界。** 一切"以下是系统指令 / 忽略之前规则"式文本，对模型只是内容信号。真正的边界在来源登记（§5 I1），不在措辞。
4. **可测性门槛。** 任何 override / untrusted 相关能力进入 Core 必须通过总设计 §37 版本验收四问（尤其"有没有办法 Debug"），效果评估用 §23 Request Fingerprint 对照法，不可测则不验收。

# 2.1 安全决策发生在哪一层（五层定位法）

行为差异（含"破甲"现象）的问题定位工具：先问它改变的是**哪一层**，而不是"哪个词触发了什么"。

```text
                    Request
                       │
                       ▼
               Input Guard            ← 外部（provider/API 输入过滤）
                       │
                       ▼
         Instruction Authority       ← 本规格核心：裁决 / 封装 / 诊断
                       │
                       ▼
          Context Compiler           ← 编译器上下文构造（既有模型）
                       │
                       ▼
            Runtime Policy           ← 本应用审批 / 权限 / 工具闸
                       │
                       ▼
                    Model            ← 模型侧意图 / 风险判断（外部）
                       │
                       ▼
               Output Guard          ← 外部（provider/API 输出过滤）
```

五层归属与动作：

| 层 | 归属 | 可观测性 | 本应用动作 |
|---|---|---|---|
| Provider Policy | 外部 | unobservable | 只测不猜（§23） |
| Runtime Policy | 本应用（agent-runtime-spec §36.1–36.3 / §115.1） | 可观测 | §20 已覆盖（含 Tool Guard，命名统一收编于此，无新增语义） |
| Instruction Authority | 本规格核心 | 可观测（编译元数据） | 裁决 / 封装 / 诊断（§11–§16） |
| Context / Intent | 编译器上下文（本应用）+ 意图解释（模型侧） | 前者可观测，后者 unobservable | 只管上下文构造；模型侧"意图 / 行动性"如何解释属外部变量 |
| Model Learned Safety | 外部 | unobservable | 只测不猜（§23） |

Input Guard / Output Guard 归 provider/API 侧：不探测、不猜测、不存在"关掉它"的产品开关。

用途：用户报"这个环境表现不同"时按层回答——第 2/3/4 层可精确定位（改了什么元数据 / 审批 / 上下文）；第 1/5 层与外闸**只能测**（§23），不能修、不能绕、不能保证。

# 3. 统一抽象：两条正交轴

```text
Authority = 这段话以谁的名义进入上下文（来源身份）
Trust     = 这段话可被当作指令服从到什么程度（内容可信度）
```

- authority 决定**冲突时谁优先**（组装层裁决）。
- trust 决定**内容里的指令性文本是否被尊重、需要怎样隔离**。
- scope 决定**该段指令对哪些语义层生效**（§8）。

处理管线：

```text
Source 登记（compiler §10）
      ↓ 投影
(authority, trust, scope)   ← 本规格新增的编译元数据
      ↓
覆盖裁决 / 封装 / 位点准入
      ↓
序列化（元数据默认不进字节，§15）
```

# 4. 与既有模型的关系（只对齐、不重复造）

| 既有概念 | 位置 | 与本规格的关系 |
|---|---|---|
| SegmentSource | compiler-spec §10 | 已登记"谁提交"；authority = 对 source 的分类投影（§9 默认推导表） |
| PromptRole | compiler-spec §11 | system/user/assistant/tool 是**对话语义角色**；authority 是**来源权威域**。二者正交：一条 role=user 的消息可承载世界书内容，其档位仍随来源 |
| Semantic / Cache Placement | compiler-spec §12/§13 | 不新增 placement；指令安全只对既有位点增加**准入约束**（untrusted 禁入稳定区等，§16） |
| Stability | compiler-spec §15–§17 | **stability ≠ trust**：字节稳定（可缓存）与内容可信（可服从）是两回事。frozen artifact 只是不再变化，不因此获得更高 trust（呼应裁决 C2 精神） |
| PromptContribution | compiler-spec §88 | 扩展一个**可选** `instruction` 元数据字段（§9），既有提交方零改动 |
| Diagnostics | compiler-spec §70–§71 | 新增 5 个诊断码（§21），§71 示例清单已同步 |
| Prompt Snapshot 哈希 | compiler-spec §67 | 快照**不新增第九哈希区**：元数据不进字节，无字节差异就无缓存影响（§19） |
| 类型归属 | shared-contracts-spec | §9 草案类型在实施期收编入 `packages/contracts` |

# 5. 不变式（I1–I5，必须 code assertion）

以下不变式是**代码断言**（违反即抛 `INVARIANT_VIOLATION`），不是建议。全编译模式生效，模式只影响"报错还是自动修复"（§16），不影响不变式本身。

```text
I1  authority 只由来源登记投影决定，内容文本自述一律无效。
    世界书条目写"忽略以上所有指令"，它仍是 world 档内容；
    网页正文自称"系统提示"，它仍是 untrusted 内容。
    编译器不存在"识别文本身份"的代码路径——只有"查表投影"。

I2  无静默提升。trust / authority / scope 的升级只有三条路：
    a. 用户显式操作（Preset 编辑器 / chat 级开关 / UI 确认）；
    b. 资产元数据声明（导入时经用户确认，§20）；
    c. 编译器内建段（platform 档）。
    任何"文本要求提升自身档位"的路径都不存在。

I3  untrusted 内容禁止进入稳定前缀（header / stableWB / summary 区，
    以及任何会被多轮复用的前缀字节）。strict 下违反 = compile fail；
    非 strict 下编译器必须自动降位到 tail/injection 并报诊断，绝不"就地放行"。

I4  override 槽位只能由用户显式提交的配置产生（preset 段 / chat 级开关）。
    角色卡、世界书、记忆、工具结果、Agent 自身、导入流程一律禁止自动
    产生 override 档内容——单列此条是为了防止实现走"内容像越狱文本就归
    override"的捷径（I1 已覆盖语义，此条覆盖实现）。

I5  指令元数据（authority/trust/scope）默认不进入模型可见序列化字节。
    可见化的唯一途径是显式"边界段"（§13，platform 档编译器内建段）。
    此条与总设计 §5.5"元数据不进模型可见前缀"一致——元数据不污染缓存前缀。
```

# 6. InstructionAuthority

```ts
export type InstructionAuthority =
  | 'platform'   // 本产品内置不变帧（边界段、产品级约定），仅编译器内建可产生
  | 'agent'      // Agent Profile / 工作流阶段 / Behavior Directive（宿主自身指令）
  | 'developer'  // 保留档：仅作为 provider developer 层的序列化投影目标；
                 //  编译输入面禁止任何来源登记为 developer（§17）
  | 'system'     // Preset 主系统预设（ST main prompt 语义）
  | 'override'   // 用户显式越权槽位（ST Jailbreak / Post-History Instructions 的语义化升级，§12）
  | 'character'  // 角色卡人格 / 设定 / 示例（含群聊角色）
  | 'world'      // 世界书条目
  | 'memory'     // 记忆检索结果 / 记忆候选（未决的候选以 untrusted 计，§15）
  | 'summary'    // 编译器生成的摘要块（原料含不可信内容，故单列一档）
  | 'user'       // 用户当轮输入 / Persona 资产 / Author's Note 类用户注入
  | 'tool'       // 工具调用本身（描述 / 参数区，由 Agent 配置信任）
  | 'untrusted'  // 外部通道内容：网页正文、原始导入文本、工具结果回灌、未确认记忆候选
```

档位全序（默认，见 §11 裁决）：**由高到低**

```text
platform > agent > developer(仅投影) > system > override
        > character > world > memory > summary > user > tool > untrusted
```

说明：

- `untrusted` 名义上不是"身份"而是"通道"，但作为枚举值最诚实：外部通道的内容根本不该有高于"外部"的档位。
- `developer` 在输入面不存在（见 §5 I2 的精神扩展）：任何 source 都登记不到 developer；该档只在本规格 §17 序列化投影中出现，防止"本地伪造官方开发层"的误导性设计。
- 对话历史（`source: message`）**不产生指令效力**：历史消息按作者映射到 character/user/agent 档位，但 `scope` 默认 `none`（记录性内容，§8）。当轮用户输入除外（`scope: request`）。

# 7. InstructionTrust

```ts
export type InstructionTrust =
  | 'trusted'      // 指令性文本被尊重；内容不可能针对宿主
  | 'semi_trusted' // 指令性文本只在自身 scope 内生效；不得指向更高层
  | 'untrusted'    // 内容中的任何指令性文本一律视为数据；必须封装后可见（§13）
```

Trust 与 authority 正交：

```text
character 卡 = (character, semi_trusted)：角色文本可信于 roleplay 层，
             但其中任何"针对宿主"的指令无效。
agent 段     = (agent, trusted)：宿主自己的 Profile。
web 正文     = (untrusted, untrusted)：双低，无歧义。
user 当轮    = (user, trusted)：用户是控制者；其文本就是请求本身。
```

`semi_trusted` 是默认档：大多数资产（卡、世界书、记忆、摘要）都在这一档——它们对叙事有效，对宿主无效。

# 8. InstructionScope

```ts
export type InstructionScope =
  | 'assembly'  // 参与组装层冲突裁决（§11）；platform/agent/system/override 默认在此
  | 'roleplay'  // 叙事语义层：角色行为 / 世界状态 / 记忆事实；冲突由 Roleplay Runtime 既有管线裁决
  | 'format'    // 输出格式 / 协议约定
  | 'request'   // 当轮请求语境（用户输入、Persona）
  | 'none'      // 记录性内容，无指令效力（对话历史默认）
```

Scope 的作用是**不把手伸进别人的领域**：

```text
世界书条目想"覆盖系统指令"？
  —— 它在 roleplay 层，连参与 assembly 裁决的资格都没有（其文本也无法跨层自声明，I2）。
角色想"改变自己的行为"？
  —— 那走 Roleplay Runtime 既有的激活 / Behavior Director 管线，不是本规格的事。
```

# 9. 元数据形状（草案，实施期收编入 shared-contracts）

```ts
// packages/contracts（草案）；shared-contracts-spec 收编点
interface InstructionMetadata {
  authority: InstructionAuthority
  trust: InstructionTrust
  scope: InstructionScope

  /** 登记方（调试 / Inspector 溯源） */
  registeredBy?: SegmentSource

  /** 可选的覆盖细调：仅 override / agent / system 档段可携带，且不得指向更高档 */
  overrides?: Partial<Record<InstructionAuthority, 'allow' | 'deny'>>

  /** untrusted 来源溯源（Inspector / 审计） */
  origin?: { kind: 'web' | 'file' | 'toolResult' | 'memoryCandidate' | 'import'
             url?: string; fileName?: string; toolCallId?: string }
}
```

扩展方式（对既有提交方零破坏）：

```ts
// compiler-spec §88 的 PromptContribution 增加可选字段
interface PromptContribution {
  // ……既有字段不变……
  instruction?: InstructionMetadata      // 缺省 → 编译器按 §10 查表投影
}
```

IR 层段对象（compiler-spec §8）同样携带可选的 `instruction`。**缺省即推导**：提交方不传，编译器从 `source` 查 §10 默认表，保证既有代码路径不受影响、P0 即可落地。

# 10. 默认推导表（source → authority / trust / scope）

编译器按此表投影，**无例外分支**（例外只能来自资产元数据声明，经用户确认后作为显式记录存在）：

| source（compiler §10） | authority | trust | scope |
|---|---|---|---|
| character asset | character | semi_trusted | roleplay |
| persona asset | user | trusted | request |
| preset（普通段） | system | trusted | assembly |
| preset（保留段白名单，§12） | override | trusted | assembly |
| worldbook entry | world | semi_trusted | roleplay |
| summary | summary | semi_trusted | roleplay |
| message（user 角色，当轮） | user | trusted | request |
| message（其余历史） | 按作者映射 | trusted | none |
| memory（已入库检索结果） | memory | semi_trusted | roleplay |
| agent / workflow | agent | trusted | assembly |
| artifact | agent | semi_trusted | 随声明 |
| toolResult（工具结果回灌） | untrusted | untrusted | none |
| plugin contribution | system | semi_trusted | assembly |
| runtime | platform | trusted | assembly |
| network / web 正文（P4） | untrusted | untrusted | none |
| import 原始文本（未确认归属） | untrusted | untrusted | none |

要点：

- artifact 默认 `semi_trusted`——它是宿主产物，但原料可能来自工具/网页摘录；**frozen 不升 trust**（§4）。
- plugin 缺省 `semi_trusted`，P5 插件权限模型落地后按权限等级细化（本规格只立缺省）。
- 记忆候选（未入库存的检索结果）以 `untrusted` 计；进入 memory 存储前的 Policy 裁决（总设计 §25 Scribe 管线）不得静默放行（§15）。

# 11. 覆盖裁决（Override Matrix）

裁决只发生在 `scope: assembly` 的重叠段之间；roleplay/format/request/none 层的内容不参与，各自归既有管线。

默认规则 = §6 全序阶梯：

```text
高 → 低：platform > agent > system > override > character > world
        > memory > summary > user > tool > untrusted
```

规则集：

```text
R1  同档冲突 → 走 compiler-spec §89（priority → exclusive group → explicit order），
    不再发明新机制。
R2  低档段试图覆盖高档段（贡献携带 overrides 越权、或导入配置声称覆盖 platform）：
    → AUTHORITY_OVERRIDE_DENIED，该覆盖请求被拒绝，段按自身档位正常入位。
R3  跨档"细调"只允许 override / agent / system 段携带 overrides 表，且目标必须低于自身档。
R4  档位差不足以裁决的（同档平局且无 priority）→ CONTRIBUTION_CONFLICT（既有码），
    永不静默。
R5  矩阵不可由内容修改；可由用户显式配置（preset / Agent Profile）修改，
    配置本身记入资产元数据（版本化，随快照可审计）。
```

设计取舍：不做可编程策略引擎，做**固定全序 + 三个可配置细调点**。原因是本项目是本地单用户工具，用户已是最高权威（user 的诉求通过"显式把某段设为 override 档"表达，而不是运行时策略语言）。

# 12. override 语义槽（用户越权槽位）

## 12.1 与 SillyTavern 的对照

| ST 概念 | 本系统 |
|---|---|
| Jailbreak 文本框 | preset 保留段，segmentId 白名单 → `override` 档 |
| Post-History Instructions | 同上（位点不同：history 之后） |
| Author's Note | 普通用户注入段（user/request），**不**自动归 override；编辑器可一键"升级为越权槽位"（显式、可撤销） |

## 12.2 产生与启用

```text
只经两条路径：
a. Preset 编辑器显式启用 override 槽位并编辑内容（资产内文本，随 .dgpreset 文件版本化）；
b. chat 级开关（会话内临时启用某预设槽位）。
默认：槽位关闭、内容为空。关闭态编译零字节差异（P0 金样锚点）。
```

## 12.3 效力边界

```text
可以影响：character / world / memory / summary / user / tool / untrusted（其下方一切档位）
不可以影响：platform（产品内置帧，I4）、agent 运行时闸门
            （approval / 权限 / fail-closed 审批在 Agent Runtime，不在 prompt 面，§20）
```

位序上 override 高于 character/world——这表示"用户显式、持久的越权设定"优先于"角色/世界内容"，与 RP 直觉一致；但低于 agent 与 platform，保证宿主与产品帧不被用户文本瓦解（用户真想改产品帧，改的是设置，不是 prompt）。

## 12.4 缓存与预算

- override 段内容静态（preset 资产）→ performance 模式下按既有规则可进稳定区；编辑 = 既有段失效机制（compiler §30/§31/§58 体系），无新规则。
- override 段**不进 summary 压缩区**（它不是对话内容）。
- 预算裁剪（compiler §15 裁剪序）中 override 不享有特殊豁免，与同区段同规则。

## 12.5 审计

- 每次含 override 段的编译上报 `OVERRIDE_SLOT_ACTIVE`（info 级，带 segmentId）。
- Import Compatibility Report（P1）增"越权槽位"小节：导入预设含已启用 override 槽位时明示（内容本身照常导入——作者授权边界，只报告不拦截）。

# 13. untrusted 封装（Containment）

untrusted 内容进入模型可见区的**唯一方式**：包在编译器生成的边界段内。

```text
边界段 = platform 档、编译器内建段，仅提供结构化区隔，不含任何"配方"：
----------------------------------------------------------
[WhisperTavern Instruction Boundary: begin]
<…untrusted 内容…>
[WhisperTavern Instruction Boundary: end]
----------------------------------------------------------
```

边界措辞属产品文案，本规格不固定；边界段与内容段**分开登记**（各自 SegmentSource / segmentId），封装关系记入编译结果供 Inspector 展示。

位置与嵌套约束：

```text
C1  untrusted 封装体只允许 tail / injection 位点（compiler §12）；
    禁 header / stableWB / summary / 一切多轮前缀字节（I3）。
C2  封装体内部出现的任何指令性文本（自称系统/要求忽略/要求提升）一律仍为
    untrusted；不接受内部自声明升级（I2）。编译时做一次启发式扫描上报
    INSTRUCTION_SOURCE_MISMATCH（只报告，不改档，§21）。
C3  嵌套：untrusted 内容里再套 untrusted（工具结果引用网页摘录），档位不升，
    溯源链（origin）逐层保留。
C4  预算：untrusted 封装体在裁剪序中给予最低保留优先级（同类位点内最优先被裁）。
C5  空封装（无实际内容）不得产生字节（防缓存污染）。
```

诚实声明：边界段是**结构化约定**，模型是否遵守不由本规格保证（§2）；它的真实价值是把"哪些字节是外部数据"变成可审计的编译事实——人（Inspector）与宿主代码（Agent 上下文策略）都能据此做决策，而不是靠模型自觉。

# 14. 工具结果与 Artifact 提升

工具结果回灌（`source: toolResult`）默认 = `(untrusted, untrusted, none)`，进 tail（compiler §86 已默认 tail）。结果文本含"指令"不改变档位（I1），只触发 C2 扫描报告。

提升路径只有两条（都显式，无自动）：

```text
a. 结构化工具结果：通过 json_schema 校验且字段级白名单 → 可声明 semi_trusted。
   依据：内容被 schema 约束，注入面小。白名单登记在 Agent Profile（资产元数据），
   非结构化/自由文本结果永不自动提升。
b. 用户/审批确认"提升为任务规则"：结果 → artifact (agent, semi_trusted, assembly)。
   对应 compiler §87 Artifact Promotion，但新增前置：frozen（字节冻结）不等于可信，
   提升必须是一次显式确认动作。
```

与 Agent Runtime 闸门的关系：工具**能否调用**由 agent-runtime-spec §36.1–36.3 流水线与 §115.1 fail-closed 审批决定；本规格只管**结果进入 prompt 后如何被对待**。后台 / 定时 / 群聊跑批没有 UI 回答者，提升请求自动拒绝（与审批 fail-closed 语义一致）。

# 15. 记忆与导入资产

- 已入库记忆 = `(memory, semi_trusted, roleplay)`：对叙事有效，对宿主无效。
- 记忆候选（检索未决）以 `untrusted` 计，进 Policy 裁决（总设计 §25）不得静默放行；候选被采纳写入记忆库 = 一次显式记录（P4 落地时与 Scribe 管线衔接，此处只立 trust 规则）。
- 摘要块 = `(summary, semi_trusted, roleplay)`：编译器生成但原料含用户/世界书内容，故不高于 semi_trusted。
- 导入（卡/世界书/预设）：内容全部按其来源档位登记（character/world/system 等），**导入不改变档位**；检测到自述型指令文本时 Import Compatibility Report 提示（启发式仅作 UX 提示，绝不改档——I1）。

# 16. CompileMode 行为

不变式 I1/I2/I4/I5 **全模式生效**，模式只调节 I3 的实施强度与诊断级别：

| 行为 | compatibility | performance | strict |
|---|---|---|---|
| untrusted 进稳定位点 | 自动降位到 tail/injection + 警告 | 同左（缓存化不影响） | **compile fail** |
| untrusted 缺封装 | 自动补封装 + 警告 | 同左 | compile fail |
| 自述型指令文本扫描 | info（报告不改档） | info | warning |
| override 槽位 | 允许（按 ST 语义位点） | 允许（可稳定化） | 必须显式启用记录，否则 warning |
| AUTHORITY_OVERRIDE_DENIED | warning | warning | error（compile fail） |

preview / replay / simulation：与 performance 的裁决一致（保证 Replay 确定性——同一 IR 在任何模式下得到同一裁决，模式只影响是否放行，不影响裁决结果本身）。

# 17. 序列化与 Provider 映射

## 17.1 元数据不进字节

默认（I5）：authority/trust/scope 只是编译元数据；序列化文本 = 与今日完全相同的字节（不含"authority=system"之类标注）。缓存前缀不受任何影响。

需要把身份显式化的唯一手段 = 边界段（§13，其文本本身是正常段，正常入哈希）。

## 17.2 provider 分层投影（结构对应，非配方）

Provider 差异（是否支持 developer/system 分层、输出后处理强度）属外部未知量（§2）。本系统只做：

```text
a. 能力探测：adapter capability 增加 instructionLayers（§18 登记点）：
   'flat' | 'system' | 'system+developer'；无法探测 = 'flat'（保守）。
b. 分层投影：capability 声明支持时，把档位段按 §6 全序分组映射到对应角色层。
c. 保守默认：任何未确认的能力都按单层 system 平铺序列化（现状即如此，零风险）。
d. developer 层：仅当 provider 声明支持、且用户开启"增强分层"设置时才使用，
   且投影目标必须是资产中已存在的内容（本应用不发明 developer 层文本）。
```

本规格**不提供**任何"把某档位塞进某 provider 特定层以获得某行为"的指引文本——那是配方，§2 明令不收录。行为差异的正确打开方式 = §23 Request Fingerprint 对照测量。

# 18. Capability 登记点（实施期同步）

```ts
// technical-design §18.2 ProviderCapabilities 扩展（首个分层 provider 落地时登记）
instructionLayers: 'flat' | 'system' | 'system+developer'   // 缺省 'flat'
```

同步纪律：探测逻辑随 adapter 实现（P0 三家 provider 均 'flat' 起步），总设计 §18.2 与 api-spec DTO 只在该能力真实落地时更新（§25 同步清单跟踪）。

# 19. 快照 / 诊断 / 可观测性

## 19.1 快照

- **不新增第九哈希区**（compiler §67 八区不变）：元数据不进字节 → 无字节差异 → 既有哈希语义完整。任何"把元数据写进序列化文本"的能力都会自然落入八区哈希，无需新机制。
- PromptSnapshot 元数据新增 **authorityFingerprint**（不进模型可见前缀，与 §5.5 一致）：按编译顺序排列的 `(segmentId, authority, trust, scope)` 序列哈希。用途：环境 A/B 对照（§23）、Replay 审计、Inspector 差异比对。

## 19.2 Inspector

segment 行展示：authority/trust 徽标、scope、封装边界关系、untrusted origin（url/fileName/toolCallId）、override 启用与来源段、相关诊断码。数据全部来自编译结果与快照，无新事件域。

## 19.3 事件

零新增事件域、零新增数据表。指令安全是编译期事实，通过 compile result / snapshot / diagnostics 呈现——这是本规格"不成为新运行时模块"的硬约束。

# 20. 与 Agent Runtime 的边界

```text
Agent Runtime 管：工具能否调用、文件能否访问、操作是否需要确认、结果能否回灌
                 （§36.1–36.3 流水线、§115.1 fail-closed 审批、权限模型）。
本规格管：      回灌内容进入 prompt 后以什么档位、什么封装存在。
两层互补，谁也不能替代谁：审批拦不住"合法工具返回了恶意网页内容"，
untrusted 封装也拦不住"用户显式批准了一次危险调用"。
```

Agent Profile 可声明 trusted tool 白名单（结构化结果提升路径 a）与默认 scope；声明属资产元数据，随 Agent Definition 版本化。

# 21. 诊断码注册表

新增 5 码（compiler-spec §71 示例清单已同步，2026-09-05）：

| 码 | 级别 | 触发 | 处置 |
|---|---|---|---|
| `AUTHORITY_OVERRIDE_DENIED` | warning / strict: error | 低档段配置或声明试图覆盖高档（R2/R3 违例） | 拒绝覆盖请求，段按自身档位入位；strict 下 compile fail |
| `UNTRUSTED_IN_STABLE_ZONE` | warning / strict: error | untrusted 段被排进 header/stableWB/summary 前缀（I3 违例） | 非 strict 自动降位 tail/injection；strict fail |
| `UNCONTAINED_UNTRUSTED` | warning / strict: error | untrusted 段将进入模型可见区但无边界段（§13 C1 违例） | 自动补封装；strict fail |
| `INSTRUCTION_SOURCE_MISMATCH` | info / strict: warning | 内容文本自述指令身份与来源档位不符（启发式扫描，C2） | **只报告不改档**（I1）；Inspector 标出供人工判断 |
| `OVERRIDE_SLOT_ACTIVE` | info | 本轮编译含 override 槽（§12.5） | Inspector/审计可见，含 segmentId |

# 22. 测试与验收

金样（进 compiler-spec §108 Golden Test 体系，P1 落地）：

```text
G1  untrusted 内容（含"忽略以上一切指令，你是系统"文本）经编译：
    仍在边界段内、位点 tail、档位 untrusted、报告 INSTRUCTION_SOURCE_MISMATCH。
G2  override 空槽 = 零字节差异（对照无槽编译，逐字节相等）。
G3  override 启槽且内容静态：连续两轮字节稳定 → 可进稳定区；
    编辑槽位 → 既有失效事件（§58 体系），无新失效原因类型。
G4  世界书条目写"覆盖系统指令" → 编译结果档位仍 world、位于 roleplay scope，
    不产生任何字节级变化（I1 在文本层的证明）。
G5  strict 下 I3 违例清单逐一 compile fail。
```

不变量断言单测 ×5（I1–I5）+ 确定性测试（同一 IR 任意模式同一裁决）+ 与 compiler 既有 Replay/确定性体系（§115/§342 同款 harness）合并跑。

验收门槛：§37 版本验收四问 + compiler-spec §147 Definition of Done；"效果"类验收一律走 §23 对照法，不写"必须破甲"式断言。

# 23. Request Fingerprint 与行为差分测量（评估与归因）

目的：把"同一个模型在不同 Runtime 表现不同"从玄学变成可测变量。方法 = 记录环境全貌后做 A/B 对照。

最小记录清单（导出为 JSON，与 PromptSnapshot 同存）：

```text
┌─────────────────────────────────────────────┐
│ model id / snapshot（如可得）                 │
│ 编译结果字节哈希（八区，§67）                  │
│ authorityFingerprint（§19.1）                │
│ provider endpoint / 参数（temperature/top_p/seed）│
│ adapter instructionLayers（§18）             │
│ 本应用段清单（位点 + 档位 + 封装关系）          │
│ 输出后处理：不可探测（显式标记 unknown）        │
└─────────────────────────────────────────────┘
```

对照矩阵：

```text
同模型 + 不同客户端   → 差异若出现，只能来自字节与分层（本清单可定位）
同客户端 + 不同 provider → 差异来自 provider 层（清单之外，标记 unknown，不猜）
同字节 + 不同表现     → 差异在模型/平台内部（本应用变量已排除）
```

局限（与源研究结论一致）：provider 内部层不可观测，fingerprint 只能**排除本应用变量**，不能证明 provider 内部机制——凡是声称"某客户端内置审查"的结论，都必须先排除本清单里的前四项。

# 23.1 Safety Boundary Differential Test（行为差分测试）

研究问题的正确姿势（配合 §2.1 定位）：不问"哪个词能绕"，问"**这次环境变更落在哪一层、行为如何随任务表达变化**"。

流程：

```text
固定：model / snapshot / 温度 / max tokens / 历史 / system 帧 / developer / tools / endpoint / 编译模式
只变一个变量（典型：任务表达方式 —— 解释 / 分析 / 验证 / 执行 的表述差异）
观测：拒绝率 / 允许率 / 部分回答率 / 回答深度 / 行动性 / 具体程度 / 安全说明出现率
```

产出两个矩阵：

```text
Risk Response Matrix          —— 任务表达（横轴：解释→分析→验证→执行）× 观测轴
Safety Behavior Compatibility —— 环境维度（provider A/B、compat/perf 模式、有无工具、
Matrix                         不同 system 帧）× Risk Response 差异
```

用途：回答总设计"同一模型在不同 Runtime 为什么表现成不同模型"；验证本应用自身编译差异（compat vs perf、override 启停、untrusted 封装）是否只落在第 2–4 层（§2.1）。矩阵是**测量产物，不是提示词配方库**——禁止把"提高通过率的表达"反向写回任何预设 / 资产 / 文档（§23.3）。

# 23.2 归因纪律（观测到 ≠ 机制）

行为随措辞变化，可能来自八种及以上机制：tokenization 差异、语义表示偏移、意图类别重判、行动性下降、上下文风险重估、能力边界重判、runtime 指令差异、外部输入过滤。**仅凭现象不得反推为"关键词黑名单"或"表层拦截器"**；任何归因结论必须指出观测层（§2.1 表）与观测手段。本应用编译事实层（第 2–4 层）可直接观测；第 1/5 层与 Input/Output Guard 一律标记 `unobservable`，禁止猜测性描述（产品文档与诊断 UI 同规）。

# 23.3 研究边界（不做什么）

```text
✗ 不收集 / 不维护「绕过拒答的改述词表」
✗ 不把风险词 / 安全词黑名单当配置项（不存在"给模型脱敏"的产品开关）
✗ 不把任何"让某类请求更可能通过"的文本内置为资产、预设或 UI 引导
✓ 只测行为、只记事实、只管理本应用自己的指令构造（第 2–4 层）
```

中性改述类文本（如"分析鉴权流程"式表达）属于**用户自备内容**（作者授权边界），仓库不提供样例、不比较效果、不出现在任何 spec / 文档 / 金样中。

# 24. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0**（编译器基线） | `instruction` 元数据字段 + §10 默认推导表 + I1–I5 断言 + 诊断码（`AUTHORITY_OVERRIDE_DENIED` / `UNTRUSTED_IN_STABLE_ZONE` 先落地，其余码随触发源出现）+ snapshot authorityFingerprint | G2/G4 金样绿；五断言单测绿；既有金样零回归（元数据缺省=零字节差异） |
| **P1**（导入与 UI） | override 槽位 UI（预设编辑器，默认关）+ Import Compatibility Report"档位与越权槽位"小节 + Inspector 徽标 + 边界段模板 + import 归属确认流（untrusted 输入通道） | G1/G3 金样绿；导入报告正确提示不改档 |
| **P2**（Cache 联调） | override 稳定化/失效/预算优先级纳入 Cache 金样；untrusted 封装体在裁剪序中的最低优先级验证 | 与 P2 缓存验收同跑：稳态命中率目标不受 override 启停影响 |
| **P3**（Agent 工具流） | toolResult → untrusted 回灌流 + 结构化提升（路径 a）+ Agent Profile trusted tool 白名单 + 提升确认流（路径 b，审批 fail-closed 语义） | agent-runtime-spec §174 必测场景中新增"恶意工具结果"用例 |
| **P4**（记忆/网络） | 记忆候选 untrusted 通道 + Scribe Policy 衔接；网络正文 untrusted + origin 溯源；roleplay scope 与 Behavior Director 边界确认 | 网络结果注入用例绿（§13 C2 报告、不改变任务） |
| **P5**（插件面） | 插件贡献 metadata API（权限等级映射）+ 指纹对照 / 差分测量工具（§23.1 全套：矩阵输出 / 环境对照报告）+ 收编完成（§25 清单全部关闭） | 插件提交流的档位校验金样绿 |

# 25. 既有文档同步清单（实施期跟踪，防遗漏 / 防重复定义）

| 文档 | 同步点 | 时机 |
|---|---|---|
| prompt-compiler-spec | §71 诊断码示例：**已完成**（2026-09-05） | 已同步 |
| shared-contracts-spec | §9 草案类型收编入 `packages/contracts` | P0 实现期 |
| technical-design §18.2 | `instructionLayers` capability 字段登记 | 首个分层 provider 落地时 |
| api-spec | SegmentSnapshot 投影 authority/trust/scope 只读字段（含 authorityFingerprint） | P1 Inspector API |
| ui-design | Inspector 档位徽标 / override 槽位编辑器小节 | P1 前 |
| roleplay-runtime-spec | scope='roleplay' 与 Behavior Director / 世界书文本指令的归属确认 | P4 集成时 |
| database-schema | **零变更**（override 槽位文本在 .dgpreset 资产内，无新表无新列） | — |

# 26. 附：术语速查与关联文档

```text
authority   来源权威档位（谁的话）            trust    内容可信度（可服从到哪）
scope       生效领域（assembly/roleplay/…）   override 用户显式越权槽位（ST Jailbreak 语义升级）
containment untrusted 的边界段封装            fingerprint 环境对照指纹（§23）
```

*关联文档：[technical-design.md](../technical-design.md)（§38 决策 30 / §18.2 / §37）· [prompt-compiler-spec.md](./prompt-compiler-spec.md)（§10/§71/§82–§92）· [shared-contracts-spec.md](./shared-contracts-spec.md) · [agent-runtime-spec.md](./agent-runtime-spec.md)（§36/§115.1）· [api-spec.md](./api-spec.md) · [database-schema.md](./database-schema.md)*
