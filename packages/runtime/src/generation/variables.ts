import type { RuntimeVariables } from '@whispertavern/core'
import type { Chat, ChatId } from '@whispertavern/contracts'
import { eq } from 'drizzle-orm'
import type { WhisperTavernDb } from '../db/database'
import { characters, personas } from '../db/schema'

/**
 * RuntimeVariables 构造(WP2.1 S16;compiler-spec §44)。
 *
 * user/char/persona 取文对象读 chat 绑定的 persona/character 资产:
 *   - user   ← personas.name(chat 无 persona 绑定 → 'User',ST 默认 persona 名)
 *   - char   ← characters.name(无角色绑定 → '')
 *   - custom.persona ← persona 档案({{persona}} 取文对象)
 * sessionId/chatId 恒为 chat.id(P0 单聊会话即聊天本体)。
 *
 * 只读 DB、无运行时态落库,与 S12 persona/preset builder 同纪律(架构纪律不依赖
 * st-compat)。time/date 不在此预置(R-P2-4 的 chat_state 冻结路径留待 S17 评估),
 * 由宏引擎按注入 now 推导——同 now 同 chat 逐字节一致。
 */

export interface BuildRuntimeVariablesInput {
  store: WhisperTavernDb
  chat: Chat
}

export function buildRuntimeVariables(input: BuildRuntimeVariablesInput): RuntimeVariables {
  const { store, chat } = input

  let user = 'User'
  let personaDescription = ''
  if (chat.personaId !== undefined) {
    const persona = store.db.select().from(personas).where(eq(personas.id, chat.personaId)).get()
    if (persona !== undefined) {
      user = persona.name
      personaDescription = persona.description ?? ''
    }
  }

  let char = ''
  if (chat.characterId !== undefined) {
    const character = store.db.select().from(characters).where(eq(characters.id, chat.characterId)).get()
    if (character !== undefined) char = character.name
  }

  return {
    user,
    char,
    sessionId: chat.id as ChatId,
    chatId: chat.id as ChatId,
    custom: { persona: personaDescription },
  }
}
