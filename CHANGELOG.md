# Changelog — API for Cursor (Windows)

All notable changes to the Windows app. Versions are the app/installer version.

## Unreleased

### Fixed
- **Prompt caching now actually hits, and is visible in `usage`**
  ([#1](https://github.com/NGLSG/Cursor2API/issues/1)). Relays such as New API bill from the
  `usage` block and reported zero cached tokens on every request. Two separate causes:

  - **Sessions were never reused for plain OpenAI clients.** 0.1.2 added agent reuse plus
    incremental prompts, but it keyed the session off `x-session-affinity` /
    `x-opencode-session-id`. Clients that send no such header — New API, LiteLLM, the official
    SDKs, curl — fell back to a fresh random key per request, so every turn created a new
    agent and re-fed the whole transcript. The Cloudflare Worker path never sent
    `incrementalPrompt` at all, and `/v1/messages` deliberately started a new session per
    request. Conversations are now recognized by their own content (`worker/chat-session.ts`):
    the transcript a client replays is fingerprinted as it is answered and matched on the next
    turn, so follow-up turns reach the warm agent and carry only the new messages. Headers
    still win when present, and an unrecognized conversation just starts fresh — a cache miss,
    never a lost context.
  - **`usage` was fabricated locally.** Token counts came from `characters / 4` and
    `cached_tokens` was hardcoded to `0`. The bridge now reads the real per-turn `TokenUsage`
    from `@cursor/sdk` (`run.wait()` and the `usage` stream event) and threads it through to
    the response: `prompt_tokens_details.cached_tokens` for OpenAI, `cache_read_input_tokens`
    and `cache_creation_input_tokens` for Anthropic. Character estimates remain as a fallback
    for paths the backend does not report usage for, and are now tagged `estimated: true`.

- **Unrelated conversations could share one agent.** On the Worker path a request without a
  session header fell back to the literal key `"default"`, so every conversation for an
  account accumulated in a single SDK agent. They are now separated by conversation.

### Changed
- `npm test` covers the sidecar. Its tests import `bun:test` and were only reachable through
  `npm run test:sidecar` (which needs Bun installed), so the Anthropic endpoint, credential
  router, and local auth store were untested in the default suite.

## 0.2.0 — 2026-06-02

### Added
- **Claude Code support** via an Anthropic Messages-compatible endpoint. The local server now
  also serves `POST /v1/messages` (non-stream `Message` + Anthropic SSE) and
  `POST /v1/messages/count_tokens`. Point Claude Code at it with
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` and `ANTHROPIC_API_KEY=cursor-local`. Text chat and
  tool use are translated to/from the existing Cursor SDK path; key is read from `x-api-key`.
  - **Caveat:** Composer wasn't trained on Claude Code's exact tool schemas, so the agentic
    tool loop can be less reliable than native Claude (improving tool-loop fidelity is on the
    roadmap). One tool call per turn (sequential).

## 0.1.2 — 2026-06-02

### Improved
- **Multi-turn reliability.** Two changes resolve the occasional single-message
  `Cursor SDK bridge run timed out` noted as a known issue in 0.1.1:
  - **Session kept "under the hood".** Chat now reuses one `@cursor/sdk` agent per client
    session and sends only the **new turn** (`incrementalPrompt`) to it, instead of
    re-feeding the whole conversation. The bridge falls back to the full prompt if the agent
    was evicted, so context is never lost. (Threads `incrementalPrompt` through
    `worker/cursor-sdk.ts`.)
  - **Transparent auto-retry.** A transient bridge stall *before any output* now retries
    automatically with a fresh session + full prompt, instead of surfacing to the client — so
    the previous manual "try again" is no longer needed.

## 0.1.1 — 2026-06-02

### Fixed
- **Multi-turn chat timed out (`Cursor SDK bridge run timed out`).** With a client that reuses a
  session across turns (e.g. **OpenCode**, which sends a stable `x-opencode-session-id`), the
  **second and later messages** hung until the 120 s bridge timeout. The first message always
  worked.

  **Root cause.** `/v1/chat/completions` is stateless — the client resends the full message
  history on every turn. But the sidecar keyed the `@cursor/sdk` agent to the client's session
  header, so the bridge **reused the cached agent** and re-fed the **entire conversation** to an
  agent that already held it. The SDK run never produced a terminal event and hit the run
  timeout.

  **Fix.** Chat completions now use a **fresh SDK session per request** (no agent reuse — a fresh
  agent receives the full prompt, which is correct for a stateless OpenAI endpoint). `/v1/responses`
  keeps session affinity for `previous_response_id` continuity.

### Known issues
- **Occasional transient `Cursor SDK bridge run timed out` on a single message** (sending again
  succeeds). With a fresh session per chat, every request creates a new SDK agent, and the agent
  handshake / first response to Cursor's backend occasionally stalls. The bridge does not yet
  auto-retry a timeout, so it surfaces to the client and a manual retry (a new agent) works.
  A transparent auto-retry for transient stalls is planned — see the Roadmap in the README.

## 0.1.0 — 2026-06-02

- Initial Windows release: Tauri 2 system-tray app exposing a local OpenAI-compatible API
  (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/health`) backed by Cursor's Composer
  models; Windows Credential Manager key storage; one-click agent setup (OpenCode, Codex, VS Code,
  Cline, Kilo Code, pi); autostart; NSIS installer + Tauri updater.
- Bundles the `@cursor/sdk` bridge as a **Node** runtime resource (the SDK's native `sqlite3`
  addon can't be `bun --compile`d, and its gRPC/HTTP-2 transport requires Node, not Bun).
- **Known issue (fixed in 0.1.1):** multi-turn chat could time out with session-reusing clients.
- Other 0.1.0 fixes made during bring-up: tray **Quit** now actually exits (was blocked by an
  unconditional `prevent_exit`); the bundled bridge spawned by the no-console GUI app crashed on
  Node's verbatim (`\\?\`) script path — the path is now stripped before launch.
