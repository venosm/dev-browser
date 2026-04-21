import { describe, expect, it } from "vitest";

import { detectAuthFlows } from "./auth-flow-manager.js";
import type { NetworkLogEntry } from "./network-manager.js";

function makeEntry(partial: Partial<NetworkLogEntry>): NetworkLogEntry {
  return {
    url: "https://example.com/",
    method: "GET",
    status: 200,
    mocked: false,
    duration: 10,
    timestamp: Date.now(),
    resourceType: "document",
    requestHeaders: {},
    responseHeaders: {},
    ...partial,
  };
}

describe("detectAuthFlows", () => {
  it("detects a basic OAuth authorization-code flow", () => {
    const log: NetworkLogEntry[] = [
      makeEntry({
        url: "https://example.com/",
      }),
      makeEntry({
        url:
          "https://id.example.com/authorize?client_id=abc&redirect_uri=https://app.example.com/cb&response_type=code&state=xyz&scope=openid+profile",
        status: 302,
        responseHeaders: { location: "https://app.example.com/cb?code=AUTH&state=xyz" },
      }),
      makeEntry({
        url: "https://app.example.com/cb?code=AUTH&state=xyz",
        status: 200,
      }),
      makeEntry({
        url: "https://id.example.com/token",
        method: "POST",
        status: 200,
        requestBody: "grant_type=authorization_code&code=AUTH&client_id=abc",
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify({ access_token: "TOKEN", token_type: "Bearer" }),
      }),
    ];

    const flows = detectAuthFlows(log);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.kind).toBe("oauth2");
    expect(flows[0]!.steps.map((s) => s.type)).toEqual([
      "oauth-authorize",
      "oauth-callback",
      "oauth-token",
    ]);
    expect(flows[0]!.clientId).toBe("abc");
    expect(flows[0]!.scopes).toContain("openid");
  });

  it("flags missing state and missing PKCE on authorize step", () => {
    const log: NetworkLogEntry[] = [
      makeEntry({
        url: "https://id.example.com/authorize?client_id=abc&redirect_uri=https://app/cb",
      }),
    ];

    const flows = detectAuthFlows(log);
    expect(flows).toHaveLength(1);
    const notes = flows[0]!.steps[0]!.notes;
    expect(notes.some((n) => n.includes("state"))).toBe(true);
    expect(notes.some((n) => n.includes("PKCE"))).toBe(true);
  });

  it("detects a SAML flow when SAMLRequest/SAMLResponse appear", () => {
    const log: NetworkLogEntry[] = [
      makeEntry({
        url: "https://idp.example.com/sso?SAMLRequest=PFNBTUw...&RelayState=abc",
      }),
      makeEntry({
        url: "https://app.example.com/acs",
        method: "POST",
        requestBody: "SAMLResponse=PFNBTUw...",
      }),
    ];

    const flows = detectAuthFlows(log);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.kind).toBe("saml2");
    expect(flows[0]!.steps.map((s) => s.type)).toEqual(["saml-request", "saml-response"]);
  });

  it("identifies OIDC discovery and upgrades the flow kind", () => {
    const log: NetworkLogEntry[] = [
      makeEntry({
        url: "https://id.example.com/.well-known/openid-configuration",
        responseHeaders: { "content-type": "application/json" },
      }),
      makeEntry({
        url:
          "https://id.example.com/authorize?client_id=abc&state=s&code_challenge=cc&redirect_uri=https://app/cb",
      }),
    ];

    const flows = detectAuthFlows(log);
    expect(flows).toHaveLength(1);
    expect(flows[0]!.kind).toBe("oidc");
  });

  it("returns an empty array when no auth URLs are present", () => {
    const log: NetworkLogEntry[] = [
      makeEntry({ url: "https://example.com/" }),
      makeEntry({ url: "https://example.com/api/users" }),
    ];
    expect(detectAuthFlows(log)).toEqual([]);
  });
});
