import { sha256Hex } from "./crypto";
import { exchangeCursorApiKey } from "./cursor";
import { HttpError } from "./http";
import type { CursorCollectedOutput, CursorTextEvent } from "./cursor";
import type {
  CursorImage,
  CursorToolCall,
  CursorTokenUsage,
  Deps,
  Env,
} from "./types";

interface CursorSdkSession {
  agentId: string;
  updatedAt: number;
}

interface CursorSdkCompletion {
  agentId: string;
  runId: string;
  stream: AsyncGenerator<CursorTextEvent>;
}

interface CursorSdkBridgeOutput {
  text?: string;
  toolCalls?: CursorToolCall[];
  agentID?: string;
  runID?: string;
  status?: string;
  usage?: CursorTokenUsage;
  /** True when the bridge served this turn from an already-warm agent, meaning the
   * incremental prompt was used and the SDK prefix cache was eligible to hit. */
  agentCached?: boolean;
}

interface ClientToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

type ToolCallDecision = boolean | string;

interface ProtobufField {
  no: number;
  wt: number;
  value: number | Uint8Array;
}

type LocalSdkDecodedEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; toolCall: CursorToolCall }
  | { type: "request_context"; id: number; execId?: string }
  | { type: "done" }
  | { type: "ignore" };

type ArgsKind =
  | "delete"
  | "edit"
  | "glob"
  | "grep"
  | "ls"
  | "mcp"
  | "readExec"
  | "readLints"
  | "readTool"
  | "semSearch"
  | "shell"
  | "write";

interface ToolSpec {
  name: string;
  argsKind: ArgsKind;
}

const SDK_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const AGENT_MODE_AGENT = 1;
const DEFAULT_SDK_CLIENT_VERSION = "sdk-1.0.13";
const SDK_STREAM_START_TIMEOUT_MS = 25_000;
const DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS = 180_000;
const SDK_TOOL_RETRY_ATTEMPTS = 3;

export function isTransientCursorSdkError(error: unknown): boolean {
  const values: unknown[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const value = pending.shift();
    if (value == null || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    pending.push(record.cause, record.error, record.reason);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }

  const statuses = values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const status = Number((value as Record<string, unknown>).status);
    return Number.isFinite(status) ? [status] : [];
  });
  if (statuses.some((status) => [408, 429, 502, 503, 504].includes(status)))
    return true;

  const text = values
    .flatMap((value) => {
      if (typeof value === "string") return [value];
      if (typeof value !== "object" || value === null) return [];
      const record = value as Record<string, unknown>;
      return [record.message, record.rawMessage, record.code, record.name];
    })
    .filter(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    )
    .map((value) => String(value).toLowerCase());

  return text.some(
    (value) =>
      value === "econnreset" ||
      value === "epipe" ||
      value === "etimedout" ||
      value === "econnrefused" ||
      value === "enetwork" ||
      value === "und_err_socket" ||
      value === "und_err_connect_timeout" ||
      value === "err_stream_premature_close" ||
      value === "cursor_sdk_timeout" ||
      value === "cursor_sdk_bridge_timeout" ||
      value.includes("socket connection was closed unexpectedly") ||
      value.includes("socket hang up") ||
      value.includes("connection reset") ||
      value.includes("connection closed unexpectedly") ||
      value.includes("premature close") ||
      value.includes("fetch failed") ||
      value.includes("network error") ||
      value.includes("unable to connect") ||
      value.includes("timed out") ||
      value.includes("timeout"),
  );
}

const TOOL_CALL_SPECS: Record<number, ToolSpec> = {
  1: { name: "shell", argsKind: "shell" },
  3: { name: "delete", argsKind: "delete" },
  4: { name: "glob", argsKind: "glob" },
  5: { name: "grep", argsKind: "grep" },
  8: { name: "read", argsKind: "readTool" },
  12: { name: "edit", argsKind: "edit" },
  13: { name: "ls", argsKind: "ls" },
  14: { name: "readLints", argsKind: "readLints" },
  15: { name: "mcp", argsKind: "mcp" },
  16: { name: "semSearch", argsKind: "semSearch" },
};

const EXEC_TOOL_SPECS: Record<number, ToolSpec> = {
  2: { name: "shell", argsKind: "shell" },
  3: { name: "write", argsKind: "write" },
  4: { name: "delete", argsKind: "delete" },
  5: { name: "grep", argsKind: "grep" },
  7: { name: "read", argsKind: "readExec" },
  8: { name: "ls", argsKind: "ls" },
  9: { name: "readLints", argsKind: "readLints" },
  11: { name: "mcp", argsKind: "mcp" },
  14: { name: "shell", argsKind: "shell" },
};

export async function createCursorSdkCompletion(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    prompt: { text: string; images?: CursorImage[] };
    model?: { id: string };
    sessionKey?: string;
    sessionOwnerKey?: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    requiresLocalTool?: boolean;
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
    /** Prefer incremental bridge events when the API response itself is streaming. */
    stream?: boolean;
    // Optional delta for a follow-up turn. When the bridge's agent for this session is
    // still cached, the bridge sends only this (the new turn) instead of re-feeding the
    // full prompt; if the agent was evicted it falls back to `prompt`, so this is safe.
    incrementalPrompt?: { text: string; images?: CursorImage[] };
  },
): Promise<CursorSdkCompletion> {
  const store = env.SDK_SESSION_STORE;
  if (!store)
    throw new HttpError(
      "Shared SDK session store is required",
      503,
      "session_store_missing",
    );
  const sessionIdentity = await sdkSessionIdentity(
    apiKey,
    input.sessionKey || "default",
    input.sessionOwnerKey,
  );
  const session = await store.get(sessionIdentity.id);
  const agentId = session?.agentId || newLocalSdkAgentId(deps.randomUUID());
  const runId = newLocalSdkRunId(deps.randomUUID());
  const updatedAt = deps.now();

  await store.set(
    sessionIdentity.id,
    { agentId, updatedAt: updatedAt.getTime() },
    SDK_SESSION_TTL_MS / 1000,
  );

  const runInput = {
    agentId,
    runId,
    sessionKey: sessionIdentity.id,
    prompt: sdkPrompt(input.prompt),
    modelId: input.model?.id || "composer-2.5",
    workingDirectory: input.workingDirectory,
    clientTools: input.clientTools,
    requiresLocalTool: input.requiresLocalTool === true,
    allowToolCall: input.allowToolCall,
    incrementalPrompt: input.incrementalPrompt
      ? sdkPrompt(input.incrementalPrompt)
      : undefined,
  };

  if (hasCursorSdkBridge(env)) {
    // Tool-call retry needs to see a complete turn before deciding whether to rerun.
    // Do not emit partial output for those requests.
    const canStream = input.stream === true && input.requiresLocalTool !== true;
    return {
      agentId,
      runId,
      stream: canStream
        ? streamCursorLocalSdkBridgeEventsWithRetry(env, deps, apiKey, runInput)
        : streamCursorLocalSdkBridgeRunWithRetry(env, deps, apiKey, runInput),
    };
  }

  const accessToken = await exchangeCursorApiKey(env, deps, apiKey);
  return {
    agentId,
    runId,
    stream: streamCursorLocalSdkRunWithRetry(env, deps, accessToken, runInput),
  };
}

export async function collectCursorSdkOutput(
  stream: AsyncIterable<CursorTextEvent>,
): Promise<CursorCollectedOutput> {
  let text = "";
  let toolCalls: CursorToolCall[] = [];
  let usage: CursorTokenUsage | undefined;
  for await (const event of stream) {
    if (event.type === "text" && event.text) text += event.text;
    if (event.type === "tool_call") toolCalls.push(event.toolCall);
    if (event.type === "done") {
      text = event.finalText;
      toolCalls = event.toolCalls;
      usage = event.usage ?? usage;
    }
  }
  return { text, toolCalls, usage };
}

export const cursorSdkTestExports = {
  decodeLocalAgentServerFrame,
  encodeAgentClientRequestContextResult,
  encodeAgentClientRunRequest,
  isEmittableSdkToolCall,
  normalizeSdkToolCallForOpenCode,
  retryPromptAfterMissingTool,
  retryPromptAfterUnsupportedTool,
};

async function* streamCursorLocalSdkRun(
  env: Env,
  deps: Deps,
  accessToken: string,
  input: {
    agentId: string;
    runId: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): AsyncGenerator<CursorTextEvent> {
  let text = "";
  const toolCalls: CursorToolCall[] = [];
  const emittedToolCallIds = new Set<string>();
  const requestId = deps.randomUUID();
  const requestBody = encodeConnectFrame(
    encodeAgentClientRunRequest({
      agentId: input.agentId,
      messageId: input.runId,
      modelId: input.modelId,
      prompt: input.prompt,
    }),
  );
  const runAbort = new AbortController();
  const upload = new TransformStream<Uint8Array, Uint8Array>();
  const uploadWriter = upload.writable.getWriter();
  const runResponsePromise = cursorLocalSdkRaw(
    env,
    deps,
    cursorLocalSdkEndpoint(env),
    accessToken,
    requestId,
    upload.readable,
    runAbort.signal,
  ).then((response) => ({
    source: "run" as const,
    response,
  }));
  let uploadOpen = false;
  if (uploadWriter) {
    await writeSdkUpload(uploadWriter, requestBody);
    uploadOpen = true;
  }

  const selected = await withSdkStartTimeout(runResponsePromise);
  const response = selected.response;

  try {
    for await (const frame of parseConnectProtoFrames(response.body)) {
      for (const event of decodeLocalAgentServerFrame(frame)) {
        if (event.type === "text" && event.text) {
          text += event.text;
          yield { type: "text", text: event.text };
        } else if (event.type === "tool_call") {
          if (!isEmittableSdkToolCall(event.toolCall)) {
            continue;
          }
          const decision = input.allowToolCall?.(event.toolCall) ?? true;
          if (decision !== true) {
            yield {
              type: "rejected_tool_call",
              toolCall: event.toolCall,
              reason: typeof decision === "string" ? decision : undefined,
            };
            yield { type: "done", finalText: text, toolCalls };
            return;
          }
          if (!emittedToolCallIds.has(event.id)) {
            emittedToolCallIds.add(event.id);
            toolCalls.push(event.toolCall);
            yield { type: "tool_call", toolCall: event.toolCall };
            yield { type: "done", finalText: text, toolCalls };
            return;
          }
        } else if (event.type === "request_context") {
          if (uploadOpen && uploadWriter) {
            await writeSdkUpload(
              uploadWriter,
              encodeConnectFrame(
                encodeAgentClientRequestContextResult(event, {
                  workingDirectory: input.workingDirectory,
                }),
              ),
            );
          }
        } else if (event.type === "done") {
          yield { type: "done", finalText: text, toolCalls };
          return;
        }
      }
    }
  } finally {
    if (uploadOpen && uploadWriter) await closeSdkUpload(uploadWriter);
    runAbort.abort("opencode_sdk_run_finished");
  }

  yield { type: "done", finalText: text, toolCalls };
}

async function* streamCursorLocalSdkRunWithRetry(
  env: Env,
  deps: Deps,
  accessToken: string,
  input: {
    agentId: string;
    runId: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    requiresLocalTool: boolean;
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
    incrementalPrompt?: string;
  },
): AsyncGenerator<CursorTextEvent> {
  if (!input.requiresLocalTool && !input.allowToolCall) {
    yield* streamCursorLocalSdkRun(env, deps, accessToken, input);
    return;
  }

  let attemptInput = input;
  let lastEvents: CursorTextEvent[] = [];
  for (let attempt = 1; attempt <= SDK_TOOL_RETRY_ATTEMPTS; attempt += 1) {
    const events: CursorTextEvent[] = [];
    let sawToolCall = false;
    let rejectedToolCall: CursorToolCall | undefined;
    let rejectedToolReason: string | undefined;
    for await (const event of streamCursorLocalSdkRun(
      env,
      deps,
      accessToken,
      attemptInput,
    )) {
      events.push(event);
      if (event.type === "tool_call") sawToolCall = true;
      if (event.type === "rejected_tool_call") {
        rejectedToolCall = event.toolCall;
        rejectedToolReason = event.reason;
      }
    }

    if (sawToolCall) {
      for (const event of events) yield event;
      return;
    }

    lastEvents = events;
    const shouldRetry = rejectedToolCall || input.requiresLocalTool;
    if (!shouldRetry || attempt >= SDK_TOOL_RETRY_ATTEMPTS) break;
    attemptInput = {
      ...input,
      runId: newLocalSdkRunId(deps.randomUUID()),
      prompt: rejectedToolCall
        ? retryPromptAfterUnsupportedTool(
            input.prompt,
            rejectedToolCall,
            rejectedToolReason,
            attempt + 1,
            SDK_TOOL_RETRY_ATTEMPTS,
          )
        : retryPromptAfterMissingTool(
            input.prompt,
            attempt + 1,
            SDK_TOOL_RETRY_ATTEMPTS,
          ),
    };
  }

  for (const event of lastEvents) yield event;
}

async function* streamCursorLocalSdkBridgeRun(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): AsyncGenerator<CursorTextEvent> {
  const output = await cursorLocalSdkBridgeJson(env, deps, apiKey, input);
  yield* bridgeOutputAsEvents(output, input.allowToolCall);
}

/** Convert a completed bridge response into the event shape used by all consumers. */
function* bridgeOutputAsEvents(
  output: CursorSdkBridgeOutput,
  allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision,
): Generator<CursorTextEvent> {
  const text = typeof output.text === "string" ? output.text : "";
  const toolCalls: CursorToolCall[] = [];
  const usage = output.usage;

  if (text) yield { type: "text", text };

  for (const rawToolCall of Array.isArray(output.toolCalls)
    ? output.toolCalls
    : []) {
    const toolCall = emittableBridgeToolCall(rawToolCall);
    if (!toolCall) continue;
    const decision = allowToolCall?.(toolCall) ?? true;
    if (decision !== true) {
      yield {
        type: "rejected_tool_call",
        toolCall,
        reason: typeof decision === "string" ? decision : undefined,
      };
      yield { type: "done", finalText: text, toolCalls, usage };
      return;
    }
    toolCalls.push(toolCall);
    yield { type: "tool_call", toolCall };
    yield { type: "done", finalText: text, toolCalls, usage };
    return;
  }

  yield { type: "done", finalText: text, toolCalls, usage };
}

function emittableBridgeToolCall(value: unknown): CursorToolCall | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  const toolCall = normalizeSdkToolCallForOpenCode({
    name: value.name,
    arguments: isRecord(value.arguments) ? value.arguments : {},
  });
  return isEmittableSdkToolCall(toolCall) ? toolCall : undefined;
}

async function* streamCursorLocalSdkBridgeRunWithRetry(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    requiresLocalTool: boolean;
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
    incrementalPrompt?: string;
  },
): AsyncGenerator<CursorTextEvent> {
  let attemptInput = input;
  let lastEvents: CursorTextEvent[] = [];
  for (let attempt = 1; attempt <= SDK_TOOL_RETRY_ATTEMPTS; attempt += 1) {
    const events: CursorTextEvent[] = [];
    let sawToolCall = false;
    let rejectedToolCall: CursorToolCall | undefined;
    let rejectedToolReason: string | undefined;
    try {
      for await (const event of streamCursorLocalSdkBridgeRun(
        env,
        deps,
        apiKey,
        attemptInput,
      )) {
        events.push(event);
        if (event.type === "tool_call") sawToolCall = true;
        if (event.type === "rejected_tool_call") {
          rejectedToolCall = event.toolCall;
          rejectedToolReason = event.reason;
        }
      }
    } catch (error) {
      if (
        events.length === 0 &&
        attempt < SDK_TOOL_RETRY_ATTEMPTS &&
        isTransientCursorSdkError(error)
      ) {
        attemptInput = {
          ...input,
          runId: newLocalSdkRunId(deps.randomUUID()),
        };
        continue;
      }
      throw error;
    }

    if (sawToolCall) {
      for (const event of events) yield event;
      return;
    }

    lastEvents = events;
    const shouldRetry = rejectedToolCall || input.requiresLocalTool;
    if (!shouldRetry || attempt >= SDK_TOOL_RETRY_ATTEMPTS) break;
    attemptInput = {
      ...input,
      runId: newLocalSdkRunId(deps.randomUUID()),
      prompt: rejectedToolCall
        ? retryPromptAfterUnsupportedTool(
            input.prompt,
            rejectedToolCall,
            rejectedToolReason,
            attempt + 1,
            SDK_TOOL_RETRY_ATTEMPTS,
          )
        : retryPromptAfterMissingTool(
            input.prompt,
            attempt + 1,
            SDK_TOOL_RETRY_ATTEMPTS,
          ),
    };
  }

  for (const event of lastEvents) yield event;
}

function retryPromptAfterMissingTool(
  prompt: string,
  attempt = 2,
  maxAttempts = SDK_TOOL_RETRY_ATTEMPTS,
): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${maxAttempts}):`,
    "Your previous SDK response did not emit a local tool call, but the latest user request requires local OpenCode execution.",
    "The next response is invalid unless it contains a tool_call.",
    "Do not answer in prose. Emit exactly one SDK tool call now using the allowed OpenCode tool inventory above, then wait for the local tool result.",
    "Use SDK mcp for an exact client tool route, or SDK shell/write when the routing map says those built-ins map to the client schema.",
    "If a specific client tool was named in the request, use that exact tool mapping and do not substitute shell, glob, or prose.",
  ].join("\n");
}

function retryPromptAfterUnsupportedTool(
  prompt: string,
  toolCall: CursorToolCall,
  reason?: string,
  attempt = 2,
  maxAttempts = SDK_TOOL_RETRY_ATTEMPTS,
): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${maxAttempts}):`,
    `Your previous SDK response requested ${toolCall.name}, but that tool could not be mapped to the allowed OpenCode tool inventory above.`,
    ...(reason ? [`Mapping failure detail: ${reason}`] : []),
    "The next response is invalid unless it contains a mappable tool_call.",
    "Do not answer in prose. Emit exactly one SDK tool call that maps to an allowed client tool.",
    "For filesystem mutations, prefer SDK write with path and fileText or SDK shell with command when those capabilities are present.",
    "For OpenCode MCP/server tools exposed as provider_tool names, use SDK mcp with providerIdentifier, toolName, and args.",
  ].join("\n");
}

async function cursorLocalSdkRaw(
  env: Env,
  deps: Deps,
  endpoint: string,
  accessToken: string,
  requestId: string,
  body: BodyInit,
  signal?: AbortSignal,
): Promise<Response> {
  const base = env.CURSOR_BACKEND_BASE_URL?.trim();
  if (!base)
    throw new HttpError(
      "Cursor backend URL is not configured",
      500,
      "cursor_missing_backend_url",
    );
  const url = /^https?:\/\//.test(endpoint)
    ? endpoint
    : `${base.replace(/\/$/, "")}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "Connect-Protocol-Version": "1",
    "Content-Type": "application/connect+proto",
    "User-Agent": "connect-es/1.6.1",
    "x-cursor-client-type": "sdk",
    "x-cursor-client-version":
      env.CURSOR_SDK_CLIENT_VERSION || DEFAULT_SDK_CLIENT_VERSION,
    "x-ghost-mode": "true",
    "x-original-request-id": requestId,
    "x-request-id": requestId,
  });
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers,
    body,
    signal,
  };
  if (body instanceof ReadableStream) init.duplex = "half";
  const response = await deps.fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseCursorSdkError(text);
    const message =
      response.status === 401
        ? "Invalid Cursor API key"
        : parsed.message ||
          `Cursor local SDK request failed with status ${response.status}`;
    const status =
      response.status === 401
        ? 401
        : response.status === 429
          ? 429
          : response.status >= 500
            ? 502
            : 400;
    throw new HttpError(
      message,
      status,
      response.status === 401
        ? "cursor_unauthorized"
        : parsed.code || "cursor_sdk_error",
    );
  }
  return response;
}

async function cursorLocalSdkBridgeJson(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    incrementalPrompt?: string;
  },
): Promise<CursorSdkBridgeOutput> {
  const body = cursorLocalSdkBridgeBody(apiKey, input, false);
  const response = await withCursorLocalSdkBridgeTimeout(
    env,
    (signal) =>
      cursorLocalSdkBridgeFetch(env, deps, body, signal) ??
      Promise.resolve(undefined),
  );
  if (!response)
    throw new HttpError(
      "Cursor SDK bridge is not configured",
      500,
      "cursor_sdk_bridge_missing",
    );
  return parseCursorLocalSdkBridgeJsonResponse(response);
}

interface CursorLocalSdkBridgeInput {
  agentId: string;
  runId: string;
  sessionKey: string;
  prompt: string;
  modelId: string;
  workingDirectory?: string;
  clientTools?: ClientToolSpec[];
  incrementalPrompt?: string;
}

function cursorLocalSdkBridgeBody(
  apiKey: string,
  input: CursorLocalSdkBridgeInput,
  streamEvents: boolean,
): string {
  return JSON.stringify({
    apiKey,
    requestId: input.runId,
    model: input.modelId,
    prompt: input.prompt,
    incrementalPrompt: input.incrementalPrompt,
    sessionKey: input.sessionKey || input.agentId,
    workingDirectory: sdkWorkingDirectory(input.workingDirectory),
    tools: bridgeClientTools(input.clientTools),
    ...(streamEvents ? { streamEvents: true } : {}),
  });
}

function cursorLocalSdkBridgeFetch(
  env: Env,
  deps: Deps,
  body: string,
  signal?: AbortSignal,
): Promise<Response> | undefined {
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  return bridgeUrl
    ? cursorLocalSdkUrlBridgeJson(env, deps, bridgeUrl, body, signal)
    : undefined;
}

async function* streamCursorLocalSdkBridgeEvents(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: CursorLocalSdkBridgeInput & {
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): AsyncGenerator<CursorTextEvent> {
  const body = cursorLocalSdkBridgeBody(apiKey, input, true);
  const controller = new AbortController();
  const response = await withCursorLocalSdkBridgeTimeout(env, (signal) => {
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
    return (
      cursorLocalSdkBridgeFetch(env, deps, body, controller.signal) ??
      Promise.resolve(undefined)
    );
  });
  if (!response)
    throw new HttpError(
      "Cursor SDK bridge is not configured",
      500,
      "cursor_sdk_bridge_missing",
    );
  if (!response.ok) await parseCursorLocalSdkBridgeJsonResponse(response);
  if (!response.headers.get("content-type")?.includes("ndjson")) {
    yield* bridgeOutputAsEvents(
      await parseCursorLocalSdkBridgeJsonResponse(response),
      input.allowToolCall,
    );
    return;
  }
  if (!response.body)
    throw new HttpError(
      "Cursor SDK bridge returned an empty stream",
      502,
      "cursor_sdk_bridge_error",
    );

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const gate = new SdkBridgeTextGate();
  const toolCalls: CursorToolCall[] = [];
  let streamedText = "";
  let buffer = "";
  let sawDone = false;
  try {
    for (;;) {
      const result = await readWithIdleTimeout(
        reader,
        cursorLocalSdkBridgeTimeoutMs(env),
        controller,
      );
      if (result.done) {
        // Flush a partial UTF-8 code point before deciding whether the bridge
        // closed cleanly. The SDK can emit non-ASCII answer text at chunk
        // boundaries, and TextDecoder keeps that byte sequence pending.
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      for (
        let newline = buffer.indexOf("\n");
        newline >= 0;
        newline = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          throw new HttpError(
            "Cursor SDK bridge returned invalid JSON",
            502,
            "cursor_sdk_bridge_invalid_json",
          );
        }
        if (!isRecord(event)) continue;
        if (event.type === "text" && typeof event.text === "string") {
          const safe = gate.push(event.text);
          if (safe) {
            streamedText += safe;
            yield { type: "text", text: safe };
          }
          continue;
        }
        if (event.type === "tool_call") {
          const toolCall = emittableBridgeToolCall(event.toolCall);
          if (!toolCall) continue;
          const decision = input.allowToolCall?.(toolCall) ?? true;
          if (decision !== true) {
            yield {
              type: "rejected_tool_call",
              toolCall,
              reason: typeof decision === "string" ? decision : undefined,
            };
            sawDone = true;
            yield {
              type: "done",
              finalText: streamedText + gate.flush(),
              toolCalls,
            };
            break;
          }
          toolCalls.push(toolCall);
          yield { type: "tool_call", toolCall };
          continue;
        }
        if (event.type === "error") throw bridgeStreamError(event.error);
        if (event.type === "done") {
          const output = cursorLocalSdkBridgeOutputFromJson(event.output);
          const tail = gate.flush();
          if (tail) {
            streamedText += tail;
            yield { type: "text", text: tail };
          }
          sawDone = true;
          yield {
            type: "done",
            finalText: output.text || streamedText,
            toolCalls: toolCalls.length ? toolCalls : output.toolCalls || [],
            usage: output.usage,
          };
          break;
        }
      }
      if (sawDone) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
    controller.abort();
  }
  if (!sawDone)
    throw new HttpError(
      "Cursor SDK bridge closed the stream unexpectedly",
      502,
      "cursor_sdk_bridge_error",
    );
}

async function* streamCursorLocalSdkBridgeEventsWithRetry(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: CursorLocalSdkBridgeInput & {
    requiresLocalTool: boolean;
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  },
): AsyncGenerator<CursorTextEvent> {
  let attemptInput = input;
  for (let attempt = 1; ; attempt += 1) {
    let emitted = false;
    try {
      for await (const event of streamCursorLocalSdkBridgeEvents(
        env,
        deps,
        apiKey,
        attemptInput,
      )) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      if (
        emitted ||
        attempt >= SDK_TOOL_RETRY_ATTEMPTS ||
        !isTransientCursorSdkError(error)
      )
        throw error;
      attemptInput = { ...input, runId: newLocalSdkRunId(deps.randomUUID()) };
    }
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  controller: AbortController,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new HttpError(
        "Cursor SDK bridge stream stalled.",
        504,
        "cursor_sdk_bridge_timeout",
      );
      reject(error);
      controller.abort(error);
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bridgeStreamError(value: unknown): HttpError {
  const error = isRecord(value) ? value : {};
  const message =
    typeof error.message === "string" && error.message
      ? error.message
      : "Cursor SDK bridge reported a stream error";
  const code =
    typeof error.code === "string" && error.code
      ? error.code
      : "cursor_sdk_bridge_error";
  return new HttpError(message, 502, code);
}

function cursorLocalSdkBridgeOutputFromJson(
  value: unknown,
): CursorSdkBridgeOutput {
  if (!isRecord(value)) return { text: "", toolCalls: [] };
  return {
    text: typeof value.text === "string" ? value.text : "",
    toolCalls: Array.isArray(value.toolCalls)
      ? value.toolCalls.flatMap((raw) => emittableBridgeToolCall(raw) ?? [])
      : [],
    agentID: typeof value.agentID === "string" ? value.agentID : undefined,
    runID: typeof value.runID === "string" ? value.runID : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    usage: cursorTokenUsageFromJson(value.usage),
    agentCached: value.agentCached === true,
  };
}

const SDK_BRIDGE_TOOL_CALLS_MARKER = "<|tool_calls_begin|>";
const SDK_BRIDGE_TEXT_MARKERS = [
  SDK_BRIDGE_TOOL_CALLS_MARKER,
  "<final_answer>",
  "</final_answer>",
  "<answer>",
  "</answer>",
];

/** Hold a possible split control marker so it never leaks into client-visible output. */
class SdkBridgeTextGate {
  private pending = "";
  private blocked = false;
  push(chunk: string): string {
    if (this.blocked) return "";
    this.pending += chunk;
    const marker = this.pending.indexOf(SDK_BRIDGE_TOOL_CALLS_MARKER);
    if (marker >= 0) {
      this.blocked = true;
      const safe = this.pending.slice(0, marker);
      this.pending = "";
      return safe;
    }
    const hold = heldMarkerSuffixLength(this.pending);
    const safe = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return safe;
  }
  flush(): string {
    if (this.blocked) return "";
    const safe = this.pending.replace(
      /\s*<\/?(?:final_answer|answer)>\s*$/i,
      "",
    );
    this.pending = "";
    return safe;
  }
}

function heldMarkerSuffixLength(text: string): number {
  const longest = Math.min(
    text.length,
    Math.max(...SDK_BRIDGE_TEXT_MARKERS.map((marker) => marker.length)),
  );
  for (let length = longest; length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (SDK_BRIDGE_TEXT_MARKERS.some((marker) => marker.startsWith(suffix)))
      return length;
  }
  return 0;
}

async function cursorLocalSdkUrlBridgeJson(
  env: Env,
  deps: Deps,
  bridgeUrl: string,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  return deps.fetch(bridgeUrl, {
    method: "POST",
    headers: cursorLocalSdkBridgeHeaders(env),
    body,
    signal,
  });
}

async function withCursorLocalSdkBridgeTimeout<T>(
  env: Env,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = cursorLocalSdkBridgeTimeoutMs(env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = run(controller.signal);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new HttpError(
        "Cursor SDK bridge request timed out.",
        504,
        "cursor_sdk_bridge_timeout",
      );
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => undefined);
  }
}

function cursorLocalSdkBridgeTimeoutMs(env: Env): number {
  const value = Number.parseInt(env.CURSOR_SDK_BRIDGE_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS;
}

async function parseCursorLocalSdkBridgeJsonResponse(
  response: Response,
): Promise<CursorSdkBridgeOutput> {
  const text = await response.text().catch(() => "");
  let object: unknown;
  if (text.trim()) {
    try {
      object = JSON.parse(text);
    } catch {
      throw new HttpError(
        "Cursor SDK bridge returned invalid JSON",
        502,
        "cursor_sdk_bridge_invalid_json",
      );
    }
  } else {
    object = {};
  }
  if (!response.ok) {
    const error =
      isRecord(object) && isRecord(object.error) ? object.error : undefined;
    const message =
      typeof error?.message === "string" && error.message
        ? error.message
        : `Cursor SDK bridge failed with status ${response.status}`;
    const code =
      typeof error?.code === "string" && error.code
        ? error.code
        : "cursor_sdk_bridge_error";
    const status =
      response.status === 401
        ? 502
        : response.status === 429
          ? 429
          : response.status >= 500
            ? 502
            : 400;
    throw new HttpError(message, status, code);
  }
  if (!isRecord(object)) {
    throw new HttpError(
      "Cursor SDK bridge returned invalid JSON",
      502,
      "cursor_sdk_bridge_invalid_json",
    );
  }
  return {
    text: typeof object.text === "string" ? object.text : "",
    toolCalls: Array.isArray(object.toolCalls)
      ? object.toolCalls.flatMap(cursorToolCallFromJson)
      : [],
    agentID: typeof object.agentID === "string" ? object.agentID : undefined,
    runID: typeof object.runID === "string" ? object.runID : undefined,
    status: typeof object.status === "string" ? object.status : undefined,
    usage: cursorTokenUsageFromJson(object.usage),
    agentCached: object.agentCached === true,
  };
}

/**
 * Read the `TokenUsage` a newer bridge attaches to its response. Older bridges omit it, so
 * every field is validated and the whole thing degrades to undefined rather than reporting
 * zeroed-out token counts as if they were real.
 */
export function cursorTokenUsageFromJson(
  value: unknown,
): CursorTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const count = (field: unknown): number => {
    const numeric = Number(field);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  };
  const inputTokens = count(value.inputTokens);
  const outputTokens = count(value.outputTokens);
  const cacheReadTokens = count(value.cacheReadTokens);
  const cacheWriteTokens = count(value.cacheWriteTokens);
  const reasoningTokens = count(value.reasoningTokens);
  const reportedTotal = count(value.totalTokens);
  const totalTokens =
    reportedTotal ||
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(reasoningTokens ? { reasoningTokens } : {}),
  };
}

function cursorToolCallFromJson(value: unknown): CursorToolCall[] {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim())
    return [];
  return [
    {
      name: value.name.trim(),
      arguments: isRecord(value.arguments) ? value.arguments : {},
    },
  ];
}

function hasCursorSdkBridge(env: Env): boolean {
  return Boolean(env.CURSOR_SDK_BRIDGE_URL?.trim());
}

function bridgeClientTools(
  tools: ClientToolSpec[] | undefined,
): ClientToolSpec[] {
  return (tools ?? []).flatMap((tool) => {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) return [];
    return [
      {
        name,
        ...(typeof tool.description === "string" && tool.description
          ? { description: tool.description }
          : {}),
        ...(tool.parameters !== undefined
          ? { parameters: tool.parameters }
          : {}),
      },
    ];
  });
}

function cursorLocalSdkBridgeHeaders(env: Env): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (env.CURSOR_SDK_BRIDGE_TOKEN?.trim()) {
    headers.set(
      "Authorization",
      `Bearer ${env.CURSOR_SDK_BRIDGE_TOKEN.trim()}`,
    );
  }
  return headers;
}

async function writeSdkUpload(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  frame: Uint8Array,
): Promise<void> {
  await writer.write(frame).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

async function closeSdkUpload(
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  await writer.close().catch(() => undefined);
  writer.releaseLock();
}

function withSdkStartTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new HttpError(
          "Cursor local SDK stream did not start.",
          504,
          "cursor_sdk_stream_timeout",
        ),
      );
    }, SDK_STREAM_START_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function cursorLocalSdkEndpoint(env: Env): string {
  const endpoint = env.CURSOR_LOCAL_AGENT_ENDPOINT?.trim();
  if (!endpoint)
    throw new HttpError(
      "Cursor local SDK endpoint is not configured",
      500,
      "cursor_missing_endpoint",
    );
  return endpoint;
}

function encodeAgentClientRunRequest(input: {
  agentId: string;
  messageId: string;
  modelId: string;
  prompt: string;
}): Uint8Array {
  const userMessage = protoMessage([
    protoStringField(1, input.prompt),
    protoStringField(2, input.messageId),
    protoVarintField(4, AGENT_MODE_AGENT),
  ]);
  const userMessageAction = protoMessage([protoMessageField(1, userMessage)]);
  const conversationAction = protoMessage([
    protoMessageField(1, userMessageAction),
  ]);
  const modelDetails = protoMessage([
    protoStringField(1, input.modelId),
    protoStringField(3, input.modelId),
    protoStringField(4, input.modelId),
  ]);
  const requestedModel = protoMessage([protoStringField(1, input.modelId)]);
  const runRequest = protoMessage([
    protoMessageField(1, protoMessage([])),
    protoMessageField(2, conversationAction),
    protoMessageField(3, modelDetails),
    protoMessageField(4, protoMessage([])),
    protoStringField(5, input.agentId),
    protoStringField(13, "sdk"),
    protoMessageField(9, requestedModel),
    protoVarintField(19, 1),
  ]);
  return protoMessage([protoMessageField(1, runRequest)]);
}

function encodeAgentClientRequestContextResult(
  input: { id: number; execId?: string },
  options: { workingDirectory?: string } = {},
): Uint8Array {
  const workingDirectory = sdkWorkingDirectory(options.workingDirectory);
  const env = protoMessage([
    protoStringField(1, "Cursor API Gateway"),
    protoStringField(2, workingDirectory),
    protoStringField(3, "sh"),
    protoVarintField(5, false),
    protoStringField(10, "UTC"),
    protoStringField(11, workingDirectory),
    protoStringField(21, workingDirectory),
  ]);
  const requestContext = protoMessage([
    protoMessageField(4, env),
    protoVarintField(17, false),
    protoVarintField(24, false),
    protoVarintField(32, true),
    protoVarintField(33, true),
    protoVarintField(35, false),
    protoVarintField(36, true),
    protoVarintField(39, true),
    protoVarintField(40, true),
    protoVarintField(41, true),
    protoVarintField(42, true),
    protoVarintField(43, true),
    protoVarintField(44, true),
    protoVarintField(45, true),
  ]);
  const success = protoMessage([protoMessageField(1, requestContext)]);
  const result = protoMessage([protoMessageField(1, success)]);
  const execClientMessage = protoMessage([
    protoVarintField(1, input.id),
    protoStringField(15, input.execId),
    protoMessageField(10, result),
  ]);
  return protoMessage([protoMessageField(2, execClientMessage)]);
}

function sdkWorkingDirectory(value: string | undefined): string {
  const trimmed = value?.trim();
  if (
    !trimmed ||
    trimmed.toLowerCase() === "undefined" ||
    trimmed.toLowerCase() === "null"
  )
    return ".";
  return trimmed;
}

function decodeLocalAgentServerFrame(
  payload: Uint8Array,
): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no === 1 && field.value instanceof Uint8Array) {
        output.push(...decodeInteractionUpdate(field.value));
      } else if (field.no === 2 && field.value instanceof Uint8Array) {
        const event = decodeExecServerMessage(field.value);
        if (event) output.push(event);
      }
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not decode Cursor local SDK stream";
    throw new HttpError(message, 502, "cursor_stream_error");
  }
  return output.length ? output : [{ type: "ignore" }];
}

function decodeExecServerMessage(
  payload: Uint8Array,
): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  if (
    fields.some((field) => field.no === 10 && field.value instanceof Uint8Array)
  ) {
    return {
      type: "request_context",
      id: numberField(fields, 1) || 0,
      execId: stringField(fields, 15),
    };
  }
  return decodeExecServerToolCall(payload, fields);
}

function decodeInteractionUpdate(payload: Uint8Array): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    if (field.no === 1) {
      const text = stringField(decodeProtobufFields(field.value), 1);
      if (text) output.push({ type: "text", text });
    } else if (field.no === 2 || field.no === 3 || field.no === 7) {
      const event = decodeToolCallUpdate(field.value, field.no === 3);
      if (event) output.push(event);
    } else if (field.no === 14) {
      output.push({ type: "done" });
    }
  }
  return output;
}

function decodeToolCallUpdate(
  payload: Uint8Array,
  completed: boolean,
): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  const callId = stringField(fields, 1) || stableToolCallId(payload);
  const toolCallBytes = bytesField(fields, 2);
  if (!toolCallBytes) return null;
  const decoded = decodeSdkToolCall(toolCallBytes);
  if (!decoded || (completed && decoded.hasResult)) return null;
  return {
    type: "tool_call",
    id: callId,
    toolCall: normalizeSdkToolCallForOpenCode(decoded.toolCall),
  };
}

function decodeSdkToolCall(
  payload: Uint8Array,
): { toolCall: CursorToolCall; hasResult: boolean } | null {
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) continue;
    const spec = TOOL_CALL_SPECS[field.no];
    if (!spec) continue;
    const toolFields = decodeProtobufFields(field.value);
    const args = bytesField(toolFields, 1);
    const hasResult = toolFields.some((item) => item.no === 2);
    return {
      hasResult,
      toolCall: {
        name: spec.name,
        arguments: args ? decodeToolArgs(spec.argsKind, args) : {},
      },
    };
  }
  return null;
}

function decodeExecServerToolCall(
  payload: Uint8Array,
  fields = decodeProtobufFields(payload),
): LocalSdkDecodedEvent | null {
  const id = numberField(fields, 1);
  const execId = stringField(fields, 15);
  for (const field of fields) {
    if (!(field.value instanceof Uint8Array)) continue;
    const spec = EXEC_TOOL_SPECS[field.no];
    if (!spec) continue;
    const args = decodeToolArgs(spec.argsKind, field.value);
    const toolCallId =
      stringArg(args, "toolCallId") ||
      execId ||
      `exec_${id ?? stableToolCallId(payload)}`;
    delete args.toolCallId;
    return {
      type: "tool_call",
      id: toolCallId,
      toolCall: normalizeSdkToolCallForOpenCode({
        name: spec.name,
        arguments: args,
      }),
    };
  }
  return null;
}

function normalizeSdkToolCallForOpenCode(
  toolCall: CursorToolCall,
): CursorToolCall {
  if (toolCall.name.toLowerCase() !== "edit") return toolCall;
  const path = stringArg(toolCall.arguments, "path");
  const streamContent = stringArgAllowEmpty(
    toolCall.arguments,
    "streamContent",
    "stream_content",
  );
  if (!path || streamContent === undefined) return toolCall;
  return {
    name: "write",
    arguments: {
      path,
      fileText: streamContent,
    },
  };
}

function decodeToolArgs(
  kind: ArgsKind,
  payload: Uint8Array,
): Record<string, unknown> {
  const fields = decodeProtobufFields(payload);
  switch (kind) {
    case "shell":
      return compactRecord({
        command: stringField(fields, 1),
        workingDirectory: stringField(fields, 2),
        timeout: numberField(fields, 3),
        toolCallId: stringField(fields, 4),
      });
    case "write":
      return compactRecord({
        path: stringField(fields, 1),
        fileText: stringField(fields, 2),
        toolCallId: stringField(fields, 3),
        returnFileContentAfterWrite: booleanField(fields, 4),
      });
    case "delete":
      return compactRecord({
        path: stringField(fields, 1),
        toolCallId: stringField(fields, 2),
      });
    case "glob":
      return compactRecord({
        targetDirectory: stringField(fields, 1),
        globPattern: stringField(fields, 2),
      });
    case "grep":
      return compactRecord({
        pattern: stringField(fields, 1),
        path: stringField(fields, 2),
        glob: stringField(fields, 3),
        outputMode: stringField(fields, 4),
        contextBefore: numberField(fields, 5),
        contextAfter: numberField(fields, 6),
        context: numberField(fields, 7),
        caseInsensitive: booleanField(fields, 8),
        type: stringField(fields, 9),
        headLimit: numberField(fields, 10),
        multiline: booleanField(fields, 11),
        sort: stringField(fields, 12),
        sortAscending: booleanField(fields, 13),
        toolCallId: stringField(fields, 14),
        offset: numberField(fields, 16),
      });
    case "readTool":
      return compactRecord({
        path: stringField(fields, 1),
        offset: numberField(fields, 2),
        limit: numberField(fields, 3),
        includeLineNumbers: booleanField(fields, 5),
      });
    case "readExec":
      return compactRecord({
        path: stringField(fields, 1),
        toolCallId: stringField(fields, 2),
        offset: numberField(fields, 4),
        limit: numberField(fields, 5),
      });
    case "edit":
      return compactRecord({
        path: stringField(fields, 1),
        streamContent: stringField(fields, 6),
      });
    case "ls":
      return compactRecord({
        path: stringField(fields, 1),
        ignore: stringFields(fields, 2),
        toolCallId: stringField(fields, 3),
      });
    case "readLints":
      return compactRecord({ paths: stringFields(fields, 1) });
    case "mcp":
      return compactRecord({
        name: stringField(fields, 1),
        args: protoValueMap(fields, 2),
        toolCallId: stringField(fields, 3),
        providerIdentifier: stringField(fields, 4),
        toolName: stringField(fields, 5),
      });
    case "semSearch":
      return compactRecord({
        query: stringField(fields, 1),
        targetDirectories: stringFields(fields, 2),
        explanation: stringField(fields, 3),
      });
  }
}

function isEmittableSdkToolCall(toolCall: CursorToolCall): boolean {
  const name = toolCall.name.toLowerCase();
  const args = toolCall.arguments ?? {};
  if (name === "glob") return hasGlobRequest(args);
  if (name === "ls") return true;
  if (name === "shell")
    return hasAnyStringArg(args, "command", "cmd", "script");
  if (name === "write") {
    return (
      hasAnyStringArg(
        args,
        "path",
        "filePath",
        "file_path",
        "targetFile",
        "target_file",
      ) &&
      hasAnyStringArgAllowEmpty(
        args,
        "fileText",
        "file_text",
        "content",
        "contents",
        "text",
        "fileContent",
        "file_content",
        "streamContent",
        "stream_content",
      )
    );
  }
  if (name === "edit") {
    const hasCompleteReplacement =
      hasAnyStringArgAllowEmpty(
        args,
        "oldText",
        "old_text",
        "oldString",
        "old_string",
        "old_str",
        "old",
        "search",
        "searchString",
        "search_string",
      ) &&
      hasAnyStringArgAllowEmpty(
        args,
        "newText",
        "new_text",
        "newString",
        "new_string",
        "new_str",
        "replacement",
        "replace",
        "content",
      );
    return (
      hasAnyStringArg(
        args,
        "path",
        "filePath",
        "file_path",
        "targetFile",
        "target_file",
      ) &&
      (hasAnyStringArgAllowEmpty(
        args,
        "patchContent",
        "patch_content",
        "patch",
        "diff",
        "unifiedDiff",
        "unified_diff",
      ) ||
        hasAnyStringArgAllowEmpty(args, "streamContent", "stream_content") ||
        hasCompleteReplacement)
    );
  }
  if (name === "read" || name === "delete")
    return hasAnyStringArg(
      args,
      "path",
      "filePath",
      "file_path",
      "targetFile",
      "target_file",
    );
  if (name === "grep")
    return hasAnyStringArg(args, "pattern", "query", "regex", "search");
  if (name === "semSearch")
    return hasAnyStringArg(args, "query", "pattern", "search");
  if (name === "readLints")
    return (
      Array.isArray(args.paths) &&
      args.paths.some((item) => typeof item === "string" && item.trim())
    );
  if (name === "mcp")
    return hasAnyStringArg(args, "toolName", "tool_name", "name");
  return Object.keys(args).length > 0;
}

function hasStringArg(args: Record<string, unknown>, key: string): boolean {
  return typeof args[key] === "string" && args[key].trim().length > 0;
}

function hasAnyStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): boolean {
  return keys.some((key) => hasStringArg(args, key));
}

function hasAnyStringArgAllowEmpty(
  args: Record<string, unknown>,
  ...keys: string[]
): boolean {
  return keys.some((key) => typeof args[key] === "string");
}

function hasGlobRequest(args: Record<string, unknown>): boolean {
  if (
    hasAnyStringArg(
      args,
      "globPattern",
      "glob_pattern",
      "filePattern",
      "file_pattern",
      "pattern",
      "glob",
      "query",
      "include",
      "includeGlob",
      "include_glob",
    )
  ) {
    return true;
  }
  const target =
    stringArg(args, "targetDirectory") ||
    stringArg(args, "target_directory") ||
    stringArg(args, "targeting") ||
    stringArg(args, "path");
  return typeof target === "string" && /[*?[\]{}]/.test(target);
}

function stringArgAllowEmpty(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function sdkPrompt(prompt: { text: string; images?: CursorImage[] }): string {
  if (!prompt.images?.length) return prompt.text;
  return `${prompt.text}\n\n[${prompt.images.length} image input${prompt.images.length === 1 ? "" : "s"} attached by the OpenAI-compatible client.]`;
}

function parseCursorSdkError(text: string): {
  message?: string;
  code?: string;
} {
  try {
    const payload = JSON.parse(text) as unknown;
    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : payload;
      return {
        message: typeof error.message === "string" ? error.message : undefined,
        code: typeof error.code === "string" ? error.code : undefined,
      };
    }
  } catch {
    // Ignore JSON parse failures.
  }
  return { message: text || undefined };
}

async function sdkSessionIdentity(
  apiKey: string,
  sessionKey: string,
  sessionOwnerKey?: string,
): Promise<{ id: string; ownerHash: string; sessionHash: string }> {
  const ownerHash = await sha256Hex(
    sessionOwnerKey || `cursor-key:${await sha256Hex(apiKey)}`,
  );
  const sessionHash = await sha256Hex(sessionKey);
  return {
    id: await sha256Hex(`${ownerHash}\n${sessionHash}`),
    ownerHash,
    sessionHash,
  };
}

function newLocalSdkAgentId(uuid: string): string {
  return uuid.startsWith("agent-") ? uuid : `agent-${uuid}`;
}

function newLocalSdkRunId(uuid: string): string {
  return uuid.startsWith("run-") ? uuid : `run-${uuid}`;
}

function protoMessage(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function protoMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return protoLengthDelimitedField(fieldNumber, value);
}

function protoStringField(
  fieldNumber: number,
  value: string | undefined,
): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return protoLengthDelimitedField(
    fieldNumber,
    new TextEncoder().encode(value),
  );
}

function protoLengthDelimitedField(
  fieldNumber: number,
  value: Uint8Array,
): Uint8Array {
  return protoMessage([
    varint((fieldNumber << 3) | 2),
    varint(value.length),
    value,
  ]);
}

function protoVarintField(
  fieldNumber: number,
  value: number | boolean | undefined,
): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return protoMessage([
    varint(fieldNumber << 3),
    varint(value === true ? 1 : value === false ? 0 : value),
  ]);
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return new Uint8Array(bytes);
}

function encodeConnectFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

async function* parseConnectProtoFrames(
  stream: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) buffer = concatBytes(buffer, value);
      for (;;) {
        if (buffer.length < 5) break;
        const flags = buffer[0];
        const length = new DataView(
          buffer.buffer,
          buffer.byteOffset + 1,
          4,
        ).getUint32(0, false);
        if (buffer.length < 5 + length) break;
        const payload = buffer.slice(5, 5 + length);
        buffer = buffer.slice(5 + length);
        if ((flags & 1) === 1) {
          throw new HttpError(
            "Cursor returned a compressed SDK frame that this Worker cannot decode.",
            502,
            "cursor_stream_error",
          );
        }
        if ((flags & 2) === 2) {
          handleEndStreamFrame(payload);
          continue;
        }
        yield payload;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function handleEndStreamFrame(payload: Uint8Array) {
  if (!payload.length) return;
  const text = decodeUtf8(payload).trim();
  if (!text || text === "{}") return;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message =
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : "Cursor local SDK stream failed";
      throw new HttpError(message, 502, "cursor_stream_error");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
}

function decodeProtobufFields(bytes: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      offset = value.offset;
      fields.push({ no: fieldNumber, wt: wireType, value: value.value });
    } else if (wireType === 1) {
      const end = offset + 8;
      if (end > bytes.length) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
      fields.push({
        no: fieldNumber,
        wt: wireType,
        value: view.getFloat64(0, true),
      });
      offset = end;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > bytes.length) break;
      fields.push({
        no: fieldNumber,
        wt: wireType,
        value: bytes.slice(offset, end),
      });
      offset = end;
    } else if (wireType === 5) {
      const end = offset + 4;
      if (end > bytes.length) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
      fields.push({
        no: fieldNumber,
        wt: wireType,
        value: view.getUint32(0, true),
      });
      offset = end;
    } else {
      break;
    }
  }
  return fields;
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7;
  }
  return { value, offset: cursor };
}

function bytesField(
  fields: ProtobufField[],
  fieldNumber: number,
): Uint8Array | undefined {
  const field = fields.find(
    (item) => item.no === fieldNumber && item.value instanceof Uint8Array,
  );
  return field?.value instanceof Uint8Array ? field.value : undefined;
}

function stringField(
  fields: ProtobufField[],
  fieldNumber: number,
): string | undefined {
  const bytes = bytesField(fields, fieldNumber);
  return bytes ? decodeUtf8(bytes) : undefined;
}

function stringFields(
  fields: ProtobufField[],
  fieldNumber: number,
): string[] | undefined {
  const values = fields
    .filter(
      (item) => item.no === fieldNumber && item.value instanceof Uint8Array,
    )
    .map((item) => decodeUtf8(item.value as Uint8Array));
  return values.length ? values : undefined;
}

function numberField(
  fields: ProtobufField[],
  fieldNumber: number,
): number | undefined {
  const field = fields.find(
    (item) => item.no === fieldNumber && typeof item.value === "number",
  );
  return typeof field?.value === "number" ? field.value : undefined;
}

function booleanField(
  fields: ProtobufField[],
  fieldNumber: number,
): boolean | undefined {
  const value = numberField(fields, fieldNumber);
  return value === undefined ? undefined : value !== 0;
}

function protoValueMap(
  fields: ProtobufField[],
  fieldNumber: number,
): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.no !== fieldNumber || !(field.value instanceof Uint8Array))
      continue;
    const entryFields = decodeProtobufFields(field.value);
    const key = stringField(entryFields, 1);
    const valueBytes = bytesField(entryFields, 2);
    const value = valueBytes ? protoValue(valueBytes) : undefined;
    if (key && value !== undefined) output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}

function protoValue(bytes: Uint8Array): unknown {
  const fields = decodeProtobufFields(bytes);
  if (fields.some((field) => field.no === 1)) return null;
  const numberValue = numberField(fields, 2);
  if (numberValue !== undefined) return numberValue;
  const stringValue = stringField(fields, 3);
  if (stringValue !== undefined) return stringValue;
  const boolValue = booleanField(fields, 4);
  if (boolValue !== undefined) return boolValue;
  const structValue = bytesField(fields, 5);
  if (structValue) return protoStruct(structValue);
  const listValue = bytesField(fields, 6);
  if (listValue) return protoList(listValue);
  return undefined;
}

function protoStruct(bytes: Uint8Array): Record<string, unknown> {
  return protoValueMap(decodeProtobufFields(bytes), 1) ?? {};
}

function protoList(bytes: Uint8Array): unknown[] {
  const output: unknown[] = [];
  for (const field of decodeProtobufFields(bytes)) {
    if (field.no !== 1 || !(field.value instanceof Uint8Array)) continue;
    const value = protoValue(field.value);
    if (value !== undefined) output.push(value);
  }
  return output;
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

function compactRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) =>
        value !== undefined && (!Array.isArray(value) || value.length > 0),
    ),
  );
}

function stableToolCallId(value: Uint8Array): string {
  let hash = 0;
  for (const byte of value.slice(0, 64)) hash = (hash * 31 + byte) >>> 0;
  return `tool_${hash.toString(16)}`;
}

function concatBytes(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length) as Uint8Array<ArrayBuffer>;
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
