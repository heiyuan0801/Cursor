import { digest } from "./pg-auth";
import { HttpError } from "../core/http";
import { anthropicToChatBody } from "./anthropic";
import {
  chatMessagesFromBody,
  newTurnStartIndex,
  rememberChatSession,
  resolveChatSession,
  type ChatSessionMessage,
  type ChatSessionResolution,
} from "../core/chat-session";

export type Surface = "chat" | "messages" | "responses";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};

export function explicitConversationId(request: Request): string | undefined {
  // Idempotency keys identify requests, not conversations.
  for (const name of [
    "x-session-affinity",
    "x-opencode-session-id",
    "x-opencode-session",
    "x-session-id",
  ]) {
    const value = request.headers.get(name)?.trim();
    if (!value) continue;
    if (value.length > 256)
      throw new HttpError("Session ID must not exceed 256 characters", 400);
    return value;
  }
  return undefined;
}

export function responseInputItems(input: unknown): unknown[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return Array.isArray(input) ? input : [];
}

export function conversationMessages(
  surface: Surface,
  body: unknown,
): ChatSessionMessage[] {
  if (surface === "chat") return chatMessagesFromBody(body);
  if (surface === "messages")
    return chatMessagesFromBody(anthropicToChatBody(body));
  const b = record(body),
    result: ChatSessionMessage[] = [];
  if (typeof b.instructions === "string" && b.instructions.trim())
    result.push({ role: "system", content: b.instructions.trim() });
  for (const raw of responseInputItems(b.input)) {
    const item = record(raw);
    if (item.type === "reasoning") continue;
    if (item.type === "function_call_output") {
      result.push({
        role: "tool",
        tool_call_id: item.call_id,
        content:
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output),
      });
      continue;
    }
    if (item.type === "function_call") {
      let assistant = result.at(-1);
      if (assistant?.role !== "assistant") {
        assistant = { role: "assistant", content: "", tool_calls: [] };
        result.push(assistant);
      }
      assistant.tool_calls = [
        ...(Array.isArray(assistant.tool_calls) ? assistant.tool_calls : []),
        { function: { name: item.name, arguments: item.arguments } },
      ];
      continue;
    }
    const role = typeof item.role === "string" ? item.role : "user";
    // Preserve complete user multimodal input; the core fingerprint hashes non-text parts.
    const content = item.content ?? (typeof raw === "string" ? raw : "");
    if (role === "assistant" && result.at(-1)?.role === "assistant") {
      const previous = result.at(-1)!;
      previous.content = [
        previous.content,
        ...(Array.isArray(content) ? content : [content]),
      ].flat();
    } else result.push({ role, content });
  }
  return result;
}

export interface GatewayConversation {
  id: string;
  affinity: string;
  ownerKey: string;
  configuration: string;
  messages: ChatSessionMessage[];
  resolution: ChatSessionResolution;
  remember(
    text: string,
    toolCalls: ReadonlyArray<{ function: { name: string; arguments: string } }>,
  ): Promise<void>;
}

export async function resolveGatewayConversation(
  request: Request,
  body: unknown,
  surface: Surface,
  clientKey: string,
): Promise<GatewayConversation> {
  const ownerKey = "gateway-v2:" + surface + ":" + digest(clientKey);
  const messages = conversationMessages(surface, body);
  const explicit = explicitConversationId(request);
  const knownId = explicit ? "explicit:" + digest(explicit) : undefined;
  const resolution = knownId
    ? {
        sessionKey: knownId,
        newTurnStart: newTurnStartIndex(messages),
        resumed: true,
      }
    : await resolveChatSession(
        messages,
        ownerKey,
        Date.now(),
        () => "conversation:" + crypto.randomUUID(),
      );
  return {
    id: resolution.sessionKey,
    affinity: ownerKey + ":" + resolution.sessionKey,
    ownerKey,
    messages,
    resolution,
    configuration: digest(
      JSON.stringify({
        system: messages.filter(
          (m) => m.role === "system" || m.role === "developer",
        ),
        tools: record(body).tools,
        toolChoice: record(body).tool_choice,
        context: record(body).cursor_context,
      }),
    ),
    remember: (text, toolCalls) =>
      rememberChatSession({
        messages,
        ownerKey,
        sessionKey: resolution.sessionKey,
        assistantText: text,
        assistantToolCalls: toolCalls,
        now: Date.now(),
      }),
  };
}
