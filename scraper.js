/**
 * CacheKaro scraper - Advanced Stealth Edition
 * ---------------------------------------------------------------
 * Handles direct login flow and saves session to 'auth.json'.
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

// Credentials
const USER_EMAIL = 'manav.sharma@acem.edu.in';
const USER_PASS = Buffer.from('bWFuYXYxMQ==', 'base64').toString('utf8');

const delay = (ms) => new Promise(res => setTimeout(res, ms));

function slugify(input) {
  return input.toLowerCase().trim().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

// ---- authentication ------------------------------------------------------

async function performLogin(page) {
  console.log("Navigating to Login...");
  await page.goto('https://earnkaro.com/login', { waitUntil: 'networkidle' });

  const inputSelector = 'input[type="text"], input[type="email"], .form-control';
  await page.waitForSelector(inputSelector);
  await page.fill(inputSelector, USER_EMAIL);
  
  console.log("Email entered. Clicking Continue...");
  await page.click('button:has-text("Continue")');

  // If the site asks for a password instead of OTP
  const passSelector = 'input[type="password"]';
  try {
    await page.waitForSelector(passSelector, { timeout: 5000 });
    await page.fill(passSelector, USER_PASS);
    await page.click('button:has-text("Login"), button:has-text("Continue")');
  } catch (e) {
    console.log("Password field not found, likely waiting for OTP/SMS...");
    // If it's OTP, it will wait for you to enter it manually or via your Gmail API integration
    await page.waitForURL('**/dashboard**', { timeout: 120000 });
  }

  await page.context().storageState({ path: 'auth.json' });
  console.log("✓ Session saved to auth.json");
}

// ---- discovery -----------------------------------------------------------

async function discoverRetailers(context) {
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://earnkaro.com/' });

  console.log(`Navigating to: ${START_URL}`);
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
  await delay(5000);

  try {
    await page.waitForSelector('img[src*="retailer"], .store-card, a[href*="/stores/"]', { timeout: 30000 });
  } catch (e) {
    if (page.url().includes('/login')) {
      await performLogin(page);
      await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    } else {
      throw new Error("Grid failed to load. Check debug_error.png");
    }
  }

  // Lazy load
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      let distance = 500;
      let timer = setInterval(() => {
        let scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) { clearInterval(timer); resolve(); }
      }, 400);
    });
  });

  const retailers = await page.evaluate(() => {
    const out = new Map();
    document.querySelectorAll('a[href*="/stores/"]').forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href || /\/stores\/?$/.test(href) || href.includes('all-stores')) return;
      const name = anchor.innerText.split('\n').map(t => t.trim()).find(t => t.length > 0);
      if (name) out.set(href, { name, url: new URL(href, location.origin).toString() });
    });
    return Array.from(out.values());
  });

  await page.close();
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
      const path = `${slug}/${today}.png`;
      
      const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: "image/png", upsert: true });
      if (error) throw error;

      await supabase.from("snapshots").upsert({
        retailer_name: retailer.name,
        retailer_slug: slug,
        image_path: path,
        captured_on: today,
      }, { onConflict: "retailer_slug,captured_on" });
    });
    console.log(`✓ ${retailer.name}`);
  } catch (err) {
    console.error(`✗ ${retailer.name}: ${err.message}`);
  } finally {
    await page.close();
  }
}

// ---- main ----------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const storageState = fs.existsSync('auth.json') ? 'auth.json' : undefined;
  
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  try {
    let retailers = await discoverRetailers(context);
    console.log(`Found ${retailers.length} retailers.`);
    if (MAX_RETAILERS) retailers = retailers.slice(0, Number(MAX_RETAILERS));

    const limit = pLimit(concurrency);
    await Promise.all(retailers.map((r) => limit(() => captureRetailer(context, r))));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
