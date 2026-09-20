import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Pool } from "pg";
import type { RedisJsonCache } from "./redis-cache";
import type { ClientKeyInfo } from "./auth";

const derive = promisify(scrypt);
export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export class PostgresAuthStore {
  constructor(
    private readonly db: Pool,
    private readonly redis: RedisJsonCache,
  ) {}
  async initialize(password: string): Promise<void> {
    if (password && !(await this.isConfigured()))
      await this.setInitialPassword(password);
  }
  async isConfigured(): Promise<boolean> {
    return Boolean(
      (
        await this.db.query(
          "SELECT 1 FROM gateway_settings WHERE key='admin_password'",
        )
      ).rowCount,
    );
  }
  private async setInitialPassword(password: string): Promise<boolean> {
    if (password.trim().length < 8 || password.length > 1024)
      throw new Error("Administrator password must contain 8–1024 characters");
    const salt = randomBytes(16).toString("hex");
    const hash = ((await derive(password, salt, 32)) as Buffer).toString("hex");
    return Boolean(
      (
        await this.db.query(
          "INSERT INTO gateway_settings(key,value) VALUES('admin_password',$1::jsonb) ON CONFLICT DO NOTHING",
          [JSON.stringify("scrypt$" + salt + "$" + hash)],
        )
      ).rowCount,
    );
  }
  async setup(password: string): Promise<string | null> {
    return (await this.setInitialPassword(password))
      ? this.createSession()
      : null;
  }
  async login(password: string): Promise<string | null> {
    if (password.length > 1024) return null;
    const row = (
      await this.db.query(
        "SELECT value FROM gateway_settings WHERE key='admin_password'",
      )
    ).rows[0];
    if (!row) return null;
    const [kind, salt, expected] = String(row.value).split("$");
    if (kind !== "scrypt" || !salt || !expected) return null;
    const actual = (await derive(password, salt, 32)) as Buffer;
    const target = Buffer.from(expected, "hex");
    if (target.length !== actual.length || !timingSafeEqual(actual, target))
      return null;
    return this.createSession();
  }
  async createSession(): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.redis.set("admin-session:" + digest(token), true, 7 * 86400);
    return token;
  }
  async isSessionValid(token: string): Promise<boolean> {
    return Boolean(
      token && (await this.redis.get("admin-session:" + digest(token))),
    );
  }
  async revokeSession(token: string): Promise<void> {
    if (token) await this.redis.delete("admin-session:" + digest(token));
  }
  async clientKey(token: string): Promise<boolean> {
    return Boolean(
      token &&
        (
          await this.db.query(
            "SELECT 1 FROM gateway_client_keys WHERE hash=$1",
            [digest(token.trim())],
          )
        ).rowCount,
    );
  }
  async listClientKeys(): Promise<ClientKeyInfo[]> {
    const result = await this.db.query(
      "SELECT id,label,hint,created_at FROM gateway_client_keys ORDER BY created_at",
    );
    return result.rows.map((r) => ({
      id: r.id,
      label: r.label,
      hint: r.hint,
      createdAt: r.created_at.toISOString(),
    }));
  }
  async createClientKey(
    label = "Default",
  ): Promise<{ token: string; info: ClientKeyInfo }> {
    const token = "sk-" + randomBytes(24).toString("base64url");
    const info = {
      id: "key_" + randomBytes(8).toString("hex"),
      label: label.trim() || "Default",
      hint: token.slice(-6),
      createdAt: new Date().toISOString(),
    };
    await this.db.query(
      "INSERT INTO gateway_client_keys(id,label,hint,hash,created_at) VALUES($1,$2,$3,$4,$5)",
      [info.id, info.label, info.hint, digest(token), info.createdAt],
    );
    return { token, info };
  }
  async revokeClientKey(id: string): Promise<boolean> {
    return Boolean(
      (await this.db.query("DELETE FROM gateway_client_keys WHERE id=$1", [id]))
        .rowCount,
    );
  }
  async publicBaseUrl(): Promise<string> {
    return (
      (
        await this.db.query(
          "SELECT value FROM gateway_settings WHERE key='public_url'",
        )
      ).rows[0]?.value || ""
    );
  }
  async setPublicBaseUrl(value: string): Promise<string> {
    await this.db.query(
      "INSERT INTO gateway_settings(key,value) VALUES('public_url',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [JSON.stringify(value)],
    );
    return value;
  }
}
