/**
 * EarnKaro scraper - GitHub Actions Edition
 * - Clicks each store's "VIEW PROFIT RATES" → opens modal
 * - Screenshots both "PROFIT RATES" and "OFFER DETAILS" tabs
 * - Uploads both to Supabase Storage
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  EARNKARO_EMAIL    = "manav.sharma@acem.edu.in",
  EARNKARO_PASSWORD = "bWFuYXYxMQ==",
  PAGE_TIMEOUT_MS   = "60000",
  MAX_RETAILERS,
  START_URL         = "https://earnkaro.com/stores",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

const BUCKET      = "earnkaro";
const today       = new Date().toISOString().slice(0, 10);
const pageTimeout = Number(PAGE_TIMEOUT_MS);

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function slugify(input) {
  return input.toLowerCase().trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function stealthPage(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });
}

async function uploadScreenshot(buffer, path) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: "image/png", upsert: true });
  if (error) throw new Error(`Upload failed: ${error.message}`);
}

async function upsertRecord(data) {
  const { error } = await supabase.from("snapshots").upsert(data, {
    onConflict: "retailer_slug,captured_on",
  });
  if (error) throw new Error(`DB upsert failed: ${error.message}`);
}

// ── LOGIN ──────────────────────────────────────────────────────────────────

async function login(context) {
  console.log("→ Logging in...");
  const page = await context.newPage();
  await stealthPage(page);
  try {
    await page.goto("https://earnkaro.com/login", { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(3000);
    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    await page.fill('input[type="text"]', EARNKARO_EMAIL);
    await delay(500);
    await page.click('button:has-text("Continue")');
    await delay(3000);
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', EARNKARO_PASSWORD);
    await delay(500);
    await page.click('button:has-text("Continue")');
    await page.waitForFunction(() => !window.location.href.includes("/login"), { timeout: 20000 });
    console.log(`✓ Logged in! URL: ${page.url()}`);
  } finally {
    await page.close();
  }
}

// ── SCRAPE ALL STORES ON THE PAGE ─────────────────────────────────────────

async function scrapeAllStores(context) {
  const page = await context.newPage();
  await stealthPage(page);

  console.log("→ Loading partners page...");
  await page.goto(START_URL, { waitUntil: "networkidle", timeout: pageTimeout });
  await delay(4000);

  // Scroll fully to load all lazy-loaded store cards
  console.log("→ Scrolling to load all cards...");
  let prevHeight = 0;
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(1500);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;
    prevHeight = newHeight;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(1000);

  // Count all "VIEW PROFIT RATES" buttons
  const totalStores = await page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter(el => el.innerText?.trim().toUpperCase() === "VIEW PROFIT RATES")
      .length
  );
  console.log(`→ Found ${totalStores} stores`);

  if (totalStores === 0) {
    await page.screenshot({ path: "debug_no_stores.png", fullPage: true });
    throw new Error("No stores found — check debug_no_stores.png");
  }

  const limit = MAX_RETAILERS ? Number(MAX_RETAILERS) : totalStores;

  // Process one store at a time (modal approach — can't parallelize on same page)
  for (let i = 0; i < Math.min(limit, totalStores); i++) {
    // Re-query each time since DOM may shift after modal close
    const storeButtons = await page.$$eval("*", (els) =>
      els
        .filter(el => el.innerText?.trim().toUpperCase() === "VIEW PROFIT RATES")
        .map((el, idx) => ({ idx }))
    );

    if (i >= storeButtons.length) break;

    // Get all matching elements fresh
    const allBtns = await page.$$("text=VIEW PROFIT RATES");
    if (i >= allBtns.length) break;

    const btn = allBtns[i];

    // Get store name from nearby img[alt] in the same card
    const storeName = await btn.evaluate((el) => {
      const card = el.closest("[class]") || el.parentElement;
      const img  = card?.querySelector("img[alt]");
      if (img?.alt?.trim()) return img.alt.trim();
      // Fallback: walk up to find any text that looks like a brand name
      let node = el.parentElement;
      for (let j = 0; j < 5; j++) {
        const imgs = node?.querySelectorAll("img[alt]");
        if (imgs?.length) return imgs[0].alt.trim();
        node = node?.parentElement;
      }
      return `store-${Date.now()}`;
    });

    const slug = slugify(storeName);
    console.log(`\n[${i + 1}/${Math.min(limit, totalStores)}] ${storeName}`);

    try {
      // Scroll button into view and click
      await btn.scrollIntoViewIfNeeded();
      await delay(500);
      await btn.click();
      await delay(2000);

      // Wait for modal to appear
      const modalSel = '[role="dialog"], .modal, [class*="modal"], [class*="popup"], [class*="overlay"]';
      try {
        await page.waitForSelector(modalSel, { timeout: 8000 });
      } catch {
        console.warn(`  ⚠ Modal not detected for ${storeName} — taking full page screenshot anyway`);
      }
      await delay(1000);

      // ── Screenshot Tab 1: PROFIT RATES (default active tab) ──
      const profitBuf = await page.screenshot({ fullPage: false, type: "png" });
      await uploadScreenshot(profitBuf, `${slug}/${today}_profit_rates.png`);
      console.log(`  ✓ Profit rates screenshot`);

      // ── Click OFFER DETAILS tab ──
      const offerTabSel = 'text=OFFER DETAILS, [role="tab"]:has-text("OFFER"), button:has-text("OFFER DETAILS")';
      try {
        await page.click(offerTabSel, { timeout: 5000 });
        await delay(1000);
        const offerBuf = await page.screenshot({ fullPage: false, type: "png" });
        await uploadScreenshot(offerBuf, `${slug}/${today}_offer_details.png`);
        console.log(`  ✓ Offer details screenshot`);
      } catch {
        console.warn(`  ⚠ Could not click OFFER DETAILS tab for ${storeName}`);
      }

      // ── Upsert DB record ──
      await upsertRecord({
        retailer_name:       storeName,
        retailer_slug:       slug,
        image_path:          `${slug}/${today}_profit_rates.png`,
        offer_image_path:    `${slug}/${today}_offer_details.png`,
        captured_on:         today,
        updated_at:          new Date().toISOString(),
      });

      // ── Close modal ──
      const closeSel = '[aria-label="Close"], button:has-text("×"), .close, [class*="close"]';
      try {
        await page.click(closeSel, { timeout: 3000 });
      } catch {
        await page.keyboard.press("Escape");
      }
      await delay(1000);

      console.log(`  ✓ Done: ${storeName}`);

    } catch (err) {
      console.error(`  ✗ ${storeName}: ${err.message}`);
      // Try to close any open modal before continuing
      try { await page.keyboard.press("Escape"); } catch {}
      await delay(1000);
    }
  }

  await page.screenshot({ path: "debug_final.png" });
  await page.close();
}

// ── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("→ Launching browser...");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
  });

  const context = await browser.newContext({
    viewport:   { width: 1920, height: 1080 },
    userAgent:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale:     "en-US",
    timezoneId: "Asia/Kolkata",
  });

  try {
    await login(context);
    await scrapeAllStores(context);
    console.log("\n✓ All done");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
