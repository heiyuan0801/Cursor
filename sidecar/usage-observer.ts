// Request-local metadata, not persistent state. Counts must not depend on whether a
// client requests the optional OpenAI streaming usage frame.
const internalUsage = new WeakMap<
  Response,
  () => Record<string, unknown> | null
>();
export function registerResponseUsage(
  response: Response,
  read: () => Record<string, unknown> | null,
): void {
  internalUsage.set(response, read);
}

/** Bounded streaming accounting; never buffers the whole SSE response or creates a tee. */
export function observeUsage(
  response: Response,
  finish: (
    usage: Record<string, unknown> | null,
    error: string | null,
  ) => Promise<void>,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const streaming = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  let buffer = "",
    oversized = false,
    usage: Record<string, unknown> | null = null;
  let error: string | null = response.ok ? null : "HTTP " + response.status,
    done = false;
  const accept = (payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (p.error || p.type === "error" || p.type === "response.failed")
      error = "Upstream stream failed";
    if (p.usage && typeof p.usage === "object")
      usage = { ...(usage || {}), ...p.usage };
    if (p.message) accept(p.message);
    if (p.response) accept(p.response);
  };
  const parse = (text: string): void => {
    try {
      accept(JSON.parse(text));
    } catch {
      /* Non-JSON SSE frames. */
    }
  };
  const consume = (text: string): void => {
    if (oversized) return;
    buffer += text;
    if (streaming) {
      let n: number;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n).trim();
        buffer = buffer.slice(n + 1);
        if (line.startsWith("data:")) parse(line.slice(5).trim());
      }
    }
    if (buffer.length > 2 * 1024 * 1024) {
      buffer = "";
      oversized = true;
    }
  };
  const complete = async (): Promise<void> => {
    if (done) return;
    done = true;
    consume(decoder.decode());
    if (!streaming && !oversized) parse(buffer);
    else if (buffer.trim().startsWith("data:"))
      parse(buffer.trim().slice(5).trim());
    await finish(internalUsage.get(response)?.() || usage, error);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await complete();
          controller.close();
          return;
        }
        consume(decoder.decode(chunk.value, { stream: true }));
        controller.enqueue(chunk.value);
      } catch (e) {
        error = "Response stream interrupted";
        await complete();
        controller.error(e);
      }
    },
    async cancel(reason) {
      error = "Client disconnected";
      try {
        await reader.cancel(reason);
      } finally {
        await complete();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
