import { escapeHtml, icon, hydrateIcons } from "./ui";

interface Credential { id: string; label: string; hint: string; status: "active" | "disabled"; models: string[]; }
interface ClientKey { id: string; label: string; hint: string; createdAt: string; }
interface Settings { publicBaseUrl: string; baseUrl: string; }
interface UsageStats {
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  averageDurationMs: number | null;
  averageFirstTokenMs: number | null;
  averageCacheHitRate: number;
  modelBreakdown: Array<{ model: string; requests: number; totalCost: number; totalTokens: number; }>;
}

interface RequestLog {
  id: string;
  endpoint: string;
  model: string | null;
  status: string;
  total_tokens: number;
  total_cost: number;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

type UsageRange = "today" | "yesterday" | "week" | "month" | "all";

function usageRangeQuery(range: UsageRange): string {
  if (range === "all") return "";
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "yesterday") {
    const end = new Date(start);
    start.setDate(start.getDate() - 1);
    return `&start_date=${encodeURIComponent(start.toISOString())}&end_date=${encodeURIComponent(end.toISOString())}`;
  }
  if (range === "week") start.setDate(start.getDate() - 6);
  if (range === "month") start.setDate(start.getDate() - 29);
  return `&start_date=${encodeURIComponent(start.toISOString())}`;
}

function cleanupBefore(range: string): string | null {
  const days = Number.parseInt(range, 10);
  if (!Number.isInteger(days) || days <= 0) return null;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff.toISOString();
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(body.error?.message || "Request failed (" + response.status + ")");
  return body;
}

export function mountDashboard(root: HTMLElement): void { void boot(root); }

async function boot(root: HTMLElement): Promise<void> {
  try {
    const status = await requestJson<{ configured: boolean; authenticated: boolean }>("/api/auth/status");
    if (!status.authenticated) { mountSignIn(root, status.configured); return; }
    mountConsole(root);
  } catch (error) {
    root.innerHTML = "<main class=\"dashboard-shell\"><div class=\"dashboard-error\">" + escapeHtml(error instanceof Error ? error.message : "后台暂时不可用") + "</div></main>";
  }
}

function mountSignIn(root: HTMLElement, configured: boolean): void {
  const title = configured ? "登录控制台" : "设置管理员密码";
  const description = configured ? "使用管理员密码进入网关控制台。" : "首次使用请设置管理员密码，保护账号池和客户端 API Keys。";
  root.innerHTML = "<div class=\"dashboard-shell dashboard-auth-shell\"><header class=\"dashboard-header\"><a class=\"brand\" href=\"/\"><img class=\"brand-icon\" src=\"/api-for-cursor-icon.png\" width=\"36\" height=\"36\" alt=\"\"/><span class=\"brand-text\">Cursor Gateway</span></a><a class=\"back-link\" href=\"/\">返回首页</a></header><main class=\"dashboard-auth-main\"><section class=\"dashboard-auth-panel\"><p class=\"dashboard-kicker\">GATEWAY CONSOLE</p><h1>" + title + "</h1><p>" + description + "</p><form id=\"auth-form\"><label>管理员密码<input id=\"auth-password\" type=\"password\" minlength=\"8\" autocomplete=\"" + (configured ? "current-password" : "new-password") + "\" required autofocus/></label><div id=\"auth-error\" class=\"dashboard-notice error\" hidden></div><button class=\"btn btn-primary auth-submit\" type=\"submit\">" + title + "</button></form></section></main></div>";
  root.querySelector<HTMLFormElement>("#auth-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = root.querySelector<HTMLInputElement>("#auth-password")?.value || "";
    const errorBox = root.querySelector<HTMLElement>("#auth-error");
    const submit = root.querySelector<HTMLButtonElement>(".auth-submit");
    if (submit) submit.disabled = true;
    void requestJson(configured ? "/api/auth/login" : "/api/auth/setup", { method: "POST", body: JSON.stringify({ password }) })
      .then(() => boot(root))
      .catch((error) => { if (errorBox) { errorBox.hidden = false; errorBox.textContent = error instanceof Error ? error.message : "操作失败"; } })
      .finally(() => { if (submit) submit.disabled = false; });
  });
}

function mountConsole(root: HTMLElement): void {
  root.innerHTML = consoleMarkup();
  let credentials: Credential[] = [];
  let clientKeys: ClientKey[] = [];
  let settings: Settings = { publicBaseUrl: "", baseUrl: window.location.origin + "/v1" };
  let usageStats: UsageStats | null = null;
  let requestLogs: RequestLog[] = [];
  let usageRange: UsageRange = "today";
  const notice = (message: string, error = false): void => { const el = root.querySelector<HTMLElement>("#dashboard-notice"); if (!el) return; el.hidden = !message; el.textContent = message; el.classList.toggle("error", error); };
  const refresh = async (): Promise<void> => {
    try {
      const rangeQuery = usageRangeQuery(usageRange);
      const [accounts, keys, nextSettings, stats, logs] = await Promise.all([
        requestJson<{ data?: Credential[] }>("/api/credentials"),
        requestJson<{ data?: ClientKey[] }>("/api/keys"),
        requestJson<Settings>("/api/settings"),
        requestJson<UsageStats>(`/api/usage?${rangeQuery.replace(/^&/, "")}`).catch(() => null),
        requestJson<{ data?: RequestLog[] }>(`/api/logs?limit=100${rangeQuery}`).catch(() => ({ data: [] }))
      ]);
      credentials = accounts.data || [];
      clientKeys = keys.data || [];
      settings = nextSettings;
      usageStats = stats;
      requestLogs = logs.data || [];
      renderConsole(root, credentials, clientKeys, settings, usageStats, requestLogs, usageRange, refresh, notice, (nextRange) => { usageRange = nextRange; void refresh(); }, (days) => cleanupLogs(days));
      notice("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载失败";
      if (/401|unauthor/i.test(message)) { void boot(root); return; }
      notice(message, true);
    }
  };
  const cleanupLogs = async (days: number): Promise<void> => {
    const before = cleanupBefore(String(days));
    if (!before) return;
    if (!window.confirm(`确定清理 ${days} 天前的使用日志吗？此操作不可撤销。`)) return;
    try {
      const result = await requestJson<{ deleted: number }>(`/api/logs?before=${encodeURIComponent(before)}`, { method: "DELETE" });
      notice(`已清理 ${result.deleted} 条使用日志`);
      await refresh();
    } catch (error) {
      notice(error instanceof Error ? error.message : "清理日志失败", true);
    }
  };
  const accountDialog = root.querySelector<HTMLDialogElement>("#account-dialog")!;
  const keyDialog = root.querySelector<HTMLDialogElement>("#client-key-dialog")!;
  root.querySelector("#add-account")?.addEventListener("click", () => accountDialog.showModal());
  root.querySelector("#import-accounts")?.addEventListener("click", () => accountDialog.showModal());
  root.querySelector("#cancel-account")?.addEventListener("click", () => accountDialog.close());
  root.querySelector("#refresh-all")?.addEventListener("click", () => void refresh());
  root.querySelector("#logout")?.addEventListener("click", () => { void requestJson("/api/auth/logout", { method: "POST" }).finally(() => boot(root)); });
  root.querySelector("#save-public-url")?.addEventListener("click", () => {
    const publicBaseUrl = root.querySelector<HTMLInputElement>("#public-base-url")?.value || "";
    void requestJson<Settings>("/api/settings", { method: "PUT", body: JSON.stringify({ publicBaseUrl }) }).then((value) => { settings = value; renderConsole(root, credentials, clientKeys, settings, usageStats, requestLogs, usageRange, refresh, notice, (nextRange) => { usageRange = nextRange; void refresh(); }, (days) => cleanupLogs(days)); notice("对外地址已保存"); }).catch((error) => notice(error instanceof Error ? error.message : "保存失败", true));
  });
  root.querySelectorAll<HTMLElement>("[data-copy-target]").forEach((button) => button.addEventListener("click", () => { const input = root.querySelector<HTMLInputElement>("#" + button.dataset.copyTarget); if (input?.value) void navigator.clipboard?.writeText(input.value); }));
  root.querySelector<HTMLFormElement>("#account-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = root.querySelector<HTMLTextAreaElement>("#account-value")?.value || "";
    const label = (root.querySelector<HTMLInputElement>("#account-label")?.value || "Imported").trim() || "Imported";
    const entries = raw.split(/[\r\n]+/).map((line, index) => { const separator = line.indexOf(","); return separator >= 0 ? { label: line.slice(0, separator).trim() || label + " " + (index + 1), cursorApiKey: line.slice(separator + 1).trim() } : { label: raw.includes("\n") ? label + " " + (index + 1) : label, cursorApiKey: line.trim() }; }).filter((item) => item.cursorApiKey);
    if (!entries.length) { notice("请输入至少一把 Cursor API Key", true); return; }
    void Promise.all(entries.map((entry) => requestJson("/api/credentials", { method: "POST", body: JSON.stringify(entry) }))).then(() => { accountDialog.close(); notice("账号已导入"); return refresh(); }).catch((error) => notice(error instanceof Error ? error.message : "导入失败", true));
  });
  root.querySelector("#create-client-key")?.addEventListener("click", () => { root.querySelector<HTMLElement>("#client-key-fields")!.hidden = false; root.querySelector<HTMLElement>("#client-key-result")!.hidden = true; keyDialog.showModal(); });
  root.querySelector("#cancel-client-key")?.addEventListener("click", () => keyDialog.close());
  root.querySelector("#close-client-key")?.addEventListener("click", () => keyDialog.close());
  root.querySelector<HTMLFormElement>("#client-key-form")?.addEventListener("submit", (event) => {
    event.preventDefault(); const label = root.querySelector<HTMLInputElement>("#client-key-label")?.value || "Default";
    void requestJson<{ token: string }>("/api/keys", { method: "POST", body: JSON.stringify({ label }) }).then((created) => { root.querySelector<HTMLElement>("#client-key-fields")!.hidden = true; root.querySelector<HTMLElement>("#client-key-result")!.hidden = false; root.querySelector<HTMLInputElement>("#new-client-key")!.value = created.token; return refresh(); }).catch((error) => notice(error instanceof Error ? error.message : "创建失败", true));
  });
  hydrateIcons(root); void refresh();
}

function consoleMarkup(): string {
  const copy = icon("Copy", { width: 16, height: 16 });
  return "<div class=\"dashboard-shell\"><header class=\"dashboard-header\"><a class=\"brand\" href=\"/\"><img class=\"brand-icon\" src=\"/api-for-cursor-icon.png\" width=\"36\" height=\"36\" alt=\"\"/><span class=\"brand-text\">Cursor Gateway</span></a><div class=\"dashboard-header-right\"><span class=\"dashboard-product\">Control Console</span><button class=\"icon-button\" id=\"logout\" title=\"退出登录\" aria-label=\"退出登录\">" + icon("LogOut", { width: 16, height: 16 }) + "</button></div></header><main class=\"dashboard-main\"><div class=\"dashboard-toolbar\"><div><p class=\"dashboard-kicker\">OPERATIONS</p><h1>网关控制台</h1><p class=\"dashboard-subtitle\">管理 Cursor 账号池、客户端密钥和对外接入地址。</p></div><div class=\"toolbar-actions\"><button class=\"icon-button\" id=\"refresh-all\" title=\"刷新数据\" aria-label=\"刷新数据\">" + icon("RefreshCw", { width: 17, height: 17 }) + "</button><button class=\"btn btn-primary\" id=\"add-account\" type=\"button\">" + icon("Plus", { width: 16, height: 16 }) + " 添加账号</button></div></div><section class=\"dashboard-summary\"><div class=\"summary-item\"><span>账号</span><strong id=\"account-count\">0</strong></div><div class=\"summary-item\"><span>可用</span><strong id=\"healthy-count\">0</strong></div><div class=\"summary-item\"><span>共同模型</span><strong id=\"model-count\">0</strong></div><div class=\"summary-item\"><span>客户端 Key</span><strong id=\"client-key-count\">0</strong></div></section><section class=\"dashboard-section usage-section\"><div class=\"section-bar\"><div><h2>使用统计</h2><p class=\"section-note\">实时 API 调用、Token 和费用分析。</p></div><label class=\"usage-filter\">时间范围<select id=\"usage-range\"><option value=\"today\">今天</option><option value=\"yesterday\">昨天</option><option value=\"week\">近一周</option><option value=\"month\">近一月</option><option value=\"all\">全部</option></select></label></div><div class=\"usage-grid\"><div class=\"usage-card\"><div class=\"usage-card-header\"><span class=\"usage-label\">总请求数</span>" + icon("Activity", { width: 16, height: 16 }) + "</div><div class=\"usage-value\" id=\"total-requests\">-</div><div class=\"usage-detail\"><span class=\"usage-success\" id=\"completed-requests\">-</span><span class=\"usage-error\" id=\"failed-requests\">-</span></div></div><div class=\"usage-card\"><div class=\"usage-card-header\"><span class=\"usage-label\">总 Tokens</span>" + icon("Zap", { width: 16, height: 16 }) + "</div><div class=\"usage-value\" id=\"total-tokens\">-</div><div class=\"usage-detail\"><span id=\"token-breakdown\">-</span></div></div><div class=\"usage-card\"><div class=\"usage-card-header\"><span class=\"usage-label\">总花费</span>" + icon("DollarSign", { width: 16, height: 16 }) + "</div><div class=\"usage-value\" id=\"total-cost\">-</div><div class=\"usage-detail\"><span id=\"cost-breakdown\">-</span></div></div><div class=\"usage-card\"><div class=\"usage-card-header\"><span class=\"usage-label\">平均响应</span>" + icon("Clock", { width: 16, height: 16 }) + "</div><div class=\"usage-value\" id=\"avg-duration\">-</div><div class=\"usage-detail\"><span id=\"ttft\">首字: -</span><span id=\"cache-rate\">缓存率: -</span></div></div></div><div id=\"model-breakdown\" class=\"model-breakdown\"></div></section><section class=\"dashboard-section logs-section\"><div class=\"section-bar\"><div><h2>使用日志</h2><p class=\"section-note\">按时间查看请求、Token 和费用明细。</p></div><div class=\"log-actions\"><select id=\"cleanup-range\" aria-label=\"清理多久以前的日志\"><option value=\"\">清理日志…</option><option value=\"7\">清理 7 天前</option><option value=\"30\">清理 30 天前</option><option value=\"90\">清理 90 天前</option></select><button class=\"btn btn-secondary\" id=\"cleanup-logs\" type=\"button\">清理</button></div></div><div class=\"log-table-head\"><span>时间</span><span>接口 / 模型</span><span>状态</span><span>Tokens</span><span>花费</span><span>耗时</span></div><div id=\"request-log-list\"></div></section><section class=\"dashboard-section connection-section\"><div class=\"section-bar\"><div><h2>客户端接入</h2><p class=\"section-note\">客户端使用后台创建的独立 <code>sk-...</code> Key，不会接触 Cursor 凭据。</p></div></div><div class=\"connection-grid endpoint-grid\"><label>API Base URL<span class=\"gateway-input\"><input id=\"api-base-url\" readonly/><button class=\"icon-button\" type=\"button\" data-copy-target=\"api-base-url\" title=\"复制 API 地址\" aria-label=\"复制 API 地址\">" + copy + "</button></span></label><label>对外地址<span class=\"endpoint-editor\"><input id=\"public-base-url\" placeholder=\"https://api.example.com\"/><button class=\"btn btn-secondary\" id=\"save-public-url\" type=\"button\">保存</button></span></label></div></section><div id=\"dashboard-notice\" class=\"dashboard-notice\" hidden></div><section class=\"dashboard-section credentials-section\"><div class=\"section-bar\"><div><h2>Cursor 账号</h2><p class=\"section-note\">凭据加密存储；账单错误会自动停用对应模型并切换账号。</p></div><button class=\"btn btn-secondary\" id=\"import-accounts\" type=\"button\">批量导入</button></div><div class=\"credential-table-head\"><span>账号</span><span>模型</span><span>状态</span><span></span></div><div id=\"account-list\"></div></section><section class=\"dashboard-section client-keys-section\"><div class=\"section-bar\"><div><h2>客户端 API Keys</h2><p class=\"section-note\">Key 仅在创建时显示一次，撤销后立即失效。</p></div><button class=\"btn btn-primary\" id=\"create-client-key\" type=\"button\">" + icon("KeyRound", { width: 16, height: 16 }) + " 创建 Key</button></div><div class=\"client-key-head\"><span>名称</span><span>密钥标识</span><span>创建时间</span><span></span></div><div id=\"client-key-list\"></div></section></main><dialog id=\"account-dialog\"><form id=\"account-form\"><h2>添加 Cursor 账号</h2><p class=\"section-note account-key-guide\">从 <a href=\"https://cursor.com/dashboard\" target=\"_blank\" rel=\"noreferrer\">cursor.com/dashboard</a> 左侧打开 API KEY，点击新建后复制页面显示的 <code>crsr_...</code> 密钥。</p><label>名称<input id=\"account-label\" placeholder=\"例如：工作账号\"/></label><label>Cursor API Key<textarea id=\"account-value\" rows=\"7\" placeholder=\"支持多行；批量格式为 名称,Key\"></textarea></label><div class=\"dialog-actions\"><button class=\"btn btn-secondary\" id=\"cancel-account\" type=\"button\">取消</button><button class=\"btn btn-primary\" type=\"submit\">保存并校验</button></div></form></dialog><dialog id=\"client-key-dialog\"><form id=\"client-key-form\"><div id=\"client-key-fields\"><h2>创建客户端 API Key</h2><label>名称<input id=\"client-key-label\" placeholder=\"例如：OpenCode 本机\" required/></label><div class=\"dialog-actions\"><button class=\"btn btn-secondary\" id=\"cancel-client-key\" type=\"button\">取消</button><button class=\"btn btn-primary\" type=\"submit\">创建 Key</button></div></div><div id=\"client-key-result\" hidden><h2>保存此 API Key</h2><p class=\"section-note\">关闭窗口后不能再次查看完整 Key。</p><span class=\"gateway-input\"><input id=\"new-client-key\" readonly/><button class=\"icon-button\" type=\"button\" data-copy-target=\"new-client-key\" title=\"复制 API Key\" aria-label=\"复制 API Key\">" + copy + "</button></span><div class=\"dialog-actions\"><button class=\"btn btn-primary\" id=\"close-client-key\" type=\"button\">完成</button></div></div></form></dialog></div>";
}

function renderConsole(root: HTMLElement, credentials: Credential[], clientKeys: ClientKey[], settings: Settings, usageStats: UsageStats | null, requestLogs: RequestLog[], usageRange: UsageRange, refresh: () => Promise<void>, notice: (message: string, error?: boolean) => void, onUsageRangeChange: (range: UsageRange) => void, onCleanup: (days: number) => Promise<void>): void {
  const active = credentials.filter((item) => item.status === "active");
  const common = active.length ? active.slice(1).reduce((shared, item) => new Set([...shared].filter((model) => item.models.includes(model))), new Set(active[0].models)) : new Set<string>();
  root.querySelector("#account-count")!.textContent = String(credentials.length);
  root.querySelector("#healthy-count")!.textContent = String(active.length);
  root.querySelector("#model-count")!.textContent = String(common.size);
  root.querySelector("#client-key-count")!.textContent = String(clientKeys.length);

  const rangeSelect = root.querySelector("#usage-range") as HTMLSelectElement | null;
  if (rangeSelect) {
    rangeSelect.value = usageRange;
    if (rangeSelect.dataset.bound !== "true") {
      rangeSelect.addEventListener("change", () => onUsageRangeChange(rangeSelect.value as UsageRange));
      rangeSelect.dataset.bound = "true";
    }
  }

  // 渲染使用统计
  if (usageStats) {
    const formatNumber = (n: number): string => n.toLocaleString();
    const formatCost = (n: number): string => "$" + Number(n || 0).toFixed(4);
    const formatPercent = (n: number): string => (n * 100).toFixed(1) + "%";

    root.querySelector("#total-requests")!.textContent = formatNumber(usageStats.totalRequests);
    root.querySelector("#completed-requests")!.textContent = "✓ " + formatNumber(usageStats.completedRequests);
    root.querySelector("#failed-requests")!.textContent = "✗ " + formatNumber(usageStats.failedRequests);

    root.querySelector("#total-tokens")!.textContent = formatNumber(usageStats.totalTokens);
    root.querySelector("#token-breakdown")!.textContent =
      "输入: " + formatNumber(usageStats.inputTokens) + " | " +
      "输出: " + formatNumber(usageStats.outputTokens) + " | " +
      "缓存: " + formatNumber(usageStats.cacheReadTokens);

    root.querySelector("#total-cost")!.textContent = formatCost(usageStats.totalCost);
    root.querySelector("#cost-breakdown")!.textContent =
      "输入: " + formatCost(usageStats.inputCost) + " | " +
      "输出: " + formatCost(usageStats.outputCost) + " | " +
      "缓存: " + formatCost(usageStats.cacheReadCost);

    root.querySelector("#avg-duration")!.textContent = usageStats.averageDurationMs
      ? Math.round(usageStats.averageDurationMs).toString() + "ms"
      : "-";

    root.querySelector("#ttft")!.textContent = usageStats.averageFirstTokenMs
      ? "首字: " + Math.round(usageStats.averageFirstTokenMs) + "ms"
      : "首字: -";

    root.querySelector("#cache-rate")!.textContent = "缓存率: " + formatPercent(usageStats.averageCacheHitRate);

    // 渲染模型分析
    const modelBreakdown = root.querySelector<HTMLElement>("#model-breakdown")!;
    if (usageStats.modelBreakdown && usageStats.modelBreakdown.length > 0) {
      modelBreakdown.innerHTML =
        "<h3>模型使用明细</h3>" +
        "<div class=\"model-breakdown-grid\">" +
        usageStats.modelBreakdown.map((item) =>
          "<div class=\"model-card\">" +
          "<div class=\"model-name\">" + escapeHtml(item.model) + "</div>" +
          "<div class=\"model-stats\">" +
          "<div><span>请求:</span><strong>" + formatNumber(item.requests) + "</strong></div>" +
          "<div><span>Token:</span><strong>" + formatNumber(item.totalTokens) + "</strong></div>" +
          "<div><span>花费:</span><strong>" + formatCost(item.totalCost) + "</strong></div>" +
          "</div>" +
          "</div>"
        ).join("") +
        "</div>";
    } else {
      modelBreakdown.innerHTML = "";
    }
  }

  const formatLogCost = (value: number): string => "$" + Number(value || 0).toFixed(4);
  const formatLogTokens = (value: number): string => Number(value || 0).toLocaleString();
  const logList = root.querySelector<HTMLElement>("#request-log-list");
  if (logList) {
    logList.innerHTML = requestLogs.length ? requestLogs.map((log) => {
      const statusLabel = log.status === "completed" ? "成功" : log.status === "error" ? "失败" : log.status;
      const statusClass = log.status === "completed" ? "ok" : log.status === "error" ? "error" : "pending";
      const duration = log.duration_ms == null ? "-" : Math.round(log.duration_ms) + "ms";
      const endpoint = escapeHtml(log.endpoint || "-");
      const model = escapeHtml(log.model || "-");
      return `<div class="log-row"><time>${escapeHtml(new Date(log.created_at).toLocaleString())}</time><div class="log-endpoint"><strong>${endpoint}</strong><span>${model}</span></div><span class="log-status ${statusClass}">${statusLabel}</span><span>${formatLogTokens(log.total_tokens)}</span><span>${formatLogCost(log.total_cost)}</span><span>${duration}</span></div>`;
    }).join("") : "<div class=\"empty-state\"><strong>该时间范围暂无使用日志</strong><span>请求完成后，日志会显示在这里。</span></div>";
  }
  const cleanupRange = root.querySelector("#cleanup-range") as HTMLSelectElement | null;
  const cleanupButton = root.querySelector<HTMLButtonElement>("#cleanup-logs");
  if (cleanupButton && cleanupButton.dataset.bound !== "true") {
    cleanupButton.addEventListener("click", () => {
      const days = Number(cleanupRange?.value || 0);
      if (Number.isInteger(days) && days > 0) void onCleanup(days);
      else notice("请选择要清理的时间范围", true);
    });
    cleanupButton.dataset.bound = "true";
  }

  root.querySelector<HTMLInputElement>("#api-base-url")!.value = settings.baseUrl;
  const publicUrl = root.querySelector<HTMLInputElement>("#public-base-url");
  if (publicUrl && document.activeElement !== publicUrl) publicUrl.value = settings.publicBaseUrl || window.location.origin;

  const accounts = root.querySelector<HTMLElement>("#account-list")!;
  accounts.innerHTML = credentials.length ? credentials.map((item) => "<div class=\"credential-row\"><div class=\"credential-identity\"><strong>" + escapeHtml(item.label) + "</strong><code>••••" + escapeHtml(item.hint) + "</code></div><div class=\"credential-models\">" + escapeHtml(item.models.length ? item.models.join(", ") : "暂无模型") + "</div><div><span class=\"credential-status " + (item.status === "active" ? "ok\">可用" : "disabled\">已禁用") + "</span></div><div class=\"credential-actions\"><button class=\"icon-button\" data-disable-account=\"" + escapeHtml(item.id) + "\" title=\"禁用账号\" aria-label=\"禁用账号\">" + icon("Trash2", { width: 16, height: 16 }) + "</button></div></div>").join("") : "<div class=\"empty-state\"><strong>还没有 Cursor 账号</strong><span>添加第一把账号 Key，开始建立账号池。</span></div>";
  accounts.querySelectorAll<HTMLElement>("[data-disable-account]").forEach((button) => button.addEventListener("click", () => { void requestJson("/api/credentials/" + encodeURIComponent(button.dataset.disableAccount || ""), { method: "DELETE" }).then(refresh).catch((error) => notice(error instanceof Error ? error.message : "禁用失败", true)); }));

  const keys = root.querySelector<HTMLElement>("#client-key-list")!;
  keys.innerHTML = clientKeys.length ? clientKeys.map((item) => "<div class=\"client-key-row\"><strong>" + escapeHtml(item.label) + "</strong><code>sk-••••" + escapeHtml(item.hint) + "</code><time>" + escapeHtml(new Date(item.createdAt).toLocaleString()) + "</time><button class=\"icon-button\" data-revoke-key=\"" + escapeHtml(item.id) + "\" title=\"撤销 API Key\" aria-label=\"撤销 API Key\">" + icon("Trash2", { width: 16, height: 16 }) + "</button></div>").join("") : "<div class=\"empty-state\"><strong>还没有客户端 API Key</strong><span>创建 Key 后即可接入 OpenAI、Anthropic 或 Responses 客户端。</span></div>";
  keys.querySelectorAll<HTMLElement>("[data-revoke-key]").forEach((button) => button.addEventListener("click", () => { void requestJson("/api/keys/" + encodeURIComponent(button.dataset.revokeKey || ""), { method: "DELETE" }).then(refresh).catch((error) => notice(error instanceof Error ? error.message : "撤销失败", true)); }));

  hydrateIcons(root);
}
