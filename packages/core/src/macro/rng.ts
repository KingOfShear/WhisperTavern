import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import type { Rng } from './types'

/**
 * 确定性 RNG —— compiler-spec §45(Replay 冻结 random seed)+ §40 S16 口径。
 *
 * 种子流:sha256(seedText) 前 8 字节 → uint32 → mulberry32(纯函数、无共享态)。
 * 播种源由 engine 决定(now|chatId),**不得**含 snapshotId/messageId 等每轮新建
 * 标识——否则同 chat 同 now 的编译结果不一致,破坏 §5 确定性测试与金样。
 */

/** mulberry32 PRNG:32 位种子 → [0,1) 流 */
export function seededRng(seedText: string): Rng {
  const digest = sha256(new TextEncoder().encode(seedText))
  const seed = bytesToHex(digest.slice(0, 4))
  let state = (parseInt(seed, 16) || 1) >>> 0
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}
