import type { RedisJsonCache, StickyBinding } from "../redis-cache";

/** Test-only shared state with a controllable clock. Live tests exercise the actual Lua. */
export function sharedRedisFixture() {
  let now = 0;
  const values = new Map<string, { value: unknown; expires: number }>();
  const read = (key: string): unknown => {
    const entry = values.get(key);
    if (!entry || entry.expires <= now) {
      values.delete(key);
      return undefined;
    }
    return structuredClone(entry.value);
  };
  const put = (key: string, value: unknown, ttl: number) =>
    values.set(key, {
      value: structuredClone(value),
      expires: now + ttl * 1000,
    });
  const cache = {
    async get(key: string) {
      return read(key);
    },
    async set(key: string, value: unknown, ttl: number) {
      put(key, value, ttl);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async take(key: string) {
      const value = read(key);
      values.delete(key);
      return value;
    },
    async increment(key: string, ttl: number) {
      const n = Number(read(key) || 0) + 1;
      put(key, n, ttl);
      return n;
    },
    async selectSticky(
      key: string,
      rotation: string,
      ids: string[],
      ttl: number,
      configuration = "",
    ) {
      if (!ids.length) return undefined;
      const current = read(key) as StickyBinding | undefined;
      if (current && ids.includes(current.credentialId)) {
        if (current.configuration !== configuration) {
          current.configuration = configuration;
          current.sessionKey = crypto.randomUUID();
        }
        put(key, current, ttl);
        return current;
      }
      const n = Number(read(rotation) || 0) + 1;
      put(rotation, n, ttl);
      const binding = {
        credentialId: ids[(n - 1) % ids.length],
        sessionKey: crypto.randomUUID(),
        configuration,
      };
      put(key, binding, ttl);
      return binding;
    },
    async replaceStickySession(
      key: string,
      credentialId: string,
      previous: string,
      next: string,
      ttl: number,
    ) {
      const current = read(key) as StickyBinding | undefined;
      if (
        !current ||
        current.credentialId !== credentialId ||
        current.sessionKey !== previous
      )
        return false;
      put(key, { ...current, sessionKey: next }, ttl);
      return true;
    },
  } as unknown as RedisJsonCache;
  return {
    cache,
    advance: (ms: number) => {
      now += ms;
    },
    clear: () => values.clear(),
  };
}
