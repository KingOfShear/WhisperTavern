import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderChatRequest,
  ProviderError,
  ProviderStreamEvent,
  ProviderUsage,
} from '@whispertavern/contracts'

/**
 * fake provider —— 脚本回放式内存 adapter,测试依赖,不出网(p0-plan S1 任务 8)。
 *
 * 职责与边界:
 * - 按脚本逐轮回放假 token 流,事件顺序不变量(§8.1)由**构造方式**保证:
 *   message_start → reasoning_delta* → text_delta* → usage → finish;
 * - PV1:脚本文本原样切片回放,不改一字节(契约测试锁定);
 * - PV6:请求 signal 已中止时立即停止产出,以 error(CANCELLED) 终止,不再有 finish;
 * - PV4:一切失败(脚本耗尽)以 ProviderError 抛出,不抛裸 Error;
 * - **四条 §5.5 不变量断言(snapshotId 必挂等)于 S5(WP0.6)在本 adapter 调用入口埋设**,
 *   本会话只立形状(p0-plan S1 任务 8);S4/S4'/S5 的 fixture 与不变量测试全部经它。
 */

/** 单轮回放脚本;usage 由 adapter 按请求与脚本合成(模拟 PV3 的"恰一次") */
export interface FakeTurn {
  /** 原样回放的正文;按 chunkSize 切片为 text_delta */
  text?: string
  /** 原样回放的思考文本;先于 text 产出 reasoning_delta(PV8 形状) */
  reasoning?: string
  /** 每 delta 的字符数,缺省 8 */
  chunkSize?: number
  /** 每 delta 之间的模拟延迟(ms,取消/超时类测试用;0 = 不延迟) */
  delayMs?: number
}

const DEFAULT_CHUNK_SIZE = 8

export class FakeProviderAdapter implements ProviderAdapter {
  readonly providerId = 'fake'

  private readonly turns: readonly FakeTurn[]
  private cursor = 0

  constructor(turns: readonly FakeTurn[]) {
    this.turns = [...turns]
  }

  capabilities(_model: string): ProviderCapabilities {
    // 保守默认(§15:探测失败用保守默认)——测试依赖,无真实能力
    return {
      systemRole: true,
      tools: false,
      vision: false,
      reasoning: false,
      streaming: true,
      promptCaching: false,
      cacheType: 'none',
      maxContextTokens: 8192,
      maxOutputTokens: 2048,
      structuredOutput: 'none',
      parallelToolCalls: false,
      toolChoice: false,
      instructionLayers: 'flat',
    }
  }

  async *stream(req: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
    const turn = this.turns[this.cursor]
    this.cursor += 1
    if (turn === undefined) {
      // 脚本耗尽 = 测试脚本与调用次数不匹配,按 PV4 兜底 UNKNOWN(fail-closed)
      throw exhaustedError()
    }

    const signal = req.signal
    yield { type: 'message_start' }
    if (aborted(signal)) {
      yield* cancelledEvent()
      return
    }

    for (const delta of chunks(turn.reasoning, turn.chunkSize)) {
      await pause(turn.delayMs)
      if (aborted(signal)) {
        yield* cancelledEvent()
        return
      }
      yield { type: 'reasoning_delta', text: delta }
    }
    for (const delta of chunks(turn.text, turn.chunkSize)) {
      await pause(turn.delayMs)
      if (aborted(signal)) {
        yield* cancelledEvent()
        return
      }
      yield { type: 'text_delta', text: delta }
    }

    if (aborted(signal)) {
      yield* cancelledEvent()
      return
    }
    yield { type: 'usage', usage: estimateUsage(req, turn) }
    yield { type: 'finish', reason: 'stop' }
  }
}

function* chunks(text: string | undefined, size: number | undefined): Generator<string> {
  if (text === undefined || text.length === 0) return
  const step = size ?? DEFAULT_CHUNK_SIZE
  for (let i = 0; i < text.length; i += step) {
    yield text.slice(i, i + step)
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function pause(ms: number | undefined): Promise<void> {
  if (ms === undefined || ms <= 0) return
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function* cancelledEvent(): Generator<ProviderStreamEvent> {
  const error: ProviderError = {
    code: 'CANCELLED',
    retryable: false,
    keyRotatable: false,
    detail: 'aborted by request signal',
  }
  yield { type: 'error', error }
}

function exhaustedError(): ProviderError {
  return {
    code: 'UNKNOWN',
    retryable: false,
    keyRotatable: false,
    detail: 'fake script exhausted: turns fewer than stream() calls (test bug)',
  }
}

/** 合成 usage:字符数 / 4 的确定性估算;fake 自报计数,故 source = 'reported' */
function estimateUsage(req: ProviderChatRequest, turn: FakeTurn): ProviderUsage {
  const inputChars = req.messages.reduce((sum, message) => sum + message.content.length, 0)
  const outputChars = (turn.reasoning?.length ?? 0) + (turn.text?.length ?? 0)
  return {
    inputTokens: Math.max(1, Math.ceil(inputChars / 4)),
    cachedInputTokens: 0,
    outputTokens: Math.max(1, Math.ceil(outputChars / 4)),
    source: 'reported',
  }
}
