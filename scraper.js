/**
 * EarnKaro scraper - GitHub Actions Edition
 * - Scrapes earnkaro.com/stores (Partners page)
 * - Clicks each store card → takes full-page screenshot
 * - Uploads to Supabase Storage + upserts metadata
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import ws from "ws";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  EARNKARO_EMAIL    = "manav.sharma@acem.edu.in",
  EARNKARO_PASSWORD = "manav11",
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

const BUCKET      = "retailer-snapshots";
const today       = new Date().toISOString().slice(0, 10);
const pageTimeout = Number(PAGE_TIMEOUT_MS);

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function slugify(input) {
  return input.toLowerCase().trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      console.warn(`[retry ${i}/${attempts}] ${label}: ${err.message}`);
      await delay(3000 * i);
    }
  }
  throw lastErr;
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

// ── COLLECT ALL STORE URLs BY CLICKING "VIEW PROFIT RATES" ────────────────

async function collectStoreUrls(context) {
  const page = await context.newPage();
  await stealthPage(page);

  console.log(`→ Loading partners page...`);
  await page.goto(START_URL, { waitUntil: "networkidle", timeout: pageTimeout });
  await delay(4000);

  await page.screenshot({ path: "debug_partners.png", fullPage: false });
  console.log(`→ Page URL: ${page.url()}`);

  // Scroll to load ALL lazy-loaded cards
  let prevHeight = 0;
  while (true) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;
    prevHeight = newHeight;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(1000);

  await page.screenshot({ path: "debug_partners_full.png", fullPage: true });

  // ── Strategy: collect hrefs from "VIEW PROFIT RATES" links ──
  // From the screenshot these are <a> tags with text "VIEW PROFIT RATES"
  let storeLinks = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll("a").forEach((a) => {
      const text = a.innerText?.trim().toUpperCase();
      if (text === "VIEW PROFIT RATES" && a.href && a.href.includes("earnkaro")) {
        // Get store name from sibling/parent card
        const card = a.closest("[class]");
        const nameEl = card?.querySelector("img");
        const name = nameEl?.alt || nameEl?.title || 
                     card?.querySelector("h2,h3,h4,p,span")?.innerText?.trim() ||
                     a.href.split("/").pop();
        results.push({ name: name || a.href.split("/").pop(), url: a.href });
      }
    });
    return results;
  });

  console.log(`→ Found ${storeLinks.length} "VIEW PROFIT RATES" links`);

  // ── Fallback: grab all unique earnkaro links that look like store pages ──
  if (storeLinks.length === 0) {
    console.log("→ Fallback: scanning all links...");
    storeLinks = await page.evaluate(() => {
      const skip = ["/stores", "/login", "/signup", "/about", "/contact",
                    "/faq", "/terms", "/privacy", "/blog", "/refer",
                    "/wallet", "/profile", "/offer", "#", "javascript"];
      const out = new Map();
      document.querySelectorAll("a[href]").forEach((a) => {
        const href = a.href;
        if (!href.includes("earnkaro.com")) return;
        if (skip.some(s => href.includes(s))) return;
        const path = new URL(href).pathname;
        if (path === "/" || path.length < 3) return;
        const name = a.closest("[class]")?.querySelector("img")?.alt
                  || a.innerText?.trim()
                  || path.split("/").pop();
        if (name && name.length > 0) out.set(href, { name, url: href });
      });
      return Array.from(out.values());
    });
    console.log(`→ Fallback found ${storeLinks.length} links`);
  }

  // ── Fallback 2: get names from img[alt] inside cards + click to get URL ──
  if (storeLinks.length === 0) {
    console.log("→ Fallback 2: reading store names from card images...");
    storeLinks = await page.evaluate(() => {
      const cards = [];
      // Cards appear to be grid items with logos — grab all card containers
      document.querySelectorAll("img[alt]").forEach((img) => {
        const alt = img.alt?.trim();
        if (!alt || alt.length < 2) return;
        const link = img.closest("a") || img.parentElement?.closest("a");
        if (link?.href && link.href.includes("earnkaro")) {
          cards.push({ name: alt, url: link.href });
        }
      });
      return cards;
    });
    console.log(`→ Fallback 2 found ${storeLinks.length} stores via img[alt]`);
  }

  // Dump what we found
  storeLinks.slice(0, 10).forEach(s => console.log(`   ${s.name} → ${s.url}`));

  await page.close();
  return storeLinks;
}

// ── CAPTURE ONE STORE PAGE ─────────────────────────────────────────────────

async function captureStore(context, store) {
  const slug = slugify(store.name);
  const page = await context.newPage();
  await stealthPage(page);

  try {
    await withRetry(`Capture: ${store.name}`, async () => {
      await page.goto(store.url, { waitUntil: "networkidle", timeout: pageTimeout });
      await delay(2500);

      const buffer      = await page.screenshot({ fullPage: true, type: "png" });
      const storagePath = `${slug}/${today}.png`;

      const { error: uploadErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buffer, { contentType: "image/png", upsert: true });
      if (uploadErr) throw new Error(`Upload: ${uploadErr.message}`);

      const { error: dbErr } = await supabase.from("snapshots").upsert(
        {
          retailer_name: store.name,
          retailer_slug: slug,
          image_path:    storagePath,
          captured_on:   today,
          updated_at:    new Date().toISOString(),
        },
        { onConflict: "retailer_slug,captured_on" }
      );
      if (dbErr) throw new Error(`DB: ${dbErr.message}`);
    });

    console.log(`✓ ${store.name}`);
  } catch (err) {
    console.error(`✗ ${store.name}: ${err.message}`);
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

    let stores = await collectStoreUrls(context);

    if (stores.length === 0) {
      console.error("✗ No stores found — check debug_partners.png and debug_partners_full.png in artifacts");
      process.exit(1);
    }

    if (MAX_RETAILERS) stores = stores.slice(0, Number(MAX_RETAILERS));
    console.log(`→ Capturing ${stores.length} stores with concurrency 2...`);

    const limit = pLimit(2);
    await Promise.all(stores.map((s) => limit(() => captureStore(context, s))));

    console.log("✓ All done");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
