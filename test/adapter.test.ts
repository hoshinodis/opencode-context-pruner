import assert from "node:assert/strict"
import {
  applyActions,
  countPendingCalls,
  isCompactionRequest,
  planActions,
  shouldPrune,
  toLibMessages,
  totalResultChars,
} from "../src/logic.js"
import type { AiMessage } from "../src/logic.js"

const long = "x".repeat(2000)

const makeMessages = (): AiMessage[] => [
  { id: "m0", role: "user", content: [{ type: "text", text: "fix the test" }] },
  {
    id: "m1",
    role: "assistant",
    content: [
      { type: "text", text: "reading the file" },
      { type: "tool-call", id: "call_1", name: "read", input: { file_path: "src/a.ts" } },
    ],
  },
  {
    id: "m2",
    role: "tool",
    content: [
      { type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: long } },
    ],
  },
  { id: "m3", role: "assistant", content: [{ type: "text", text: "the test fails because X" }] },
  { id: "m4", role: "user", content: [{ type: "text", text: "now fix it" }] },
  { id: "m5", role: "assistant", content: [{ type: "text", text: "ok" }] },
  { id: "m6", role: "user", content: [{ type: "text", text: "thanks" }] },
]

const fakeAsker = (callKeep: number, resultKeep: number) => ({
  ask: async (_state: unknown, questions: Record<string, unknown>) => ({
    answers: Object.fromEntries(
      Object.keys(questions).map((key) => [
        key,
        { type: "noul", noul: key.startsWith("call_") ? callKeep : resultKeep } as const,
      ]),
    ),
  }),
})

// 1. mapping
const lib = toLibMessages(makeMessages())
assert.equal(lib.length, 7)
assert.equal(lib[1].toolUses[0].tool_use_id, "call_1")
assert.equal(lib[1].toolUses[0].tool, "read")
assert.equal(lib[2].toolResults?.[0].text.length, 2000)
assert.equal(totalResultChars(makeMessages()), 2000)
console.log("PASS mapping")

// 2. planActions: judge only the unpinned call, cache the result
{
  const messages = makeMessages()
  const cache = new Map()
  const plan = await planActions({
    messages,
    asker: fakeAsker(0.1, 0.1),
    options: { preserveRecentMessages: 2 },
    cache,
  })
  assert.equal(plan.judged, 1)
  assert.equal(plan.actions.get("call_1"), "drop_call")
  assert.equal(cache.size, 1, "planActions fills the caller cache")
  // second run with the cache filled: nothing left to judge
  const plan2 = await planActions({
    messages,
    asker: fakeAsker(0.9, 0.9),
    options: { preserveRecentMessages: 2 },
    cache,
  })
  assert.equal(plan2.judged, 0)
  assert.equal(plan2.actions.get("call_1"), "drop_call", "cached decision wins")
  console.log("PASS planActions")
}

// 3. drop_call removes the call and its result; the tool message disappears
{
  const messages = makeMessages()
  const applied = applyActions(messages, new Map([["call_1", "drop_call"]]), 300)
  assert.equal(applied.droppedCalls, 1)
  assert.equal(applied.removedMessages, 1)
  assert.equal(applied.messages.length, 6)
  const ids = applied.messages.flatMap((m) => (m.content ?? []).map((p) => p.id))
  assert.ok(!ids.includes("call_1"))
  // inputs are never mutated (copy-on-write)
  assert.equal(messages.length, 7)
  const originalIds = messages.flatMap((m) => (m.content ?? []).map((p) => p.id))
  assert.ok(originalIds.includes("call_1"))
  console.log("PASS drop_call")
}

// 4. drop_result keeps the call and truncates the result
{
  const messages = makeMessages()
  const applied = applyActions(messages, new Map([["call_1", "drop_result"]]), 300)
  assert.equal(applied.droppedCalls, 0)
  assert.equal(applied.removedMessages, 0)
  assert.equal(applied.changedMessages, 1)
  const part = applied.messages
    .flatMap((m) => m.content ?? [])
    .find((p) => p.type === "tool-result")
  const text = String(part?.result?.value ?? "")
  assert.ok(text.startsWith("x".repeat(300)))
  assert.ok(text.includes("truncated 1700 chars"))
  // the original part is untouched (copy-on-write)
  const original = messages.flatMap((m) => m.content ?? []).find((p) => p.type === "tool-result")
  assert.equal(String(original?.result?.value ?? "").length, 2000)
  console.log("PASS drop_result")
}

// 5. keep leaves everything untouched
{
  const messages = makeMessages()
  const applied = applyActions(messages, new Map([["call_1", "keep"]]), 300)
  assert.equal(applied.changedMessages, 0)
  assert.equal(applied.removedMessages, 0)
  assert.equal(applied.messages.length, 7)
  assert.equal(applied.messages[0], messages[0], "untouched messages keep their identity")
  console.log("PASS keep")
}

// 6. a message that loses all content is removed
{
  const messages: AiMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: {} }] },
    {
      role: "tool",
      content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "data" } }],
    },
  ]
  const applied = applyActions(messages, new Map([["c1", "drop_call"]]), 300)
  assert.equal(applied.messages.length, 0)
  // inputs are never mutated
  assert.equal(messages.length, 2)
  assert.ok((messages[0].content ?? []).some((part) => part.id === "c1"))
  console.log("PASS empty message removal")
}

// 7. compaction request detection
{
  const user = (text: string, id?: string): AiMessage => ({
    id,
    role: "user",
    content: [{ type: "text", text }],
  })
  assert.equal(isCompactionRequest([user("fix the test", "m1")]), false)
  assert.equal(
    isCompactionRequest([
      user("You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.\n\nSummarize only the history shown."),
    ]),
    true,
    "initial compaction prompt",
  )
  assert.equal(
    isCompactionRequest([user("Update the existing checkpoint in the conversation above into one consolidated summary.")]),
    true,
    "checkpoint update prompt",
  )
  assert.equal(isCompactionRequest([user("Rewrite the running checkpoint into a fresh summary.")]), true, "unknown id-less variant")
  assert.equal(isCompactionRequest([user("この要約をevaluateのときに実行して通知したい", "msg_1")]), false, "real user message with an id")
  assert.equal(
    isCompactionRequest([user("<conversation-checkpoint>\n<summary>old summary</summary>\n</conversation-checkpoint>")]),
    false,
    "checkpoint body is not a compaction request",
  )
  assert.equal(
    isCompactionRequest([
      user("You MUST summarize the conversation above into a structured summary."),
      { id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }] },
      user("now fix the test", "m9"),
    ]),
    false,
    "only the last user message counts",
  )
  console.log("PASS compaction detection")
}

// 8. prune gate: compaction always prunes; per-request only after the gap
{
  const gap = 3600
  assert.equal(shouldPrune({ mode: "compaction-only", compaction: false, idleMs: 10 * 3600_000, gapSeconds: gap }), false)
  assert.equal(shouldPrune({ mode: "compaction-only", compaction: true, idleMs: 1000, gapSeconds: gap }), true)
  assert.equal(shouldPrune({ mode: "per-request", compaction: false, idleMs: 10 * 60_000, gapSeconds: gap }), false, "warm: leave it alone")
  assert.equal(shouldPrune({ mode: "per-request", compaction: false, idleMs: 2 * 3600_000, gapSeconds: gap }), true, "cold: prune")
  assert.equal(shouldPrune({ mode: "per-request", compaction: false, idleMs: undefined, gapSeconds: gap }), true, "first request in a session")
  assert.equal(shouldPrune({ mode: "per-request", compaction: false, idleMs: 1000, gapSeconds: 0 }), true, "gapSeconds 0 = always prune")
  assert.equal(shouldPrune({ mode: "per-request", compaction: true, idleMs: 1000, gapSeconds: gap }), true, "compaction always prunes")
  console.log("PASS prune gate")
}

// 9. countPendingCalls counts unjudged, unpinned calls without calling Jev
{
  const messages = makeMessages()
  const cache = new Map<string, "keep">()
  assert.equal(countPendingCalls({ messages, options: { preserveRecentMessages: 2 }, cache }), 1)
  cache.set("call_1", "keep")
  assert.equal(countPendingCalls({ messages, options: { preserveRecentMessages: 2 }, cache }), 0)
  console.log("PASS pending count")
}

console.log("ALL PASS")
