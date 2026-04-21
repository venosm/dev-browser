// @ts-nocheck
import { describe, expect, it } from "vitest";

import { unsafeLocatorOrSelectorAsSelector } from "./locatorParser";

function toSelector(locator: string): string {
  return unsafeLocatorOrSelectorAsSelector("javascript", locator, "data-testid");
}

describe("locatorParser composite operations", () => {
  it("handles getByRole chained with and()", () => {
    const selector = toSelector(
      `getByRole('button').and(getByTestId('submit-btn'))`,
    );
    expect(selector).toContain("internal:role=button");
    expect(selector).toContain("internal:and=");
    expect(selector).toContain("data-testid=");
    expect(selector).toContain("submit-btn");
  });

  it("handles or() combining two locators", () => {
    const selector = toSelector(
      `getByRole('button').or(getByRole('link'))`,
    );
    expect(selector).toContain("internal:role=button");
    expect(selector).toContain("internal:or=");
    expect(selector).toContain("internal:role=link");
  });

  it("still handles filter(has=...) recursively", () => {
    const selector = toSelector(
      `locator('div').filter({ has: getByText('hello') })`,
    );
    expect(selector).toContain("internal:has=");
    expect(selector).toContain("internal:text=");
  });

  it("handles nested and() + filter()", () => {
    const selector = toSelector(
      `getByRole('listitem').filter({ hasText: 'widget' }).and(getByTestId('active'))`,
    );
    expect(selector).toContain("internal:role=listitem");
    expect(selector).toContain("internal:has-text=");
    expect(selector).toContain("internal:and=");
  });
});
