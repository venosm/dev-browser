import type { BrowserContext } from "playwright";

import type { NetworkLogEntry } from "./network-manager.js";
import { replayRequest } from "./security-manager.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuthFlowKind = "oauth2" | "oidc" | "saml2" | "unknown";

export type AuthStepType =
  | "oauth-authorize"
  | "oauth-callback"
  | "oauth-token"
  | "oauth-userinfo"
  | "oidc-discovery"
  | "saml-request"
  | "saml-response"
  | "redirect"
  | "other";

export interface AuthFlowStep {
  index: number;
  logIndex: number;
  type: AuthStepType;
  url: string;
  method: string;
  status: number;
  params: Record<string, string>;
  notes: string[];
}

export interface DetectedAuthFlow {
  id: string;
  kind: AuthFlowKind;
  startedAt: number;
  issuer?: string;
  clientId?: string;
  scopes: string[];
  steps: AuthFlowStep[];
  summary: string;
}

// ── URL / param helpers ───────────────────────────────────────────────────────

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function collectParams(url: URL, body?: string): Record<string, string> {
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, name) => {
    params[name] = value;
  });
  if (body) {
    try {
      const form = new URLSearchParams(body);
      form.forEach((value, name) => {
        if (params[name] === undefined) params[name] = value;
      });
    } catch {
      // not form-encoded
    }
  }
  return params;
}

function classifyStep(entry: NetworkLogEntry, parsed: URL): AuthStepType {
  const path = parsed.pathname.toLowerCase();
  const query = parsed.searchParams;
  const method = entry.method.toUpperCase();
  const contentType = (entry.responseHeaders["content-type"] ?? "").toLowerCase();

  if (/\/(\.well-known|openid-configuration)/.test(path)) return "oidc-discovery";
  if (/\/authorize(\/|$)/.test(path) || /\/oauth.*\/auth/.test(path)) return "oauth-authorize";
  if (/\/token(\/|$)/.test(path) && method === "POST") return "oauth-token";
  if (/\/userinfo(\/|$)/.test(path)) return "oauth-userinfo";
  if (query.has("code") && query.has("state")) return "oauth-callback";
  if (query.has("SAMLRequest")) return "saml-request";
  if (query.has("SAMLResponse") || (entry.requestBody ?? "").includes("SAMLResponse")) {
    return "saml-response";
  }
  if (entry.status >= 300 && entry.status < 400 && entry.responseHeaders["location"]) {
    return "redirect";
  }
  if (contentType.includes("application/json") && /oauth|token|auth/.test(path)) {
    return "oauth-token";
  }
  return "other";
}

// ── Detection ─────────────────────────────────────────────────────────────────

export function detectAuthFlows(log: NetworkLogEntry[]): DetectedAuthFlow[] {
  const flows: DetectedAuthFlow[] = [];

  let current: DetectedAuthFlow | null = null;
  const finalizeCurrent = (): void => {
    if (!current) return;
    if (current.steps.length === 0) {
      current = null;
      return;
    }
    current.summary = buildSummary(current);
    flows.push(current);
    current = null;
  };

  for (let i = 0; i < log.length; i++) {
    const entry = log[i]!;
    const parsed = parseUrl(entry.url);
    if (!parsed) continue;

    const type = classifyStep(entry, parsed);
    if (type === "other") {
      // If we haven't seen an auth step in the last few entries, close the flow.
      if (current && current.steps.length > 0) {
        const last = current.steps[current.steps.length - 1]!;
        if (i - last.logIndex > 10) {
          finalizeCurrent();
        }
      }
      continue;
    }

    const params = collectParams(parsed, entry.requestBody);
    const step: AuthFlowStep = {
      index: 0,
      logIndex: i,
      type,
      url: entry.url,
      method: entry.method,
      status: entry.status,
      params,
      notes: [],
    };

    // Annotate security issues
    if (type === "oauth-authorize") {
      if (!params.state) step.notes.push("missing `state` param (CSRF risk)");
      if (!params.code_challenge) step.notes.push("no PKCE code_challenge");
      if ((params.redirect_uri ?? "").includes("http://")) {
        step.notes.push("redirect_uri over http (tls downgrade risk)");
      }
    }
    if (type === "oauth-token" && entry.responseBody) {
      try {
        const body = JSON.parse(entry.responseBody) as Record<string, unknown>;
        if (typeof body.access_token !== "string") step.notes.push("no access_token in response");
      } catch {
        step.notes.push("token response was not JSON");
      }
    }

    const startsNewFlow =
      type === "oidc-discovery" ||
      type === "saml-request" ||
      (type === "oauth-authorize" &&
        !!current &&
        current.steps.some((s) => s.type === "oauth-authorize"));
    if (startsNewFlow && current) {
      finalizeCurrent();
    }
    if (!current) {
      const kind: AuthFlowKind =
        type === "saml-request" || type === "saml-response"
          ? "saml2"
          : type === "oidc-discovery"
            ? "oidc"
            : "oauth2";
      current = {
        id: `flow-${flows.length + 1}`,
        kind,
        startedAt: entry.timestamp,
        clientId: params.client_id,
        issuer: parsed.origin,
        scopes: (params.scope ?? "").split(/\s+/).filter(Boolean),
        steps: [],
        summary: "",
      };
    } else if (current.kind === "oauth2" && type.startsWith("oidc")) {
      current.kind = "oidc";
    }
    step.index = current.steps.length;
    current.steps.push(step);

    if (current.clientId === undefined && params.client_id) current.clientId = params.client_id;
    if (current.scopes.length === 0 && params.scope) {
      current.scopes = params.scope.split(/\s+/).filter(Boolean);
    }
  }

  finalizeCurrent();
  return flows;
}

function buildSummary(flow: DetectedAuthFlow): string {
  const types = flow.steps.map((s) => s.type).join(" → ");
  const concerns = flow.steps.flatMap((s) => s.notes);
  const concernText = concerns.length > 0 ? ` | concerns: ${concerns.length}` : "";
  return `${flow.kind.toUpperCase()} flow (${flow.steps.length} steps): ${types}${concernText}`;
}

// ── Replay ────────────────────────────────────────────────────────────────────

export interface AuthReplayMutations {
  /** Tamper with the `state` parameter on the callback step. */
  state?: string | null;
  /** Tamper with the `code` parameter (e.g. to test reuse detection). */
  code?: string | null;
  /** Override the Authorization header (e.g. "Bearer <token>"). */
  authorization?: string | null;
  /** Explicit full replacement token in the POST body for token-exchange steps. */
  accessToken?: string;
  /** Drop PKCE verifier from the request. */
  dropPkceVerifier?: boolean;
  /** Remove the client_secret from the request. */
  dropClientSecret?: boolean;
}

export interface AuthReplayStepResult {
  stepIndex: number;
  stepType: AuthStepType;
  requestUrl: string;
  status: number;
  mutationsApplied: string[];
  responseHeaders: Record<string, string>;
  bodyPreview: string;
}

export interface AuthReplayResult {
  flowId: string;
  kind: AuthFlowKind;
  steps: AuthReplayStepResult[];
  summary: string;
}

function applyMutations(
  step: AuthFlowStep,
  log: NetworkLogEntry,
  mutations: AuthReplayMutations
): { modifications: Parameters<typeof replayRequest>[2]; applied: string[] } {
  const applied: string[] = [];
  const modifications: Parameters<typeof replayRequest>[2] = {};

  const url = parseUrl(log.url);
  if (!url) return { modifications, applied };

  if (mutations.state !== undefined && url.searchParams.has("state")) {
    if (mutations.state === null) url.searchParams.delete("state");
    else url.searchParams.set("state", mutations.state);
    modifications.url = url.toString();
    applied.push(mutations.state === null ? "removed state" : "tampered state");
  }

  if (mutations.code !== undefined && url.searchParams.has("code")) {
    if (mutations.code === null) url.searchParams.delete("code");
    else url.searchParams.set("code", mutations.code);
    modifications.url = url.toString();
    applied.push(mutations.code === null ? "removed code" : "tampered code");
  }

  if (mutations.authorization !== undefined) {
    modifications.headers = { ...(modifications.headers ?? {}) };
    if (mutations.authorization === null) {
      modifications.removeHeaders = [...(modifications.removeHeaders ?? []), "authorization"];
      applied.push("removed Authorization");
    } else {
      modifications.headers.authorization = mutations.authorization;
      applied.push("overrode Authorization");
    }
  }

  if (mutations.accessToken !== undefined && log.requestBody) {
    try {
      const form = new URLSearchParams(log.requestBody);
      form.set("access_token", mutations.accessToken);
      modifications.body = form.toString();
      applied.push("overrode access_token in body");
    } catch {
      // skip
    }
  }

  if ((mutations.dropPkceVerifier || mutations.dropClientSecret) && log.requestBody) {
    try {
      const form = new URLSearchParams(log.requestBody);
      if (mutations.dropPkceVerifier && form.has("code_verifier")) {
        form.delete("code_verifier");
        applied.push("dropped code_verifier");
      }
      if (mutations.dropClientSecret && form.has("client_secret")) {
        form.delete("client_secret");
        applied.push("dropped client_secret");
      }
      modifications.body = form.toString();
    } catch {
      // skip
    }
  }

  void step;
  return { modifications, applied };
}

export async function replayAuthFlow(
  context: BrowserContext,
  log: NetworkLogEntry[],
  flowId: string,
  mutations: AuthReplayMutations = {}
): Promise<AuthReplayResult> {
  const flows = detectAuthFlows(log);
  const flow = flows.find((f) => f.id === flowId);
  if (!flow) {
    throw new Error(`replayAuthFlow: no flow with id "${flowId}" (detected ${flows.length} flows)`);
  }

  const stepResults: AuthReplayStepResult[] = [];
  for (const step of flow.steps) {
    const logEntry = log[step.logIndex]!;
    const { modifications, applied } = applyMutations(step, logEntry, mutations);

    let result;
    try {
      result = await replayRequest(context, logEntry, modifications);
    } catch (err) {
      stepResults.push({
        stepIndex: step.index,
        stepType: step.type,
        requestUrl: logEntry.url,
        status: 0,
        mutationsApplied: applied,
        responseHeaders: {},
        bodyPreview: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    stepResults.push({
      stepIndex: step.index,
      stepType: step.type,
      requestUrl: result.finalUrl,
      status: result.status,
      mutationsApplied: applied,
      responseHeaders: result.headers,
      bodyPreview: result.body.length > 400 ? result.body.slice(0, 400) + "…" : result.body,
    });
  }

  const okCount = stepResults.filter((s) => s.status >= 200 && s.status < 400).length;
  return {
    flowId: flow.id,
    kind: flow.kind,
    steps: stepResults,
    summary: `Replayed ${stepResults.length} step(s) of ${flow.kind}; ${okCount} succeeded`,
  };
}
