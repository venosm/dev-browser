import type { BrowserContext, Page } from "playwright";
import type { NetworkLogEntry } from "./network-manager.js";

// ── Request replay ────────────────────────────────────────────────────────────

export interface ReplayModifications {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  removeHeaders?: string[];
  body?: string;
}

export interface ReplayResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  duration: number;
  originalUrl: string;
  finalUrl: string;
}

export async function replayRequest(
  context: BrowserContext,
  logEntry: NetworkLogEntry,
  modifications: ReplayModifications = {}
): Promise<ReplayResult> {
  const method = (modifications.method ?? logEntry.method).toUpperCase();
  const url = modifications.url ?? logEntry.url;

  const headers: Record<string, string> = { ...logEntry.requestHeaders };
  if (modifications.removeHeaders) {
    for (const name of modifications.removeHeaders) {
      delete headers[name.toLowerCase()];
    }
  }
  if (modifications.headers) {
    for (const [name, value] of Object.entries(modifications.headers)) {
      headers[name.toLowerCase()] = value;
    }
  }

  // Headers set by the browser automatically and rejected by Playwright request API
  delete headers["content-length"];
  delete headers["host"];
  delete headers[":authority"];
  delete headers[":method"];
  delete headers[":path"];
  delete headers[":scheme"];

  const body = modifications.body ?? logEntry.requestBody;

  const start = Date.now();
  const response = await context.request.fetch(url, {
    method,
    headers,
    data: body,
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  const duration = Date.now() - start;

  const responseHeaders = response.headers();
  let text = "";
  try {
    text = await response.text();
  } catch {
    // best effort
  }

  return {
    status: response.status(),
    headers: responseHeaders,
    body: text,
    duration,
    originalUrl: logEntry.url,
    finalUrl: url,
  };
}

// ── Certificate inspection ────────────────────────────────────────────────────

export interface CertificateInfo {
  url: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  protocol?: string;
  cipher?: string;
  keyExchange?: string;
  subjectAltNames: string[];
  isExpired: boolean;
  isSelfSigned: boolean;
  isValidating?: boolean;
}

interface CdpSecurityState {
  securityState?: string;
  explanations?: Array<{
    securityState?: string;
    title?: string;
    summary?: string;
    description?: string;
    certificate?: string[];
  }>;
}

export async function inspectCertificate(
  context: BrowserContext,
  page: Page
): Promise<CertificateInfo> {
  const url = page.url();
  if (!url.startsWith("https://")) {
    throw new Error(`inspectCertificate: only https:// URLs supported, got ${url}`);
  }

  const session = await context.newCDPSession(page);
  try {
    await session.send("Security.enable");
    await session.send("Network.enable");

    // Capture a Security.securityStateChanged event by navigating the current page.
    const securityInfo = await new Promise<CdpSecurityState>((resolve) => {
      let resolved = false;
      const listener = (payload: unknown) => {
        if (resolved) return;
        resolved = true;
        resolve(payload as CdpSecurityState);
      };
      session.on("Security.securityStateChanged", listener);
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({});
        }
      }, 2_000);
      void page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    });

    const explanation = securityInfo.explanations?.find((e) => Array.isArray(e.certificate));
    const certLines = explanation?.certificate ?? [];
    const certText = certLines.join("\n");

    // Extract basic fields from the human-readable description
    const description = explanation?.description ?? "";
    const subjectMatch = /Subject:\s*(.+)/i.exec(description);
    const issuerMatch = /Issuer:\s*(.+)/i.exec(description);
    const validFromMatch = /Valid From:\s*(.+)/i.exec(description);
    const validToMatch = /Valid To:\s*(.+)/i.exec(description);
    const sanMatch = /Subject Alternative Names?:\s*([^\n]+)/i.exec(description);

    const validFrom = validFromMatch?.[1]?.trim() ?? "";
    const validTo = validToMatch?.[1]?.trim() ?? "";
    const validToDate = validTo ? new Date(validTo) : null;
    const isExpired = validToDate ? validToDate.getTime() < Date.now() : false;

    const subject = subjectMatch?.[1]?.trim() ?? certText.split("\n")[0] ?? "";
    const issuer = issuerMatch?.[1]?.trim() ?? "";
    const isSelfSigned = subject.length > 0 && subject === issuer;

    const subjectAltNames = sanMatch?.[1]
      ? sanMatch[1].split(/[,\s]+/).filter((n) => n.length > 0)
      : [];

    return {
      url,
      subject,
      issuer,
      validFrom,
      validTo,
      protocol: undefined,
      cipher: undefined,
      keyExchange: undefined,
      subjectAltNames,
      isExpired,
      isSelfSigned,
      isValidating: securityInfo.securityState === "secure",
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

// ── XSS detection ─────────────────────────────────────────────────────────────

export interface XSSOptions {
  inputs?: string[];
  payloads?: string[];
  checkReflected?: boolean;
  timeoutMs?: number;
}

export interface XSSVulnerability {
  input: string;
  payload: string;
  type: "reflected" | "dialog" | "dom";
  evidence: string;
}

export interface XSSReport {
  url: string;
  safe: boolean;
  vulnerabilities: XSSVulnerability[];
  summary: string;
}

const DEFAULT_XSS_PAYLOADS = [
  `<script>/*dvbrw-xss-canary*/</script>`,
  `"><svg/onload=alert('dvbrw-xss')>`,
  `'><img src=x onerror=alert('dvbrw-xss')>`,
  `javascript:alert('dvbrw-xss')`,
  `<iframe src="javascript:alert('dvbrw-xss')">`,
];

export async function detectXSS(page: Page, options: XSSOptions = {}): Promise<XSSReport> {
  const url = page.url();
  const payloads = options.payloads ?? DEFAULT_XSS_PAYLOADS;
  const checkReflected = options.checkReflected ?? true;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const vulnerabilities: XSSVulnerability[] = [];

  // Listen for dialog events — if any payload triggers one, flag it.
  const dialogsCaught: string[] = [];
  const dialogHandler = async (dialog: { message(): string; dismiss(): Promise<void> }) => {
    dialogsCaught.push(dialog.message());
    await dialog.dismiss().catch(() => undefined);
  };
  page.on("dialog", dialogHandler);

  try {
    // Discover inputs if not provided
    const inputSelectors =
      options.inputs ??
      (await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("input, textarea"));
        return all
          .map((el, i) => {
            const input = el as HTMLInputElement;
            const type = (input.type ?? "").toLowerCase();
            if (type === "hidden" || type === "submit" || type === "button") return null;
            if (input.id) return `#${CSS.escape(input.id)}`;
            if (input.name) return `[name="${input.name}"]`;
            return `${input.tagName.toLowerCase()}:nth-of-type(${i + 1})`;
          })
          .filter((s): s is string => s !== null);
      }));

    for (const selector of inputSelectors) {
      for (const payload of payloads) {
        try {
          const locator = page.locator(selector).first();
          if ((await locator.count()) === 0) continue;

          await locator.fill(payload, { timeout: 1_000 }).catch(() => undefined);
          await locator.press("Enter", { timeout: 1_000 }).catch(() => undefined);

          await new Promise((r) => setTimeout(r, 250));

          if (dialogsCaught.length > 0) {
            vulnerabilities.push({
              input: selector,
              payload,
              type: "dialog",
              evidence: `dialog fired: ${dialogsCaught.join(", ")}`,
            });
            dialogsCaught.length = 0;
            continue;
          }

          if (checkReflected) {
            const html = await page.content();
            if (html.includes(payload)) {
              // Reflected unescaped
              vulnerabilities.push({
                input: selector,
                payload,
                type: "reflected",
                evidence: "payload reflected unescaped in response body",
              });
            } else if (
              payload.includes("dvbrw-xss-canary") &&
              html.includes("dvbrw-xss-canary")
            ) {
              vulnerabilities.push({
                input: selector,
                payload,
                type: "reflected",
                evidence: "canary token found in DOM",
              });
            }
          }
        } catch {
          // Best effort per input/payload combination
        }
      }
    }

    // Also check DOM XSS sinks via simple heuristics
    const domSinks = await page.evaluate(() => {
      const sinks: string[] = [];
      const hash = location.hash;
      const search = location.search;
      const html = document.documentElement.outerHTML;
      if (hash.length > 1 && html.includes(hash.slice(1))) sinks.push("location.hash reflected in DOM");
      if (search.length > 1 && html.includes(search.slice(1))) sinks.push("location.search reflected in DOM");
      return sinks;
    });
    for (const sink of domSinks) {
      vulnerabilities.push({
        input: "location",
        payload: "(url parameter)",
        type: "dom",
        evidence: sink,
      });
    }
  } finally {
    page.off("dialog", dialogHandler);
  }

  const safe = vulnerabilities.length === 0;
  const summary = safe
    ? `No XSS vulnerabilities detected across ${payloads.length} payloads`
    : `${vulnerabilities.length} potential XSS finding(s) — ${vulnerabilities.map((v) => v.type).join(", ")}`;

  return { url, safe, vulnerabilities, summary };
  void timeoutMs;
}

// ── CSRF tokens ───────────────────────────────────────────────────────────────

export interface CsrfTokenInfo {
  source: "meta" | "input" | "cookie" | "header";
  name: string;
  value: string;
  location: string;
}

export async function extractCSRFTokens(page: Page): Promise<CsrfTokenInfo[]> {
  const tokens: CsrfTokenInfo[] = [];

  // Meta tags
  const metaTokens = await page.evaluate(() => {
    const results: Array<{ name: string; value: string }> = [];
    const metas = Array.from(document.querySelectorAll("meta"));
    for (const meta of metas) {
      const name = (meta.getAttribute("name") ?? "").toLowerCase();
      const content = meta.getAttribute("content") ?? "";
      if (/csrf|xsrf|token/i.test(name) && content.length > 0) {
        results.push({ name, value: content });
      }
    }
    return results;
  });
  for (const t of metaTokens) {
    tokens.push({ source: "meta", name: t.name, value: t.value, location: `<meta name="${t.name}">` });
  }

  // Hidden inputs
  const inputTokens = await page.evaluate(() => {
    const results: Array<{ name: string; value: string; formAction: string }> = [];
    const inputs = Array.from(document.querySelectorAll('input[type="hidden"]'));
    for (const input of inputs) {
      const el = input as HTMLInputElement;
      const name = (el.name ?? "").toLowerCase();
      if (/csrf|xsrf|authenticity|nonce|_token/i.test(name) && el.value.length > 0) {
        results.push({
          name: el.name,
          value: el.value,
          formAction: el.form?.action ?? "",
        });
      }
    }
    return results;
  });
  for (const t of inputTokens) {
    tokens.push({
      source: "input",
      name: t.name,
      value: t.value,
      location: `hidden input (form action: ${t.formAction})`,
    });
  }

  // Cookies
  const cookies = await page.context().cookies();
  for (const cookie of cookies) {
    if (/csrf|xsrf|_token/i.test(cookie.name)) {
      tokens.push({
        source: "cookie",
        name: cookie.name,
        value: cookie.value,
        location: `cookie (domain: ${cookie.domain})`,
      });
    }
  }

  return tokens;
}

export async function replayWithCSRF(
  context: BrowserContext,
  logEntry: NetworkLogEntry,
  token: string,
  options: { headerName?: string; paramName?: string } = {}
): Promise<ReplayResult> {
  const headerName = options.headerName ?? "x-csrf-token";
  const paramName = options.paramName;

  const modifications: ReplayModifications = {
    headers: { [headerName]: token },
  };

  if (paramName && logEntry.requestBody) {
    // Inject into form or JSON body
    try {
      const json = JSON.parse(logEntry.requestBody) as Record<string, unknown>;
      json[paramName] = token;
      modifications.body = JSON.stringify(json);
    } catch {
      const params = new URLSearchParams(logEntry.requestBody);
      params.set(paramName, token);
      modifications.body = params.toString();
    }
  }

  return replayRequest(context, logEntry, modifications);
}
