import { batchCalls, decideCall, questionsFor, resolveOptions } from "./vendor/compact.js"
import { noulAnswer } from "./vendor/request.js"
import { collectToolCalls, fitState } from "./vendor/state.js"
import type { CompactOptions, JevAsker, Message as LibMessage } from "./vendor/types.js"

export type ContentPart = {
  type?: string
  id?: string
  name?: string
  text?: string
  input?: unknown
  result?: { type?: string; value?: unknown }
  [key: string]: unknown
}

export type AiMessage = {
  id?: string
  role?: string
  content?: ContentPart[]
}

export type AdapterOptions = {
  keepThreshold?: number
  preserveRecentMessages?: number
  truncateHeadChars?: number
  maxStateTokens?: number
  maxRequestTokens?: number
  /** ツール結果の合計がこれ未満なら何もしない。 */
  minResultChars?: number
}

export type Action = "keep" | "drop_result" | "drop_call"

/**
 * per-request: 毎リクエストで剪定する(キャッシュを壊す可能性がある)。
 * compaction-only: compact の要約リクエストだけ剪定する(既定)。
 */
export type PruneMode = "per-request" | "compaction-only"

export const DEFAULT_MODE: PruneMode = "compaction-only"

export type PlanResult = {
  /** tool_use_id -> action（keep も含む） */
  actions: Map<string, Action>
  judged: number
  stateTokens: number
  stateStage: string
  batches: number
  ms: number
}

export const DEFAULTS = {
  // 上流は0.5。0.15だと「呼び出しは残して結果だけ短縮」が標準になる
  keepThreshold: 0.15,
  preserveRecentMessages: 10,
  truncateHeadChars: 300,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  minResultChars: 4000,
}

export const resultText = (result: ContentPart["result"]): string => {
  if (!result) return ""
  const value = result.value
  if (result.type === "text") return typeof value === "string" ? value : String(value ?? "")
  if (result.type === "error") return typeof value === "string" ? value : JSON.stringify(value)
  if (result.type === "json") return JSON.stringify(value)
  if (result.type === "content" && Array.isArray(value)) {
    return value
      .map((part) => (part && part.type === "text" ? part.text ?? "" : `[${part?.type ?? "part"}]`))
      .join("\n")
  }
  return typeof value === "string" ? value : JSON.stringify(value)
}

export const truncateResult = (text: string, headChars: number, isError: boolean): string => {
  if (text.length <= headChars + 120) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ""
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? " (error)" : ""
  }; re-run the tool if needed]`
}

const asInput = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

/** opencode の Message[] を fast-jev-compaction の Message[] に 1:1 で変換する。 */
export const toLibMessages = (messages: readonly AiMessage[]): LibMessage[] =>
  messages.map((message) => {
    const parts = Array.isArray(message.content) ? message.content : []
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    const toolUses = parts
      .filter((part) => part.type === "tool-call" && part.id)
      .map((part) => ({
        tool_use_id: String(part.id),
        tool: String(part.name ?? "tool"),
        input: asInput(part.input),
      }))
    const toolResults = parts
      .filter((part) => part.type === "tool-result" && part.id)
      .map((part) => ({
        tool_use_id: String(part.id),
        text: resultText(part.result),
        isError: part.result?.type === "error",
      }))
    const converted: LibMessage = {
      role: message.role === "assistant" ? "assistant" : "user",
      text,
      toolUses,
    }
    if (toolResults.length > 0) converted.toolResults = toolResults
    return converted
  })

export const totalResultChars = (messages: readonly AiMessage[]): number =>
  messages.reduce(
    (sum, message) =>
      sum +
      (Array.isArray(message.content) ? message.content : [])
        .filter((part) => part.type === "tool-result")
        .reduce((inner, part) => inner + resultText(part.result).length, 0),
    0,
  )

const messageText = (message: AiMessage): string =>
  (Array.isArray(message.content) ? message.content : [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim()

/** beta-19271 実測の compact プロンプト署名（初回/更新/システム側）。 */
const COMPACTION_PROMPT =
  /^(you must summarize the conversation above|update the existing checkpoint in the conversation above|you are a context summarization agent)/i
/** 未知の変種を拾う保険。id が無い合成プロンプトに限って使う。 */
const SYNTHETIC_PROMPT_HINT = /summar|checkpoint|conversation above|history shown/i

/**
 * 最後のユーザーメッセージが compact の要約リクエストかを判定する。
 * beta-19271 では compaction フックが発火しないため、context フックで署名から検出する。
 */
export const isCompactionRequest = (messages: readonly AiMessage[]): boolean => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== "user") continue
    const text = messageText(message)
    if (!text) continue
    if (COMPACTION_PROMPT.test(text)) return true
    if (message.id) return false
    if (!SYNTHETIC_PROMPT_HINT.test(text)) return false
    // 過去の checkpoint 本文（要約そのもの）を compact リクエストと誤認しない
    if (text.includes("<conversation-checkpoint>") || text.includes("<recent-context>")) return false
    return true
  }
  return false
}

const resolve = (options: AdapterOptions) =>
  resolveOptions({
    keepThreshold: options.keepThreshold ?? DEFAULTS.keepThreshold,
    preserveRecentMessages: options.preserveRecentMessages ?? DEFAULTS.preserveRecentMessages,
    maxStateTokens: options.maxStateTokens,
    maxRequestTokens: options.maxRequestTokens,
    truncateHeadChars: options.truncateHeadChars ?? DEFAULTS.truncateHeadChars,
  } satisfies CompactOptions)

/** 未判定のツールコールだけ Jev に判定させ、cache に書き戻す。 */
export const planActions = async (args: {
  messages: readonly AiMessage[]
  asker: JevAsker
  options: AdapterOptions
  cache: Map<string, Action>
}): Promise<PlanResult> => {
  const started = Date.now()
  const resolved = resolve(args.options)
  const lib = toLibMessages(args.messages)
  const calls = collectToolCalls(lib, resolved.preserveRecentMessages)
  const pending = calls.filter((call) => !call.pinned && !args.cache.has(call.tool_use_id))
  const actions = args.cache
  let stateTokens = 0
  let stateStage = ""
  let batches = 0
  if (pending.length > 0) {
    const fitted = fitState(lib, calls, resolved)
    stateTokens = fitted.tokens
    stateStage = fitted.stage
    const groups = batchCalls(pending, fitted.tokens, resolved)
    batches = groups.length
    const byShortId = new Map(calls.map((call) => [call.id, call]))
    const results = await Promise.all(
      groups.map(async (group) => {
        const questions = Object.assign({}, ...group.map(questionsFor))
        const response = await args.asker.ask(fitted.state, questions)
        return group.map((call) =>
          decideCall(
            call,
            {
              keepCall: noulAnswer(response.answers, `call_${call.id}`),
              keepResult: noulAnswer(response.answers, `result_${call.id}`),
            },
            resolved,
          ),
        )
      }),
    )
    for (const decision of results.flat()) {
      const call = byShortId.get(decision.id)
      if (!call) continue
      actions.set(call.tool_use_id, decision.action)
    }
  }
  return {
    actions,
    judged: pending.length,
    stateTokens,
    stateStage,
    batches,
    ms: Date.now() - started,
  }
}

export type ApplyResult = {
  messages: AiMessage[]
  changedMessages: number
  removedMessages: number
  droppedCalls: number
  droppedResults: number
}

const hasContent = (message: AiMessage): boolean =>
  Array.isArray(message.content) && message.content.length > 0

/** 判定を適用した Message[] を返す（入力は書き換えない）。 */
export const applyActions = (
  messages: readonly AiMessage[],
  actions: ReadonlyMap<string, Action>,
  truncateHeadChars: number,
): ApplyResult => {
  let changedMessages = 0
  let droppedCalls = 0
  let droppedResults = 0
  const kept: AiMessage[] = []
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : []
    if (content.length === 0) continue
    let changed = false
    const next: ContentPart[] = []
    for (const part of content) {
      const id = part.id ? String(part.id) : undefined
      const action = id ? actions.get(id) : undefined
      if (part.type === "tool-call") {
        if (action === "drop_call") {
          droppedCalls += 1
          changed = true
          continue
        }
        next.push(part)
        continue
      }
      if (part.type === "tool-result") {
        if (action === "drop_call") {
          droppedResults += 1
          changed = true
          continue
        }
        if (action === "drop_result") {
          const current = resultText(part.result)
          const truncated = truncateResult(current, truncateHeadChars, part.result?.type === "error")
          if (truncated !== current) {
            next.push({ ...part, result: { type: "text", value: truncated } })
            changed = true
            continue
          }
        }
        next.push(part)
        continue
      }
      next.push(part)
    }
    if (!changed) {
      kept.push(message)
      continue
    }
    changedMessages += 1
    const cloned: AiMessage = { ...message, content: next }
    if (hasContent(cloned)) kept.push(cloned)
  }
  return {
    messages: kept,
    changedMessages,
    removedMessages: messages.length - kept.length,
    droppedCalls,
    droppedResults,
  }
}

/** event.messages を差し替える（代入できない実装では何もしない）。 */
export const setMessages = (target: { messages?: AiMessage[] }, messages: AiMessage[]): boolean => {
  try {
    target.messages = messages
  } catch {
    return false
  }
  return target.messages === messages
}
