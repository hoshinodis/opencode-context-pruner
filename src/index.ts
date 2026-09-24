import { define } from "@opencode-ai/plugin/v2/promise"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { JevClient } from "./vendor/client.js"
import {
  applyActions,
  countPendingCalls,
  DEFAULT_GAP_SECONDS,
  DEFAULT_MODE,
  DEFAULTS,
  isCompactionRequest,
  planActions,
  setMessages,
  shouldPrune,
  totalResultChars,
} from "./logic.js"
import type { Action, AdapterOptions, AiMessage, PruneMode } from "./logic.js"

type Options = AdapterOptions & {
  enabled?: boolean
  mode?: PruneMode
  gapSeconds?: number
  model?: string
  apiKeyEnv?: string
  apiKeyFile?: string
  logFile?: string
  rejudge?: "never" | "always"
}

type ContextHookEvent = {
  sessionID?: string
  messages?: AiMessage[]
  system?: Array<{ type: "text"; text: string }>
}

type Ctx = {
  options: Record<string, unknown>
  session: {
    hook(
      name: "context",
      callback: (event: ContextHookEvent) => Promise<void> | void,
      options?: { providerID?: string },
    ): Promise<unknown>
  }
}

export default define({
  id: "context-pruner",
  async setup(rawCtx: unknown) {
    const ctx = rawCtx as Ctx
    const options = ctx.options as Options
    const enabled = options.enabled !== false && process.env.TYPESAFE_COMPACTION !== "off"
    const mode: PruneMode =
      options.mode === "per-request" || process.env.TYPESAFE_PRUNER_MODE === "per-request"
        ? "per-request"
        : DEFAULT_MODE
    const gapSeconds = options.gapSeconds ?? DEFAULT_GAP_SECONDS
    const model = options.model ?? "jev-1.13.0"
    const apiKeyEnv = options.apiKeyEnv ?? "TYPESAFE_API_KEY"
    const apiKeyFile = options.apiKeyFile ?? join(homedir(), ".config/opencode/typesafe/api_key")
    const logFile =
      options.logFile ?? join(homedir(), ".config/opencode/context-pruner/decisions.jsonl")
    const minResultChars = options.minResultChars ?? DEFAULTS.minResultChars
    const truncateHeadChars = options.truncateHeadChars ?? DEFAULTS.truncateHeadChars
    const adapterOptions: AdapterOptions = {
      keepThreshold: options.keepThreshold,
      preserveRecentMessages: options.preserveRecentMessages,
      truncateHeadChars,
      maxStateTokens: options.maxStateTokens,
      maxRequestTokens: options.maxRequestTokens,
      minResultChars,
    }
    const rejudge = options.rejudge === "always"

    const caches = new Map<string, Map<string, Action>>()
    const lastSeen = new Map<string, number>()
    let client: JevClient | undefined
    let warnedNoKey = false

    await mkdir(dirname(logFile), { recursive: true }).catch(() => {})
    const log = (entry: Record<string, unknown>) => {
      void appendFile(logFile, JSON.stringify(entry) + "\n").catch(() => {})
    }

    if (enabled && !process.env[apiKeyEnv]?.trim()) {
      const fileKey = await readFile(apiKeyFile, "utf8").catch(() => "")
      if (!fileKey.trim()) {
        console.warn(
          `[context-pruner] no API key (${apiKeyEnv} or ${apiKeyFile}); compaction disabled`,
        )
      }
    }

    const resolveKey = async (): Promise<string | undefined> => {
      const fromEnv = process.env[apiKeyEnv]?.trim()
      if (fromEnv) return fromEnv
      const fromFile = (await readFile(apiKeyFile, "utf8").catch(() => "")).trim()
      return fromFile || undefined
    }

    await ctx.session.hook("context", async (event) => {
      try {
        if (!enabled) return
        const messages = event.messages
        if (!Array.isArray(messages) || messages.length === 0) return

        const sessionID = String(event.sessionID ?? "?")
        const now = Date.now()
        const previous = lastSeen.get(sessionID)
        const idleMs = previous === undefined ? undefined : now - previous
        lastSeen.set(sessionID, now)
        if (lastSeen.size > 50) {
          const oldest = lastSeen.keys().next().value
          if (oldest !== undefined) lastSeen.delete(oldest)
        }

        const compaction = isCompactionRequest(messages)
        let cache = caches.get(sessionID)
        if (!cache || rejudge) {
          cache = new Map()
          caches.set(sessionID, cache)
        }
        if (caches.size > 50) {
          const oldest = caches.keys().next().value
          if (oldest !== undefined) caches.delete(oldest)
        }

        if (!shouldPrune({ mode, compaction, idleMs, gapSeconds })) {
          const pending = countPendingCalls({ messages, options: adapterOptions, cache })
          if (pending > 0) {
            log({
              ts: new Date().toISOString(),
              event: "skip",
              reason: "gap",
              sessionID,
              mode,
              idleSec: idleMs === undefined ? null : Math.round(idleMs / 1000),
              pending,
            })
          }
          return
        }

        if (totalResultChars(messages) < minResultChars) return

        if (!client) {
          const key = await resolveKey()
          if (!key) {
            if (!warnedNoKey) {
              warnedNoKey = true
              console.warn(`[context-pruner] no API key (${apiKeyEnv} or ${apiKeyFile}); compaction disabled`)
            }
            return
          }
          client = new JevClient({ apiKey: key, model })
        }

        const plan = await planActions({ messages, asker: client, options: adapterOptions, cache })
        const applied = applyActions(messages, plan.actions, truncateHeadChars)
        const changed =
          applied.changedMessages > 0 || applied.removedMessages > 0
            ? setMessages(event, applied.messages)
            : false
        if (plan.judged > 0 || applied.changedMessages > 0 || applied.removedMessages > 0) {
          log({
            ts: new Date().toISOString(),
            event: "apply",
            sessionID,
            mode,
            compaction,
            idleSec: idleMs === undefined ? null : Math.round(idleMs / 1000),
            messages: messages.length,
            judged: plan.judged,
            batches: plan.batches,
            stateTokens: plan.stateTokens,
            stateStage: plan.stateStage,
            ms: plan.ms,
            changedMessages: applied.changedMessages,
            removedMessages: applied.removedMessages,
            droppedCalls: applied.droppedCalls,
            droppedResults: applied.droppedResults,
            applied: changed,
          })
        }
      } catch (error) {
        log({
          ts: new Date().toISOString(),
          event: "error",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })
      }
    })

    log({ ts: new Date().toISOString(), event: "setup", enabled, mode, gapSeconds, model, minResultChars })
  },
})
