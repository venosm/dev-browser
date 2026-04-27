import { describe, expect, it, vi } from "vitest";

import {
  detectState,
  stealthLaunchArgs,
  waitForPass,
} from "./cloudflare-manager.js";
import type { NetworkLogEntry } from "./network-manager.js";

interface FakePageDom {
  hasInterstitial: boolean;
  hasTurnstile: boolean;
  hasManagedChallenge: boolean;
  hasErrorPage: boolean;
  errorCode: string | null;
  title: string;
}

function makePage(dom: Partial<FakePageDom> & { url?: string } = {}): {
  page: Parameters<typeof detectState>[0];
} {
  const result: FakePageDom = {
    hasInterstitial: false,
    hasTurnstile: false,
    hasManagedChallenge: false,
    hasErrorPage: false,
    errorCode: null,
    title: "Hello",
    ...dom,
  };
  const page = {
    evaluate: vi.fn().mockResolvedValue(result),
    url: () => dom.url ?? "https://example.com/",
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
  return { page: page as unknown as Parameters<typeof detectState>[0] };
}

function makeLog(partial: Partial<NetworkLogEntry>[] = []): NetworkLogEntry[] {
  return partial.map((p) => ({
    url: "https://example.com/",
    method: "GET",
    status: 200,
    mocked: false,
    duration: 1,
    timestamp: Date.now(),
    resourceType: "document",
    requestHeaders: {},
    responseHeaders: {},
    ...p,
  }));
}

describe("cloudflare detectState", () => {
  it("returns kind=none for a clean page", async () => {
    const { page } = makePage();
    const detection = await detectState(page);
    expect(detection.kind).toBe("none");
    expect(detection.fromDom).toBe(false);
    expect(detection.fromHeaders).toBe(false);
  });

  it("classifies a JS interstitial", async () => {
    const { page } = makePage({ hasInterstitial: true, title: "Just a moment..." });
    const detection = await detectState(page);
    expect(detection.kind).toBe("interstitial");
    expect(detection.fromDom).toBe(true);
    expect(detection.notes.join(" ")).toMatch(/self-resolves/);
  });

  it("classifies turnstile widget", async () => {
    const { page } = makePage({ hasTurnstile: true });
    const detection = await detectState(page);
    expect(detection.kind).toBe("turnstile");
  });

  it("classifies managed challenge", async () => {
    const { page } = makePage({ hasManagedChallenge: true, hasInterstitial: true });
    const detection = await detectState(page);
    expect(detection.kind).toBe("managed-challenge");
  });

  it("classifies 1015 rate limit error", async () => {
    const { page } = makePage({ hasErrorPage: true, errorCode: "1015" });
    const detection = await detectState(page);
    expect(detection.kind).toBe("blocked-1015");
  });

  it("captures cf-ray and challenge URLs from the network log", async () => {
    const { page } = makePage({ url: "https://target.example.com/" });
    const log = makeLog([
      {
        url: "https://target.example.com/",
        responseHeaders: { "cf-ray": "abc123-FRA" },
      },
      {
        url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/scripts/main.js",
      },
    ]);
    const detection = await detectState(page, { networkLog: log });
    expect(detection.rayId).toBe("abc123-FRA");
    expect(detection.fromHeaders).toBe(true);
    expect(detection.fromNetwork).toBe(true);
    expect(detection.challengeUrls).toHaveLength(1);
  });
});

describe("cloudflare waitForPass", () => {
  it("returns immediately when page is clean", async () => {
    const { page } = makePage();
    const result = await waitForPass(page, { timeoutMs: 100, pollIntervalMs: 10 });
    expect(result.passed).toBe(true);
    expect(result.finalKind).toBe("none");
  });

  it("does not wait on turnstile (returns failed quickly)", async () => {
    const { page } = makePage({ hasTurnstile: true });
    const result = await waitForPass(page, { timeoutMs: 200, pollIntervalMs: 10 });
    expect(result.passed).toBe(false);
    expect(result.finalKind).toBe("turnstile");
  });

  it("returns immediately on 1015 block", async () => {
    const { page } = makePage({ hasErrorPage: true, errorCode: "1015" });
    const result = await waitForPass(page, { timeoutMs: 500, pollIntervalMs: 10 });
    expect(result.passed).toBe(false);
    expect(result.finalKind).toBe("blocked-1015");
  });
});

describe("cloudflare stealthLaunchArgs", () => {
  it("returns sensible default args and a real Chromium UA", () => {
    const result = stealthLaunchArgs();
    expect(result.args).toContain("--disable-blink-features=AutomationControlled");
    expect(result.userAgent).toMatch(/Chrome\/\d+/);
    expect(result.userAgent).not.toMatch(/HeadlessChrome|chrome-headless-shell/i);
  });

  it("adds --headless=new when newHeadless is set", () => {
    const result = stealthLaunchArgs({ newHeadless: true });
    expect(result.args).toContain("--headless=new");
  });

  it("respects custom user agent", () => {
    const result = stealthLaunchArgs({ userAgent: "MyBot/1.0" });
    expect(result.userAgent).toBe("MyBot/1.0");
  });
});
