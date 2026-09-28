# @whispertavern/agent

Agent Runtime:runtime / workflow / tools / skills / memory / artifacts。
规格真相源:[agent-runtime-spec](../../docs/specs/agent-runtime-spec.md);
执行层级(Run / Attempt / StepRun / Operation)见其 C5(§4.1–4.6)。

## 分层地位(§38 决策 45,方案 A)

```text
agent → runtime → core → contracts
```

**编排层是终点**:本包可依赖 contracts / core / runtime;
runtime / core / contracts **不得**反向依赖本包。
该约束由 `tests/architecture.test.ts` 的 **B4** 断言焊死——新增任何依赖越出此白名单,
必须先改决策 45(不是改测试)。

## 目录归属(决策 45 第 2 条)

| 目录 | 承载 |
|---|---|
| `src/runtime/` | Agent Definition/Type/Instance/State/StateMachine(§5–§16)、执行循环(§103)、Run Recovery(§96/§97)、Resume/Replay(§51–§58)、Context Resolution(§152–§155) |
| `src/tools/` | Tool Runtime(§31–§36)、五段流水线(§36.1)、权限(§33/§34)、沙箱(§89) |
| `src/workflow/` | Workflow Runtime(§62–§70)、Node 族、Scheduler(§93/§94) |
| `src/skills/` | Skill Runtime(§154 的 `GET /skills` 面) |
| `src/artifacts/` | Artifact(§71–§75)、Frozen Artifact(§72)、Output Commit(§74) |
| `src/memory/` | Memory Policy **接口形状 + 空实现**(R-P3-9:四层记忆表归 P4) |

**持久化原语不在这里**——四层执行表、事件、快照、生成编排归 `packages/runtime`
(S22 已落 migration v8)。本包只在其上做编排,不复刻 IO。

> P0–P2 期间本包为空壳;自 S23(WP3.1b)起按上表落码。
