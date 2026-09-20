/** PostgreSQL + Redis gateway with OpenAI/Anthropic adapters and a Node SDK bridge. */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import {
  createCursorCompletion,
  streamCursorText,
  type CursorTextEvent,
} from "../core/cursor";
import {
  errorResponse,
  HttpError,
  json,
  notFound,
  openAiError,
  optionsResponse,
  parseJsonBody,
  sseResponse,
  unauthorized,
} from "../core/http";
import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  prepareChatRequest,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseErrorEvent,
  responseObject,
  responseTextStartEvents,
  responseToolCallEvents,
  toOpenAiToolCalls,
  toolCallRetryHint,
  type OpenAiToolCall,
  type OpenAiToolSpec,
  type ToolCallContext,
} from "../core/openai";
import { collectCursorOutput } from "../core/cursor";
import { newTurnMessages, type ChatSessionMessage } from "../core/chat-session";
import {
  createCursorSdkCompletion,
  collectCursorSdkOutput,
  isTransientCursorSdkError,
} from "../core/cursor-sdk";
import { encodeSse } from "../core/sse";
import type {
  CursorTokenUsage,
  CursorToolCall,
  Deps,
  Env,
} from "../core/types";
import {
  anthropicError,
  anthropicMessage,
  anthropicSseEvents,
  anthropicToChatBody,
  contextFromAnthropicBeta,
  estimateTokens,
  mapModel,
  toolCallsForSessionFingerprint,
} from "./anthropic";
import {
  canonicalModelId,
  isBillingError,
  parseCursorCredentialEnv,
} from "./router";
import { sessionCookie, sessionToken } from "./auth";
import { PostgresAuthStore, digest } from "./pg-auth";
import { PostgresCredentialPool } from "./pg-router";
import {
  resolveGatewayConversation,
  responseInputItems,
  type GatewayConversation,
  type Surface,
} from "./conversation";
import { createDatabase, migrateDatabase } from "./database";
import { configureChatSessionStore } from "../core/chat-session";
import { observeUsage, registerResponseUsage } from "./usage-observer";
import { anthropicSseResponse, notifyStreamError } from "./streaming";
import { PostgresUsageStore } from "./postgres";
import { RedisJsonCache } from "./redis-cache";
import { expandPreviousResponse } from "./response-context";
import { usageRange, usageCutoff, usagePagination } from "./usage-query";

const HOST = process.env.HOST?.trim() || "127.0.0.1";
const DEFAULT_PORT = 8787;
const PRIMARY_MODEL = "auto";
const STATIC_DIR = process.env.STATIC_DIR?.trim()
  ? resolve(process.env.STATIC_DIR.trim())
  : "";
const MAX_REQUEST_BODY_BYTES = parsePositiveInteger(
  process.env.MAX_REQUEST_BODY_BYTES,
  8 * 1024 * 1024,
);

/** Runtime dependencies shared by the protocol clients. */
const deps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
};

/** Upstream connection configuration; all state stores are injected below. */
function buildEnv(): Env {
  return {
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    CURSOR_API_BASE: process.env.CURSOR_API_BASE || "https://api.cursor.com",
    CURSOR_BACKEND_BASE_URL: process.env.CURSOR_BACKEND_BASE_URL,
    CURSOR_CHAT_ENDPOINT: process.env.CURSOR_CHAT_ENDPOINT,
    CURSOR_CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "2.6.22",
    CURSOR_SDK_BRIDGE_URL: process.env.CURSOR_SDK_BRIDGE_URL,
    CURSOR_SDK_BRIDGE_TOKEN: process.env.CURSOR_SDK_BRIDGE_TOKEN,
    CURSOR_SDK_BRIDGE_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS,
  };
}

const env = buildEnv();
const database = createDatabase();
const redisCache = new RedisJsonCache(
  process.env.REDIS_URL || "",
  process.env.REDIS_PREFIX || "cursor2api:",
);
const authStore = new PostgresAuthStore(database, redisCache);
const stickyTtlSeconds = Number(
  process.env.CURSOR_ACCOUNT_STICKY_TTL_SECONDS || 7200,
);
const credentialPool = new PostgresCredentialPool(
  database,
  redisCache,
  process.env.ENCRYPTION_KEY || "",
  stickyTtlSeconds,
);
const usageStore = new PostgresUsageStore(database);
configureChatSessionStore(
  {
    take: (key) => redisCache.take("conversation:" + key),
    set: (key, value, ttl) => redisCache.set("conversation:" + key, value, ttl),
  },
  stickyTtlSeconds,
);
env.SDK_SESSION_STORE = {
  get: (key) => redisCache.get("sdk-session:" + key),
  set: (key, value, ttl) => redisCache.set("sdk-session:" + key, value, ttl),
  delete: (key) => redisCache.delete("sdk-session:" + key),
};

/**
 * The SDK bridge path (full macOS parity) is the PRIMARY route for
 * chat/responses whenever `CURSOR_SDK_BRIDGE_URL` is set. Otherwise we fall back
 * to the direct `core/cursor.ts` path.
 */
function hasSdkBridge(): boolean {
  return Boolean(env.CURSOR_SDK_BRIDGE_URL?.trim());
}

interface RequestConversation {
  conversation: GatewayConversation;
  sdkSessionKey: string;
  credentialId: string;
  inputItems: unknown[];
}
const requestConversations = new WeakMap<Request, RequestConversation>();
function conversationContext(request: Request): RequestConversation {
  const context = requestConversations.get(request);
  if (!context) throw new Error("Missing request conversation");
  return context;
}
async function sdkAttemptSession(
  request: Request,
  attempt: number,
): Promise<string> {
  const context = conversationContext(request);
  if (attempt === 0) return context.sdkSessionKey;
  const next = "retry-" + crypto.randomUUID();
  await credentialPool.replaceSession(
    context.conversation.affinity,
    context.credentialId,
    context.sdkSessionKey,
    next,
  );
  context.sdkSessionKey = next;
  return next;
}

/**
 * Scope SDK sessions to both the client and upstream credential, so callers
 * sharing an upstream account never share an agent.
 */
function sdkSessionOwner(request: Request, apiKey: string): string {
  return `client:${digest(requestApiKey(request))}:cursor:${digest(apiKey)}`;
}

/**
 * Shared, caller-scoped Redis store for the Responses API so that
 * `GET/DELETE /v1/responses/{id}` can echo a previously created response.
 */
async function storeResponse(
  request: Request,
  id: string,
  response: Record<string, unknown>,
): Promise<void> {
  if (response.store === false) return;
  const context = conversationContext(request);
  // Keep context and output in one Redis value, so previous_response_id cannot see half a write.
  await redisCache.set(
    "response:" + digest(requestApiKey(request)) + ":" + id,
    {
      response,
      conversationId: context.conversation.id,
      inputItems: context.inputItems,
    },
    86400,
  );
}

/**
 * External API calls use client keys created in the local control console.
 * Cursor credentials never leave the credential pool.
 */
interface RequestAccess {
  mode: "pool";
}

function requestApiKey(request: Request): string {
  // Anthropic clients send the key as `x-api-key`; OpenAI clients use Bearer auth.
  const apiKeyHeader = (request.headers.get("x-api-key") || "").trim();
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const bearer = match ? match[1].trim() : "";
  const candidate = apiKeyHeader || bearer;
  return candidate;
}

async function resolveAccess(request: Request): Promise<RequestAccess | null> {
  return (await authStore.clientKey(requestApiKey(request)))
    ? { mode: "pool" }
    : null;
}

async function cursorModelSelection(
  requestedModel: string,
  body: unknown,
  apiKey?: string,
): Promise<{ id: string }> {
  const rawModel = requestedModel.trim() || PRIMARY_MODEL;
  const match = /^([^\[]+?)(?:\[(.*)\])?$/.exec(rawModel);
  let modelId = (match?.[1] || PRIMARY_MODEL).trim();
  if (modelId.toLowerCase() === "default") modelId = "auto";

  const params = new Map<string, string>();
  const explicitParams = new Set<string>();
  const rawParams = match?.[2]?.trim();
  if (rawParams) {
    for (const entry of rawParams.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) continue;
      const id = entry.slice(0, separator).trim();
      const value = entry
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (id && value) {
        params.set(id, value);
        explicitParams.add(id);
      }
    }
  }

  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const reasoning =
    record.reasoning &&
    typeof record.reasoning === "object" &&
    !Array.isArray(record.reasoning)
      ? (record.reasoning as Record<string, unknown>)
      : {};
  const outputConfig =
    record.output_config &&
    typeof record.output_config === "object" &&
    !Array.isArray(record.output_config)
      ? (record.output_config as Record<string, unknown>)
      : {};
  const effort = [
    record.reasoning_effort,
    reasoning.effort,
    outputConfig.effort,
  ].find((value) => typeof value === "string" && value.trim()) as
    | string
    | undefined;
  let supportedParameters: Set<string> | undefined;
  if (apiKey) {
    const catalog = await liveCursorModels(apiKey);
    const normalizedModelId =
      modelId.split("/").filter(Boolean).at(-1) || modelId;
    const model = catalog.find(
      (item) =>
        item.id === normalizedModelId ||
        item.aliases?.includes(normalizedModelId),
    );
    supportedParameters = model
      ? new Set((model.parameters ?? []).map((parameter) => parameter.id))
      : undefined;
  }
  if (
    effort &&
    supportedParameters?.has("effort") &&
    !params.has("effort") &&
    !params.has("reasoning_effort")
  ) {
    params.set("effort", effort.trim());
  }

  const serviceTier =
    typeof record.service_tier === "string"
      ? record.service_tier.trim().toLowerCase()
      : "";
  const standardFast =
    typeof record.fast === "boolean"
      ? record.fast
      : serviceTier === "priority" || serviceTier === "fast"
        ? true
        : undefined;
  if (
    standardFast !== undefined &&
    supportedParameters?.has("fast") &&
    !params.has("fast")
  ) {
    params.set("fast", String(standardFast));
  }

  if (typeof record.cursor_fast === "boolean" && !params.has("fast")) {
    params.set("fast", String(record.cursor_fast));
  }
  if (
    typeof record.cursor_context === "string" &&
    record.cursor_context.trim() &&
    !params.has("context")
  ) {
    params.set("context", record.cursor_context.trim());
  }

  const routerMode = [record.cursor_router_mode, record.optimize_for].find(
    (value) => typeof value === "string" && value.trim(),
  ) as string | undefined;
  if (
    modelId.toLowerCase() === "auto-smart" &&
    routerMode &&
    !params.has("optimize_for")
  ) {
    params.set("optimize_for", routerMode.trim());
  }

  const customParams = record.cursor_params ?? record.model_params;
  if (Array.isArray(customParams)) {
    for (const item of customParams) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const param = item as Record<string, unknown>;
      if (
        typeof param.id === "string" &&
        typeof param.value === "string" &&
        param.id.trim() &&
        param.value.trim()
      ) {
        params.set(param.id.trim(), param.value.trim());
        explicitParams.add(param.id.trim());
      }
    }
  } else if (customParams && typeof customParams === "object") {
    for (const [id, value] of Object.entries(
      customParams as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.trim()) {
        params.set(id, value.trim());
        explicitParams.add(id);
      } else if (typeof value === "boolean" || typeof value === "number") {
        params.set(id, String(value));
        explicitParams.add(id);
      }
    }
  }

  for (const id of explicitParams) {
    if (id === "reasoning_effort") {
      if (!params.has("effort")) params.set("effort", params.get(id) ?? "");
      params.delete(id);
    }
  }

  return {
    id: parameterizedModelId(
      modelId,
      Array.from(params, ([id, value]) => ({ id, value })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Route handlers for the shared PostgreSQL + Redis gateway.
// ---------------------------------------------------------------------------

async function healthResponse(request: Request): Promise<Response> {
  await database.query("SELECT 1");
  await redisCache.client.ping();
  const credentials = await credentialPool.list();
  return json({
    ok: true,
    service: "api-for-cursor",
    host: HOST,
    modelCatalog:
      credentials.length > 1
        ? "multi-key-intersection"
        : "live-account-specific",
    credentialCount: credentials.length,
    clientKeyAuth: true,
    sdkVersion: "1.0.27",
    baseUrl: await publicApiBaseUrl(request),
  });
}

interface CursorCatalogParameter {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
}

interface CursorCatalogVariant {
  params: Array<{ id: string; value: string }>;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

interface CursorCatalogModel {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: CursorCatalogParameter[];
  variants?: CursorCatalogVariant[];
}

const MODEL_CATALOG_TTL_MS = 60_000;
const modelCatalogRequests = new Map<string, Promise<CursorCatalogModel[]>>();

async function modelCatalogCacheKey(apiKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function cursorSdkModelsUrl(): string {
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  if (!bridgeUrl) {
    throw new HttpError(
      "Cursor SDK bridge is not configured",
      503,
      "cursor_sdk_bridge_missing",
    );
  }
  const url = new URL(bridgeUrl);
  url.pathname = "/models";
  url.search = "";
  return url.toString();
}

async function liveCursorModels(apiKey: string): Promise<CursorCatalogModel[]> {
  const cacheKey = await modelCatalogCacheKey(apiKey);
  const pending = modelCatalogRequests.get(cacheKey);
  if (pending) return pending;
  const work = loadModelCatalog(apiKey, cacheKey);
  modelCatalogRequests.set(cacheKey, work);
  try {
    return await work;
  } finally {
    modelCatalogRequests.delete(cacheKey);
  }
}

async function loadModelCatalog(
  apiKey: string,
  cacheKey: string,
): Promise<CursorCatalogModel[]> {
  const key = "model-catalog:" + cacheKey;
  const cached = await redisCache
    .get<{ models: CursorCatalogModel[]; freshUntil: number }>(key)
    .catch(() => undefined);
  if (cached && cached.freshUntil > Date.now()) return cached.models;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const bridgeToken = env.CURSOR_SDK_BRIDGE_TOKEN?.trim();
    if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;

    const response = await deps.fetch(cursorSdkModelsUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message =
        text || `Cursor model discovery failed with status ${response.status}`;
      try {
        const payload = JSON.parse(text) as { error?: { message?: string } };
        if (payload.error?.message) message = payload.error.message;
      } catch {
        // Keep the raw response text.
      }
      const status =
        response.status === 401 ? 401 : response.status === 429 ? 429 : 502;
      throw new HttpError(
        message,
        status,
        response.status === 401 ? "cursor_unauthorized" : "cursor_models_error",
      );
    }

    const payload = (await response.json()) as {
      models?: CursorCatalogModel[];
    };
    const models = Array.isArray(payload.models)
      ? payload.models.filter(
          (model) =>
            model &&
            typeof model.id === "string" &&
            typeof model.displayName === "string",
        )
      : [];
    await redisCache
      .set(key, { models, freshUntil: Date.now() + MODEL_CATALOG_TTL_MS }, 600)
      .catch(() => undefined);
    return models;
  } catch (error) {
    if (cached && !(error instanceof HttpError && error.status === 401))
      return cached.models;
    throw error;
  }
}

function parameterizedModelId(
  modelId: string,
  params: Array<{ id: string; value: string }>,
): string {
  if (!params.length) return modelId;
  return `${modelId}[${params.map((param) => `${param.id}=${param.value}`).join(",")}]`;
}

function openAiCatalogItem(
  model: CursorCatalogModel,
  id: string,
  displayName: string,
): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "cursor",
    name: displayName,
    description: model.description ?? null,
    cursor_base_model: model.id,
    cursor_aliases: model.aliases ?? [],
    cursor_parameters: model.parameters ?? [],
  };
}

function openAiCatalogData(
  models: CursorCatalogModel[],
): Array<Record<string, unknown>> {
  const data: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const add = (item: Record<string, unknown>) => {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    data.push(item);
  };

  for (const model of models) {
    add(openAiCatalogItem(model, model.id, model.displayName));
  }

  return data;
}

async function handleModels(request: Request): Promise<Response> {
  if (!(await resolveAccess(request))) return unauthorized();
  const models = await credentialPool.intersectModels(liveCursorModels);
  return json({ object: "list", data: openAiCatalogData(models) });
}

async function handleModel(request: Request, id: string): Promise<Response> {
  if (!(await resolveAccess(request))) return unauthorized();
  const catalog = await credentialPool.intersectModels(liveCursorModels);
  const models = openAiCatalogData(catalog);
  const model = models.find((item) => item.id === id);
  if (!model)
    return openAiError(`Model '${id}' not found`, 404, "not_found", "model");
  return json(model);
}

async function hasAdminSession(request: Request): Promise<boolean> {
  return authStore.isSessionValid(sessionToken(request));
}

function assertManagedCredentialStore(): void {
  if (!process.env.ENCRYPTION_KEY?.trim()) {
    throw new HttpError(
      "ENCRYPTION_KEY is required for credential encryption",
      503,
      "server_error",
    );
  }
}

async function configuredPublicBaseUrl(): Promise<string> {
  return (
    (await authStore.publicBaseUrl()) ||
    (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "")
  );
}

async function publicApiBaseUrl(request: Request): Promise<string> {
  const configured = await configuredPublicBaseUrl();
  return (configured || new URL(request.url).origin) + "/v1";
}

function normalizePublicBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/v1$/i, "").replace(/\/+$/, "");
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(
      "Public URL must be a complete http(s) URL",
      400,
      "invalid_request_error",
      "publicBaseUrl",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.host
  ) {
    throw new HttpError(
      "Public URL must use http or https",
      400,
      "invalid_request_error",
      "publicBaseUrl",
    );
  }
  return parsed.toString().replace(/\/$/, "").replace(/\/v1$/i, "");
}

async function handleAuthStatus(request: Request): Promise<Response> {
  return json({
    configured: await authStore.isConfigured(),
    authenticated: await hasAdminSession(request),
  });
}

async function handleAuthSetup(request: Request): Promise<Response> {
  if (await authStore.isConfigured())
    throw new HttpError(
      "Administrator password is already configured",
      409,
      "conflict",
    );
  const body = (await parseJsonBody(request)) as Record<string, unknown>;
  const password = typeof body.password === "string" ? body.password : "";
  if (password.trim().length < 8 || password.length > 1024)
    throw new HttpError(
      "Password must contain 8–1024 characters",
      400,
      "invalid_request_error",
      "password",
    );
  const token = await authStore.setup(password);
  if (!token)
    throw new HttpError(
      "Administrator password is already configured",
      409,
      "conflict",
    );
  return json(
    { configured: true, authenticated: true },
    { headers: { "set-cookie": sessionCookie(token) } },
  );
}

async function handleAuthLogin(request: Request): Promise<Response> {
  if (!(await authStore.isConfigured()))
    throw new HttpError(
      "Set an administrator password before signing in",
      409,
      "setup_required",
    );
  const body = (await parseJsonBody(request)) as Record<string, unknown>;
  const password = typeof body.password === "string" ? body.password : "";
  const token = await authStore.login(password);
  if (!token) return unauthorized();
  return json(
    { configured: true, authenticated: true },
    { headers: { "set-cookie": sessionCookie(token) } },
  );
}

async function handleAuthLogout(request: Request): Promise<Response> {
  await authStore.revokeSession(sessionToken(request));
  return json(
    { ok: true },
    { headers: { "set-cookie": sessionCookie("", 0) } },
  );
}

async function handleSettings(request: Request): Promise<Response> {
  if (!(await hasAdminSession(request))) return unauthorized();
  if (request.method === "GET")
    return json({
      publicBaseUrl: await configuredPublicBaseUrl(),
      baseUrl: await publicApiBaseUrl(request),
    });
  if (request.method === "PUT") {
    const body = (await parseJsonBody(request)) as Record<string, unknown>;
    const value =
      typeof body.publicBaseUrl === "string" ? body.publicBaseUrl : "";
    const publicBaseUrl = await authStore.setPublicBaseUrl(
      normalizePublicBaseUrl(value),
    );
    return json({ publicBaseUrl, baseUrl: await publicApiBaseUrl(request) });
  }
  return notFound();
}

async function hasUsageAdminSession(request: Request): Promise<boolean> {
  return authStore.isSessionValid(sessionToken(request));
}

async function handleLocalUsage(request: Request): Promise<Response> {
  if (!(await hasUsageAdminSession(request))) return unauthorized();
  if (request.method !== "GET") return notFound();
  return json(await usageStore.stats(usageRange(request)));
}

async function handleLocalLogs(request: Request): Promise<Response> {
  if (!(await hasUsageAdminSession(request))) return unauthorized();
  const url = new URL(request.url);
  if (request.method === "GET") {
    return json({
      data: await usageStore.list({
        ...usageRange(request),
        ...usagePagination(url.searchParams),
      }),
    });
  }
  if (request.method === "DELETE") {
    const before = usageCutoff(url.searchParams);
    return json({ deleted: await usageStore.deleteBefore(before) });
  }
  return notFound();
}

async function handleClientKeys(
  request: Request,
  keyId = "",
): Promise<Response> {
  if (!(await hasAdminSession(request))) return unauthorized();
  if (request.method === "GET" && !keyId)
    return json({ data: await authStore.listClientKeys() });
  if (request.method === "POST" && !keyId) {
    const body = (await parseJsonBody(request)) as Record<string, unknown>;
    const label = typeof body.label === "string" ? body.label : "Default";
    const created = await authStore.createClientKey(label);
    return json({ ...created.info, token: created.token }, { status: 201 });
  }
  if (request.method === "DELETE" && keyId) {
    if (!(await authStore.revokeClientKey(keyId))) return notFound();
    return json({ id: keyId, revoked: true });
  }
  return notFound();
}

async function handleLocalCredentials(
  request: Request,
  credentialId = "",
): Promise<Response> {
  if (!(await hasAdminSession(request))) return unauthorized();

  if (request.method === "GET" && !credentialId) {
    const data = await Promise.all(
      (await credentialPool.list()).map(async (credential) => {
        let models: string[] = [];
        if (credential.status === "active") {
          try {
            models = (await liveCursorModels(credential.apiKey))
              .map((model) => model.id)
              .filter(
                (model) =>
                  !credential.disabledModels.has(canonicalModelId(model)),
              );
          } catch {
            models = [];
          }
        }
        return {
          id: credential.id,
          label: credential.label,
          hint: credential.hint,
          status: credential.status,
          disabledReason: credential.disabledReason || null,
          models,
          disabledModels: [...credential.disabledModels],
        };
      }),
    );
    return json({ data });
  }

  if (request.method === "POST" && !credentialId) {
    assertManagedCredentialStore();
    const body = (await parseJsonBody(request)) as Record<string, unknown>;
    const cursorApiKey =
      typeof body.cursorApiKey === "string" ? body.cursorApiKey.trim() : "";
    const label =
      typeof body.label === "string" ? body.label.trim() : "Imported";
    if (!cursorApiKey)
      throw new HttpError(
        "Cursor API key is required",
        400,
        "invalid_request_error",
        "cursorApiKey",
      );
    const models = await liveCursorModels(cursorApiKey);
    const credential = await credentialPool.addCredential(cursorApiKey, label);
    return json(
      {
        id: credential.id,
        label: credential.label,
        hint: credential.hint,
        cursorEmail: null,
        models: models.map((model) => model.id),
        disabledModels: [...credential.disabledModels],
      },
      { status: 201 },
    );
  }

  if (request.method === "DELETE" && credentialId) {
    if (!(await credentialPool.disableCredential(credentialId)))
      return notFound();
    return json({ id: credentialId, disabled: true });
  }

  return notFound();
}

async function routeCredentialRequest(
  request: Request,
  requestedModel: string,
  body: unknown,
  run: (
    apiKey: string,
    onBillingError?: (error: unknown) => void | Promise<void>,
  ) => Promise<Response>,
): Promise<Response> {
  if (!(await resolveAccess(request))) return unauthorized();

  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const surface: Surface = path.endsWith("/messages")
    ? "messages"
    : path.endsWith("/responses")
      ? "responses"
      : "chat";
  const conversation = await resolveGatewayConversation(
    request,
    body,
    surface,
    requestApiKey(request),
  );
  const context: RequestConversation = {
    conversation,
    sdkSessionKey: "",
    credentialId: "",
    inputItems: responseInputItems((body as { input?: unknown })?.input),
  };
  requestConversations.set(request, context);
  const attempted = new Set<string>();
  let lastBillingError: unknown;
  for (;;) {
    const selected = await credentialPool.select(
      requestedModel,
      conversation.affinity,
      liveCursorModels,
      attempted,
      conversation.configuration,
    );
    if (!selected) {
      if (lastBillingError instanceof Error) throw lastBillingError;
      throw new HttpError(
        "No eligible Cursor account supports this model",
        404,
        "model_not_found",
        "model",
      );
    }
    const { credential } = selected;
    attempted.add(credential.id);
    context.credentialId = credential.id;
    context.sdkSessionKey = selected.sessionKey;
    const disableOnBilling = async (error: unknown): Promise<void> => {
      if (!isBillingError(error)) return;
      await credentialPool.disableModel(credential, requestedModel);
      console.warn(
        JSON.stringify({
          event: "cursor_model_disabled",
          credentialId: credential.id,
          credentialHint: credential.hint,
          model: requestedModel,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    };
    try {
      return await run(credential.apiKey, disableOnBilling);
    } catch (error) {
      if (!isBillingError(error)) throw error;
      lastBillingError = error;
      await disableOnBilling(error);
    }
  }
}

async function handleChatCompletions(request: Request): Promise<Response> {
  const body = await parseJsonBody(request);
  const requestedModel =
    typeof (body as { model?: unknown })?.model === "string"
      ? (body as { model: string }).model
      : PRIMARY_MODEL;
  return routeCredentialRequest(
    request,
    requestedModel,
    body,
    (apiKey, onBillingError) =>
      handleChatCompletionsWithKey(
        request,
        body,
        requestedModel,
        apiKey,
        onBillingError,
      ),
  );
}

async function handleChatCompletionsWithKey(
  request: Request,
  body: unknown,
  requestedModel: string,
  apiKey: string,
  onBillingError?: (error: unknown) => void | Promise<void>,
): Promise<Response> {
  const cursorModel = await cursorModelSelection(requestedModel, body, apiKey);
  const prepared = prepareChatRequest(body, cursorModel);

  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);

  if (hasSdkBridge()) {
    const context = conversationContext(request);
    const { conversation } = context;
    return handleSdkRoute(
      "chat",
      request,
      prepared,
      apiKey,
      id,
      created,
      {
        incrementalPrompt: chatIncrementalPrompt(
          body,
          cursorModel,
          newTurnMessages(conversation.messages, conversation.resolution),
        ),
        remember: conversation.remember,
      },
      onBillingError,
    );
  }

  const completion = await createCursorCompletion(env, deps, apiKey, {
    prompt: prepared.prompt,
    model: prepared.cursorModel,
  });

  if (prepared.stream) {
    return streamOpenAiResponse("chat", completion.stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      tools: prepared.tools,
      context: prepared.toolContext,
      onError: onBillingError,
      onDone: (text, _chars, calls) =>
        conversationContext(request).conversation.remember(text, calls),
    });
  }

  const output = await collectCursorOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext,
  });
  await conversationContext(request).conversation.remember(
    output.text,
    toolCalls,
  );
  return json(
    chatCompletionResponse({
      id,
      created,
      model: prepared.model,
      text: output.text,
      toolCalls,
      promptChars: prepared.promptChars,
      metadata: prepared.responseMetadata,
    }),
  );
}

async function handleResponses(request: Request): Promise<Response> {
  if (!(await resolveAccess(request))) return unauthorized();
  const body = await expandPreviousResponse(
    redisCache,
    requestApiKey(request),
    await parseJsonBody<Record<string, unknown>>(request),
    MAX_REQUEST_BODY_BYTES,
  );
  const requestedModel =
    typeof (body as { model?: unknown })?.model === "string"
      ? (body as { model: string }).model
      : PRIMARY_MODEL;
  return routeCredentialRequest(
    request,
    requestedModel,
    body,
    (apiKey, onBillingError) =>
      handleResponsesWithKey(
        request,
        body,
        requestedModel,
        apiKey,
        onBillingError,
      ),
  );
}

async function handleResponsesWithKey(
  request: Request,
  body: unknown,
  requestedModel: string,
  apiKey: string,
  onBillingError?: (error: unknown) => void | Promise<void>,
): Promise<Response> {
  const cursorModel = await cursorModelSelection(requestedModel, body, apiKey);
  const prepared = prepareResponsesRequest(body, cursorModel);

  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);

  if (hasSdkBridge()) {
    const context = conversationContext(request);
    const input = responseInputItems((body as { input?: unknown }).input);
    let end = -1;
    for (let i = 0; i < input.length; i++) {
      const item = input[i] as { role?: unknown; type?: unknown };
      if (item?.role === "assistant" || item?.type === "function_call") end = i;
    }
    const incrementalPrompt =
      context.conversation.resolution.resumed &&
      end >= 0 &&
      end < input.length - 1
        ? prepareResponsesRequest(
            {
              ...(body as object),
              input: input.slice(end + 1),
              previous_response_id: undefined,
            },
            cursorModel,
          ).prompt
        : undefined;
    return handleSdkRoute(
      "responses",
      request,
      prepared,
      apiKey,
      id,
      created,
      {
        incrementalPrompt,
        remember: context.conversation.remember,
      },
      onBillingError,
    );
  }

  const completion = await createCursorCompletion(env, deps, apiKey, {
    prompt: prepared.prompt,
    model: prepared.cursorModel,
  });

  if (prepared.stream) {
    return streamOpenAiResponse("responses", completion.stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      tools: prepared.tools,
      context: prepared.toolContext,
      onError: onBillingError,
      onDone: async (text, _completionChars, toolCalls) => {
        await conversationContext(request).conversation.remember(
          text,
          toolCalls,
        );
        await storeResponse(
          request,
          id,
          responseObject({
            id,
            created,
            model: prepared.model,
            text,
            toolCalls,
            promptChars: prepared.promptChars,
            metadata: prepared.responseMetadata,
          }),
        );
      },
    });
  }

  const output = await collectCursorOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext,
  });
  const response = responseObject({
    id,
    created,
    model: prepared.model,
    text: output.text,
    toolCalls,
    promptChars: prepared.promptChars,
    metadata: prepared.responseMetadata,
  });
  await conversationContext(request).conversation.remember(
    output.text,
    toolCalls,
  );
  await storeResponse(request, id, response);
  return json(response);
}

// ---------------------------------------------------------------------------
// SDK bridge path (full macOS parity).
// `handleSdkPreparedOpenAiRoute`: `createCursorSdkCompletion` ->
// `collectCursorSdkOutput` + `chatCompletionResponse`/`responseObject` (non-stream)
// or `streamOpenAiEvents` over `completion.stream` (stream). The SDK completion's
// `.stream` is already an `AsyncIterable<CursorTextEvent>`, so the same
// `streamOpenAiEvents` / collected-output builders work unchanged.
// ---------------------------------------------------------------------------

type PreparedRequest =
  | ReturnType<typeof prepareChatRequest>
  | ReturnType<typeof prepareResponsesRequest>;

/**
 * Transient SDK failures worth a transparent retry: the bridge does NOT auto-retry a run
 * timeout, and a freshly created SDK agent occasionally stalls on the handshake / first
 * token to Cursor's backend. We only retry when this happens *before any output*.
 */
function isTransientSdkError(error: unknown): boolean {
  return isTransientCursorSdkError(error);
}

/**
 * Wrap an SDK event stream so a transient failure *before any event is emitted* retries
 * with a fresh attempt (the factory decides what changes per attempt). Once any event has
 * been yielded we never retry, so partial output is never duplicated.
 */
function retryingSdkStream(
  make: (attempt: number) => Promise<AsyncIterable<CursorTextEvent>>,
  maxAttempts = 2,
): AsyncIterable<CursorTextEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let attempt = 0; ; attempt += 1) {
        const iterator = (await make(attempt))[Symbol.asyncIterator]();
        let emitted = false;
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            emitted = true;
            yield next.value;
          }
        } catch (error) {
          try {
            await iterator.return?.();
          } catch {
            /* ignore */
          }
          if (
            !emitted &&
            attempt + 1 < maxAttempts &&
            isTransientSdkError(error)
          )
            continue;
          throw error;
        }
      }
    },
  };
}

/**
 * The incremental "new turn" for a follow-up chat request: the messages the resolved session
 * has not seen yet. Returned as a CursorPrompt so a still-cached SDK agent receives only the
 * new turn instead of the whole conversation, which is what lets the SDK's prefix cache hit.
 * Undefined on a first turn — then the bridge uses the full prompt.
 */
function chatIncrementalPrompt(
  body: unknown,
  cursorModel: { id: string },
  newTurn: ChatSessionMessage[],
): ReturnType<typeof prepareChatRequest>["prompt"] | undefined {
  if (!newTurn.length) return undefined;
  try {
    const deltaBody = {
      ...(body as Record<string, unknown>),
      messages: newTurn,
      stream: false,
    };
    return prepareChatRequest(
      deltaBody as Parameters<typeof prepareChatRequest>[0],
      cursorModel,
    ).prompt;
  } catch {
    return undefined;
  }
}

/** Shared tool-call gate for the SDK paths (OpenAI + Anthropic): allow a tool call only
 * if it maps to a known client tool, else return a retry hint string. */
function sdkAllowToolCall(prepared: PreparedRequest, toolCall: CursorToolCall) {
  if (!prepared.tools.length)
    return "No client tool inventory was available for this request.";
  const toolCalls = toOpenAiToolCalls({
    toolCalls: [toolCall],
    tools: prepared.tools,
    responseId: "probe",
    context: prepared.toolContext,
  });
  return (
    toolCalls.length > 0 ||
    toolCallRetryHint({
      toolCall,
      tools: prepared.tools,
      context: prepared.toolContext,
    })
  );
}

// ---------------------------------------------------------------------------
// Anthropic Messages API (Claude Code). Translates Anthropic <-> the OpenAI/Cursor SDK
// path via `anthropic.ts`. See docs/superpowers/specs/2026-06-02-anthropic-endpoint-*.
// ---------------------------------------------------------------------------

/** Validate and route Anthropic requests through the shared credential pool. */
async function handleAnthropicMessages(request: Request): Promise<Response> {
  const body = await parseJsonBody(request);
  const requestedModel =
    body &&
    typeof body === "object" &&
    typeof (body as { model?: unknown }).model === "string"
      ? (body as { model: string }).model
      : PRIMARY_MODEL;
  return routeCredentialRequest(
    request,
    requestedModel,
    body,
    (apiKey, onBillingError) =>
      handleAnthropicMessagesWithKey(
        request,
        body,
        requestedModel,
        apiKey,
        onBillingError,
      ),
  );
}

async function handleAnthropicMessagesWithKey(
  request: Request,
  body: unknown,
  requestedModel: string,
  apiKey: string,
  onBillingError?: (error: unknown) => void | Promise<void>,
): Promise<Response> {
  const translatedBody = anthropicToChatBody(body);
  const requestedContext = contextFromAnthropicBeta(
    request.headers.get("anthropic-beta"),
  );
  if (requestedContext) translatedBody.cursor_context = requestedContext;
  const cursorModel = await cursorModelSelection(
    mapModel(requestedModel),
    translatedBody,
    apiKey,
  );
  const prepared = prepareChatRequest(translatedBody, cursorModel);
  logToolForwarding("anthropic", prepared);
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const inputTokens = estimateTokens(prepared.promptChars);

  // Claude Code resends the full conversation (incl. tool_result) every turn. Rather than
  // burning a fresh agent per request, recognize the conversation by its content so the
  // follow-up turns land on the warm agent and only carry the new messages — that is what
  // makes the SDK's prefix cache hit and shows up as cache_read_input_tokens.
  const context = conversationContext(request);
  const ownerKey = sdkSessionOwner(request, apiKey);
  const incrementalPrompt = chatIncrementalPrompt(
    translatedBody,
    cursorModel,
    newTurnMessages(
      context.conversation.messages,
      context.conversation.resolution,
    ),
  );
  const remember = (
    text: string,
    toolUseBlocks: Array<Record<string, unknown>>,
  ): Promise<void> =>
    context.conversation.remember(
      text,
      toolCallsForSessionFingerprint(toolUseBlocks),
    );

  const makeStream = async (
    attempt: number,
  ): Promise<AsyncIterable<CursorTextEvent>> => {
    const completion = await createCursorSdkCompletion(env, deps, apiKey, {
      prompt: prepared.prompt,
      model: prepared.cursorModel,
      sessionKey: await sdkAttemptSession(request, attempt),
      sessionOwnerKey: ownerKey,
      incrementalPrompt: attempt === 0 ? incrementalPrompt : undefined,
      workingDirectory: prepared.toolContext?.workingDirectory,
      clientTools: prepared.tools,
      requiresLocalTool: prepared.requiresLocalTool,
      stream: prepared.stream,
      allowToolCall: (toolCall) => sdkAllowToolCall(prepared, toolCall),
    });
    return completion.stream;
  };
  const stream = retryingSdkStream(makeStream);

  if (prepared.stream) {
    return anthropicSseResponse(
      anthropicSseEvents({
        id,
        model: requestedModel,
        inputTokens,
        stream,
        tools: prepared.tools,
        toolContext: prepared.toolContext,
        onDone: remember,
      }),
      onBillingError,
    );
  }

  const output = await collectCursorSdkOutput(stream);
  const message = anthropicMessage({
    id,
    model: requestedModel,
    text: output.text,
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    toolContext: prepared.toolContext,
    inputTokens,
    outputTokens: estimateTokens(output.text.length),
    usage: output.usage,
  });
  // Fingerprint the turn the client will replay, which is the message we are about to send.
  await remember(
    output.text,
    message.content as Array<Record<string, unknown>>,
  );
  return json(message);
}

/** `POST /v1/messages/count_tokens` — Claude Code's pre-send estimate. Uses the
 * same client API-key authorization as `/v1/messages`. */
async function handleCountTokens(request: Request): Promise<Response> {
  if (!(await resolveAccess(request))) return unauthorized();
  const body = await parseJsonBody(request);
  const translatedBody = anthropicToChatBody(body);
  const prepared = prepareChatRequest(
    translatedBody,
    await cursorModelSelection(mapModel(""), translatedBody),
  );
  return json({ input_tokens: estimateTokens(prepared.promptChars) });
}

interface SdkRouteSession {
  incrementalPrompt?: ReturnType<typeof prepareChatRequest>["prompt"];
  /** Record the answered conversation so the client's next turn resolves to this session. */
  remember?: (
    text: string,
    toolCalls: OpenAiToolCall[],
  ) => void | Promise<void>;
}

async function handleSdkRoute(
  kind: "chat" | "responses",
  request: Request,
  prepared: PreparedRequest,
  apiKey: string,
  id: string,
  created: number,
  session?: SdkRouteSession,
  onBillingError?: (error: unknown) => void | Promise<void>,
): Promise<Response> {
  logToolForwarding(kind, prepared);
  // Maintain one SDK agent per client conversation "under the hood": attempt 0 reuses the
  // session (affinity header or conversation fingerprint) and sends only the new turn
  // (incrementalPrompt). The bridge re-feeds nothing while the agent is still cached and
  // falls back to the full prompt if it was evicted, so context is never lost. A transparent
  // retry (attempt >= 1) uses a FRESH session + the full prompt, so a transient bridge stall
  // ("run timed out") self-recovers instead of surfacing to the client.
  const makeStream = async (
    attempt: number,
  ): Promise<AsyncIterable<CursorTextEvent>> => {
    const completion = await createCursorSdkCompletion(env, deps, apiKey, {
      prompt: prepared.prompt,
      model: prepared.cursorModel,
      sessionKey: await sdkAttemptSession(request, attempt),
      sessionOwnerKey: sdkSessionOwner(request, apiKey),
      incrementalPrompt: attempt === 0 ? session?.incrementalPrompt : undefined,
      workingDirectory: prepared.toolContext?.workingDirectory,
      clientTools: prepared.tools,
      requiresLocalTool: prepared.requiresLocalTool,
      stream: prepared.stream,
      allowToolCall: (toolCall) => sdkAllowToolCall(prepared, toolCall),
    });
    return completion.stream;
  };
  const stream = retryingSdkStream(makeStream);

  if (prepared.stream) {
    return streamOpenAiEvents(kind, stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      tools: prepared.tools,
      context: prepared.toolContext,
      onError: onBillingError,
      onDone: async (text, _completionChars, toolCalls, usage) => {
        await session?.remember?.(text, toolCalls);
        if (kind === "responses") {
          await storeResponse(
            request,
            id,
            responseObject({
              id,
              created,
              model: prepared.model,
              text,
              toolCalls,
              promptChars: prepared.promptChars,
              metadata: prepared.responseMetadata,
              usage,
            }),
          );
        }
      },
    });
  }

  const output = await collectCursorSdkOutput(stream);
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext,
  });
  await session?.remember?.(output.text, toolCalls);

  if (kind === "chat") {
    return json(
      chatCompletionResponse({
        id,
        created,
        model: prepared.model,
        text: output.text,
        toolCalls,
        promptChars: prepared.promptChars,
        metadata: prepared.responseMetadata,
        usage: output.usage,
      }),
    );
  }

  const response = responseObject({
    id,
    created,
    model: prepared.model,
    text: output.text,
    toolCalls,
    promptChars: prepared.promptChars,
    metadata: prepared.responseMetadata,
    usage: output.usage,
  });
  await storeResponse(request, id, response);
  return json(response);
}

function logToolForwarding(surface: string, prepared: PreparedRequest): void {
  console.info(
    JSON.stringify({
      event: "client_tool_forwarding",
      surface,
      mode: prepared.prompt.mode,
      toolCount: prepared.tools.length,
      toolNames: prepared.tools.map((tool) => tool.name),
      requiresLocalTool: prepared.requiresLocalTool,
    }),
  );
}

async function handleResponseState(
  request: Request,
  responseId: string,
): Promise<Response> {
  if (!(await resolveAccess(request))) return unauthorized();
  const key = "response:" + digest(requestApiKey(request)) + ":" + responseId;
  const entry = await redisCache.get<Record<string, unknown>>(key);
  const stored = entry && (entry.response || entry); // Read older response-only cache entries as well.
  if (!stored) return openAiError("Response not found", 404, "not_found");
  if (request.method === "GET" || request.method === "HEAD") {
    return json(stored);
  }
  if (request.method === "DELETE") {
    await redisCache.delete(key);
    return json({ id: responseId, object: "response", deleted: true });
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Streaming protocol conversion and usage accounting.
// ---------------------------------------------------------------------------

interface StreamInput {
  id: string;
  created: number;
  model: string;
  promptChars: number;
  includeUsage: boolean;
  metadata?: Record<string, unknown>;
  tools: OpenAiToolSpec[];
  context?: ToolCallContext;
  onDone?: (
    text: string,
    completionChars: number,
    toolCalls: OpenAiToolCall[],
    usage?: CursorTokenUsage,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

function streamOpenAiResponse(
  kind: "chat" | "responses",
  cursorStream: Response,
  input: StreamInput,
): Response {
  return streamOpenAiEvents(kind, streamCursorText(cursorStream), input);
}

function streamOpenAiEvents(
  kind: "chat" | "responses",
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: StreamInput,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let accountingUsage: Record<string, unknown> | null = null;
  const pump = async () => {
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: OpenAiToolCall[] = [];
    let responseNextOutputIndex = 0;
    let responseTextOutputIndex: number | null = null;
    let usage: CursorTokenUsage | undefined;
    try {
      if (kind === "chat") {
        await writer.write(
          chatChunk({
            id: input.id,
            created: input.created,
            model: input.model,
            role: "assistant",
          }),
        );
      } else {
        for (const event of responseCreatedEvents(input))
          await writer.write(event);
      }

      for await (const event of cursorEvents) {
        if (event.type === "text" && event.text) {
          text += event.text;
          if (kind === "chat") {
            await writer.write(
              chatChunk({
                id: input.id,
                created: input.created,
                model: input.model,
                delta: event.text,
              }),
            );
          } else {
            if (responseTextOutputIndex === null) {
              responseTextOutputIndex = responseNextOutputIndex;
              responseNextOutputIndex += 1;
              for (const chunk of responseTextStartEvents({
                id: input.id,
                outputIndex: responseTextOutputIndex,
              })) {
                await writer.write(chunk);
              }
            }
            await writer.write(
              responseDeltaEvent({
                id: input.id,
                delta: event.text,
                outputIndex: responseTextOutputIndex,
              }),
            );
          }
        }
        if (event.type === "tool_call") {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: input.tools,
            responseId: input.id,
            startIndex: toolCallCount,
            context: input.context,
          });
          if (!toolCall) continue;
          finishReason = "tool_calls";
          streamedToolCalls.push(toolCall);
          if (kind === "chat") {
            await writer.write(
              chatChunk({
                id: input.id,
                created: input.created,
                model: input.model,
                toolCall: { index: toolCallCount, value: toolCall },
              }),
            );
          } else {
            for (const chunk of responseToolCallEvents({
              id: input.id,
              toolCall,
              outputIndex: responseNextOutputIndex,
            })) {
              await writer.write(chunk);
            }
            responseNextOutputIndex += 1;
          }
          toolCallCount += 1;
        }
        if (event.type === "done") {
          text = event.finalText;
          usage = event.usage ?? usage;
        }
      }

      accountingUsage = usage
        ? {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_input_tokens: usage.cacheReadTokens,
            cache_creation_input_tokens: usage.cacheWriteTokens,
            total_tokens: usage.totalTokens,
          }
        : {
            input_tokens: estimateTokens(input.promptChars),
            output_tokens: estimateTokens(
              completionCharsFromOutput(text, streamedToolCalls),
            ),
          };
      // Publish the binding/transcript before the terminal event permits a follow-up.
      await input.onDone?.(
        text,
        completionCharsFromOutput(text, streamedToolCalls),
        streamedToolCalls,
        usage,
      );
      if (kind === "chat") {
        const completionChars = completionCharsFromOutput(
          text,
          streamedToolCalls,
        );
        await writer.write(
          chatChunk({
            id: input.id,
            created: input.created,
            model: input.model,
            finish: true,
            finishReason,
          }),
        );
        if (input.includeUsage) {
          await writer.write(
            chatUsageChunk({
              id: input.id,
              created: input.created,
              model: input.model,
              promptChars: input.promptChars,
              completionChars,
              usage,
            }),
          );
        }
        await writer.write(doneChunk());
      } else {
        if (responseTextOutputIndex === null && !streamedToolCalls.length) {
          responseTextOutputIndex = responseNextOutputIndex;
          responseNextOutputIndex += 1;
          for (const chunk of responseTextStartEvents({
            id: input.id,
            outputIndex: responseTextOutputIndex,
          })) {
            await writer.write(chunk);
          }
        }
        for (const event of responseDoneEvents({
          ...input,
          text,
          toolCalls: streamedToolCalls,
          textStarted: responseTextOutputIndex !== null,
          textOutputIndex: responseTextOutputIndex ?? 0,
          usage,
        })) {
          await writer.write(event);
        }
      }
    } catch (error) {
      await notifyStreamError(input.onError, error);
      const message = error instanceof Error ? error.message : "Stream failed";
      await writer
        .write(
          kind === "responses"
            ? responseErrorEvent(message)
            : encodeSse(
                {
                  error: {
                    message,
                    type: "cursor_error",
                    code: "cursor_stream_error",
                  },
                },
                "error",
              ),
        )
        .catch(() => undefined);
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  void pump();
  const response = sseResponse(readable);
  registerResponseUsage(response, () => accountingUsage);
  return response;
}

function staticContentType(filePath: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  };
  return types[extname(filePath).toLowerCase()] || "application/octet-stream";
}

function serveStatic(request: Request, pathname: string): Response {
  if (!STATIC_DIR || (request.method !== "GET" && request.method !== "HEAD"))
    return notFound();
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return notFound();
  }
  const requested =
    decoded === "/" || !extname(decoded) ? "/index.html" : decoded;
  const filePath = resolve(STATIC_DIR, `.${requested}`);
  if (filePath !== STATIC_DIR && !filePath.startsWith(`${STATIC_DIR}${sep}`))
    return notFound();
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return notFound();
  const headers = new Headers({
    "content-type": staticContentType(filePath),
    "cache-control":
      requested === "/index.html" || /\.(?:css|js|map)$/.test(requested)
        ? "no-cache"
        : "public, max-age=3600",
  });
  const body =
    request.method === "HEAD" ? null : new Uint8Array(readFileSync(filePath));
  return new Response(body, { headers });
}

// ---------------------------------------------------------------------------
// Router. Only the bare `/v1/...` surface is matched; account-scoped,
// opencode, and opencodev2 surfaces from the worker are intentionally omitted.
// ---------------------------------------------------------------------------

async function routeInternal(
  request: Request,
  port: number,
  clientIp: string,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return optionsResponse();
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return notFound();
      return await healthResponse(request);
    }

    if (pathname === "/api/auth/status") {
      if (request.method !== "GET") return notFound();
      return await handleAuthStatus(request);
    }

    if (pathname === "/api/auth/setup") {
      if (request.method !== "POST") return notFound();
      return await handleAuthSetup(request);
    }

    if (pathname === "/api/auth/login") {
      if (request.method !== "POST") return notFound();
      if (
        (await redisCache.increment("login-attempt:" + digest(clientIp), 60)) >
        10
      ) {
        return openAiError(
          "Too many login attempts; retry in one minute",
          429,
          "rate_limit_exceeded",
        );
      }
      return await handleAuthLogin(request);
    }

    if (pathname === "/api/auth/logout") {
      if (request.method !== "POST") return notFound();
      return await handleAuthLogout(request);
    }

    if (pathname === "/api/settings") return await handleSettings(request);

    if (pathname === "/api/usage") return await handleLocalUsage(request);

    if (pathname === "/api/logs") return await handleLocalLogs(request);

    if (pathname === "/api/keys") return await handleClientKeys(request);

    const clientKeyMatch = /^\/api\/keys\/([^/]+)$/.exec(pathname);
    if (clientKeyMatch)
      return await handleClientKeys(
        request,
        decodeURIComponent(clientKeyMatch[1]),
      );

    if (pathname === "/api/credentials") {
      return await handleLocalCredentials(request);
    }

    const credentialMatch = /^\/api\/credentials\/([^/]+)$/.exec(pathname);
    if (credentialMatch) {
      return await handleLocalCredentials(
        request,
        decodeURIComponent(credentialMatch[1]),
      );
    }

    const v1Path = pathname.startsWith("/v1/")
      ? pathname.slice(3)
      : pathname === "/v1"
        ? "/"
        : "";

    if (v1Path === "/models") {
      if (request.method !== "GET") return notFound();
      return await handleModels(request);
    }

    const modelMatch = /^\/models\/(.+)$/.exec(v1Path);
    if (modelMatch) {
      if (request.method !== "GET") return notFound();
      return await handleModel(request, decodeURIComponent(modelMatch[1]));
    }

    if (v1Path === "/chat/completions") {
      if (request.method !== "POST") return notFound();
      return await handleChatCompletions(request);
    }

    if (v1Path === "/responses") {
      if (request.method !== "POST") return notFound();
      return await handleResponses(request);
    }

    if (v1Path === "/messages/count_tokens") {
      if (request.method !== "POST") return notFound();
      return await handleCountTokens(request);
    }

    if (v1Path === "/messages") {
      if (request.method !== "POST") return notFound();
      return await handleAnthropicMessages(request);
    }

    const responseMatch = /^\/responses\/([^/]+)$/.exec(v1Path);
    if (responseMatch) {
      return await handleResponseState(
        request,
        decodeURIComponent(responseMatch[1]),
      );
    }

    if (
      pathname === "/api" ||
      pathname.startsWith("/api/") ||
      pathname === "/v1" ||
      pathname.startsWith("/v1/")
    ) {
      return notFound();
    }
    return serveStatic(request, pathname);
  } catch (error) {
    return errorResponse(error);
  }
}

const pendingWrites = new Set<Promise<void>>();

async function route(
  request: Request,
  port: number,
  clientIp: string,
): Promise<Response> {
  const startedAt = Date.now();
  const pathname = new URL(request.url).pathname;
  const track =
    request.method === "POST" &&
    ["/v1/chat/completions", "/v1/responses", "/v1/messages"].includes(
      pathname.replace(/\/+$/, ""),
    );
  const snapshot = track ? request.clone() : null;
  const response = await routeInternal(request, port, clientIp);
  if (!snapshot) return response;
  const data = (await snapshot.json().catch(() => ({}))) as { model?: unknown };
  return observeUsage(response, async (usage, error) => {
    const pending = usageStore
      .add({
        endpoint: pathname,
        model: typeof data?.model === "string" ? data.model : null,
        status: error ? "error" : "completed",
        usage,
        startedAt,
        durationMs: Date.now() - startedAt,
        error,
      })
      .catch(() => console.error("Usage log persistence failed"));
    pendingWrites.add(pending);
    try {
      await pending;
    } finally {
      pendingWrites.delete(pending);
    }
  });
}

// ---------------------------------------------------------------------------
// node:http <-> Web Request/Response adapters.
// ---------------------------------------------------------------------------

function toWebRequest(req: IncomingMessage, port: number): Request {
  const method = req.method || "GET";
  const authority =
    typeof req.headers.host === "string" && req.headers.host.trim()
      ? req.headers.host.trim()
      : `${HOST}:${port}`;
  const url = `http://${authority}${req.url || "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    const bodyPromise = new Promise<Buffer>((resolve, reject) => {
      let totalBytes = 0;
      let settled = false;
      req.on("data", (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > MAX_REQUEST_BODY_BYTES) {
          settled = true;
          reject(
            new HttpError("Request body too large", 413, "request_too_large"),
          );
          req.resume();
          return;
        }
        chunks.push(buffer);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      req.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    // Materialize the body synchronously-ish: callers await `route`, which
    // awaits `request.json()`. We attach a stream so the Web Request can read it.
    init.body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const buffer = await bodyPromise;
        if (buffer.length) controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    });
    (init as { duplex?: string }).duplex = "half";
  }
  return new Request(url, init);
}

async function writeWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  res.once("close", () => {
    void reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      if (value && !res.write(Buffer.from(value)))
        await new Promise<void>((resolve) => {
          const resume = (): void => {
            res.off("drain", resume);
            res.off("close", resume);
            resolve();
          };
          res.once("drain", resume);
          res.once("close", resume);
        });
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

function parsePort(): number {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_PORT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 && value < 65536
    ? value
    : DEFAULT_PORT;
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  await migrateDatabase(database);
  await usageStore.ensureSchema();
  await redisCache.connect();
  await authStore.initialize(process.env.ADMIN_PASSWORD || "");
  for (const entry of parseCursorCredentialEnv(
    process.env.CURSOR_API_KEY || "",
    process.env.CURSOR_API_KEYS || "",
  )) {
    await credentialPool.addCredential(entry.apiKey, entry.label, false);
  }
  await credentialPool.list(); // Validate encryption before accepting requests.
  const port = parsePort();
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() =>
        route(
          toWebRequest(req, port),
          port,
          req.socket.remoteAddress || "unknown",
        ),
      )
      .then((response) => writeWebResponse(res, response))
      .catch((error) => {
        if (res.headersSent || res.destroyed) {
          res.destroy();
          return;
        }
        const response = errorResponse(error);
        writeWebResponse(res, response).catch(() => {
          res.destroy();
        });
      });
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    server.close(() => {
      void (async () => {
        await Promise.allSettled([...pendingWrites]);
        await redisCache.close();
        await database.end();
        clearTimeout(deadline);
      })().catch(() => process.exit(1));
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen(port, HOST, () => {
    console.log(`API for Cursor server running at http://${HOST}:${port}/v1`);
  });
}

void main().catch(async () => {
  console.error(
    "Gateway initialization failed; check PostgreSQL, Redis and encryption configuration",
  );
  await redisCache.close();
  await database.end();
  process.exitCode = 1;
});
