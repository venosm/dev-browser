/**
 * Test: Login flow on dev.zakazky.nipez.cz as Cvrčková2
 *
 * Flow:
 *   1. Navigate to dev.zakazky.nipez.cz
 *   2. Enter dev-environment password on /overeni-pristupu
 *   3. Click "Přihlásit se" → redirect to auth-test.nipez.cz
 *   4. Click "Občan ČR nebo EU" → redirect to tnia.identita.gov.cz
 *   5. Click "Testovací profily (LoA High jako eObčanka)"
 *   6. Select user "Cvrckova2" from dropdown, click "Přihlásit"
 *   7. Assert redirect back to dev.zakazky.nipez.cz with user CECÍLIE CVRČKOVÁ
 */

const DEV_PASSWORD = "Heslo12345";
const EXPECTED_USER_NAME = "CECÍLIE CVRČKOVÁ";

// Helper: wait until URL matches predicate, polling every second up to maxSeconds
async function waitForUrl(page, predicate, maxSeconds) {
  for (let i = 0; i < maxSeconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (predicate(page.url())) return page.url();
  }
  throw new Error(
    `URL did not match within ${maxSeconds}s. Last URL: ${page.url()}`
  );
}

// Helper: click via evaluate so Playwright doesn't wait for navigation (avoids 30s timeout)
async function evalClick(page, predicate) {
  await page.evaluate((pred) => {
    const el = document.querySelector(pred);
    if (!el) throw new Error("Element not found: " + pred);
    el.click();
  }, predicate);
}

const page = await browser.getPage("nipez-login-test");

// ── Step 1: navigate ──────────────────────────────────────────────────────────
console.log("Step 1: Navigate to dev.zakazky.nipez.cz");
await page.goto("https://dev.zakazky.nipez.cz/");
await new Promise((r) => setTimeout(r, 1500));

// ── Step 2: dev-environment password gate ─────────────────────────────────────
if (page.url().includes("/overeni-pristupu")) {
  console.log("Step 2: Entering dev environment password");
  const passwordInput = await page.$('input[type="password"]');
  if (!passwordInput) throw new Error("Password input not found");
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(DEV_PASSWORD);
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 2000));
  if (page.url().includes("/overeni-pristupu")) {
    throw new Error("Dev password rejected — check DEV_PASSWORD constant");
  }
  console.log("  ✓ Password accepted");
} else {
  console.log("Step 2: No password gate (already past it)");
}

// ── Step 2b: log out if already logged in ─────────────────────────────────────
// The logout button has title="Odhlásit se" (icon-only, no text content)
const isLoggedIn = await page.evaluate(() => {
  return !!document.querySelector('button[title="Odhlásit se"]');
});
if (isLoggedIn) {
  console.log("Step 2b: Already logged in — logging out first");
  await page.evaluate(() => {
    const btn = document.querySelector('button[title="Odhlásit se"]');
    if (btn) btn.click();
  });
  // Logout redirects to tnia signout page; navigate back to homepage
  await waitForUrl(page, (u) => u.includes("tnia.identita.gov.cz/FPSTS/signout") || u.includes("dev.zakazky.nipez.cz"), 15);
  if (!page.url().includes("dev.zakazky.nipez.cz")) {
    await page.goto("https://dev.zakazky.nipez.cz/");
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("  ✓ Logged out, back on homepage");
}

// ── Step 3: click "Přihlásit se" ──────────────────────────────────────────────
// The login button has title="Přihlásit se" and a text paragraph inside
console.log("Step 3: Clicking 'Přihlásit se'");
await page.evaluate(() => {
  const btn = document.querySelector('button[title="Přihlásit se"]');
  if (!btn) throw new Error("'Přihlásit se' button not found");
  btn.click();
});
await waitForUrl(page, (u) => u.includes("auth-test.nipez.cz"), 20);
console.log("  ✓ Redirected to auth-test.nipez.cz");

// ── Step 4: click "Občan ČR nebo EU" ─────────────────────────────────────────
console.log("Step 4: Selecting 'Občan ČR nebo EU'");
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => {
  const link = document.querySelector('a[href="/Authorization/Nia"]');
  if (!link) throw new Error("'Občan ČR nebo EU' link not found");
  link.click();
});
await waitForUrl(page, (u) => u.includes("tnia.identita.gov.cz"), 20);
console.log("  ✓ Redirected to tnia.identita.gov.cz");

// ── Step 5: click "Testovací profily (LoA High jako eObčanka)" ────────────────
console.log("Step 5: Clicking 'Testovací profily (LoA High jako eObčanka)'");
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) =>
      b.textContent.includes("Testovací profily") &&
      b.textContent.includes("eObčanka")
  );
  if (!btn)
    throw new Error("'Testovací profily (eObčanka)' button not found");
  btn.click();
});
await waitForUrl(
  page,
  (u) => u.includes("IPSTS.DEV.HIGH/UI/Login"),
  20
);
console.log("  ✓ Redirected to IPSTS.DEV.HIGH login page");

// ── Step 6: select Cvrckova2 and submit ───────────────────────────────────────
console.log("Step 6: Selecting user 'Cvrckova2'");
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => {
  const sel = document.querySelector("select");
  if (!sel) throw new Error("User dropdown not found");
  const opt = Array.from(sel.options).find((o) =>
    o.text.toLowerCase().includes("cvrckova2")
  );
  if (!opt) throw new Error("Option 'Cvrckova2' not found in dropdown");
  sel.value = opt.value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});

await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent.trim() === "Přihlásit"
  );
  if (!btn) throw new Error("'Přihlásit' button not found");
  btn.click();
});

await waitForUrl(page, (u) => u.includes("dev.zakazky.nipez.cz"), 25);
console.log("  ✓ Redirected back to dev.zakazky.nipez.cz");

// ── Step 7: assert logged-in user ────────────────────────────────────────────
console.log("Step 7: Verifying logged-in user");
await new Promise((r) => setTimeout(r, 1500));

const headerText = await page.evaluate(() => document.body.innerText);
if (!headerText.includes(EXPECTED_USER_NAME)) {
  throw new Error(
    `Expected user '${EXPECTED_USER_NAME}' not found in page. ` +
      `Body text snippet: ${headerText.substring(0, 300)}`
  );
}
console.log(`  ✓ User '${EXPECTED_USER_NAME}' is logged in`);

// ── Done ──────────────────────────────────────────────────────────────────────
console.log("\n✓ All steps passed — login flow works correctly");
console.log(JSON.stringify({ url: page.url(), user: EXPECTED_USER_NAME }));
