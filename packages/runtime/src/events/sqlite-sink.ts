import type { RuntimeEvent } from './catalog'
import type { DesireGrimoireDb } from '../db/database'
import { events as eventsTable } from '../db/schema'

/**
 * SQLite 事件汇(EventBus sink 的默认实现,durable/deferred-durable 落 events 表;
 * live 不会到达此处——§5.4/§141)。sequence 由 EventBus 按 run 分配后随行落库,
 * 是 SSE Last-Event-ID 续传的重放依据(api-spec §27/§142)。
 */
export function createSqliteEventSink(store: DesireGrimoireDb) {
  return {
    insert: (batch: readonly RuntimeEvent[]): void => {
      for (const event of batch) {
        store.db
          .insert(eventsTable)
          .values({
            id: event.id,
            eventType: event.type,
            durability: event.durability,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            runId: event.runId,
            payload: JSON.stringify(event.payload),
            sequence: event.sequence,
            createdAt: event.timestamp,
          })
          .run()
      }
    },
  }
}
