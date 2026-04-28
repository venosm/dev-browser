import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";

import { getDevBrowserBaseDir } from "./local-endpoint.js";
import type { NetworkLogEntry } from "./network-manager.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CloudflareKind =
  | "none"
  | "interstitial"
  | "turnstile"
  | "managed-challenge"
  | "blocked-1015"
  | "blocked-other";

export interface CloudflareDetection {
  kind: CloudflareKind;
  rayId: string | null;
  fromHeaders: boolean;
  fromDom: boolean;
  fromNetwork: boolean;
  challengeUrls: string[];
  notes: string[];
}

export interface CloudflareWaitResult {
  passed: boolean;
  finalKind: CloudflareKind;
  elapsedMs: number;
  detection: CloudflareDetection;
}

export interface CloudflareClearance {
  domain: string;
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
  capturedAt: string;
}

const CLEARANCE_DIR = path.join(getDevBrowserBaseDir(), "cloudflare");
const CF_COOKIE_NAMES = new Set(["cf_clearance", "__cf_bm", "__cflb"]);

// ── DOM detection ─────────────────────────────────────────────────────────────

async function inspectDom(page: Page): Promise<{
  hasInterstitial: boolean;
  hasTurnstile: boolean;
  hasManagedChallenge: boolean;
  hasErrorPage: boolean;
  errorCode: string | null;
  title: string;
}> {
  try {
    return await page.evaluate(() => {
      const title = document.title || "";
      const lowerTitle = title.toLowerCase();
      const bodyText = document.body?.innerText?.slice(0, 4000) ?? "";
      const lowerBody = bodyText.toLowerCase();

      const interstitialMarkers = [
        "#cf-please-wait",
        "#cf-spinner-please-wait",
        "#challenge-running",
        "#cf-challenge-stage",
      ];
      const hasInterstitial =
        interstitialMarkers.some((sel) => !!document.querySelector(sel)) ||
        lowerTitle.includes("just a moment") ||
        lowerTitle.includes("attention required");

      const hasTurnstile =
        !!document.querySelector(
          'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]',
        ) || !!document.querySelector(".cf-turnstile, [data-sitekey]");

      const hasManagedChallenge =
        !!document.querySelector("#challenge-form") ||
        !!document.querySelector('form[action*="/cdn-cgi/challenge"]');

      const errorMatch = bodyText.match(/Error\s*(\d{3,4})/i);
      const errorCode = errorMatch ? errorMatch[1]! : null;
      const hasErrorPage =
        !!errorCode &&
        (lowerBody.includes("cloudflare") ||
          !!document.querySelector(".cf-error-details, #cf-error-details"));

      return {
        hasInterstitial,
        hasTurnstile,
        hasManagedChallenge,
        hasErrorPage,
        errorCode,
        title,
      };
    });
  } catch {
    return {
      hasInterstitial: false,
      hasTurnstile: false,
      hasManagedChallenge: false,
      hasErrorPage: false,
      errorCode: null,
      title: "",
    };
  }
}

// ── Network signal helpers ────────────────────────────────────────────────────

function findRayIdInLog(log: readonly NetworkLogEntry[], pageUrl: string): string | null {
  let pageOrigin = "";
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    /* ignore */
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!;
    if (pageOrigin && !entry.url.startsWith(pageOrigin)) continue;
    const ray = entry.responseHeaders["cf-ray"];
    if (ray) return ray;
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const ray = log[i]!.responseHeaders["cf-ray"];
    if (ray) return ray;
  }
  return null;
}

function findChallengeUrls(log: readonly NetworkLogEntry[]): string[] {
  const urls: string[] = [];
  for (const entry of log) {
    if (
      entry.url.includes("/cdn-cgi/challenge-platform/") ||
      entry.url.includes("challenges.cloudflare.com")
    ) {
      urls.push(entry.url);
    }
  }
  return urls;
}

// ── Public detection ──────────────────────────────────────────────────────────

export interface DetectOptions {
  networkLog?: readonly NetworkLogEntry[];
}

export async function detectState(
  page: Page,
  options: DetectOptions = {},
): Promise<CloudflareDetection> {
  const dom = await inspectDom(page);
  const log = options.networkLog ?? [];
  const rayId = findRayIdInLog(log, page.url());
  const challengeUrls = findChallengeUrls(log);
  const notes: string[] = [];

  let kind: CloudflareKind = "none";
  if (dom.hasErrorPage && dom.errorCode === "1015") {
    kind = "blocked-1015";
    notes.push("Cloudflare rate-limit (1015) — try again later or use different IP");
  } else if (dom.hasErrorPage) {
    kind = "blocked-other";
    notes.push(`Cloudflare error page (code=${dom.errorCode ?? "?"})`);
  } else if (dom.hasManagedChallenge) {
    kind = "managed-challenge";
    notes.push("Managed challenge form present — may need human interaction");
  } else if (dom.hasTurnstile) {
    kind = "turnstile";
    notes.push("Turnstile widget detected — needs real click or auto-pass");
  } else if (dom.hasInterstitial) {
    kind = "interstitial";
    notes.push("JS interstitial — usually self-resolves in 5-10s");
  } else if (challengeUrls.length > 0 && rayId) {
    notes.push("CF challenge resources requested but no DOM markers — likely passed");
  }

  return {
    kind,
    rayId,
    fromHeaders: !!rayId,
    fromDom:
      dom.hasInterstitial || dom.hasTurnstile || dom.hasManagedChallenge || dom.hasErrorPage,
    fromNetwork: challengeUrls.length > 0,
    challengeUrls,
    notes,
  };
}

// ── Wait helpers ──────────────────────────────────────────────────────────────

export interface WaitForPassOptions extends DetectOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function waitForPass(
  page: Page,
  options: WaitForPassOptions = {},
): Promise<CloudflareWaitResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const start = Date.now();
  let detection = await detectState(page, { networkLog: options.networkLog });

  while (Date.now() - start < timeoutMs) {
    if (detection.kind === "none") {
      return {
        passed: true,
        finalKind: "none",
        elapsedMs: Date.now() - start,
        detection,
      };
    }
    if (detection.kind === "blocked-1015" || detection.kind === "blocked-other") {
      return {
        passed: false,
        finalKind: detection.kind,
        elapsedMs: Date.now() - start,
        detection,
      };
    }
    if (detection.kind === "turnstile" || detection.kind === "managed-challenge") {
      // These need manual / fingerprint-level intervention. waitForPass should not block on them.
      return {
        passed: false,
        finalKind: detection.kind,
        elapsedMs: Date.now() - start,
        detection,
      };
    }

    await page.waitForTimeout(pollIntervalMs);
    detection = await detectState(page, { networkLog: options.networkLog });
  }

  return {
    passed: detection.kind === "none",
    finalKind: detection.kind,
    elapsedMs: Date.now() - start,
    detection,
  };
}

export interface WaitForSolveOptions extends DetectOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function waitForSolve(
  page: Page,
  options: WaitForSolveOptions = {},
): Promise<CloudflareWaitResult> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const start = Date.now();
  let detection = await detectState(page, { networkLog: options.networkLog });

  while (Date.now() - start < timeoutMs) {
    if (
      detection.kind === "none" ||
      (detection.kind !== "turnstile" &&
        detection.kind !== "managed-challenge" &&
        detection.kind !== "interstitial")
    ) {
      return {
        passed: detection.kind === "none",
        finalKind: detection.kind,
        elapsedMs: Date.now() - start,
        detection,
      };
    }
    await page.waitForTimeout(pollIntervalMs);
    detection = await detectState(page, { networkLog: options.networkLog });
  }

  return {
    passed: detection.kind === "none",
    finalKind: detection.kind,
    elapsedMs: Date.now() - start,
    detection,
  };
}

// ── Clearance cookie persistence ──────────────────────────────────────────────

function clearancePathFor(domain: string): string {
  const safe = domain.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(CLEARANCE_DIR, `${safe}.json`);
}

function matchesDomain(cookieDomain: string, target: string): boolean {
  const c = cookieDomain.replace(/^\./, "").toLowerCase();
  const t = target.replace(/^\./, "").toLowerCase();
  return c === t || t.endsWith("." + c) || c.endsWith("." + t);
}

export async function saveClearance(
  context: BrowserContext,
  domain: string,
): Promise<CloudflareClearance> {
  const allCookies = await context.cookies();
  const cookies = allCookies
    .filter((c) => CF_COOKIE_NAMES.has(c.name) && matchesDomain(c.domain, domain))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));

  const clearance: CloudflareClearance = {
    domain,
    cookies,
    capturedAt: new Date().toISOString(),
  };
  await mkdir(CLEARANCE_DIR, { recursive: true });
  await writeFile(clearancePathFor(domain), JSON.stringify(clearance, null, 2), "utf-8");
  return clearance;
}

export async function restoreClearance(
  context: BrowserContext,
  domain: string,
): Promise<{ restored: number; expired: number } | null> {
  let raw: string;
  try {
    raw = await readFile(clearancePathFor(domain), "utf-8");
  } catch {
    return null;
  }
  const clearance = JSON.parse(raw) as CloudflareClearance;
  const nowSec = Date.now() / 1000;
  const fresh = clearance.cookies.filter((c) => c.expires <= 0 || c.expires > nowSec);
  const expired = clearance.cookies.length - fresh.length;
  if (fresh.length > 0) {
    await context.addCookies(fresh);
  }
  return { restored: fresh.length, expired };
}

// ── Stealth launch args ───────────────────────────────────────────────────────

export interface StealthLaunchOptions {
  /** Override the user agent. Defaults to a real Chromium UA. */
  userAgent?: string;
  /** Use new headless mode (--headless=new) instead of headless-shell. */
  newHeadless?: boolean;
}

const DEFAULT_STEALTH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.182 Safari/537.36";

export function stealthLaunchArgs(options: StealthLaunchOptions = {}): {
  args: string[];
  userAgent: string;
  channel?: string;
} {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process,Translate",
    "--disable-site-isolation-trials",
    "--no-default-browser-check",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
  ];
  if (options.newHeadless) {
    args.push("--headless=new");
  }
  return {
    args,
    userAgent: options.userAgent ?? DEFAULT_STEALTH_UA,
  };
}

/**
 * Page-side init script that mirrors the core evasions from `playwright-stealth`:
 *   - hides `navigator.webdriver`
 *   - populates `navigator.plugins` and `navigator.mimeTypes`
 *   - sets a realistic `navigator.languages`
 *   - stubs `window.chrome.runtime`
 *   - patches `permissions.query` to behave like a real Chrome (notifications)
 *   - rewrites WebGL UNMASKED_VENDOR/RENDERER strings
 *
 * Apply with `context.addInitScript(stealthInitScript())` so it runs before any
 * page JS executes — including Cloudflare's Turnstile fingerprint script.
 */
export function stealthInitScript(): string {
  return `
    (() => {
      try {
        Object.defineProperty(Navigator.prototype, "webdriver", {
          get: () => undefined,
          configurable: true,
        });
      } catch {}

      try {
        const fakePlugin = (name, filename, description) => ({
          name,
          filename,
          description,
          length: 1,
          item: () => null,
          namedItem: () => null,
        });
        const plugins = [
          fakePlugin("Chrome PDF Plugin", "internal-pdf-viewer", "Portable Document Format"),
          fakePlugin("Chrome PDF Viewer", "mhjfbmdgcfjbbpaeojofohoefgiehjai", ""),
          fakePlugin("Native Client", "internal-nacl-plugin", ""),
        ];
        Object.defineProperty(Navigator.prototype, "plugins", {
          get: () => plugins,
          configurable: true,
        });
        Object.defineProperty(Navigator.prototype, "mimeTypes", {
          get: () => [{ type: "application/pdf", suffixes: "pdf", description: "PDF" }],
          configurable: true,
        });
      } catch {}

      try {
        Object.defineProperty(Navigator.prototype, "languages", {
          get: () => ["en-US", "en"],
          configurable: true,
        });
      } catch {}

      try {
        if (!window.chrome) {
          window.chrome = {};
        }
        if (!window.chrome.runtime) {
          window.chrome.runtime = {
            PlatformOs: { MAC: "mac", WIN: "win", LINUX: "linux" },
            connect: () => {},
            sendMessage: () => {},
          };
        }
      } catch {}

      try {
        const origQuery = Navigator.prototype.permissions
          ? null
          : null;
        if (navigator.permissions && navigator.permissions.query) {
          const realQuery = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (parameters) => {
            if (parameters && parameters.name === "notifications") {
              return Promise.resolve({ state: Notification.permission, onchange: null });
            }
            return realQuery(parameters);
          };
        }
        void origQuery;
      } catch {}

      try {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (parameter) {
          if (parameter === 37445) return "Intel Inc.";
          if (parameter === 37446) return "Intel Iris OpenGL Engine";
          return getParameter.call(this, parameter);
        };
      } catch {}

      try {
        Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
          get: () => 8,
          configurable: true,
        });
        Object.defineProperty(Navigator.prototype, "deviceMemory", {
          get: () => 8,
          configurable: true,
        });
      } catch {}
    })();
  `;
}
