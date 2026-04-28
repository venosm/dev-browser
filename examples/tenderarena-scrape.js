// Example: Scrape a tender detail page from dev.tenderarena.cz with stealth +
// Cloudflare-aware waits. Run with:
//
//   dev-browser run examples/tenderarena-scrape.js --stealth
//
// `--stealth` applies the navigator.webdriver / plugins / chrome.runtime
// evasions, real Chrome UA, and 1280x720 viewport. Headed mode is the default
// (the daemon launches Chromium with a visible window) so any Turnstile
// checkbox can be clicked manually — `cloudflare.waitForSolve()` waits up to
// five minutes for the human to finish.

const HOME = "https://dev.tenderarena.cz/dodavatel";
const PAGE_NAME = "tenderarena";

// Pause for a uniformly random number of milliseconds in [min, max].
async function humanDelay(page, min = 1000, max = 3000) {
  const ms = Math.floor(min + Math.random() * (max - min));
  await page.waitForTimeout(ms);
}

// Detect Cloudflare; if a JS interstitial is present, wait it out; if a
// Turnstile / managed challenge is present, wait for the user to solve it.
async function passCloudflare(page) {
  const initial = await cloudflare.detect(PAGE_NAME);
  console.log(`[cf] state=${initial.kind} ray=${initial.rayId ?? "-"}`);
  if (initial.kind === "none") return;

  if (initial.kind === "interstitial") {
    const r = await cloudflare.waitForPass(PAGE_NAME, { timeoutMs: 30_000 });
    console.log(`[cf] interstitial ${r.passed ? "passed" : "stuck"} in ${r.elapsedMs}ms`);
    if (!r.passed) throw new Error(`CF interstitial did not clear (${r.finalKind})`);
    return;
  }

  if (initial.kind === "turnstile" || initial.kind === "managed-challenge") {
    console.log("[cf] solve the challenge in the browser window — waiting up to 5 min");
    const r = await cloudflare.waitForSolve(PAGE_NAME, { timeoutMs: 5 * 60_000 });
    console.log(`[cf] human solve ${r.passed ? "ok" : "failed"} in ${r.elapsedMs}ms`);
    if (!r.passed) throw new Error(`CF challenge did not resolve (${r.finalKind})`);
    return;
  }

  throw new Error(`Cloudflare blocked: ${initial.kind} — ${initial.notes.join("; ")}`);
}

(async () => {
  // Replay any prior cf_clearance cookie to skip re-solving the challenge.
  const restored = await cloudflare.restoreClearance("tenderarena.cz");
  if (restored) {
    console.log(`[cf] restored ${restored.restored} clearance cookie(s)`);
  }

  const page = await browser.getPage(PAGE_NAME);

  await page.goto(HOME, { waitUntil: "domcontentloaded" });
  await passCloudflare(page);

  // Wait for the listing to render. networkidle is unreliable on CF-protected
  // pages because the challenge platform keeps long-poll requests open.
  await page.waitForLoadState("domcontentloaded");
  await humanDelay(page);

  // Identify a tender detail link. The selector is a best guess for
  // tenderarena — adjust to whatever the real markup uses. The pattern here
  // tries multiple likely selectors so the script survives small layout
  // changes; the first matching strategy wins.
  const detailCandidates = [
    () => page.getByRole("link", { name: /detail/i }).first(),
    () => page.locator('a[href*="/dodavatel/zakazka"]').first(),
    () => page.locator("a.btn-detail, a.detail-link").first(),
    () => page.locator("table a").first(),
  ];

  let detailLink = null;
  for (const make of detailCandidates) {
    const candidate = make();
    if ((await candidate.count()) > 0) {
      detailLink = candidate;
      break;
    }
  }
  if (!detailLink) {
    throw new Error("Could not locate a tender detail link on the listing page");
  }

  await humanDelay(page, 800, 2000);
  await detailLink.scrollIntoViewIfNeeded();
  await humanDelay(page, 400, 1200);
  await detailLink.click();

  // After clicking, Cloudflare may interpose another challenge.
  await page.waitForLoadState("domcontentloaded");
  await passCloudflare(page);
  await humanDelay(page, 1000, 2500);

  // Wait long enough for a possible human CF solve before insisting on the
  // detail content. `waitForSelector` retries until it finds the heading.
  const title = await page
    .waitForSelector("h1, h2, .tender-title, [data-testid=tender-title]", {
      state: "visible",
      timeout: 6 * 60_000,
    })
    .then((el) => el.innerText());

  // Description: try several likely containers, fall back to the page body.
  const descCandidates = [
    ".tender-description",
    "[data-testid=tender-description]",
    "#popis",
    ".popis",
    "main",
  ];
  let description = "";
  for (const sel of descCandidates) {
    if ((await page.locator(sel).count()) > 0) {
      description = (await page.locator(sel).first().innerText()).trim();
      if (description.length > 0) break;
    }
  }

  console.log("─".repeat(60));
  console.log("Title:", title.trim());
  console.log("─".repeat(60));
  console.log(description.slice(0, 2000));
  console.log("─".repeat(60));

  // Save fresh CF cookies for next run.
  const saved = await cloudflare.saveClearance("tenderarena.cz");
  console.log(`[cf] saved ${saved.cookies.length} clearance cookie(s)`);
})();
