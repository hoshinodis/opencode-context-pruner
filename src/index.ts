import { define } from "@opencode-ai/plugin/v2/promise"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { JevClient } from "./vendor/client.js"
import { applyActions, DEFAULTS, planActions, setMessages, totalResultChars } from "./logic.js"
import type { Action, AdapterOptions, AiMessage } from "./logic.js"

type Options = AdapterOptions & {
  enabled?: boolean
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
        if (totalResultChars(messages) < minResultChars) return

        const sessionID = String(event.sessionID ?? "?")
        let cache = caches.get(sessionID)
        if (!cache || rejudge) {
          cache = new Map()
          caches.set(sessionID, cache)
        }
        if (caches.size > 50) {
          const oldest = caches.keys().next().value
          if (oldest !== undefined) caches.delete(oldest)
        }

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

    log({ ts: new Date().toISOString(), event: "setup", enabled, model, minResultChars })
  },
})
