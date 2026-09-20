import Redis from "ioredis";

export interface StickyBinding {
  credentialId: string;
  sessionKey: string;
  configuration: string;
}
// Both keys use the same routing hash tag. Selection and TTL refresh are atomic:
// simultaneous first requests on different API instances must agree on one account.
export const SELECT_STICKY_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then
  local current = cjson.decode(raw)
  for i = 4, #ARGV do
    if current.credentialId == ARGV[i] then
      if current.configuration ~= ARGV[3] then
        current.sessionKey = ARGV[2]
        current.configuration = ARGV[3]
        raw = cjson.encode(current)
        redis.call('SET', KEYS[1], raw, 'EX', ARGV[1])
      end
      redis.call('EXPIRE', KEYS[1], ARGV[1])
      return raw
    end
  end
end
if #ARGV < 4 then return nil end
local n = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[1])
local selected = ARGV[4 + ((n - 1) % (#ARGV - 3))]
local binding = cjson.encode({credentialId=selected, sessionKey=ARGV[2], configuration=ARGV[3]})
redis.call('SET', KEYS[1], binding, 'EX', ARGV[1])
return binding
`;

/** Shared state is strict: authentication never falls back to process-local sessions. */
export class RedisJsonCache {
  readonly client: Redis;
  constructor(
    url: string,
    readonly prefix = "cursor2api:",
  ) {
    if (!url.trim()) throw new Error("REDIS_URL is required");
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 5000,
      enableOfflineQueue: false,
    });
    this.client.on("error", () => console.warn("Redis connection unavailable"));
  }
  async connect(): Promise<void> {
    await this.client.connect();
    await this.client.ping();
  }
  async get<T>(key: string): Promise<T | undefined> {
    const value = await this.client.get(this.prefix + key);
    return value === null ? undefined : (JSON.parse(value) as T);
  }
  async take<T>(key: string): Promise<T | undefined> {
    const value = await this.client.getdel(this.prefix + key);
    return value === null ? undefined : (JSON.parse(value) as T);
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.client.set(
      this.prefix + key,
      JSON.stringify(value),
      "EX",
      ttlSeconds,
    );
  }
  async delete(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }
  async selectSticky(
    key: string,
    rotationKey: string,
    ids: string[],
    ttl: number,
    configuration = "",
  ): Promise<StickyBinding | undefined> {
    if (!ids.length) return undefined;
    const raw = await this.client.eval(
      SELECT_STICKY_SCRIPT,
      2,
      this.prefix + key,
      this.prefix + rotationKey,
      ttl,
      crypto.randomUUID(),
      configuration,
      ...ids,
    );
    return typeof raw === "string"
      ? (JSON.parse(raw) as StickyBinding)
      : undefined;
  }
  async replaceStickySession(
    key: string,
    credentialId: string,
    previousSession: string,
    nextSession: string,
    ttl: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.client.eval(
          `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.credentialId ~= ARGV[1] or value.sessionKey ~= ARGV[2] then return 0 end
value.sessionKey = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(value), 'EX', ARGV[4])
return 1`,
          1,
          this.prefix + key,
          credentialId,
          previousSession,
          nextSession,
          ttl,
        ),
      ) === 1
    );
  }
  async increment(key: string, ttlSeconds: number): Promise<number> {
    return Number(
      await this.client.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
        1,
        this.prefix + key,
        ttlSeconds,
      ),
    );
  }
  async close(): Promise<void> {
    this.client.disconnect();
  }
}
