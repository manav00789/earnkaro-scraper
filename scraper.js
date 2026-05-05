/**
 * EarnKaro scraper - Daily Edition
 * - Scrolls inside modal to capture full content
 * - Stitches all scroll positions into one tall image
 * - Captures both PROFIT RATES + OFFER DETAILS tabs
 * - Robust timeout handling so one stuck store doesn't block all
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { createCanvas, loadImage } from "canvas";

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
const STORE_TIMEOUT_MS = 45000; // max 45s per store before skipping

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

// Scroll inside modal and stitch screenshots into one tall image
async function screenshotModalFull(page, modalSel) {
  const modal = await page.$(modalSel);
  if (!modal) {
    // Fallback: just screenshot viewport
    return await page.screenshot({ type: "png" });
  }

  const box = await modal.boundingBox();
  if (!box) return await page.screenshot({ type: "png" });

  // Scroll modal content to top
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const scrollable = el?.querySelector('[class*="body"], [class*="content"], [class*="scroll"]') || el;
    if (scrollable) scrollable.scrollTop = 0;
  }, modalSel);
  await delay(400);

  const screenshots = [];
  let lastScrollTop = -1;

  // Scroll and capture in chunks
  while (true) {
    const buf = await page.screenshot({ type: "png", clip: box });
    screenshots.push(buf);

    const { scrollTop, scrollHeight, clientHeight } = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const scrollable = el?.querySelector('[class*="body"], [class*="content"], [class*="scroll"]') || el;
      return {
        scrollTop:    scrollable?.scrollTop ?? 0,
        scrollHeight: scrollable?.scrollHeight ?? 0,
        clientHeight: scrollable?.clientHeight ?? 0,
      };
    }, modalSel);

    if (scrollTop === lastScrollTop || scrollTop + clientHeight >= scrollHeight) break;
    lastScrollTop = scrollTop;

    // Scroll down by modal height
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const scrollable = el?.querySelector('[class*="body"], [class*="content"], [class*="scroll"]') || el;
      if (scrollable) scrollable.scrollTop += scrollable.clientHeight - 40;
    }, modalSel);
    await delay(400);
  }

  if (screenshots.length === 1) return screenshots[0];

  // Stitch screenshots vertically using canvas
  const images = await Promise.all(screenshots.map(b => loadImage(b)));
  const totalHeight = images.reduce((sum, img) => sum + img.height, 0);
  const canvas = createCanvas(images[0].width, totalHeight);
  const ctx = canvas.getContext("2d");
  let y = 0;
  for (const img of images) {
    ctx.drawImage(img, 0, y);
    y += img.height;
  }
  return canvas.toBuffer("image/png");
}

async function uploadBuffer(buffer, path) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: "image/png", upsert: true });
  if (error) throw new Error(`Upload: ${error.message}`);
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
    console.log(`✓ Logged in`);
  } finally {
    await page.close();
  }
}

// ── SCRAPE ALL STORES ─────────────────────────────────────────────────────

async function scrapeAllStores(context) {
  const page = await context.newPage();
  await stealthPage(page);

  console.log("→ Loading partners page...");
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
  await delay(3000);

  // Scroll to bottom to load all lazy cards
  console.log("→ Scrolling to load all cards...");
  let prevHeight = 0;
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(800);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prevHeight) break;
    prevHeight = h;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(800);

  // Count VIEW PROFIT RATES buttons
  const totalStores = await page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter(el => el.innerText?.trim().toUpperCase() === "VIEW PROFIT RATES")
      .length
  );
  console.log(`→ Found ${totalStores} stores`);

  if (totalStores === 0) {
    await page.screenshot({ path: "debug_no_stores.png", fullPage: true });
    throw new Error("No stores found");
  }

  const limit = MAX_RETAILERS ? Number(MAX_RETAILERS) : totalStores;
  const MODAL_SEL = '[role="dialog"], .modal-content, [class*="modal"][class*="content"], [class*="popup"]';

  for (let i = 0; i < Math.min(limit, totalStores); i++) {
    // Re-fetch buttons fresh each iteration (DOM can shift)
    const allBtns = await page.$$("text=VIEW PROFIT RATES");
    if (i >= allBtns.length) { console.log("→ No more buttons found, stopping"); break; }

    const btn = allBtns[i];

    // Get store name from img[alt] inside the same card
    const storeName = await btn.evaluate((el) => {
      let node = el.parentElement;
      for (let j = 0; j < 6; j++) {
        const img = node?.querySelector("img[alt]");
        if (img?.alt?.trim()) return img.alt.trim();
        node = node?.parentElement;
      }
      return null;
    });

    if (!storeName) { console.log(`[${i+1}] Skipping — no store name found`); continue; }

    const slug = slugify(storeName);
    console.log(`\n[${i+1}/${Math.min(limit, totalStores)}] ${storeName}`);

    // Per-store timeout — skip if hangs
    const storeTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Store timeout after 45s")), STORE_TIMEOUT_MS)
    );

    try {
      await Promise.race([
        (async () => {
          await btn.scrollIntoViewIfNeeded();
          await delay(400);
          await btn.click();
          await delay(1500);

          // Wait for modal
          await page.waitForSelector(MODAL_SEL, { timeout: 8000 });
          await delay(600);

          // ── Tab 1: PROFIT RATES (default) — scroll & stitch ──
          const profitBuf = await screenshotModalFull(page, MODAL_SEL);
          await uploadBuffer(profitBuf, `${slug}/${today}_profit_rates.png`);
          console.log(`  ✓ Profit rates`);

          // ── Tab 2: OFFER DETAILS ──
          try {
            // Click the tab
            const offerTab = await page.$('text=OFFER DETAILS');
            if (offerTab) {
              await offerTab.click();
              await delay(800);
              // Scroll modal back to top for offer details
              await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                const scrollable = el?.querySelector('[class*="body"],[class*="content"],[class*="scroll"]') || el;
                if (scrollable) scrollable.scrollTop = 0;
              }, MODAL_SEL);
              await delay(400);
              const offerBuf = await screenshotModalFull(page, MODAL_SEL);
              await uploadBuffer(offerBuf, `${slug}/${today}_offer_details.png`);
              console.log(`  ✓ Offer details`);
            } else {
              console.warn(`  ⚠ OFFER DETAILS tab not found for ${storeName}`);
            }
          } catch (e) {
            console.warn(`  ⚠ Offer details failed: ${e.message}`);
          }

          // ── DB upsert ──
          const { error } = await supabase.from("snapshots").upsert({
            retailer_name:    storeName,
            retailer_slug:    slug,
            image_path:       `${slug}/${today}_profit_rates.png`,
            offer_image_path: `${slug}/${today}_offer_details.png`,
            captured_on:      today,
            updated_at:       new Date().toISOString(),
          }, { onConflict: "retailer_slug,captured_on" });
          if (error) console.warn(`  ⚠ DB: ${error.message}`);

          // ── Close modal ──
          try {
            const closeBtn = await page.$('[aria-label="Close"], button:has-text("×"), [class*="close-btn"], [class*="closeBtn"]');
            if (closeBtn) await closeBtn.click();
            else await page.keyboard.press("Escape");
          } catch { await page.keyboard.press("Escape"); }
          await delay(600);

          console.log(`  ✓ Done`);
        })(),
        storeTimeout,
      ]);
    } catch (err) {
      console.error(`  ✗ ${storeName}: ${err.message}`);
      // Force close modal and continue
      try { await page.keyboard.press("Escape"); } catch {}
      await delay(800);
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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
           "--disable-blink-features=AutomationControlled", "--window-size=1920,1080"],
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
