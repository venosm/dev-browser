import type { ConsoleMessage, Page, Request, Response } from "playwright";

export type ErrorType =
  | "console-error"
  | "console-warn"
  | "js-exception"
  | "network-failure"
  | "cors-error";

export interface ErrorEntry {
  type: ErrorType;
  message: string;
  url?: string;
  location?: string;
  pageName: string;
  timestamp: number;
  count: number;
  resourceType?: string;
  status?: number;
}

export interface ErrorReport {
  entries: ErrorEntry[];
  summary: {
    total: number;
    byType: Record<string, number>;
    topErrors: ErrorEntry[];
  };
  diagnostics: string[];
  pageCount: number;
}

export interface GetErrorsOptions {
  types?: ErrorType[];
  pageName?: string;
  since?: number;
  limit?: number;
  minCount?: number;
}

const MAX_ENTRIES = 500;

// Noise patterns to filter out — browser extensions, HMR, favicons, etc.
const NOISE_PATTERNS: RegExp[] = [
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /\[HMR\]/,
  /hot.?module.?replacement/i,
  /favicon\.ico/i,
  /\[webpack\]/i,
  /\[vite\]/i,
  /fast refresh/i,
];

// Module-level singleton — error state outlives individual sandbox runs
const _entries: ErrorEntry[] = [];
const _attached = new Map<string, () => void>(); // pageName -> cleanup fn

function isNoise(message: string, url?: string): boolean {
  const text = message + (url ?? "");
  return NOISE_PATTERNS.some((p) => p.test(text));
}

function dedupeKey(type: string, message: string, location?: string): string {
  return `${type}\0${message.slice(0, 200)}\0${location ?? ""}`;
}

function addEntry(entry: Omit<ErrorEntry, "count">): void {
  const key = dedupeKey(entry.type, entry.message, entry.location);
  const existing = _entries.find((e) => dedupeKey(e.type, e.message, e.location) === key);
  if (existing) {
    existing.count++;
    existing.timestamp = entry.timestamp;
    return;
  }
  if (_entries.length >= MAX_ENTRIES) {
    _entries.shift();
  }
  _entries.push({ ...entry, count: 1 });
}

export function attachToPage(pageName: string, page: Page): void {
  if (_attached.has(pageName)) return;

  const handleConsole = (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    const text = msg.text();
    if (isNoise(text)) return;
    const loc = msg.location();
    const isCors = /CORS|cross.origin|blocked by CORS/i.test(text);
    addEntry({
      type: isCors ? "cors-error" : type === "error" ? "console-error" : "console-warn",
      message: text,
      location: loc
        ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}`
        : undefined,
      pageName,
      timestamp: Date.now(),
    });
  };

  const handlePageError = (error: Error) => {
    if (isNoise(error.message)) return;
    const stackLine = error.stack?.split("\n")[1]?.trim();
    addEntry({
      type: "js-exception",
      message: error.message,
      location: stackLine,
      pageName,
      timestamp: Date.now(),
    });
  };

  const handleRequestFailed = (request: Request) => {
    const url = request.url();
    if (isNoise("", url)) return;
    addEntry({
      type: "network-failure",
      message: `${request.method()} ${url} — ${request.failure()?.errorText ?? "failed"}`,
      url,
      resourceType: request.resourceType(),
      pageName,
      timestamp: Date.now(),
    });
  };

  const handleResponse = (response: Response) => {
    const status = response.status();
    if (status < 400) return;
    const url = response.url();
    if (isNoise("", url)) return;
    addEntry({
      type: "network-failure",
      message: `HTTP ${status} ${response.request().method()} ${url}`,
      url,
      status,
      resourceType: response.request().resourceType(),
      pageName,
      timestamp: Date.now(),
    });
  };

  page.on("console", handleConsole);
  page.on("pageerror", handlePageError);
  page.on("requestfailed", handleRequestFailed);
  page.on("response", handleResponse);

  _attached.set(pageName, () => {
    page.off("console", handleConsole);
    page.off("pageerror", handlePageError);
    page.off("requestfailed", handleRequestFailed);
    page.off("response", handleResponse);
    _attached.delete(pageName);
  });
}

export function detachFromPage(pageName: string): void {
  _attached.get(pageName)?.();
}

export function getErrors(options: GetErrorsOptions = {}): ErrorReport {
  let entries: ErrorEntry[] = [..._entries];

  if (options.types?.length) {
    entries = entries.filter((e) => options.types!.includes(e.type));
  }
  if (options.pageName) {
    entries = entries.filter((e) => e.pageName === options.pageName);
  }
  if (options.since !== undefined) {
    entries = entries.filter((e) => e.timestamp >= options.since!);
  }
  if (options.minCount !== undefined) {
    entries = entries.filter((e) => e.count >= options.minCount!);
  }
  if (options.limit) {
    entries = entries.slice(-options.limit);
  }

  const byType: Record<string, number> = {};
  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + e.count;
  }

  const topErrors = [...entries].sort((a, b) => b.count - a.count).slice(0, 5);

  return {
    entries,
    summary: { total: entries.reduce((n, e) => n + e.count, 0), byType, topErrors },
    diagnostics: generateDiagnostics(entries),
    pageCount: new Set(entries.map((e) => e.pageName)).size,
  };
}

function generateDiagnostics(entries: ErrorEntry[]): string[] {
  const diag: string[] = [];

  const typeErrors = entries.filter(
    (e) => /TypeError|Cannot read|is not a function|is undefined/i.test(e.message)
  );
  if (typeErrors.length >= 3) {
    diag.push(
      `TypeError cascade (${typeErrors.length} errors) — likely null/undefined access on a missing DOM element or API response`
    );
  }

  const corsErrors = entries.filter((e) => e.type === "cors-error");
  if (corsErrors.length > 0) {
    diag.push(
      `CORS errors detected (${corsErrors.length}) — check Access-Control-Allow-Origin headers or use a proxy`
    );
  }

  const authFailures = entries.filter((e) => e.status === 401 || e.status === 403);
  if (authFailures.length >= 2) {
    diag.push(
      `Auth failures (${authFailures.length}× HTTP ${authFailures[0]?.status}) — session may have expired, try session.restore()`
    );
  }

  const missing = entries.filter((e) => e.status === 404);
  if (missing.length > 0) {
    diag.push(`${missing.length} missing resource(s) (404) — check asset/API paths`);
  }

  if (entries.some((e) => /mixed content/i.test(e.message))) {
    diag.push("Mixed content — HTTPS page loading HTTP resources; upgrade URLs or set CSP");
  }

  const netFails = entries.filter((e) => e.type === "network-failure" && !e.status);
  if (netFails.length > 0) {
    diag.push(
      `${netFails.length} connection failure(s) — server unreachable or DNS resolution failed`
    );
  }

  return diag;
}

export function clearErrors(pageName?: string): void {
  if (pageName) {
    const keep = _entries.filter((e) => e.pageName !== pageName);
    _entries.length = 0;
    _entries.push(...keep);
  } else {
    _entries.length = 0;
  }
}

export function getSummary(): string {
  const report = getErrors();
  if (report.entries.length === 0) return "No errors collected.";
  const lines: string[] = [
    `${report.summary.total} error(s) across ${report.pageCount} page(s)`,
  ];
  for (const [type, count] of Object.entries(report.summary.byType)) {
    lines.push(`  ${type}: ${count}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push("Diagnostics:");
    for (const d of report.diagnostics) lines.push(`  • ${d}`);
  }
  return lines.join("\n");
}
