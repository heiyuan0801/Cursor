/**
 * Conversation-derived SDK session keys.
 *
 * Cursor's SDK keeps a prompt-prefix cache per agent, so a follow-up turn only hits that
 * cache when it (a) reaches the same bridge agent and (b) sends just the new turn instead of
 * replaying the whole transcript. Both halves need a session key that is stable across the
 * turns of one conversation.
 *
 * Header-based affinity (`x-session-affinity` and friends) covers OpenCode, but every plain
 * OpenAI client — New API, LiteLLM, the official SDKs, curl — sends no such header. The only
 * thing tying turn N+1 back to turn N is the transcript itself: the client replays every
 * message it sent before, plus the assistant reply we produced. So we fingerprint the
 * conversation as we answer it and look that fingerprint up when the next request arrives.
 *
 * Every lookup failure is harmless. An unrecognized fingerprint simply starts a new session,
 * and the bridge re-sends the full prompt whenever its agent has been evicted, so a wrong
 * guess costs a cache miss and never loses context.
 */
import { sha256Hex } from "./crypto";

export interface ChatSessionResolution {
  /** Stable key to hand to `createCursorSdkCompletion({ sessionKey })`. */
  sessionKey: string;
  /** Index of the first message belonging to the new turn, for incremental prompts. */
  newTurnStart: number;
  /** True when this conversation was recognized as a continuation of a known session. */
  resumed: boolean;
}

export interface ChatSessionMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

interface SessionEntry {
  sessionKey: string;
  updatedAt: number;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TRACKED_CONVERSATIONS = 2048;

const conversations = new Map<string, SessionEntry>();

/**
 * Resolve the session key for an incoming chat request.
 *
 * `ownerKey` scopes the lookup so two callers holding different Cursor keys never land on a
 * shared agent even if they send byte-identical transcripts.
 *
 * A fingerprint is consumed by the request that claims it. Two conversations can share a
 * prefix — same system prompt, same opening question, same reply — and would otherwise both
 * resolve to one agent and then diverge onto it, leaking each other's turns. Claiming the
 * entry means the first continuation inherits the warm agent and any other starts fresh with
 * the full prompt: a cache miss instead of crosstalk. The next turn re-registers under its
 * own fingerprint, so a conversation keeps its session for as long as it keeps going.
 */
export async function resolveChatSession(
  messages: readonly ChatSessionMessage[],
  ownerKey: string,
  now: number,
  newSessionKey: () => string
): Promise<ChatSessionResolution> {
  pruneConversations(now);
  const lastAssistant = lastAssistantIndex(messages);
  if (lastAssistant < 0) {
    return { sessionKey: newSessionKey(), newTurnStart: messages.length, resumed: false };
  }

  const fingerprint = await conversationFingerprint(messages.slice(0, lastAssistant + 1), ownerKey);
  const existing = conversations.get(fingerprint);
  if (!existing) {
    return { sessionKey: newSessionKey(), newTurnStart: messages.length, resumed: false };
  }

  conversations.delete(fingerprint);
  return { sessionKey: existing.sessionKey, newTurnStart: lastAssistant + 1, resumed: true };
}

/**
 * Record the conversation as it will look on the client's next request: everything we were
 * sent, plus the assistant turn we just produced. The next request's prefix hashes to this
 * same value, which is what lets `resolveChatSession` recognize it.
 *
 * Two conversations that are still word-for-word identical collapse onto one entry. That is
 * safe because their agents hold the same context, and `resolveChatSession` hands the entry
 * to a single claimant, so they cannot both continue on it.
 */
export async function rememberChatSession(input: {
  messages: readonly ChatSessionMessage[];
  ownerKey: string;
  sessionKey: string;
  assistantText: string;
  assistantToolCalls?: ReadonlyArray<{ function: { name: string; arguments: string } }>;
  now: number;
}): Promise<void> {
  const toolCalls = (input.assistantToolCalls ?? []).map((toolCall) => ({
    function: { name: toolCall.function.name, arguments: toolCall.function.arguments }
  }));
  const assistant: ChatSessionMessage = {
    role: "assistant",
    content: input.assistantText,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  };
  const fingerprint = await conversationFingerprint([...input.messages, assistant], input.ownerKey);
  conversations.delete(fingerprint);
  conversations.set(fingerprint, { sessionKey: input.sessionKey, updatedAt: input.now });
  pruneConversations(input.now);
}

/** Messages of the new turn — everything the previous turn had not seen yet. */
export function newTurnMessages(
  messages: readonly ChatSessionMessage[],
  resolution: ChatSessionResolution
): ChatSessionMessage[] {
  if (!resolution.resumed) return [];
  return messages.slice(resolution.newTurnStart);
}

/**
 * Start index of the not-yet-sent turn: everything after the last assistant message. Equals
 * `messages.length` when no assistant has spoken yet, i.e. nothing is incremental. Used when
 * the client supplies its own session key and no fingerprint lookup is needed.
 */
export function newTurnStartIndex(messages: readonly ChatSessionMessage[]): number {
  const lastAssistant = lastAssistantIndex(messages);
  return lastAssistant < 0 ? messages.length : lastAssistant + 1;
}

export function chatMessagesFromBody(body: unknown): ChatSessionMessage[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as ChatSessionMessage[]) : [];
}

export function resetChatSessionCacheForTest(): void {
  conversations.clear();
}

function lastAssistantIndex(messages: readonly ChatSessionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") return index;
  }
  return -1;
}

async function conversationFingerprint(messages: readonly ChatSessionMessage[], ownerKey: string): Promise<string> {
  const canonical = messages.map(canonicalMessage).join("\n\u0000\n");
  return sha256Hex(`${ownerKey}\n\u0000\u0000\n${canonical}`);
}

/**
 * Canonical form of a message, built only from the parts a client reliably echoes back:
 * the role, the text, and the tool calls. Multimodal parts and provider-specific extras are
 * deliberately reduced to a coarse marker — over-matching would risk reusing a session for a
 * different conversation, while under-matching only costs a cache miss.
 */
function canonicalMessage(message: ChatSessionMessage): string {
  const role = typeof message.role === "string" ? message.role : "user";
  const parts = [role, messageText(message.content)];
  if (typeof message.tool_call_id === "string") parts.push(`tool_call_id=${message.tool_call_id}`);
  if (typeof message.name === "string") parts.push(`name=${message.name}`);
  if (Array.isArray(message.tool_calls)) {
    parts.push(message.tool_calls.map(canonicalToolCall).join("\u0001"));
  }
  return parts.join("\u0002");
}

function canonicalToolCall(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const fn = (value as { function?: unknown }).function;
  if (typeof fn !== "object" || fn === null) return "";
  const name = (fn as { name?: unknown }).name;
  const args = (fn as { arguments?: unknown }).arguments;
  return `${typeof name === "string" ? name : ""}(${typeof args === "string" ? args : JSON.stringify(args ?? null)})`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : "[non-text]";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const record = part as { type?: unknown; text?: unknown };
      if (typeof record.text === "string") return record.text;
      return typeof record.type === "string" ? `[${record.type}]` : "";
    })
    .join("");
}

function pruneConversations(now: number): void {
  for (const [fingerprint, entry] of conversations) {
    if (entry.updatedAt + SESSION_TTL_MS < now) conversations.delete(fingerprint);
  }
  if (conversations.size <= MAX_TRACKED_CONVERSATIONS) return;
  // Map preserves insertion order and every touch re-inserts, so the oldest keys come first.
  const excess = conversations.size - MAX_TRACKED_CONVERSATIONS;
  let removed = 0;
  for (const fingerprint of conversations.keys()) {
    conversations.delete(fingerprint);
    removed += 1;
    if (removed >= excess) break;
  }
}
