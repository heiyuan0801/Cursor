import { HttpError } from "../core/http";
import { digest } from "./pg-auth";
import { responseInputItems } from "./conversation";
import type { RedisJsonCache } from "./redis-cache";

export interface CachedResponseContext {
  response: { output?: unknown[]; [key: string]: unknown };
  conversationId: string;
  inputItems: unknown[];
}

export async function expandPreviousResponse(
  cache: Pick<RedisJsonCache, "get">,
  clientKey: string,
  body: Record<string, unknown>,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (body.previous_response_id == null) return body;
  if (
    typeof body.previous_response_id !== "string" ||
    !body.previous_response_id.trim()
  )
    throw new HttpError("Invalid previous_response_id", 400);
  const cached = await cache.get<CachedResponseContext>(
    "response:" + digest(clientKey) + ":" + body.previous_response_id.trim(),
  );
  if (
    !cached?.response ||
    !cached.conversationId ||
    !Array.isArray(cached.inputItems)
  )
    throw new HttpError(
      "Previous response context not found or expired",
      404,
      "not_found",
    );
  const expanded = {
    ...body,
    input: [
      ...cached.inputItems,
      ...(cached.response.output || []),
      ...responseInputItems(body.input),
    ],
  };
  if (new TextEncoder().encode(JSON.stringify(expanded)).length > maxBytes)
    throw new HttpError("Conversation context is too large", 413);
  // Resolve this transcript using the same single-claim mechanism as full-history
  // clients. Two continuations of one response must fork, not share an SDK agent.
  return expanded;
}
