/**
 * CacheKaro scraper - Stealth Auth Edition
 * ---------------------------------------------------------------
 * Uses 'auth.json' with advanced evasion to bypass bot detection.
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import fs from "fs";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  CONCURRENCY = "4",
  PAGE_TIMEOUT_MS = "45000",
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

// ---- helpers -------------------------------------------------------------

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
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw lastErr;
}

// ---- discovery -----------------------------------------------------------

async function discoverRetailers(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(pageTimeout);

  console.log(`Navigating to: ${START_URL}`);
  
  // Navigate with a more patient wait strategy
  await page.goto(START_URL, { waitUntil: "networkidle" });

  // Wait for the grid or specific card elements
  try {
    await page.waitForSelector('.store-card, .store-box, a[href*="/stores/"]', { timeout: 20000 });
  } catch (e) {
    console.error("CRITICAL: Store grid not found.");
    console.log(`Final URL reached: ${page.url()}`);
    
    // Take a debug screenshot to see what the bot sees (Auth error vs Bot Block)
    const debugBuf = await page.screenshot({ fullPage: true });
    await fs.writeFileSync('debug_error.png', debugBuf);
    console.log("Debug screenshot saved as debug_error.png");
    
    if (page.url().includes('/login')) {
      throw new Error("Session Expired: Redirected to Login. Update auth.json.");
    }
    throw new Error("Bot Blocked: The grid failed to load despite being on the correct URL.");
  }

  // Human-like scrolling
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });

  const retailers = await page.evaluate(() => {
    const out = new Map();
    const elements = document.querySelectorAll('a[href*="/stores/"], .store-card, .store-box');
    
    elements.forEach((el) => {
      const anchor = el.tagName === 'A' ? el : el.querySelector('a');
      if (!anchor) return;

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
  console.log(`Successfully discovered ${retailers.length} retailers.`);
  return retailers;
}

// ---- per-retailer worker -------------------------------------------------

async function captureRetailer(context, retailer) {
  const slug = slugify(retailer.name);
  const page = await context.newPage();
  
  try {
    await withRetry(`Capture: ${retailer.name}`, async () => {
      await page.goto(retailer.url, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000); // Wait for images to load
      
      const buffer = await page.screenshot({ fullPage: true, type: "png" });

      const primaryPath = `${slug}/${today}.png`;
      
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(primaryPath, buffer, {
          contentType: "image/png",
          upsert: true,
        });
      if (error) throw error;

      await supabase.from("snapshots").upsert({
        retailer_name: retailer.name,
        retailer_slug: slug,
        image_path: primaryPath,
        captured_on: today,
      }, { onConflict: "retailer_slug,captured_on" });

      await supabase.from("retailers").update({ 
        last_capture_at: new Date().toISOString() 
      }).eq("slug", slug);
    });

    console.log(`✓ Captured: ${retailer.name}`);
    return { ok: true };
  } catch (err) {
    console.error(`✗ Failed ${retailer.name}: ${err.message}`);
    return { ok: false };
  } finally {
    await page.close();
  }
}

// ---- main ----------------------------------------------------------------

async function main() {
  if (!fs.existsSync('auth.json')) {
    throw new Error("File 'auth.json' not found in root directory.");
  }

  const browser = await chromium.launch({ 
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });
  
  const context = await browser.newContext({
    storageState: 'auth.json',
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  // Stealth: Hide automation flags
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    let retailers = await discoverRetailers(context);
    
    if (MAX_RETAILERS) {
      retailers = retailers.slice(0, Number(MAX_RETAILERS));
    }

    const limit = pLimit(concurrency);
    const results = await Promise.all(
      retailers.map((r) => limit(() => captureRetailer(context, r)))
    );

    const ok = results.filter((r) => r.ok).length;
    console.log(`\nJob finished: ${ok}/${results.length} retailers processed.`);
    
    if (ok === 0) process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal Script Error:", err);
  process.exit(1);
});
