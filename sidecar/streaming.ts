import { encodeSse } from "../core/sse";
import { sseResponse } from "../core/http";
import { anthropicError } from "./anthropic";

export async function notifyStreamError(
  handler: ((error: unknown) => void | Promise<void>) | undefined,
  error: unknown,
): Promise<void> {
  try {
    await handler?.(error);
  } catch {
    console.error("Could not persist stream failure state");
  }
}

/** Pull-based conversion honors client backpressure and forwards cancellation upstream. */
export function anthropicSseResponse(
  events: AsyncGenerator<{ event: string; data: Record<string, unknown> }>,
  onError?: (error: unknown) => void | Promise<void>,
): Response {
  let ended = false;
  let cancelled = false;
  return sseResponse(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (ended) {
          controller.close();
          return;
        }
        try {
          const result = await events.next();
          if (ended) return;
          if (result.done) {
            ended = true;
            controller.close();
            return;
          }
          controller.enqueue(encodeSse(result.value.data, result.value.event));
        } catch (error) {
          if (ended) return;
          ended = true;
          await notifyStreamError(onError, error);
          if (cancelled) return;
          controller.enqueue(
            encodeSse(
              anthropicError(
                error instanceof Error
                  ? error.message
                  : "Upstream stream failed",
                "api_error",
              ),
              "error",
            ),
          );
          controller.close();
        }
      },
      async cancel() {
        cancelled = true;
        ended = true;
        await events.return(undefined).catch(() => undefined);
      },
    }),
  );
}
