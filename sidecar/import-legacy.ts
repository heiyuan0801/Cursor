import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDecipheriv, createHash } from "node:crypto";
import type { Pool } from "pg";

/** One transaction per explicit import. Original files are never changed or deleted. */
export async function importLegacy(
  db: Pool,
  paths: { auth?: string; router?: string; usage?: string },
  encryptionSecret: string,
): Promise<void> {
  const files = await Promise.all(
    Object.entries(paths)
      .filter(([, path]) => path)
      .map(async ([kind, path]) => ({
        kind,
        path: resolve(path!),
        data: JSON.parse(await readFile(path!, "utf8")),
      })),
  );
  if (!files.length) throw new Error("Specify --auth, --router or --usage");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(67180919)");
    for (const file of files) {
      const source = file.kind + ":" + file.path;
      if (
        (
          await client.query("SELECT 1 FROM gateway_imports WHERE source=$1", [
            source,
          ])
        ).rowCount
      )
        continue;
      if (file.kind === "auth") {
        if (!Array.isArray(file.data.clientKeys))
          throw new Error("Invalid legacy auth file");
        for (const [key, value] of [
          ["admin_password", file.data.adminPasswordHash],
          ["public_url", file.data.publicBaseUrl],
        ]) {
          if (value !== undefined)
            await client.query(
              "INSERT INTO gateway_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING",
              [key, JSON.stringify(value)],
            );
        }
        for (const key of file.data.clientKeys) {
          if (!key.id || !key.hash || !key.createdAt)
            throw new Error("Invalid legacy client key");
          await client.query(
            "INSERT INTO gateway_client_keys(id,label,hint,hash,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [
              key.id,
              key.label || "Imported",
              key.hint || "",
              key.hash,
              key.createdAt,
            ],
          );
        }
      } else if (file.kind === "router") {
        if (
          !Array.isArray(file.data.credentials) ||
          encryptionSecret.trim().length < 16
        )
          throw new Error(
            "Invalid router file or missing original ENCRYPTION_KEY",
          );
        const key = createHash("sha256")
          .update(encryptionSecret.trim())
          .digest();
        for (const c of file.data.credentials) {
          const decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            Buffer.from(c.secret.iv, "base64"),
          );
          decipher.setAuthTag(Buffer.from(c.secret.tag, "base64"));
          const apiKey = Buffer.concat([
            decipher.update(Buffer.from(c.secret.ciphertext, "base64")),
            decipher.final(),
          ]).toString("utf8");
          const expected =
            "cred_" +
            createHash("sha256").update(apiKey).digest("hex").slice(0, 24);
          if (c.id !== expected)
            throw new Error("Credential identity mismatch");
          const reason = file.data.disabledCredentials?.[c.id];
          await client.query(
            "INSERT INTO gateway_credentials(id,label,hint,secret,status,disabled_reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            [
              c.id,
              c.label,
              apiKey.slice(-4),
              JSON.stringify(c.secret),
              reason ? "disabled" : "active",
              reason || null,
            ],
          );
        }
        // Environment-provided keys have no ciphertext in legacy files. Seed those keys before importing.
        for (const [id, reason] of Object.entries(
          file.data.disabledCredentials || {},
        )) {
          const result = await client.query(
            "UPDATE gateway_credentials SET status='disabled',disabled_reason=$2 WHERE id=$1",
            [id, reason],
          );
          if (!result.rowCount)
            throw new Error(
              "Reconfigure the original CURSOR_API_KEY(S) before importing disabled credentials",
            );
        }
        for (const [id, models] of Object.entries(
          file.data.disabledModels || {},
        )) {
          if (!Array.isArray(models))
            throw new Error("Invalid disabled models");
          for (const model of models)
            await client.query(
              "INSERT INTO gateway_disabled_models(credential_id,model) VALUES($1,$2) ON CONFLICT DO NOTHING",
              [id, model],
            );
        }
      } else {
        if (!Array.isArray(file.data.logs))
          throw new Error("Invalid legacy usage file");
        const fields = [
          "id",
          "endpoint",
          "model",
          "status",
          "total_tokens",
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
          "total_cost",
          "input_cost",
          "output_cost",
          "cache_read_cost",
          "cache_write_cost",
          "duration_ms",
          "created_at",
          "completed_at",
          "error",
        ];
        for (const log of file.data.logs) {
          if (
            !log.id ||
            !log.created_at ||
            !["completed", "error"].includes(log.status)
          )
            throw new Error("Invalid legacy usage row");
          await client.query(
            "INSERT INTO cursor_usage_logs(" +
              fields.join(",") +
              ") VALUES(" +
              fields.map((_, i) => "$" + (i + 1)).join(",") +
              ") ON CONFLICT DO NOTHING",
            fields.map(
              (f) =>
                log[f] ??
                (["model", "error"].includes(f)
                  ? null
                  : f === "completed_at"
                    ? log.created_at
                    : 0),
            ),
          );
        }
      }
      await client.query("INSERT INTO gateway_imports(source) VALUES($1)", [
        source,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
