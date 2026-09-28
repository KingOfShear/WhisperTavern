import type { Timestamp } from '@whispertavern/contracts'

/**
 * 事件权威目录(technical-design §5.4 的**源码常量化**,落实该节"待办":
 * 事件清单做成源码常量,防止事件名与分档再次分叉)。
 *
 * 规则:①事件名只允许本目录内的键(点分小写,`域.对象.动作`);
 * ②新增事件必须同时声明分档,否则打回(§5.4 硬约束二);
 * ③发布未注册事件名 = 实现 bug,Event Bus 直接抛 INVARIANT_VIOLATION。
 *
 * 覆盖进度:
 * - P0 子集 = generation.* / usage.* / chat.* / message.* / prompt.* / provider.*(p0-plan S5 任务 1);
 * - P1–P2 补 worldbook.* / cache.*(S22 随执行层一并补齐 worldbook.* 的既缺登记);
 * - P3(S22/WP3.1a)补 agent.* / agent.run.* / agent.turn.* / tool.call.* / approval.* /
 *   workflow.* / artifact.*(database-schema §27–§36 对应表同批落库)。
 *
 * 仍未注册的域(明示,避免"看起来漏了"):import.* / export.* / memory.* / roleplay.*
 * ——分别归 P4(WP4.4 群聊/记忆)、P5(插件与导入导出作业面),到那时随触发源逐条登记(X13)。
 */
export type EventDurability = 'durable' | 'deferred-durable' | 'live'

/** §5.4 权威表的已注册子集(名称与分档逐字对齐权威表) */
export const EVENT_CATALOG = {
  // durable:重建执行树或账目所需
  'chat.created': 'durable',
  'chat.updated': 'durable',
  'message.created': 'durable',
  'message.edited': 'durable',
  'message.swiped': 'durable',
  'message.deleted': 'durable',
  'generation.started': 'durable',
  'generation.completed': 'durable',
  'generation.failed': 'durable',
  'prompt.compiled': 'durable',
  'prompt.snapshot.created': 'durable',
  'prompt.invalidated': 'durable',
  'provider.fallback': 'durable',
  // worldbook.activated 归 durable 是因为 Activation Engine **有状态**(sticky/cooldown/delay/
  // 概率掷骰,§5.1);Replay 要复现激活结果就必须记录激活历史(§5.4 注)
  'worldbook.activated': 'durable',
  'worldbook.changed': 'durable',
  // P3 执行树:Agent 生命周期(§5.4 durable 清单)
  'agent.created': 'durable',
  'agent.run.created': 'durable',
  'agent.run.started': 'durable',
  'agent.run.paused': 'durable',
  'agent.run.resumed': 'durable',
  'agent.run.completed': 'durable',
  'agent.run.failed': 'durable',
  'agent.run.cancelled': 'durable',
  'agent.run.interrupted': 'durable',
  'agent.turn.started': 'durable',
  'agent.turn.completed': 'durable',
  // P3 工具与审批:waiting 状态靠 approval.* 唤醒,不能只靠内存 Promise(§116–§119)
  'tool.call.started': 'durable',
  'tool.call.completed': 'durable',
  'tool.call.failed': 'durable',
  'tool.call.denied': 'durable',
  'approval.requested': 'durable',
  'approval.decided': 'durable',
  'workflow.started': 'durable',
  'workflow.stage_started': 'durable',
  'workflow.stage_completed': 'durable',
  'workflow.completed': 'durable',
  // deferred-durable:异步批量落库,允许延迟不允许丢
  'usage.recorded': 'deferred-durable',
  'cache.hit': 'deferred-durable',
  'cache.miss': 'deferred-durable',
  'cache.invalidated': 'deferred-durable',
  'artifact.created': 'deferred-durable',
  'artifact.updated': 'deferred-durable',
  // live:内存广播即可,丢了不影响重建(generation.delta 每 token 一条,落表撑爆 events)
  'generation.delta': 'live',
  'prompt.compiling': 'live',
} as const satisfies Record<string, EventDurability>

export type EventName = keyof typeof EVENT_CATALOG

/** 共享契约 §7 RuntimeEvent 形状 + events 表列(aggregate / durability / sequence) */
export interface RuntimeEvent<TPayload = Record<string, unknown>> {
  /** 幂等 event_id(UUIDv7;§5.4 硬约束四:durable 事件必须带幂等 id) */
  id: string
  type: EventName
  durability: EventDurability
  traceId?: string
  runId?: string
  attemptId?: string
  aggregateType?: string
  aggregateId?: string
  /** api-spec §27:run 内单调递增(SSE sequence / Last-Event-ID 续传依据) */
  sequence?: number
  timestamp: Timestamp
  payload: TPayload
}

/** 未注册事件名 / 未声明分档 = 实现 bug,按总设计 §5.5 抛出 */
export class EventCatalogViolation extends Error {
  constructor(message: string) {
    super(`INVARIANT_VIOLATION: ${message}`)
    this.name = 'EventCatalogViolation'
  }
}

export function assertEventName(type: string): asserts type is EventName {
  if (!Object.hasOwn(EVENT_CATALOG, type)) {
    throw new EventCatalogViolation(`事件名未注册于 §5.4 权威目录: ${type}`)
  }
}

export function durabilityOf(type: EventName): EventDurability {
  return EVENT_CATALOG[type]
}
