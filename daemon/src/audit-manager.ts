import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Page } from "playwright";

const _require = createRequire(import.meta.url);

let _axeSource: string | undefined;

async function getAxeSource(): Promise<string> {
  if (_axeSource) return _axeSource;
  const axePath = _require.resolve("axe-core/axe.min.js");
  _axeSource = await readFile(axePath, "utf8");
  return _axeSource;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface AccessibilityOptions {
  /** CSS selector to limit the audit scope */
  context?: string;
  /** axe-core rule tags to run — defaults to ["wcag2a", "wcag2aa", "best-practice"] */
  tags?: string[];
  /** Rule IDs to disable */
  disabledRules?: string[];
}

export interface AccessibilityViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: { html: string; target: string[]; failureSummary: string }[];
}

export interface AccessibilityReport {
  url: string;
  violations: AccessibilityViolation[];
  passes: number;
  incomplete: number;
  summary: string;
  score: number; // 0–100 (100 = no violations)
}

export interface PerformanceOptions {
  /** Wait for this many ms after load before sampling metrics */
  settleMs?: number;
}

export interface PerformanceCoreWebVitals {
  /** Largest Contentful Paint (ms) — good < 2500, needs improvement < 4000 */
  lcp: number | null;
  /** First Input Delay (ms) — good < 100, needs improvement < 300 */
  fid: number | null;
  /** Cumulative Layout Shift (unitless) — good < 0.1, needs improvement < 0.25 */
  cls: number | null;
  /** First Contentful Paint (ms) — good < 1800 */
  fcp: number | null;
  /** Time to First Byte (ms) */
  ttfb: number | null;
  /** Total Blocking Time (ms) */
  tbt: number | null;
  /** DOM Interactive (ms) */
  domInteractive: number | null;
  /** DOM Content Loaded (ms) */
  domContentLoaded: number | null;
  /** Load complete (ms) */
  loadComplete: number | null;
  /** Total transfer size of all resources (bytes) */
  transferSize: number;
  /** Number of resources loaded */
  resourceCount: number;
}

export interface PerformanceReport {
  url: string;
  metrics: PerformanceCoreWebVitals;
  summary: string;
  ratings: { lcp: string; fid: string; cls: string; fcp: string };
}

export interface FullAuditReport {
  url: string;
  accessibility: AccessibilityReport;
  performance: PerformanceReport;
  summary: string;
}

// ── Accessibility ─────────────────────────────────────────────────────────────

export async function auditAccessibility(
  page: Page,
  options: AccessibilityOptions = {}
): Promise<AccessibilityReport> {
  const axeSource = await getAxeSource();
  const url = page.url();

  await page.evaluate(axeSource);

  const tags = options.tags ?? ["wcag2a", "wcag2aa", "best-practice"];
  const disabledRules = options.disabledRules ?? [];

  const raw = await page.evaluate(
    ({ context, tags, disabledRules }) => {
      return (window as unknown as { axe: { run: (...a: unknown[]) => Promise<unknown> } }).axe.run(
        context ? document.querySelector(context) ?? document : document,
        {
          runOnly: { type: "tag", values: tags },
          rules: Object.fromEntries(disabledRules.map((id: string) => [id, { enabled: false }])),
        }
      );
    },
    { context: options.context, tags, disabledRules }
  );

  type AxeResult = {
    violations: {
      id: string;
      impact: AccessibilityViolation["impact"];
      description: string;
      help: string;
      helpUrl: string;
      nodes: { html: string; target: string[]; failureSummary: string }[];
    }[];
    passes: { id: string }[];
    incomplete: { id: string }[];
  };

  const result = raw as AxeResult;
  const violations: AccessibilityViolation[] = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({
      html: n.html,
      target: n.target,
      failureSummary: n.failureSummary,
    })),
  }));

  const criticalCount = violations.filter((v) => v.impact === "critical").length;
  const seriousCount = violations.filter((v) => v.impact === "serious").length;
  const totalNodes = violations.reduce((n, v) => n + v.nodes.length, 0);

  // Score: deduct points for violations by severity
  const score = Math.max(
    0,
    100 - criticalCount * 20 - seriousCount * 10 - violations.length * 2
  );

  const summary =
    violations.length === 0
      ? `No accessibility violations found (${result.passes.length} rules passed)`
      : [
          `${violations.length} violation(s) affecting ${totalNodes} element(s)`,
          criticalCount ? `${criticalCount} critical` : "",
          seriousCount ? `${seriousCount} serious` : "",
          `Score: ${score}/100`,
        ]
          .filter(Boolean)
          .join(" — ");

  return {
    url,
    violations,
    passes: result.passes.length,
    incomplete: result.incomplete.length,
    summary,
    score,
  };
}

// ── Performance ───────────────────────────────────────────────────────────────

export async function auditPerformance(
  page: Page,
  options: PerformanceOptions = {}
): Promise<PerformanceReport> {
  const url = page.url();
  if (options.settleMs) {
    await new Promise((r) => setTimeout(r, options.settleMs));
  }

  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType("paint");
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];

    const fcpEntry = paint.find((p) => p.name === "first-contentful-paint");

    // LCP via PerformanceObserver buffer (available after page load)
    let lcp: number | null = null;
    try {
      const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
      if (lcpEntries.length > 0) {
        lcp = lcpEntries[lcpEntries.length - 1]!.startTime;
      }
    } catch {
      // not supported
    }

    // CLS
    let cls: number | null = null;
    try {
      const clsEntries = performance.getEntriesByType("layout-shift");
      if (clsEntries.length > 0) {
        cls = (clsEntries as unknown as { value: number }[]).reduce((s, e) => s + e.value, 0);
      }
    } catch {
      // not supported
    }

    // TBT (sum of long task excess over 50ms)
    let tbt: number | null = null;
    try {
      const tasks = performance.getEntriesByType("longtask") as PerformanceEntry[];
      if (tasks) {
        tbt = tasks.reduce((s, t) => s + Math.max(0, t.duration - 50), 0);
      }
    } catch {
      // not supported
    }

    const transferSize = resources.reduce((s, r) => s + (r.transferSize ?? 0), 0);

    return {
      lcp,
      fid: null as number | null, // FID requires real user interaction
      cls,
      fcp: fcpEntry?.startTime ?? null,
      ttfb: nav ? nav.responseStart - nav.requestStart : null,
      tbt,
      domInteractive: nav?.domInteractive ?? null,
      domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
      loadComplete: nav?.loadEventEnd ?? null,
      transferSize,
      resourceCount: resources.length,
    };
  });

  function rate(value: number | null, good: number, poor: number): string {
    if (value === null) return "n/a";
    if (value <= good) return "good";
    if (value <= poor) return "needs-improvement";
    return "poor";
  }

  const ratings = {
    lcp: rate(metrics.lcp, 2500, 4000),
    fid: "n/a",
    cls: rate(metrics.cls, 0.1, 0.25),
    fcp: rate(metrics.fcp, 1800, 3000),
  };

  const lines: string[] = [];
  if (metrics.lcp !== null) lines.push(`LCP ${metrics.lcp.toFixed(0)}ms (${ratings.lcp})`);
  if (metrics.fcp !== null) lines.push(`FCP ${metrics.fcp.toFixed(0)}ms (${ratings.fcp})`);
  if (metrics.cls !== null) lines.push(`CLS ${metrics.cls.toFixed(3)} (${ratings.cls})`);
  if (metrics.ttfb !== null) lines.push(`TTFB ${metrics.ttfb.toFixed(0)}ms`);
  if (metrics.tbt !== null) lines.push(`TBT ${metrics.tbt.toFixed(0)}ms`);
  lines.push(
    `${metrics.resourceCount} resources, ${(metrics.transferSize / 1024).toFixed(0)} KB transferred`
  );

  return {
    url,
    metrics,
    summary: lines.join(" | "),
    ratings,
  };
}

// ── Full audit ────────────────────────────────────────────────────────────────

export async function auditFull(
  page: Page,
  options: AccessibilityOptions & PerformanceOptions = {}
): Promise<FullAuditReport> {
  const [accessibility, performance] = await Promise.all([
    auditAccessibility(page, options),
    auditPerformance(page, options),
  ]);

  const summary = [
    `Accessibility: ${accessibility.summary}`,
    `Performance: ${performance.summary}`,
  ].join("\n");

  return { url: page.url(), accessibility, performance, summary };
}
