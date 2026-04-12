import type { BrowserContext, Cookie } from "playwright";

export interface CookieFilter {
  name?: string;
  domain?: string;
  path?: string;
  url?: string;
}

type CookieInit = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export async function getCookies(context: BrowserContext, urls?: unknown): Promise<Cookie[]> {
  if (urls === undefined || urls === null) {
    return context.cookies();
  }

  if (typeof urls === "string") {
    return context.cookies([urls]);
  }

  if (Array.isArray(urls)) {
    return context.cookies(urls.map((entry) => String(entry)));
  }

  throw new TypeError("cookies.get expects a string URL, string[], or undefined");
}

export async function setCookies(context: BrowserContext, cookies: unknown): Promise<void> {
  if (!Array.isArray(cookies)) {
    throw new TypeError("cookies.set expects an array of cookie objects");
  }

  const normalized: CookieInit[] = [];
  for (const raw of cookies) {
    if (typeof raw !== "object" || raw === null) {
      throw new TypeError("cookies.set: each cookie must be an object");
    }

    const cookie = raw as Record<string, unknown>;
    if (typeof cookie.name !== "string" || cookie.name.length === 0) {
      throw new TypeError("cookies.set: each cookie must have a string `name`");
    }
    if (typeof cookie.value !== "string") {
      throw new TypeError("cookies.set: each cookie must have a string `value`");
    }

    const entry: CookieInit = {
      name: cookie.name,
      value: cookie.value,
    };

    if (typeof cookie.url === "string") entry.url = cookie.url;
    if (typeof cookie.domain === "string") entry.domain = cookie.domain;
    if (typeof cookie.path === "string") entry.path = cookie.path;
    if (typeof cookie.expires === "number") entry.expires = cookie.expires;
    if (typeof cookie.httpOnly === "boolean") entry.httpOnly = cookie.httpOnly;
    if (typeof cookie.secure === "boolean") entry.secure = cookie.secure;
    if (
      cookie.sameSite === "Strict" ||
      cookie.sameSite === "Lax" ||
      cookie.sameSite === "None"
    ) {
      entry.sameSite = cookie.sameSite;
    }

    normalized.push(entry);
  }

  await context.addCookies(normalized);
}

export async function deleteCookies(context: BrowserContext, filter?: unknown): Promise<void> {
  if (filter === undefined || filter === null) {
    await context.clearCookies();
    return;
  }

  if (typeof filter !== "object") {
    throw new TypeError("cookies.delete: filter must be an object or undefined");
  }

  const f = filter as CookieFilter;
  const clearOptions: Parameters<BrowserContext["clearCookies"]>[0] = {};
  if (typeof f.name === "string") clearOptions.name = f.name;
  if (typeof f.domain === "string") clearOptions.domain = f.domain;
  if (typeof f.path === "string") clearOptions.path = f.path;

  await context.clearCookies(clearOptions);
}
