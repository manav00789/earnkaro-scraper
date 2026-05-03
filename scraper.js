/**
 * CacheKaro scraper - Advanced Stealth Edition
 * ---------------------------------------------------------------
 * Uses 'auth.json' with human-mimicry delays and header spoofing.
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import fs from "fs";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  CONCURRENCY = "4",
  PAGE_TIMEOUT_MS = "60000",
  MAX_RETAILERS,
  START_URL = "https://earnkaro.com/stores",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "retailer-snapshots";
const today = new Date().toISOString().slice(0, 10);
const pageTimeout = Number(PAGE_TIMEOUT_MS);
const concurrency = Math.max(1, Number(CONCURRENCY));

// Utility for human-like pauses
const delay = (ms) => new Promise(res => setTimeout(res, ms));

function slugify(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`[retry ${i}/${attempts}] ${label}: ${err.message}`);
      await delay(2000 * i);
    }
  }
  throw lastErr;
}

// ---- discovery -----------------------------------------------------------

async function discoverRetailers(context) {
  const page = await context.newPage();
  
  // Set headers to look like a standard Windows browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://earnkaro.com/'
  });

  console.log(`Navigating to: ${START_URL}`);
  
  // Use 'domcontentloaded' to avoid waiting for every tracking pixel
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
  
  // Random human-like delay before acting
  await delay(Math.floor(Math.random() * 3000) + 4000);

  try {
    // Look for store images or card containers
    await page.waitForSelector('img[src*="retailer"], .store-card, a[href*="/stores/"]', { timeout: 30000 });
  } catch (e) {
    console.error("CRITICAL: Store grid not found.");
    console.log(`Final URL: ${page.url()}`);
    
    const debugBuf = await page.screenshot({ fullPage: true });
    fs.writeFileSync('debug_error.png', debugBuf);
    console.log("Debug screenshot saved as debug_error.png");
    
    if (page.url().includes('/login')) {
      throw new Error("Session Expired: Redirected to Login. Refresh auth.json.");
    }
    throw new Error("Bot Blocked: The grid failed to load despite being on the correct URL.");
  }

  // Smooth scrolling to trigger lazy loading
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  });

  const retailers = await page.evaluate(() => {
    const out = new Map();
    const elements = document.querySelectorAll('a[href*="/stores/"]');
    
    elements.forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href || /\/stores\/?$/.test(href) || href.includes('all-stores')) return;

      const name = anchor.innerText.split('\n').map(t => t.trim()).find(t => t.length > 0);
      if (!name) return;

      const url = new URL(href, location.origin).toString();
      if (!out.has(url)) out.set(url, { name, url });
    });
    return Array.from(out.values());
  });

  await page.close();
  console.log(`Found ${retailers.length} retailers.`);
  return retailers;
}

// ---- worker --------------------------------------------------------------

async function captureRetailer(context, retailer) {
  const slug = slugify(retailer.name);
  const page = await context.newPage();
  
  try {
    await withRetry(`Capture: ${retailer.name}`, async () => {
      await page.goto(retailer.url, { waitUntil: "domcontentloaded" });
      await delay(3000); 
      
      const buffer = await page.screenshot({ fullPage: true, type: "png" });
      const primaryPath = `${slug}/${today}.png`;
      
      const { error: storageErr } = await supabase.storage
        .from(BUCKET)
        .upload(primaryPath, buffer, { contentType: "image/png", upsert: true });
      if (storageErr) throw storageErr;

      await supabase.from("snapshots").upsert({
        retailer_name: retailer.name,
        retailer_slug: slug,
        image_path: primaryPath,
        captured_on: today,
      }, { onConflict: "retailer_slug,captured_on" });
    });

    console.log(`✓ ${retailer.name}`);
    return { ok: true };
  } catch (err) {
    console.error(`✗ ${retailer.name}: ${err.message}`);
    return { ok: false };
  } finally {
    await page.close();
  }
}

// ---- main ----------------------------------------------------------------

async function main() {
  if (!fs.existsSync('auth.json')) {
    throw new Error("Missing auth.json in root directory.");
  }

  const browser = await chromium.launch({ 
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });
  
  const context = await browser.newContext({
    storageState: 'auth.json',
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  // Hide the navigator.webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    let retailers = await discoverRetailers(context);
    if (MAX_RETAILERS) retailers = retailers.slice(0, Number(MAX_RETAILERS));

    const limit = pLimit(concurrency);
    await Promise.all(retailers.map((r) => limit(() => captureRetailer(context, r))));

  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
