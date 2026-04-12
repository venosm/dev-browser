import type { BrowserContext, Request, Response, Route } from "playwright";

interface MockResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: string;
  delay?: number;
  times?: number;
}

export interface NetworkLogEntry {
  url: string;
  method: string;
  status: number;
  mocked: boolean;
  intercepted?: boolean;
  duration: number;
  timestamp: number;
  resourceType: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
}

interface MockEntry {
  handler: (route: Route, request: Request) => Promise<void>;
  timesLeft: number;
}

interface InterceptEntry {
  handler: (route: Route, request: Request) => Promise<void>;
}

interface InterceptModifications {
  headers?: Record<string, string>;
  removeHeaders?: string[];
  method?: string;
  url?: string;
  postData?: string;
}

const MAX_LOG_ENTRIES = 5_000;

export class NetworkManager {
  readonly #context: BrowserContext;
  readonly #mocks = new Map<string, MockEntry>();
  readonly #intercepts = new Map<string, InterceptEntry>();
  readonly #log: NetworkLogEntry[] = [];
  readonly #pendingRequests = new Map<Request, number>();
  #requestListener?: (request: Request) => void;
  #responseListener?: (response: Response) => void;

  constructor(context: BrowserContext) {
    this.#context = context;
    this.#startLog();
  }

  async mock(pattern: unknown, responseOptions: unknown): Promise<void> {
    const patternStr = String(pattern);
    const opts = ((responseOptions ?? {}) as MockResponseOptions);
    const times = typeof opts.times === "number" && opts.times > 0 ? opts.times : Infinity;

    const existing = this.#mocks.get(patternStr);
    if (existing) {
      try {
        await this.#context.unroute(patternStr, existing.handler);
      } catch {
        // Best effort
      }
    }

    const entry: MockEntry = {
      timesLeft: times,
      handler: async (route: Route) => {
        if (entry.timesLeft !== Infinity && entry.timesLeft <= 0) {
          await route.continue();
          return;
        }
        if (entry.timesLeft !== Infinity) {
          entry.timesLeft--;
        }
        if (typeof opts.delay === "number" && opts.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, opts.delay));
        }

        let body: string;
        if (opts.body === undefined || opts.body === null) {
          body = "";
        } else if (typeof opts.body === "string") {
          body = opts.body;
        } else {
          body = JSON.stringify(opts.body);
        }

        const contentType =
          opts.contentType ??
          (opts.body !== undefined && opts.body !== null && typeof opts.body === "object"
            ? "application/json"
            : "text/plain");

        await route.fulfill({
          status: opts.status ?? 200,
          headers: opts.headers,
          contentType,
          body,
        });
      },
    };

    this.#mocks.set(patternStr, entry);
    await this.#context.route(patternStr, entry.handler);
  }

  async clearMocks(pattern?: unknown): Promise<void> {
    if (pattern !== null && pattern !== undefined) {
      const patternStr = String(pattern);
      const entry = this.#mocks.get(patternStr);
      if (entry) {
        try {
          await this.#context.unroute(patternStr, entry.handler);
        } catch {
          // Best effort
        }
        this.#mocks.delete(patternStr);
      }
    } else {
      const entries = [...this.#mocks.entries()];
      for (const [pat, entry] of entries) {
        try {
          await this.#context.unroute(pat, entry.handler);
        } catch {
          // Best effort
        }
      }
      this.#mocks.clear();
    }
  }

  #startLog(): void {
    this.#requestListener = (request: Request) => {
      this.#pendingRequests.set(request, Date.now());
    };

    this.#responseListener = async (response: Response) => {
      const request = response.request();
      const startTime = this.#pendingRequests.get(request);
      if (startTime === undefined) return;
      this.#pendingRequests.delete(request);

      const url = request.url();
      const isMocked = this.#isUrlMocked(url);
      let responseBody: string | undefined;
      let responseHeaders: Record<string, string> = {};

      try {
        responseHeaders = response.headers();
        const contentLengthStr = responseHeaders["content-length"];
        const contentLength =
          contentLengthStr !== undefined ? Number.parseInt(contentLengthStr, 10) : 0;
        if (!Number.isNaN(contentLength) && contentLength > 0 && contentLength < 10_240) {
          responseBody = await response.text().catch(() => undefined);
        }
      } catch {
        // Best effort
      }

      this.#log.push({
        url,
        method: request.method(),
        status: response.status(),
        mocked: isMocked,
        duration: Date.now() - startTime,
        timestamp: startTime,
        resourceType: request.resourceType(),
        requestHeaders: request.headers(),
        responseHeaders,
        requestBody: request.postData() ?? undefined,
        responseBody,
      });

      if (this.#log.length > MAX_LOG_ENTRIES) {
        this.#log.splice(0, this.#log.length - MAX_LOG_ENTRIES);
      }
    };

    this.#context.on("request", this.#requestListener);
    this.#context.on("response", this.#responseListener);
  }

  #isUrlMocked(url: string): boolean {
    for (const pattern of this.#mocks.keys()) {
      try {
        const regexSource = pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*");
        if (new RegExp(regexSource).test(url)) {
          return true;
        }
      } catch {
        if (url.includes(pattern)) {
          return true;
        }
      }
    }
    return false;
  }

  getLog(options?: unknown): NetworkLogEntry[] {
    const opts = (options ?? {}) as {
      mockedOnly?: boolean;
      failedOnly?: boolean;
      urlPattern?: string;
      limit?: number;
    };

    let entries = [...this.#log];

    if (opts.mockedOnly) {
      entries = entries.filter((e) => e.mocked);
    }
    if (opts.failedOnly) {
      entries = entries.filter((e) => e.status >= 400 || e.status === 0);
    }
    if (typeof opts.urlPattern === "string" && opts.urlPattern.length > 0) {
      const pat = opts.urlPattern;
      entries = entries.filter((e) => e.url.includes(pat));
    }
    if (typeof opts.limit === "number" && opts.limit > 0) {
      entries = entries.slice(0, opts.limit);
    }

    return entries;
  }

  clearLog(): void {
    this.#log.length = 0;
  }

  getLogEntry(index: unknown): NetworkLogEntry {
    const idx = typeof index === "number" ? index : Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.#log.length) {
      throw new Error(`Invalid log entry index: ${index} (log has ${this.#log.length} entries)`);
    }
    return this.#log[idx]!;
  }

  getLogLength(): number {
    return this.#log.length;
  }

  async intercept(pattern: unknown, modifications: unknown): Promise<void> {
    const patternStr = String(pattern);
    const mods = ((modifications ?? {}) as InterceptModifications);

    const existing = this.#intercepts.get(patternStr);
    if (existing) {
      try {
        await this.#context.unroute(patternStr, existing.handler);
      } catch {
        // Best effort
      }
    }

    const entry: InterceptEntry = {
      handler: async (route: Route, request: Request) => {
        const overrides: Record<string, unknown> = {};

        if (mods.method) {
          overrides.method = mods.method;
        }
        if (mods.url) {
          overrides.url = mods.url;
        }
        if (mods.postData) {
          overrides.postData = mods.postData;
        }

        if (mods.headers || mods.removeHeaders) {
          const currentHeaders = { ...request.headers() };
          if (mods.removeHeaders) {
            for (const name of mods.removeHeaders) {
              delete currentHeaders[name.toLowerCase()];
            }
          }
          if (mods.headers) {
            for (const [name, value] of Object.entries(mods.headers)) {
              currentHeaders[name.toLowerCase()] = value;
            }
          }
          overrides.headers = currentHeaders;
        }

        await route.continue(overrides);
      },
    };

    this.#intercepts.set(patternStr, entry);
    await this.#context.route(patternStr, entry.handler);
  }

  async clearIntercepts(pattern?: unknown): Promise<void> {
    if (pattern !== null && pattern !== undefined) {
      const patternStr = String(pattern);
      const entry = this.#intercepts.get(patternStr);
      if (entry) {
        try {
          await this.#context.unroute(patternStr, entry.handler);
        } catch {
          // Best effort
        }
        this.#intercepts.delete(patternStr);
      }
    } else {
      const entries = [...this.#intercepts.entries()];
      for (const [pat, entry] of entries) {
        try {
          await this.#context.unroute(pat, entry.handler);
        } catch {
          // Best effort
        }
      }
      this.#intercepts.clear();
    }
  }

  exportHar(): unknown {
    const entries = this.#log.map((entry) => ({
      startedDateTime: new Date(entry.timestamp).toISOString(),
      time: entry.duration,
      request: {
        method: entry.method,
        url: entry.url,
        httpVersion: "HTTP/1.1",
        headers: Object.entries(entry.requestHeaders).map(([name, value]) => ({ name, value })),
        queryString: this.#parseQueryString(entry.url),
        postData: entry.requestBody
          ? { mimeType: entry.requestHeaders["content-type"] ?? "application/octet-stream", text: entry.requestBody }
          : undefined,
        headersSize: -1,
        bodySize: entry.requestBody ? entry.requestBody.length : 0,
        cookies: [],
      },
      response: {
        status: entry.status,
        statusText: "",
        httpVersion: "HTTP/1.1",
        headers: Object.entries(entry.responseHeaders).map(([name, value]) => ({ name, value })),
        content: {
          size: entry.responseBody ? entry.responseBody.length : 0,
          mimeType: entry.responseHeaders["content-type"] ?? "application/octet-stream",
          text: entry.responseBody ?? "",
        },
        redirectURL: entry.responseHeaders["location"] ?? "",
        headersSize: -1,
        bodySize: entry.responseBody ? entry.responseBody.length : -1,
        cookies: [],
      },
      cache: {},
      timings: {
        send: 0,
        wait: entry.duration,
        receive: 0,
      },
    }));

    return {
      log: {
        version: "1.2",
        creator: { name: "dev-browser", version: "0.2.4" },
        entries,
      },
    };
  }

  importHar(har: unknown): void {
    if (typeof har !== "object" || har === null) {
      throw new TypeError("HAR data must be an object");
    }

    const log = (har as { log?: unknown }).log;
    if (typeof log !== "object" || log === null) {
      throw new TypeError("HAR data must contain a log object");
    }

    const entries = (log as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) {
      throw new TypeError("HAR log must contain an entries array");
    }

    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const req = (entry as { request?: Record<string, unknown> }).request;
      const res = (entry as { response?: Record<string, unknown> }).response;
      if (!req || !res) continue;

      const reqHeaders: Record<string, string> = {};
      if (Array.isArray(req.headers)) {
        for (const h of req.headers as Array<{ name?: string; value?: string }>) {
          if (h.name && h.value) reqHeaders[h.name.toLowerCase()] = h.value;
        }
      }

      const resHeaders: Record<string, string> = {};
      if (Array.isArray(res.headers)) {
        for (const h of res.headers as Array<{ name?: string; value?: string }>) {
          if (h.name && h.value) resHeaders[h.name.toLowerCase()] = h.value;
        }
      }

      const content = res.content as { text?: string } | undefined;
      const postData = req.postData as { text?: string } | undefined;

      this.#log.push({
        url: String(req.url ?? ""),
        method: String(req.method ?? "GET"),
        status: typeof res.status === "number" ? res.status : 0,
        mocked: false,
        duration: typeof (entry as { time?: number }).time === "number" ? (entry as { time: number }).time : 0,
        timestamp: new Date(String((entry as { startedDateTime?: string }).startedDateTime ?? "")).getTime() || Date.now(),
        resourceType: "other",
        requestHeaders: reqHeaders,
        responseHeaders: resHeaders,
        requestBody: postData?.text,
        responseBody: content?.text,
      });
    }

    if (this.#log.length > MAX_LOG_ENTRIES) {
      this.#log.splice(0, this.#log.length - MAX_LOG_ENTRIES);
    }
  }

  #parseQueryString(url: string): Array<{ name: string; value: string }> {
    try {
      const parsed = new URL(url);
      const result: Array<{ name: string; value: string }> = [];
      parsed.searchParams.forEach((value, name) => {
        result.push({ name, value });
      });
      return result;
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    await this.clearMocks();
    await this.clearIntercepts();
    if (this.#requestListener) {
      this.#context.off("request", this.#requestListener);
      this.#requestListener = undefined;
    }
    if (this.#responseListener) {
      this.#context.off("response", this.#responseListener);
      this.#responseListener = undefined;
    }
    this.#pendingRequests.clear();
  }
}
