import assert from "node:assert/strict"
import { JevClient } from "../src/vendor/client.js"
import { buildJevRequest } from "../src/vendor/request.js"
import type { JevQuestions } from "../src/vendor/types.js"

const questions: JevQuestions = {
  is_work_request: {
    type: "noul",
    instructions: "The message asks for work on the codebase.",
  },
}

const endpoint = "http://localhost:11434/v1/systemone"

const fakeFetch = () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(
      JSON.stringify({ answers: { is_work_request: { type: "noul", noul: 0.9 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  return { calls, fetcher }
}

// 1. the hosted endpoint sends the key
{
  const request = buildJevRequest(
    { apiKey: "test-key", model: "clef:cloud", baseUrl: endpoint },
    { note: "state" },
    questions,
  )
  assert.equal(request.url, endpoint)
  assert.equal(request.headers.authorization, "Bearer test-key")
  assert.equal(JSON.parse(request.body).model, "clef:cloud")
  console.log("PASS request with key")
}

// 2. a keyless request omits the Authorization header
{
  const request = buildJevRequest(
    { apiKey: "", model: "clef:cloud", baseUrl: endpoint },
    { note: "state" },
    questions,
  )
  assert.equal("authorization" in request.headers, false)
  console.log("PASS request without key")
}

// 3. a custom endpoint works without an API key
{
  const { calls, fetcher } = fakeFetch()
  const client = new JevClient({
    apiKey: "",
    baseUrl: endpoint,
    model: "clef:cloud",
    fetch: fetcher,
  })
  const response = await client.ask({ note: "state" }, questions)
  const answer = response.answers.is_work_request
  assert.equal("noul" in answer ? answer.noul : undefined, 0.9)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, endpoint)
  assert.equal("authorization" in (calls[0].init.headers as Record<string, string>), false)
  console.log("PASS keyless custom endpoint")
}

// 4. the hosted endpoint still requires a key
{
  const { fetcher } = fakeFetch()
  const client = new JevClient({ apiKey: "", fetch: fetcher })
  await assert.rejects(() => client.ask({ note: "state" }, questions), /TYPESAFE_API_KEY/)
  console.log("PASS key required for the hosted endpoint")
}

console.log("ALL PASS client")
