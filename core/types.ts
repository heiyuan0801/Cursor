export interface Env {
  SDK_SESSION_STORE?: {
    get(
      key: string,
    ): Promise<{ agentId: string; updatedAt: number } | undefined>;
    set(
      key: string,
      value: { agentId: string; updatedAt: number },
      ttlSeconds: number,
    ): Promise<void>;
    delete(key: string): Promise<void>;
  };
  ENCRYPTION_KEY?: string;
  CURSOR_API_BASE?: string;
  CURSOR_BACKEND_BASE_URL?: string;
  CURSOR_CHAT_ENDPOINT?: string;
  CURSOR_CLIENT_VERSION?: string;
  CURSOR_LOCAL_AGENT_ENDPOINT?: string;
  CURSOR_SDK_BRIDGE_TOKEN?: string;
  CURSOR_SDK_BRIDGE_TIMEOUT_MS?: string;
  CURSOR_SDK_BRIDGE_URL?: string;
  CURSOR_SDK_CLIENT_VERSION?: string;
}

export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
  randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
}

export interface CursorMe {
  apiKeyName: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  createdAt: string;
}

export type CursorImage =
  | {
      url: string;
      dimension?: { width: number; height: number };
      uuid?: string;
    }
  | {
      data: string;
      mimeType: string;
      dimension?: { width: number; height: number };
      uuid?: string;
    };

export interface CursorPrompt {
  text: string;
  images?: CursorImage[];
  mode?: "ask" | "agent";
}

export interface CursorToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Billed token counts for one turn, as reported by the Cursor backend (`TokenUsage` in
 * `@cursor/sdk`). `inputTokens`, `cacheReadTokens`, and `cacheWriteTokens` are disjoint
 * parts of the prompt: `cacheReadTokens` is the portion served from the SDK's prefix cache,
 * which OpenAI exposes as `prompt_tokens_details.cached_tokens` and Anthropic as
 * `cache_read_input_tokens`. Absent whenever the backend did not report usage (legacy
 * direct-Composer path, turns cut short by a client tool call, older bridges) — callers
 * fall back to character-based estimates in that case.
 */
export interface CursorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface CursorCompletion {
  requestId: string;
  conversationId: string;
  stream: Response;
}

export interface CompletionResult {
  id: string;
  model: string;
  created: number;
  text: string;
  promptChars: number;
  completionChars: number;
  cursorAgentId?: string;
  cursorRunId?: string;
}
