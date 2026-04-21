import type { Page } from "playwright";

import * as FormManager from "./form-manager.js";

// ── Page summary (compact semantic tree for LLMs) ─────────────────────────────

export interface SummarizeOptions {
  /** Max tree depth (default 8). */
  maxDepth?: number;
  /** Max total nodes (default 200). */
  maxNodes?: number;
  /** Max text length per node (default 120). */
  maxTextLength?: number;
  /** Include hidden elements (default false). */
  includeHidden?: boolean;
  /** Restrict to a CSS selector root (default: document.body). */
  rootSelector?: string;
}

export interface SummaryNode {
  role: string;
  name?: string;
  tag?: string;
  text?: string;
  value?: string;
  selector: string;
  interactable?: boolean;
  href?: string;
  children?: SummaryNode[];
}

export interface SummaryResult {
  url: string;
  title: string;
  truncated: boolean;
  nodeCount: number;
  tree: SummaryNode;
}

export async function summarizePage(
  page: Page,
  options: SummarizeOptions = {}
): Promise<SummaryResult> {
  const opts = {
    maxDepth: options.maxDepth ?? 8,
    maxNodes: options.maxNodes ?? 200,
    maxTextLength: options.maxTextLength ?? 120,
    includeHidden: options.includeHidden ?? false,
    rootSelector: options.rootSelector ?? null,
  };

  const title = await page.title().catch(() => "");
  const url = page.url();

  const result = (await page.evaluate((cfg) => {
    const INTERACTIVE_TAGS = new Set([
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "option",
      "summary",
      "details",
    ]);
    const SKIP_TAGS = new Set([
      "script",
      "style",
      "noscript",
      "meta",
      "link",
      "head",
      "title",
      "template",
      "svg",
      "path",
    ]);
    const CONTAINER_ROLES = new Set([
      "main",
      "navigation",
      "banner",
      "contentinfo",
      "complementary",
      "region",
      "form",
      "search",
      "article",
      "section",
      "dialog",
      "alertdialog",
      "menu",
      "menubar",
      "tablist",
      "list",
      "listbox",
      "tree",
      "grid",
      "table",
    ]);

    const isVisible = (el: Element): boolean => {
      const he = el as HTMLElement;
      if (!he.isConnected) return false;
      const rect = he.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = getComputedStyle(he);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (style.opacity === "0") return false;
      return true;
    };

    const nth = (el: Element): number => {
      let i = 1;
      let prev = el.previousElementSibling;
      while (prev) {
        if (prev.tagName === el.tagName) i++;
        prev = prev.previousElementSibling;
      }
      return i;
    };

    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === 1 && current !== document.body) {
        const he = current as HTMLElement;
        if (he.id) {
          parts.unshift(`#${CSS.escape(he.id)}`);
          break;
        }
        const dti = he.getAttribute("data-testid");
        if (dti) {
          parts.unshift(`[data-testid="${dti}"]`);
          break;
        }
        const tag = he.tagName.toLowerCase();
        parts.unshift(`${tag}:nth-of-type(${nth(he)})`);
        current = current.parentElement;
        if (parts.length > 6) break;
      }
      return parts.join(" > ") || el.tagName.toLowerCase();
    };

    const accessibleName = (el: Element): string | undefined => {
      const he = el as HTMLElement;
      const aria = he.getAttribute("aria-label");
      if (aria) return aria.trim();
      const labelledby = he.getAttribute("aria-labelledby");
      if (labelledby) {
        const ids = labelledby.split(/\s+/).filter(Boolean);
        const texts = ids
          .map((id) => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean);
        if (texts.length) return texts.join(" ");
      }
      if (he.tagName === "INPUT" || he.tagName === "TEXTAREA" || he.tagName === "SELECT") {
        const input = he as HTMLInputElement;
        if (input.labels && input.labels.length > 0) {
          const labelText = Array.from(input.labels)
            .map((l) => l.textContent?.trim())
            .filter(Boolean)
            .join(" ");
          if (labelText) return labelText;
        }
        if (input.placeholder) return input.placeholder;
        const title = he.getAttribute("title");
        if (title) return title;
      }
      if (he.tagName === "IMG") {
        const alt = (he as HTMLImageElement).alt;
        if (alt) return alt;
      }
      if (he.tagName === "BUTTON" || he.tagName === "A") {
        const t = he.textContent?.trim();
        if (t && t.length <= 80) return t;
      }
      return undefined;
    };

    const inferRole = (el: Element): string => {
      const he = el as HTMLElement;
      const explicit = he.getAttribute("role");
      if (explicit) return explicit;
      const tag = he.tagName.toLowerCase();
      switch (tag) {
        case "a":
          return he.hasAttribute("href") ? "link" : "generic";
        case "button":
          return "button";
        case "input": {
          const type = (he as HTMLInputElement).type?.toLowerCase() ?? "text";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "submit" || type === "button" || type === "reset") return "button";
          if (type === "search") return "searchbox";
          if (type === "range") return "slider";
          return "textbox";
        }
        case "textarea":
          return "textbox";
        case "select":
          return "combobox";
        case "option":
          return "option";
        case "nav":
          return "navigation";
        case "main":
          return "main";
        case "header":
          return "banner";
        case "footer":
          return "contentinfo";
        case "aside":
          return "complementary";
        case "form":
          return "form";
        case "table":
          return "table";
        case "ul":
        case "ol":
          return "list";
        case "li":
          return "listitem";
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          return `heading${tag.charAt(1)}`;
        case "img":
          return "img";
        case "dialog":
          return "dialog";
        case "article":
          return "article";
        case "section":
          return "region";
        case "details":
          return "group";
        default:
          return "generic";
      }
    };

    let nodeCount = 0;
    let truncated = false;

    const trimText = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined;
      const trimmed = value.replace(/\s+/g, " ").trim();
      if (!trimmed) return undefined;
      return trimmed.length > cfg.maxTextLength
        ? trimmed.slice(0, cfg.maxTextLength) + "…"
        : trimmed;
    };

    const build = (el: Element, depth: number): SummaryNode | null => {
      if (nodeCount >= cfg.maxNodes) {
        truncated = true;
        return null;
      }
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return null;
      if (!cfg.includeHidden && !isVisible(el)) return null;

      const role = inferRole(el);
      const name = accessibleName(el);
      const interactable = INTERACTIVE_TAGS.has(tag) || el.hasAttribute("onclick") ||
        el.hasAttribute("tabindex");

      const isContainer = CONTAINER_ROLES.has(role);
      const isHeading = /^heading/.test(role);

      // Decide whether to emit this node
      const hasName = !!name;
      const shouldEmit =
        interactable ||
        isContainer ||
        isHeading ||
        tag === "img" ||
        (hasName && role !== "generic") ||
        depth === 0;

      let emitted: SummaryNode | null = null;
      if (shouldEmit) {
        nodeCount += 1;
        emitted = {
          role,
          selector: cssPath(el),
        };
        if (name) emitted.name = name;
        if (tag !== role && role === "generic") emitted.tag = tag;
        if (interactable) emitted.interactable = true;

        const href = (el as HTMLAnchorElement).href;
        if (tag === "a" && href) emitted.href = href;

        if (tag === "input" || tag === "textarea" || tag === "select") {
          const value = (el as HTMLInputElement).value;
          if (value) emitted.value = trimText(value);
        } else if (isHeading || (interactable && tag !== "input")) {
          const text = trimText(el.textContent);
          if (text && text !== name) emitted.text = text;
        } else if (!name && (role === "img" || role === "region" || role === "article")) {
          const text = trimText(el.textContent);
          if (text) emitted.text = text;
        }
      }

      if (depth >= cfg.maxDepth) {
        if (emitted) return emitted;
        return null;
      }

      const childNodes: SummaryNode[] = [];
      for (const child of Array.from(el.children)) {
        const sub = build(child, depth + 1);
        if (sub) childNodes.push(sub);
        if (nodeCount >= cfg.maxNodes) {
          truncated = true;
          break;
        }
      }

      if (emitted) {
        if (childNodes.length > 0) emitted.children = childNodes;
        return emitted;
      }
      if (childNodes.length === 1) return childNodes[0]!;
      if (childNodes.length > 1) {
        nodeCount += 1;
        return {
          role: "group",
          selector: cssPath(el),
          children: childNodes,
        };
      }
      return null;
    };

    const rootEl = cfg.rootSelector
      ? (document.querySelector(cfg.rootSelector) as Element | null) ?? document.body
      : document.body;

    const tree = build(rootEl, 0) ?? {
      role: "generic",
      selector: "body",
    };

    return { tree, nodeCount, truncated };
  }, opts)) as { tree: SummaryNode; nodeCount: number; truncated: boolean };

  return { url, title, ...result };
}

// ── Stable selector resolver ──────────────────────────────────────────────────

export interface SelectorCandidate {
  method:
    | "getByTestId"
    | "getByRole"
    | "getByLabel"
    | "getByPlaceholder"
    | "getByAltText"
    | "getByTitle"
    | "getByText"
    | "id"
    | "css";
  expression: string;
  description: string;
  stability: number; // 0–100
  unique: boolean;
}

export interface StableSelectorResult {
  target: string;
  tagName: string;
  best: SelectorCandidate | null;
  alternatives: SelectorCandidate[];
}

export async function resolveStableSelector(
  page: Page,
  target: string
): Promise<StableSelectorResult> {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("resolveStableSelector: target must be a non-empty string");
  }

  const locator = page.locator(target).first();
  const count = await locator.count();
  if (count === 0) {
    throw new Error(`resolveStableSelector: no element matches "${target}"`);
  }

  const raw = (await locator.evaluate((el) => {
    const he = el as HTMLElement;

    const testId = he.getAttribute("data-testid") ?? he.getAttribute("data-test-id");
    const role = he.getAttribute("role");
    const tag = he.tagName.toLowerCase();
    const id = he.id;

    let label: string | null = null;
    if (he.tagName === "INPUT" || he.tagName === "TEXTAREA" || he.tagName === "SELECT") {
      const input = he as HTMLInputElement;
      if (input.labels && input.labels.length > 0) {
        label = input.labels[0]!.textContent?.trim() ?? null;
      }
    }

    const ariaLabel = he.getAttribute("aria-label");
    const placeholder = he.getAttribute("placeholder");
    const alt = he.getAttribute("alt");
    const title = he.getAttribute("title");
    const text = he.textContent?.trim() ?? "";
    const shortText = text.length > 0 && text.length <= 40 ? text : null;

    let impliedRole: string | null = role;
    if (!impliedRole) {
      switch (tag) {
        case "button":
          impliedRole = "button";
          break;
        case "a":
          impliedRole = he.hasAttribute("href") ? "link" : null;
          break;
        case "input": {
          const t = (he as HTMLInputElement).type?.toLowerCase() ?? "text";
          if (t === "checkbox") impliedRole = "checkbox";
          else if (t === "radio") impliedRole = "radio";
          else if (t === "submit" || t === "button") impliedRole = "button";
          else impliedRole = "textbox";
          break;
        }
        case "textarea":
          impliedRole = "textbox";
          break;
        case "select":
          impliedRole = "combobox";
          break;
        default:
          impliedRole = null;
      }
    }

    const accessibleName = ariaLabel ?? label ?? (tag === "img" ? alt : null) ?? shortText;

    return {
      tag,
      id,
      testId,
      role: impliedRole,
      name: accessibleName,
      label,
      placeholder,
      alt,
      title,
      text: shortText,
    };
  })) as {
    tag: string;
    id: string;
    testId: string | null;
    role: string | null;
    name: string | null;
    label: string | null;
    placeholder: string | null;
    alt: string | null;
    title: string | null;
    text: string | null;
  };

  const candidates: SelectorCandidate[] = [];

  const checkUnique = async (selector: string): Promise<boolean> => {
    try {
      return (await page.locator(selector).count()) === 1;
    } catch {
      return false;
    }
  };

  if (raw.testId) {
    const sel = `[data-testid="${raw.testId}"]`;
    candidates.push({
      method: "getByTestId",
      expression: `page.getByTestId(${JSON.stringify(raw.testId)})`,
      description: `data-testid="${raw.testId}"`,
      stability: 95,
      unique: await checkUnique(sel),
    });
  }

  if (raw.role && raw.name) {
    const roleSel = `role=${raw.role}[name="${raw.name.replace(/"/g, '\\"')}"]`;
    candidates.push({
      method: "getByRole",
      expression: `page.getByRole(${JSON.stringify(raw.role)}, { name: ${JSON.stringify(raw.name)} })`,
      description: `role=${raw.role}, name=${JSON.stringify(raw.name)}`,
      stability: 90,
      unique: await checkUnique(roleSel),
    });
  }

  if (raw.label) {
    candidates.push({
      method: "getByLabel",
      expression: `page.getByLabel(${JSON.stringify(raw.label)})`,
      description: `label=${JSON.stringify(raw.label)}`,
      stability: 80,
      unique: await checkUnique(`internal:label=${JSON.stringify(raw.label)}`),
    });
  }

  if (raw.placeholder) {
    candidates.push({
      method: "getByPlaceholder",
      expression: `page.getByPlaceholder(${JSON.stringify(raw.placeholder)})`,
      description: `placeholder=${JSON.stringify(raw.placeholder)}`,
      stability: 70,
      unique: await checkUnique(
        `internal:attr=[placeholder="${raw.placeholder.replace(/"/g, '\\"')}"]`
      ),
    });
  }

  if (raw.alt) {
    candidates.push({
      method: "getByAltText",
      expression: `page.getByAltText(${JSON.stringify(raw.alt)})`,
      description: `alt=${JSON.stringify(raw.alt)}`,
      stability: 70,
      unique: await checkUnique(`internal:attr=[alt="${raw.alt.replace(/"/g, '\\"')}"]`),
    });
  }

  if (raw.title) {
    candidates.push({
      method: "getByTitle",
      expression: `page.getByTitle(${JSON.stringify(raw.title)})`,
      description: `title=${JSON.stringify(raw.title)}`,
      stability: 60,
      unique: await checkUnique(`internal:attr=[title="${raw.title.replace(/"/g, '\\"')}"]`),
    });
  }

  if (raw.text && !raw.name) {
    candidates.push({
      method: "getByText",
      expression: `page.getByText(${JSON.stringify(raw.text)})`,
      description: `text=${JSON.stringify(raw.text)}`,
      stability: 50,
      unique: await checkUnique(`internal:text=${JSON.stringify(raw.text)}`),
    });
  }

  if (raw.id) {
    const sel = `#${raw.id}`;
    candidates.push({
      method: "id",
      expression: `page.locator(${JSON.stringify(sel)})`,
      description: `#${raw.id}`,
      stability: /^[0-9]/.test(raw.id) || /[A-Z][a-z]*[0-9]/.test(raw.id) ? 30 : 75,
      unique: await checkUnique(sel),
    });
  }

  candidates.push({
    method: "css",
    expression: `page.locator(${JSON.stringify(target)})`,
    description: target,
    stability: 20,
    unique: count === 1,
  });

  // Rank unique candidates by stability (descending), then non-unique.
  const ranked = [...candidates].sort((a, b) => {
    if (a.unique !== b.unique) return a.unique ? -1 : 1;
    return b.stability - a.stability;
  });

  return {
    target,
    tagName: raw.tag,
    best: ranked[0] ?? null,
    alternatives: ranked.slice(1),
  };
}

// ── Intent-level action ───────────────────────────────────────────────────────

export interface ActIntentCredentials {
  username?: string;
  email?: string;
  password?: string;
  query?: string;
}

export interface ActIntentOptions extends ActIntentCredentials {
  /** Max ms to wait for navigation/error settle after submission (default 2000). */
  settleMs?: number;
  /** If false, do not actually submit the form (default true). */
  submit?: boolean;
}

export interface ActIntentResult {
  intent: string;
  matched:
    | "login"
    | "signup"
    | "search"
    | "form-fill"
    | "no-form-detected"
    | "unsupported-intent";
  actions: string[];
  success: boolean;
  urlBefore: string;
  urlAfter: string;
  consoleErrors: string[];
  error?: string;
}

type IntentKind = "login" | "signup" | "search" | "unknown";

function classifyIntent(intent: string): IntentKind {
  const lower = intent.toLowerCase();
  if (/\b(log\s*in|login|sign\s*in|signin|authenticate)\b/.test(lower)) return "login";
  if (/\b(sign\s*up|signup|register|create\s+account)\b/.test(lower)) return "signup";
  if (/\b(search|find|query|look\s+up)\b/.test(lower)) return "search";
  return "unknown";
}

export async function actIntent(
  page: Page,
  intent: string,
  options: ActIntentOptions = {}
): Promise<ActIntentResult> {
  if (typeof intent !== "string" || intent.length === 0) {
    throw new TypeError("actIntent: intent must be a non-empty string");
  }

  const settleMs = options.settleMs ?? 2_000;
  const shouldSubmit = options.submit !== false;

  const urlBefore = page.url();
  const consoleErrors: string[] = [];
  const consoleHandler = (msg: { type(): string; text(): string }): void => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  };
  page.on("console", consoleHandler);

  const actions: string[] = [];
  let matched: ActIntentResult["matched"] = "form-fill";
  let success = false;
  let errorText: string | undefined;

  try {
    const kind = classifyIntent(intent);
    const forms = await FormManager.detectForms(page);

    if (kind === "login") {
      matched = "login";
      const loginForm = forms.find((f) => f.isLogin);
      if (!loginForm) {
        matched = "no-form-detected";
        throw new Error("No login form detected on page");
      }
      if (!options.password) {
        throw new Error("actIntent(login): credentials.password is required");
      }
      await FormManager.autoFillForm(page, {
        username: options.username,
        email: options.email,
        password: options.password,
        submit: shouldSubmit,
      });
      actions.push("filled login form");
      if (shouldSubmit) actions.push("submitted form");
      success = true;
    } else if (kind === "signup") {
      matched = "signup";
      const signupForm = forms.find((f) => f.isSignup);
      if (!signupForm) {
        matched = "no-form-detected";
        throw new Error("No signup form detected on page");
      }
      if (!options.password) {
        throw new Error("actIntent(signup): credentials.password is required");
      }
      const usernameValue = options.email ?? options.username;
      const userField = signupForm.fields.find(
        (f) =>
          f.type === "email" ||
          /email|user|login|username/i.test(`${f.name} ${f.id} ${f.placeholder}`)
      );
      if (userField && usernameValue) {
        await page.fill(userField.selector, usernameValue);
        actions.push(`filled ${userField.selector}`);
      }
      const passwordFields = signupForm.fields.filter((f) => f.type === "password");
      for (const pw of passwordFields) {
        await page.fill(pw.selector, options.password);
        actions.push(`filled ${pw.selector}`);
      }
      if (shouldSubmit) {
        const submit = page
          .locator(`${signupForm.selector} button[type="submit"], ${signupForm.selector} input[type="submit"]`)
          .first();
        if ((await submit.count()) > 0) {
          await submit.click();
          actions.push("submitted form");
        }
      }
      success = true;
    } else if (kind === "search") {
      matched = "search";
      if (!options.query) {
        throw new Error("actIntent(search): options.query is required");
      }
      const searchForm = forms.find((f) => f.isSearch) ?? forms[0];
      const searchField =
        searchForm?.fields.find(
          (f) => f.type === "search" || f.name === "q" || /search|query/i.test(f.name + f.id)
        ) ?? searchForm?.fields[0];
      if (searchField && searchForm) {
        await page.fill(searchField.selector, options.query);
        actions.push(`filled ${searchField.selector}`);
        if (shouldSubmit) {
          await page.locator(searchField.selector).press("Enter");
          actions.push("submitted search");
        }
        success = true;
      } else {
        matched = "no-form-detected";
        throw new Error("No search field detected on page");
      }
    } else {
      matched = "unsupported-intent";
      throw new Error(
        `actIntent: could not classify intent "${intent}" (supported: login/signup/search)`
      );
    }

    if (settleMs > 0) {
      await page.waitForLoadState("networkidle", { timeout: settleMs }).catch(() => undefined);
    }
  } catch (err) {
    success = false;
    errorText = err instanceof Error ? err.message : String(err);
  } finally {
    page.off("console", consoleHandler);
  }

  return {
    intent,
    matched,
    actions,
    success,
    urlBefore,
    urlAfter: page.url(),
    consoleErrors,
    error: errorText,
  };
}
