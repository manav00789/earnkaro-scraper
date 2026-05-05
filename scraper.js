/**
 * EarnKaro scraper - Daily Edition
 * - Extracts profit rates + offer details as TEXT (copyable)
 * - Also saves screenshot of modal
 * - Reloads stores page for each store to avoid DOM shift issues
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  EARNKARO_EMAIL    = "manav.sharma@acem.edu.in",
  EARNKARO_PASSWORD = "manav11",
  PAGE_TIMEOUT_MS   = "30000",
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

// ── LOGIN ──────────────────────────────────────────────────────────────────

async function login(context) {
  console.log("→ Logging in...");
  const page = await context.newPage();
  await stealthPage(page);
  try {
    await page.goto("https://earnkaro.com/login", { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(2000);
    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    await page.fill('input[type="text"]', EARNKARO_EMAIL);
    await delay(400);
    await page.click('button:has-text("Continue")');
    await delay(2000);
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', EARNKARO_PASSWORD);
    await delay(400);
    await page.click('button:has-text("Continue")');
    await page.waitForFunction(() => !window.location.href.includes("/login"), { timeout: 20000 });
    console.log("✓ Logged in");
  } finally {
    await page.close();
  }
}

// ── LOAD STORES PAGE + COLLECT ALL STORE NAMES ────────────────────────────
// Returns array of store names in order from the page

async function collectStoreNames(context) {
  const page = await context.newPage();
  await stealthPage(page);
  try {
    console.log("→ Loading stores page to collect names...");
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(3000);

    // Scroll all the way down to load lazy cards
    let prevHeight = 0;
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(700);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prevHeight) break;
      prevHeight = h;
    }
    await delay(500);

    // Collect store names from img[alt] inside each card that has VIEW PROFIT RATES
    const names = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll("*").forEach((el) => {
        if (el.innerText?.trim().toUpperCase() !== "VIEW PROFIT RATES") return;
        // Walk up to find img[alt] in the card
        let node = el.parentElement;
        for (let j = 0; j < 8; j++) {
          const img = node?.querySelector("img[alt]");
          if (img?.alt?.trim()) {
            results.push(img.alt.trim());
            return;
          }
          node = node?.parentElement;
        }
        results.push(null); // placeholder if name not found
      });
      return results;
    });

    const valid = names.filter(Boolean);
    console.log(`→ Found ${valid.length} stores`);
    return valid;
  } finally {
    await page.close();
  }
}

// ── EXTRACT TEXT FROM MODAL ────────────────────────────────────────────────

async function extractModalData(page) {
  const MODAL = '[role="dialog"], [class*="modal-content"], [class*="modalContent"], [class*="popup"]';

  // ── PROFIT RATES tab (default) ──
  const profitRates = await page.evaluate((sel) => {
    const modal = document.querySelector(sel);
    if (!modal) return [];
    const rows = [];

    // Find all rows — each typically has a % value + description side by side
    // Strategy: find elements with % or ₹ in text, pair with sibling text
    const allEls = [...modal.querySelectorAll("*")];
    allEls.forEach((el) => {
      const text = el.innerText?.trim();
      if (!text) return;
      // Match lines like "8%", "10.20%", "Flat Rs 40", "₹40"
      if (/^\d+(\.\d+)?%$/.test(text) || /^(flat\s*)?(rs\.?\s*|₹)\d+/i.test(text)) {
        // Get the description — next sibling or parent's next child
        const parent = el.parentElement;
        const children = [...(parent?.children || [])];
        const idx = children.indexOf(el);
        const desc = children[idx + 1]?.innerText?.trim()
                  || el.nextElementSibling?.innerText?.trim()
                  || "";
        if (desc) rows.push({ rate: text, description: desc });
      }
    });

    // Deduplicate
    const seen = new Set();
    return rows.filter(r => {
      const key = r.rate + r.description;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, MODAL);

  // Screenshot of profit rates tab (full modal scroll)
  const profitScreenshot = await screenshotFullModal(page, MODAL);

  // ── OFFER DETAILS tab ──
  let offerText = "";
  let offerScreenshot = null;
  try {
    const offerTab = await page.$('text=OFFER DETAILS');
    if (offerTab) {
      await offerTab.click();
      await delay(700);
      offerText = await page.evaluate((sel) => {
        const modal = document.querySelector(sel);
        if (!modal) return "";
        // Get all text content from the offer details tab body
        const body = modal.querySelector('[class*="tab"], [class*="content"], [class*="body"]') || modal;
        return body.innerText?.trim() || "";
      }, MODAL);
      offerScreenshot = await screenshotFullModal(page, MODAL);
    }
  } catch (e) {
    console.warn(`  ⚠ Offer details extraction failed: ${e.message}`);
  }

  return { profitRates, profitScreenshot, offerText, offerScreenshot };
}

// ── SCROLL MODAL + SCREENSHOT ──────────────────────────────────────────────

async function screenshotFullModal(page, modalSel) {
  // Reset scroll to top
  await page.evaluate((sel) => {
    const modal = document.querySelector(sel);
    const scrollable = modal?.querySelector('[class*="body"],[class*="content"],[class*="scroll"]') || modal;
    if (scrollable) scrollable.scrollTop = 0;
  }, modalSel);
  await delay(300);

  const modal = await page.$(modalSel);
  if (!modal) return await page.screenshot({ type: "png" });

  // Get modal bounding box
  const box = await modal.boundingBox();
  if (!box) return await page.screenshot({ type: "png" });

  // Take screenshot of just the modal element (Playwright clips to element)
  return await modal.screenshot({ type: "png" });
}

// ── PROCESS ONE STORE ──────────────────────────────────────────────────────

async function processStore(context, storeName, storeIndex, totalStores) {
  const slug = slugify(storeName);
  console.log(`\n[${storeIndex}/${totalStores}] ${storeName}`);

  const page = await context.newPage();
  await stealthPage(page);

  try {
    // Load stores page fresh
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(2500);

    // Scroll down enough to load the card (approx — we'll search all loaded cards)
    let found = false;
    let scrollAttempts = 0;

    while (!found && scrollAttempts < 30) {
      // Find the VIEW PROFIT RATES button for this specific store
      const btn = await page.evaluateHandle((targetName) => {
        const buttons = [...document.querySelectorAll("*")]
          .filter(el => el.innerText?.trim().toUpperCase() === "VIEW PROFIT RATES");

        for (const btn of buttons) {
          let node = btn.parentElement;
          for (let j = 0; j < 8; j++) {
            const img = node?.querySelector("img[alt]");
            if (img?.alt?.trim().toLowerCase() === targetName.toLowerCase()) {
              return btn;
            }
            node = node?.parentElement;
          }
        }
        return null;
      }, storeName);

      if (btn.asElement()) {
        found = true;
        await btn.asElement().scrollIntoViewIfNeeded();
        await delay(500);
        await btn.asElement().click();
        console.log(`  → Clicked VIEW PROFIT RATES`);
      } else {
        // Scroll more to load lazy cards
        await page.evaluate(() => window.scrollBy(0, 800));
        await delay(600);
        scrollAttempts++;
      }
    }

    if (!found) {
      console.warn(`  ⚠ Button not found for "${storeName}" after scrolling — skipping`);
      return;
    }

    // Wait for modal
    const MODAL = '[role="dialog"], [class*="modal-content"], [class*="modalContent"], [class*="popup"]';
    await page.waitForSelector(MODAL, { timeout: 8000 });
    await delay(800);

    // Extract data
    const { profitRates, profitScreenshot, offerText, offerScreenshot } = await extractModalData(page);
    console.log(`  → Profit rows: ${profitRates.length}, Offer text: ${offerText.length} chars`);

    // Upload screenshots
    let profitImagePath = null;
    let offerImagePath = null;

    if (profitScreenshot) {
      profitImagePath = `${slug}/${today}_profit_rates.png`;
      const { error } = await supabase.storage.from(BUCKET)
        .upload(profitImagePath, profitScreenshot, { contentType: "image/png", upsert: true });
      if (error) console.warn(`  ⚠ Profit screenshot upload: ${error.message}`);
      else console.log(`  ✓ Profit screenshot uploaded`);
    }

    if (offerScreenshot) {
      offerImagePath = `${slug}/${today}_offer_details.png`;
      const { error } = await supabase.storage.from(BUCKET)
        .upload(offerImagePath, offerScreenshot, { contentType: "image/png", upsert: true });
      if (error) console.warn(`  ⚠ Offer screenshot upload: ${error.message}`);
      else console.log(`  ✓ Offer screenshot uploaded`);
    }

    // Upsert to DB with full text data
    const { error: dbErr } = await supabase.from("snapshots").upsert({
      retailer_name:    storeName,
      retailer_slug:    slug,
      profit_rates:     JSON.stringify(profitRates),   // e.g. [{"rate":"8%","description":"..."}]
      offer_details:    offerText,                      // plain text, copyable
      image_path:       profitImagePath,
      offer_image_path: offerImagePath,
      captured_on:      today,
      updated_at:       new Date().toISOString(),
    }, { onConflict: "retailer_slug,captured_on" });

    if (dbErr) console.warn(`  ⚠ DB: ${dbErr.message}`);
    else console.log(`  ✓ Saved to DB`);

  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("→ Launching browser...");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
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

    // Step 1: collect all store names in one pass
    let storeNames = await collectStoreNames(context);
    if (storeNames.length === 0) throw new Error("No stores found");

    if (MAX_RETAILERS) storeNames = storeNames.slice(0, Number(MAX_RETAILERS));
    console.log(`\n→ Processing ${storeNames.length} stores one by one...\n`);

    // Step 2: process each store on a fresh page load
    for (let i = 0; i < storeNames.length; i++) {
      try {
        await Promise.race([
          processStore(context, storeNames[i], i + 1, storeNames.length),
          new Promise((_, rej) => setTimeout(() => rej(new Error("45s timeout")), 45000)),
        ]);
      } catch (err) {
        console.error(`  ✗ Skipped "${storeNames[i]}": ${err.message}`);
      }
    }

    console.log("\n✓ All done");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
