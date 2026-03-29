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

export class NetworkManager {
  readonly #context: BrowserContext;
  readonly #mocks = new Map<string, MockEntry>();
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

  async dispose(): Promise<void> {
    await this.clearMocks();
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
