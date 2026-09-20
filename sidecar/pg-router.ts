import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Pool } from "pg";
import {
  canonicalModelId,
  type PoolCredential,
  type PoolCatalogModel,
} from "./router";
import { digest } from "./pg-auth";
import { HttpError } from "../core/http";
import type { RedisJsonCache } from "./redis-cache";

export class PostgresCredentialPool {
  private readonly key: Buffer;
  constructor(
    private readonly db: Pool,
    private readonly redis: RedisJsonCache,
    secret: string,
    private readonly stickyTtlSeconds = 7200,
  ) {
    if (secret.trim().length < 16)
      throw new Error("ENCRYPTION_KEY must contain at least 16 characters");
    if (
      !Number.isInteger(stickyTtlSeconds) ||
      stickyTtlSeconds < 60 ||
      stickyTtlSeconds > 86400
    )
      throw new Error(
        "CURSOR_ACCOUNT_STICKY_TTL_SECONDS must be between 60 and 86400",
      );
    this.key = createHash("sha256").update(secret.trim()).digest();
  }
  async list(): Promise<PoolCredential[]> {
    const rows = (
      await this.db.query(`SELECT c.*, COALESCE(
      (SELECT jsonb_agg(model) FROM gateway_disabled_models WHERE credential_id=c.id),'[]') AS models
      FROM gateway_credentials c ORDER BY c.id`)
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      hint: r.hint,
      status: r.status,
      disabledReason: r.disabled_reason,
      disabledModels: new Set<string>(r.models),
      managed: true,
      apiKey: this.decrypt(r.secret),
    }));
  }
  async addCredential(
    apiKey: string,
    label = "Imported",
    reactivate = true,
  ): Promise<PoolCredential> {
    const normalized = apiKey.trim();
    const id = "cred_" + digest(normalized).slice(0, 24);
    const secret = this.encrypt(normalized);
    await this.db.query(
      `INSERT INTO gateway_credentials(id,label,hint,secret) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) ${reactivate ? "DO UPDATE SET label=excluded.label,secret=excluded.secret,status='active',disabled_reason=NULL" : "DO NOTHING"}`,
      [id, label, normalized.slice(-4), JSON.stringify(secret)],
    );
    return (await this.list()).find((c) => c.id === id)!;
  }
  async disableCredential(
    id: string,
    reason = "disabled by gateway owner",
  ): Promise<boolean> {
    return Boolean(
      (
        await this.db.query(
          "UPDATE gateway_credentials SET status='disabled',disabled_reason=$2 WHERE id=$1",
          [id, reason],
        )
      ).rowCount,
    );
  }
  async disableModel(credential: PoolCredential, model: string): Promise<void> {
    await this.db.query(
      "INSERT INTO gateway_disabled_models(credential_id,model) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [credential.id, canonicalModelId(model)],
    );
  }
  async intersectModels<T extends PoolCatalogModel>(
    load: (key: string) => Promise<T[]>,
  ): Promise<T[]> {
    const active = (await this.list()).filter((c) => c.status === "active");
    const results = await Promise.allSettled(active.map((c) => load(c.apiKey)));
    const ready = results.flatMap((r, i) =>
      r.status === "fulfilled"
        ? [{ credential: active[i], models: r.value }]
        : [],
    );
    if (!ready.length) {
      if (results.length) throw new Error("Model catalogs unavailable");
      return [];
    }
    const shared = new Map(
      ready[0].models.map((m) => [canonicalModelId(m.id), m]),
    );
    for (const r of ready.slice(1)) {
      const ids = new Set(r.models.map((m) => canonicalModelId(m.id)));
      for (const id of shared.keys()) if (!ids.has(id)) shared.delete(id);
    }
    return [...shared].flatMap(([id, m]) =>
      ready.some((r) => !r.credential.disabledModels.has(id)) ? [m] : [],
    );
  }
  async select<T extends PoolCatalogModel>(
    model: string,
    affinity: string,
    load: (key: string) => Promise<T[]>,
    excluded: ReadonlySet<string> = new Set(),
    configuration = "",
  ): Promise<{ credential: PoolCredential; sessionKey: string } | undefined> {
    const id = canonicalModelId(model);
    const bindingKey = "{routing}:binding:" + digest(affinity);
    const previous = await this.redis.get<{ credentialId: string }>(bindingKey);
    const active = (await this.list()).filter(
      (c) =>
        c.status === "active" &&
        !c.disabledModels.has(id) &&
        !excluded.has(c.id),
    );
    let boundCatalogFailed = false;
    let catalogFailures = 0;
    const checks = await Promise.all(
      active.map(async (c) => {
        try {
          return (await load(c.apiKey)).some((m) =>
            [m.id, ...(m.aliases || [])].map(canonicalModelId).includes(id),
          )
            ? c
            : null;
        } catch {
          catalogFailures += 1;
          if (c.id === previous?.credentialId) boundCatalogFailed = true;
          return null;
        }
      }),
    );
    // A temporary discovery error is not proof that the bound account lost the model.
    if (boundCatalogFailed)
      throw new HttpError(
        "Bound account model catalog temporarily unavailable",
        503,
        "cursor_models_unavailable",
      );
    const eligible = checks.filter((c): c is PoolCredential => c !== null);
    if (!eligible.length && catalogFailures)
      throw new HttpError(
        "Model catalogs temporarily unavailable",
        503,
        "cursor_models_unavailable",
      );
    if (!eligible.length) return undefined;
    const binding = await this.redis.selectSticky(
      bindingKey,
      "{routing}:allocation:" + digest(id),
      eligible.map((c) => c.id),
      this.stickyTtlSeconds,
      digest(model.trim() + ":" + configuration),
    );
    const credential = eligible.find((c) => c.id === binding?.credentialId);
    return credential && binding
      ? { credential, sessionKey: binding.sessionKey }
      : undefined;
  }
  async replaceSession(
    affinity: string,
    credentialId: string,
    previous: string,
    next: string,
  ): Promise<boolean> {
    return this.redis.replaceStickySession(
      "{routing}:binding:" + digest(affinity),
      credentialId,
      previous,
      next,
      this.stickyTtlSeconds,
    );
  }
  private encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }
  private decrypt(value: {
    iv: string;
    tag: string;
    ciphertext: string;
  }): string {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(value.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
