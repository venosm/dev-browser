import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { getDevBrowserBaseDir } from "./local-endpoint.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(getDevBrowserBaseDir(), "sessions");
const SESSION_VERSION = 1;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const AUTH_KEYWORDS = ["token", "auth", "session", "jwt", "access", "sid", "csrf", "login"];
const RESTORE_DUMMY_PATH = "/__dev_browser_session_restore__";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionStorageEntry {
  origin: string;
  entries: Array<{ key: string; value: string }>;
}

type AuthType = "cookie" | "jwt-localStorage" | "jwt-sessionStorage" | "oauth" | "unknown";

interface SessionSnapshot {
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  storageState: {
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
    }>;
    origins: Array<{
      origin: string;
      localStorage: Array<{ name: string; value: string }>;
    }>;
  };
  sessionStorage?: SessionStorageEntry[];
  metadata: {
    sourceUrl: string;
    domains: string[];
    authType: AuthType;
    tags: string[];
    estimatedExpiry: string | null;
    sizeBytes: number;
  };
}

interface SaveOptions {
  description?: string;
  overwrite?: boolean;
  includeSessionStorage?: boolean;
  tags?: string[];
  domains?: string[];
  analyzeAuth?: boolean;
}

interface RestoreOptions {
  clearExisting?: boolean;
  navigateToSource?: boolean;
  validateExpiry?: boolean;
  page?: string;
}

interface ListOptions {
  tags?: string[];
  domain?: string;
  sortBy?: "name" | "createdAt" | "updatedAt" | "size";
  checkExpiry?: boolean;
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

function sanitizeSessionName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Session name must be a non-empty string");
  }
  if (name.length > 100) {
    throw new Error("Session name must be 100 characters or less");
  }
  if (/[/\\:\0]/.test(name) || name.includes("..")) {
    throw new Error("Session name contains invalid characters");
  }
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function getSessionPath(name: string): string {
  return path.join(SESSIONS_DIR, `${name}.json`);
}

async function sessionExists(name: string): Promise<boolean> {
  try {
    await stat(getSessionPath(name));
    return true;
  } catch {
    return false;
  }
}

async function readSnapshot(name: string): Promise<SessionSnapshot> {
  const filePath = getSessionPath(name);
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as SessionSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Session "${name}" not found`);
    }
    throw error;
  }
}

function getFirstActivePage(pages: Map<string, Page>): Page | undefined {
  for (const page of pages.values()) {
    if (!page.isClosed()) return page;
  }
  return undefined;
}

function extractDomains(storageState: SessionSnapshot["storageState"]): string[] {
  const domains = new Set<string>();
  for (const cookie of storageState.cookies) {
    domains.add(cookie.domain.replace(/^\./, ""));
  }
  for (const origin of storageState.origins) {
    try {
      domains.add(new URL(origin.origin).hostname);
    } catch {
      // skip malformed origins
    }
  }
  return [...domains].sort();
}

function getPageOrigin(page: Page): string | null {
  try {
    const url = new URL(page.url());
    if (url.protocol === "about:" || url.protocol === "data:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function findPageForOrigin(pages: Map<string, Page>, origin: string): Page | undefined {
  for (const page of pages.values()) {
    if (!page.isClosed() && getPageOrigin(page) === origin) {
      return page;
    }
  }
  return undefined;
}

// ── Session Storage Capture ───────────────────────────────────────────────────

async function captureSessionStorage(
  pages: Map<string, Page>
): Promise<SessionStorageEntry[]> {
  const results: SessionStorageEntry[] = [];
  const seenOrigins = new Set<string>();

  for (const page of pages.values()) {
    if (page.isClosed()) continue;
    const origin = getPageOrigin(page);
    if (!origin || seenOrigins.has(origin)) continue;
    seenOrigins.add(origin);

    try {
      const data: Array<{ key: string; value: string }> = await page.evaluate(() => {
        const items: Array<{ key: string; value: string }> = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key !== null) {
            items.push({ key, value: sessionStorage.getItem(key) ?? "" });
          }
        }
        return items;
      });

      if (data.length > 0) {
        results.push({ origin, entries: data });
      }
    } catch {
      // Page might be on a restricted origin
    }
  }

  return results;
}

// ── Auth Analysis ─────────────────────────────────────────────────────────────

function isAuthCookieName(name: string): boolean {
  const lower = name.toLowerCase();
  return AUTH_KEYWORDS.some((kw) => lower.includes(kw));
}

function looksLikeJwt(value: string): boolean {
  return JWT_RE.test(value.trim());
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

interface JwtInfo {
  location: "cookie" | "localStorage" | "sessionStorage";
  key: string;
  payload: Record<string, unknown>;
  expiresAt: string | null;
  expired: boolean;
}

function findJwts(
  storageState: SessionSnapshot["storageState"],
  sessionStorage?: SessionStorageEntry[]
): JwtInfo[] {
  const results: JwtInfo[] = [];
  const now = Date.now() / 1000;

  for (const cookie of storageState.cookies) {
    if (looksLikeJwt(cookie.value)) {
      const payload = decodeJwtPayload(cookie.value);
      if (payload) {
        const exp = typeof payload.exp === "number" ? payload.exp : null;
        results.push({
          location: "cookie",
          key: cookie.name,
          payload,
          expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
          expired: exp !== null && exp < now,
        });
      }
    }
  }

  for (const origin of storageState.origins) {
    for (const entry of origin.localStorage) {
      if (looksLikeJwt(entry.value)) {
        const payload = decodeJwtPayload(entry.value);
        if (payload) {
          const exp = typeof payload.exp === "number" ? payload.exp : null;
          results.push({
            location: "localStorage",
            key: entry.name,
            payload,
            expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
            expired: exp !== null && exp < now,
          });
        }
      }
    }
  }

  if (sessionStorage) {
    for (const origin of sessionStorage) {
      for (const entry of origin.entries) {
        if (looksLikeJwt(entry.value)) {
          const payload = decodeJwtPayload(entry.value);
          if (payload) {
            const exp = typeof payload.exp === "number" ? payload.exp : null;
            results.push({
              location: "sessionStorage",
              key: entry.key,
              payload,
              expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
              expired: exp !== null && exp < now,
            });
          }
        }
      }
    }
  }

  return results;
}

function analyzeAuth(
  storageState: SessionSnapshot["storageState"],
  sessionStorage?: SessionStorageEntry[]
): { authType: AuthType; estimatedExpiry: string | null } {
  const jwts = findJwts(storageState, sessionStorage);
  const authCookies = storageState.cookies.filter((c) => isAuthCookieName(c.name));

  let nearestExpiry: Date | null = null;

  for (const jwt of jwts) {
    if (jwt.expiresAt) {
      const exp = new Date(jwt.expiresAt);
      if (!nearestExpiry || exp < nearestExpiry) nearestExpiry = exp;
    }
  }

  for (const cookie of authCookies) {
    if (cookie.expires > 0) {
      const exp = new Date(cookie.expires * 1000);
      if (!nearestExpiry || exp < nearestExpiry) nearestExpiry = exp;
    }
  }

  let authType: AuthType = "unknown";
  if (jwts.some((j) => j.location === "localStorage")) authType = "jwt-localStorage";
  else if (jwts.some((j) => j.location === "sessionStorage")) authType = "jwt-sessionStorage";
  else if (authCookies.some((c) => c.name.toLowerCase().includes("oauth"))) authType = "oauth";
  else if (authCookies.length > 0) authType = "cookie";

  return {
    authType,
    estimatedExpiry: nearestExpiry?.toISOString() ?? null,
  };
}

function checkExpired(snapshot: SessionSnapshot): { expired: boolean; details: string } {
  const expiry = snapshot.metadata.estimatedExpiry;
  if (!expiry) return { expired: false, details: "No expiry information available" };

  const expiryDate = new Date(expiry);
  const now = new Date();

  if (expiryDate <= now) {
    const ago = humanizeDuration(now.getTime() - expiryDate.getTime());
    return {
      expired: true,
      details: `Session expired ${ago} ago (at ${expiry}). Re-login recommended.`,
    };
  }

  const remaining = humanizeDuration(expiryDate.getTime() - now.getTime());
  return {
    expired: false,
    details: `Session valid. Expires in ${remaining} (at ${expiry}).`,
  };
}

function humanizeDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveSession(
  context: BrowserContext,
  pages: Map<string, Page>,
  name: unknown,
  options: unknown = {}
): Promise<unknown> {
  const sanitized = sanitizeSessionName(name);
  const opts = (options ?? {}) as SaveOptions;

  const storageState = await context.storageState();

  // Filter by domains if specified
  if (opts.domains?.length) {
    const allowed = new Set(opts.domains.map((d) => d.toLowerCase()));
    storageState.cookies = storageState.cookies.filter((c) =>
      allowed.has(c.domain.replace(/^\./, "").toLowerCase())
    );
    storageState.origins = storageState.origins.filter((o) => {
      try {
        return allowed.has(new URL(o.origin).hostname.toLowerCase());
      } catch {
        return false;
      }
    });
  }

  // Capture sessionStorage
  let sessionStorageData: SessionStorageEntry[] | undefined;
  if (opts.includeSessionStorage !== false) {
    sessionStorageData = await captureSessionStorage(pages);
    if (opts.domains?.length) {
      const allowed = new Set(opts.domains.map((d) => d.toLowerCase()));
      sessionStorageData = sessionStorageData.filter((s) => {
        try {
          return allowed.has(new URL(s.origin).hostname.toLowerCase());
        } catch {
          return false;
        }
      });
    }
  }

  const firstPage = getFirstActivePage(pages);
  const sourceUrl = firstPage ? firstPage.url() : "";

  const authAnalysis =
    opts.analyzeAuth !== false
      ? analyzeAuth(storageState, sessionStorageData)
      : { authType: "unknown" as const, estimatedExpiry: null };

  if (opts.overwrite === false && (await sessionExists(sanitized))) {
    throw new Error(`Session "${sanitized}" already exists. Set overwrite: true to replace.`);
  }

  const now = new Date().toISOString();
  const snapshot: SessionSnapshot = {
    name: sanitized,
    description: opts.description,
    createdAt: now,
    updatedAt: now,
    version: SESSION_VERSION,
    storageState,
    sessionStorage: sessionStorageData,
    metadata: {
      sourceUrl,
      domains: extractDomains(storageState),
      authType: authAnalysis.authType,
      tags: opts.tags ?? [],
      estimatedExpiry: authAnalysis.estimatedExpiry,
      sizeBytes: 0,
    },
  };

  // Preserve createdAt from existing snapshot
  try {
    const existing = await readSnapshot(sanitized);
    snapshot.createdAt = existing.createdAt;
  } catch {
    // new session
  }

  const json = JSON.stringify(snapshot, null, 2);
  snapshot.metadata.sizeBytes = Buffer.byteLength(json, "utf-8");
  const finalJson = JSON.stringify(snapshot, null, 2);

  await ensureSessionsDir();
  await writeFile(getSessionPath(sanitized), finalJson, "utf-8");

  return {
    name: sanitized,
    path: getSessionPath(sanitized),
    sizeBytes: snapshot.metadata.sizeBytes,
    domains: snapshot.metadata.domains,
    cookieCount: storageState.cookies.length,
    localStorageEntries: storageState.origins.reduce((s, o) => s + o.localStorage.length, 0),
    sessionStorageEntries:
      sessionStorageData?.reduce((s, o) => s + o.entries.length, 0) ?? 0,
    estimatedExpiry: authAnalysis.estimatedExpiry,
    authType: authAnalysis.authType,
  };
}

export async function restoreSession(
  context: BrowserContext,
  pages: Map<string, Page>,
  name: unknown,
  options: unknown = {}
): Promise<unknown> {
  const sanitized = sanitizeSessionName(name);
  const opts = (options ?? {}) as RestoreOptions;
  const snapshot = await readSnapshot(sanitized);
  const warnings: string[] = [];

  // Check expiry
  let expired = false;
  if (opts.validateExpiry !== false) {
    const expiryCheck = checkExpired(snapshot);
    expired = expiryCheck.expired;
    if (expired) {
      warnings.push(expiryCheck.details);
    }
  }

  // Clear existing state
  if (opts.clearExisting !== false) {
    await context.clearCookies();
    for (const page of pages.values()) {
      if (page.isClosed()) continue;
      if (!getPageOrigin(page)) continue;
      try {
        await page.evaluate(() => {
          localStorage.clear();
        });
      } catch {
        // restricted origin
      }
    }
  }

  // Restore cookies
  if (snapshot.storageState.cookies.length > 0) {
    await context.addCookies(snapshot.storageState.cookies);
  }

  // Restore localStorage
  let restoredLocalStorage = 0;
  for (const origin of snapshot.storageState.origins) {
    if (origin.localStorage.length === 0) continue;

    const existingPage = findPageForOrigin(pages, origin.origin);
    if (existingPage) {
      try {
        await existingPage.evaluate(
          (entries: Array<{ name: string; value: string }>) => {
            for (const { name, value } of entries) {
              localStorage.setItem(name, value);
            }
          },
          origin.localStorage
        );
        restoredLocalStorage += origin.localStorage.length;
      } catch {
        warnings.push(`Failed to restore localStorage for ${origin.origin}`);
      }
    } else {
      // No page on this origin — create a temp page with a mocked route
      try {
        const dummyUrl = origin.origin + RESTORE_DUMMY_PATH;
        await context.route(dummyUrl, (route) =>
          route.fulfill({ status: 200, contentType: "text/html", body: "" })
        );
        const tempPage = await context.newPage();
        try {
          await tempPage.goto(dummyUrl, { waitUntil: "commit" });
          await tempPage.evaluate(
            (entries: Array<{ name: string; value: string }>) => {
              for (const { name, value } of entries) {
                localStorage.setItem(name, value);
              }
            },
            origin.localStorage
          );
          restoredLocalStorage += origin.localStorage.length;
        } finally {
          await tempPage.close().catch(() => {});
          await context.unroute(dummyUrl).catch(() => {});
        }
      } catch {
        warnings.push(`Failed to restore localStorage for ${origin.origin} (no open page)`);
      }
    }
  }

  // Restore sessionStorage
  let restoredSessionStorage = 0;
  if (snapshot.sessionStorage?.length) {
    for (const ssEntry of snapshot.sessionStorage) {
      if (ssEntry.entries.length === 0) continue;

      let targetPage: Page | undefined;
      if (opts.page) {
        const namedPage = pages.get(opts.page);
        if (namedPage && !namedPage.isClosed() && getPageOrigin(namedPage) === ssEntry.origin) {
          targetPage = namedPage;
        }
      }
      if (!targetPage) {
        targetPage = findPageForOrigin(pages, ssEntry.origin);
      }

      if (targetPage) {
        try {
          await targetPage.evaluate((entries: Array<{ key: string; value: string }>) => {
            sessionStorage.clear();
            for (const { key, value } of entries) {
              sessionStorage.setItem(key, value);
            }
          }, ssEntry.entries);
          restoredSessionStorage += ssEntry.entries.length;
        } catch {
          warnings.push(`Failed to restore sessionStorage for ${ssEntry.origin}`);
        }
      } else {
        warnings.push(
          `Could not restore sessionStorage for ${ssEntry.origin} — no open page on this origin`
        );
      }
    }
  }

  // Navigate to source if requested
  if (opts.navigateToSource && snapshot.metadata.sourceUrl) {
    const targetPage = opts.page ? pages.get(opts.page) : getFirstActivePage(pages);
    if (targetPage && !targetPage.isClosed()) {
      await targetPage.goto(snapshot.metadata.sourceUrl);
    }
  }

  return {
    success: true,
    name: sanitized,
    warnings,
    restored: {
      cookies: snapshot.storageState.cookies.length,
      localStorageEntries: restoredLocalStorage,
      sessionStorageEntries: restoredSessionStorage,
    },
    expired,
    recommendation: expired
      ? `Session "${sanitized}" has expired. Re-login recommended.`
      : undefined,
  };
}

export async function listSessions(options: unknown = {}): Promise<unknown> {
  const opts = (options ?? {}) as ListOptions;
  await ensureSessionsDir();

  let files: string[];
  try {
    files = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const entries: Array<{
    name: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    sizeBytes: number;
    domains: string[];
    tags: string[];
    authType: AuthType;
    expired: boolean;
    estimatedExpiry: string | null;
  }> = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(path.join(SESSIONS_DIR, file), "utf-8");
      const snapshot = JSON.parse(content) as SessionSnapshot;

      if (opts.tags?.length) {
        const hasTags = opts.tags.every((t) => snapshot.metadata.tags.includes(t));
        if (!hasTags) continue;
      }
      if (opts.domain) {
        if (!snapshot.metadata.domains.includes(opts.domain)) continue;
      }

      const expiryCheck =
        opts.checkExpiry !== false ? checkExpired(snapshot) : { expired: false };

      entries.push({
        name: snapshot.name,
        description: snapshot.description,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        sizeBytes: snapshot.metadata.sizeBytes,
        domains: snapshot.metadata.domains,
        tags: snapshot.metadata.tags,
        authType: snapshot.metadata.authType,
        expired: expiryCheck.expired,
        estimatedExpiry: snapshot.metadata.estimatedExpiry,
      });
    } catch {
      // Skip malformed files
    }
  }

  const sortBy = opts.sortBy ?? "name";
  entries.sort((a, b) => {
    switch (sortBy) {
      case "createdAt":
        return b.createdAt.localeCompare(a.createdAt);
      case "updatedAt":
        return b.updatedAt.localeCompare(a.updatedAt);
      case "size":
        return b.sizeBytes - a.sizeBytes;
      default:
        return a.name.localeCompare(b.name);
    }
  });

  return entries;
}

export async function deleteSession(name: unknown): Promise<unknown> {
  const sanitized = sanitizeSessionName(name);
  const filePath = getSessionPath(sanitized);
  try {
    await unlink(filePath);
    return { deleted: true, name: sanitized };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Session "${sanitized}" not found`);
    }
    throw error;
  }
}

export async function inspectSession(name: unknown): Promise<unknown> {
  const sanitized = sanitizeSessionName(name);
  const snapshot = await readSnapshot(sanitized);

  const authCookies = snapshot.storageState.cookies
    .filter((c) => isAuthCookieName(c.name))
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      httpOnly: c.httpOnly,
      secure: c.secure,
      expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session",
      expired: c.expires > 0 && c.expires * 1000 < Date.now(),
      likelyAuth: true,
    }));

  const jwts = findJwts(snapshot.storageState, snapshot.sessionStorage);
  const jwtSummary = jwts.map((j) => ({
    location: j.location,
    key: j.key,
    expiresAt: j.expiresAt,
    expired: j.expired,
    issuer: typeof j.payload.iss === "string" ? j.payload.iss : undefined,
    subject: typeof j.payload.sub === "string" ? j.payload.sub : undefined,
  }));

  const localStorageByOrigin: Record<string, number> = {};
  for (const origin of snapshot.storageState.origins) {
    localStorageByOrigin[origin.origin] = origin.localStorage.length;
  }

  const sessionStorageByOrigin: Record<string, number> = {};
  if (snapshot.sessionStorage) {
    for (const entry of snapshot.sessionStorage) {
      sessionStorageByOrigin[entry.origin] = entry.entries.length;
    }
  }

  const expiryCheck = checkExpired(snapshot);

  return {
    snapshot: {
      name: snapshot.name,
      description: snapshot.description,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      version: snapshot.version,
      metadata: snapshot.metadata,
    },
    summary: {
      totalCookies: snapshot.storageState.cookies.length,
      authCookies,
      localStorageByOrigin,
      sessionStorageByOrigin,
      jwtTokens: jwtSummary,
      expired: expiryCheck.expired,
      expiryDetails: expiryCheck.details,
    },
  };
}
