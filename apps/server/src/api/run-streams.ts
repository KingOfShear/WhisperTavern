import type { RuntimeEvent } from '@desiregrimoire/runtime'
import type { EventBus } from '@desiregrimoire/runtime'

/**
 * 活跃 Run 流注册表 —— api-spec §26/§27/§142:
 * - 每个活跃 run 一条流(buffer 含 live 事件,sequence 由 EventBus 按 run 分配);
 * - 断线重连:Last-Event-ID 之后从 buffer 续发(活跃)或从 events 表重放 durable
 *   行(已结束;live 不落库 = 重连丢中间 delta,客户端以消息正文为完整恢复面,§141);
 * - 终止事件(generation.completed/failed)到达即关闭流(D4:到达静默态)。
 */

interface RunStream {
  buffer: RuntimeEvent[]
  controller: AbortController
  subscribers: Set<(event: RuntimeEvent) => void>
  finished: boolean
}

const TERMINAL_EVENTS = new Set(['generation.completed', 'generation.failed'])

export class RunStreamRegistry {
  private readonly streams = new Map<string, RunStream>()

  constructor(bus: EventBus) {
    // 单一总线订阅扇出:live 事件(generation.delta)只在此进内存,不落库(§141)
    bus.subscribe('*', (event) => this.fanout(event))
  }

  track(runId: string, controller: AbortController): void {
    this.streams.set(runId, { buffer: [], controller, subscribers: new Set(), finished: false })
  }

  isTracked(runId: string): boolean {
    const stream = this.streams.get(runId)
    return stream !== undefined && !stream.finished
  }

  abort(runId: string): boolean {
    const stream = this.streams.get(runId)
    if (stream === undefined || stream.finished) return false
    stream.controller.abort()
    return true
  }

  /**
   * 订阅并原子取回 afterSequence 之后的缓冲(单线程同 tick,无丢失窗口)。
   * 返回退订函数(D4:客户端断开先退订再清理)。
   */
  subscribe(
    runId: string,
    handler: (event: RuntimeEvent) => void,
    afterSequence?: number,
  ): { replay: RuntimeEvent[]; unsubscribe: () => void } {
    const stream = this.streams.get(runId)
    if (stream === undefined) return { replay: [], unsubscribe: () => undefined }
    const replay = stream.buffer.filter((e) => afterSequence === undefined || (e.sequence ?? 0) > afterSequence)
    stream.subscribers.add(handler)
    return {
      replay,
      unsubscribe: () => {
        stream.subscribers.delete(handler)
      },
    }
  }

  private fanout(event: RuntimeEvent): void {
    if (event.runId === undefined) return
    const stream = this.streams.get(event.runId)
    if (stream === undefined) return
    stream.buffer.push(event)
    for (const handler of [...stream.subscribers]) {
      try {
        handler(event) // D5:单个坏订阅者不影响其他
      } catch {
        // 忽略订阅者异常
      }
    }
    if (TERMINAL_EVENTS.has(event.type)) {
      stream.finished = true
      // 保留 buffer 供重连重放;订阅者由各自流在终态事件后自行关闭
    }
  }
}
