import type { Page } from "playwright";

export interface FormField {
  selector: string;
  name: string;
  id: string;
  type: string;
  required: boolean;
  placeholder: string;
  value: string;
  autocomplete: string;
}

export interface FormInfo {
  selector: string;
  action: string;
  method: string;
  id: string;
  name: string;
  isLogin: boolean;
  isSignup: boolean;
  isSearch: boolean;
  fields: FormField[];
}

export async function detectForms(page: Page): Promise<FormInfo[]> {
  return page.evaluate(() => {
    const nth = (el: Element): number => {
      let i = 1;
      let prev = el.previousElementSibling;
      while (prev) {
        if (prev.tagName === el.tagName) i++;
        prev = prev.previousElementSibling;
      }
      return i;
    };

    const buildSelector = (el: Element): string => {
      const element = el as HTMLElement;
      if (element.id) return `#${CSS.escape(element.id)}`;
      const nameAttr = element.getAttribute("name");
      if (nameAttr) return `${element.tagName.toLowerCase()}[name="${nameAttr}"]`;
      return `${element.tagName.toLowerCase()}:nth-of-type(${nth(element)})`;
    };

    const forms = Array.from(document.querySelectorAll("form"));
    return forms.map((form) => {
      const inputs = Array.from(form.querySelectorAll("input, select, textarea")) as Array<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >;

      const fields: FormField[] = inputs.map((input) => ({
        selector: buildSelector(input),
        name: input.name ?? "",
        id: input.id ?? "",
        type: (input as HTMLInputElement).type ?? input.tagName.toLowerCase(),
        required: input.required,
        placeholder: (input as HTMLInputElement).placeholder ?? "",
        value: input.value ?? "",
        autocomplete: (input as HTMLInputElement).autocomplete ?? "",
      }));

      const hasPassword = fields.some((f) => f.type === "password");
      const hasEmail = fields.some((f) => f.type === "email" || /email|user|login/i.test(f.name + f.id));
      const hasConfirmPassword =
        fields.filter((f) => f.type === "password").length > 1 ||
        fields.some((f) => /confirm|confirmation|retype/i.test(f.name + f.id));
      const hasSearch = fields.some((f) => f.type === "search" || f.name === "q");

      return {
        selector: buildSelector(form),
        action: form.action ?? "",
        method: (form.method ?? "GET").toUpperCase(),
        id: form.id ?? "",
        name: form.name ?? "",
        isLogin: hasPassword && hasEmail && !hasConfirmPassword,
        isSignup: hasConfirmPassword,
        isSearch: hasSearch,
        fields,
      };
    });
  }) as Promise<FormInfo[]>;
}

export interface LoginCredentials {
  username?: string;
  email?: string;
  password: string;
  submit?: boolean;
}

export async function autoFillForm(page: Page, credentials: LoginCredentials): Promise<void> {
  const forms = await detectForms(page);
  const loginForm = forms.find((f) => f.isLogin) ?? forms[0];
  if (!loginForm) {
    throw new Error("autoFillForm: no form detected on page");
  }

  const usernameField = loginForm.fields.find(
    (f) =>
      f.type === "email" ||
      f.type === "text" ||
      /email|user|login|username/i.test(`${f.name} ${f.id} ${f.placeholder}`)
  );
  const passwordField = loginForm.fields.find((f) => f.type === "password");

  if (!passwordField) {
    throw new Error("autoFillForm: no password field found");
  }

  const usernameValue = credentials.email ?? credentials.username;
  if (usernameField && usernameValue) {
    await page.fill(usernameField.selector, usernameValue);
  }
  await page.fill(passwordField.selector, credentials.password);

  if (credentials.submit) {
    const submitButton = await page
      .locator(`${loginForm.selector} button[type="submit"], ${loginForm.selector} input[type="submit"]`)
      .first();
    if ((await submitButton.count()) > 0) {
      await submitButton.click();
    } else {
      await page.locator(passwordField.selector).press("Enter");
    }
  }
}

export async function submitForm(
  page: Page,
  selector: string,
  data: Record<string, string>
): Promise<void> {
  const form = page.locator(selector).first();
  if ((await form.count()) === 0) {
    throw new Error(`submitForm: no form matching selector "${selector}"`);
  }

  for (const [name, value] of Object.entries(data)) {
    const field = form.locator(`[name="${name}"]`).first();
    if ((await field.count()) === 0) continue;

    const tagName = await field.evaluate((el) => el.tagName.toLowerCase());
    const type = await field.evaluate((el) => (el as HTMLInputElement).type ?? "");

    if (tagName === "select") {
      await field.selectOption(value);
    } else if (type === "checkbox" || type === "radio") {
      if (value === "true" || value === "on" || value === "1") {
        await field.check();
      } else {
        await field.uncheck();
      }
    } else {
      await field.fill(value);
    }
  }

  const submitButton = form.locator('button[type="submit"], input[type="submit"]').first();
  if ((await submitButton.count()) > 0) {
    await submitButton.click();
  } else {
    await form.evaluate((el) => (el as HTMLFormElement).submit());
  }
}
