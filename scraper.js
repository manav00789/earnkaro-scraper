/**
 * EarnKaro scraper - GitHub Actions Edition
 * ---------------------------------------------------------------
 * - Headless Chromium via Playwright
 * - Cookie-string auth (no OTP/manual login needed in CI)
 * - Uploads screenshots to Supabase Storage
 * - Upserts metadata to `snapshots` table
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import ws from "ws";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  EARNKARO_COOKIE_STRING = "",   // set in GitHub Secrets
  CONCURRENCY = "3",
  PAGE_TIMEOUT_MS = "60000",
  MAX_RETAILERS,
  START_URL = "https://earnkaro.com/stores",
} = process.env;

// ---- guards --------------------------------------------------------------

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

// ---- supabase ------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },   // required for Node 20
});

// ---- constants -----------------------------------------------------------

const BUCKET        = "retailer-snapshots";
const today         = new Date().toISOString().slice(0, 10);
const pageTimeout   = Number(PAGE_TIMEOUT_MS);
const concurrency   = Math.max(1, Number(CONCURRENCY));

// ---- helpers -------------------------------------------------------------

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

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

/**
 * Parse EARNKARO_COOKIE_STRING (copied from browser DevTools → Network tab)
 * Format expected:  name=value; name2=value2; ...
 * Returns a Playwright-compatible cookie array for earnkaro.com
 */
function parseCookies(raw) {
  if (!raw.trim()) return [];
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf("=");
      const name  = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      return {
        name,
        value,
        domain: ".earnkaro.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      };
    });
}

// ---- discovery -----------------------------------------------------------

async function discoverRetailers(context) {
  const page = await context.newPage();

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://earnkaro.com/",
  });

  console.log(`→ Navigating to: ${START_URL}`);
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
  await delay(4000);

  // Redirect to login = cookies are invalid / missing
  if (page.url().includes("/login")) {
    throw new Error(
      "Redirected to login page — EARNKARO_COOKIE_STRING is missing or expired. " +
      "Copy fresh cookies from your browser and update the GitHub secret."
    );
  }

  // Wait for store grid
  try {
    await page.waitForSelector('a[href*="/stores/"]', { timeout: 30000 });
  } catch {
    await page.screenshot({ path: "debug_discover.png", fullPage: true });
    throw new Error("Store grid not found — see debug_discover.png artifact");
  }

  // Scroll to trigger lazy-load
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance  = 600;
      const timer     = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 350);
    });
  });

  await delay(2000);

  const retailers = await page.evaluate(() => {
    const out = new Map();
    document.querySelectorAll('a[href*="/stores/"]').forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href || /\/stores\/?$/.test(href) || href.includes("all-stores")) return;
      const name = [...anchor.innerText.split("\n")]
        .map((t) => t.trim())
        .find((t) => t.length > 0);
      if (name) {
        out.set(href, {
          name,
          url: new URL(href, location.origin).toString(),
        });
      }
    });
    return Array.from(out.values());
  });

  await page.close();
  console.log(`→ Discovered ${retailers.length} retailers`);
  return retailers;
}

// ---- worker --------------------------------------------------------------

async function captureRetailer(context, retailer) {
  const slug = slugify(retailer.name);
  const page = await context.newPage();

  try {
    await withRetry(`Capture: ${retailer.name}`, async () => {
      await page.goto(retailer.url, {
        waitUntil: "domcontentloaded",
        timeout: pageTimeout,
      });
      await delay(2500);

      const buffer = await page.screenshot({ fullPage: true, type: "png" });
      const storagePath = `${slug}/${today}.png`;

      // Upload screenshot
      const { error: uploadErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buffer, { contentType: "image/png", upsert: true });

      if (uploadErr) throw new Error(`Storage upload: ${uploadErr.message}`);

      // Upsert metadata row
      const { error: dbErr } = await supabase.from("snapshots").upsert(
        {
          retailer_name: retailer.name,
          retailer_slug: slug,
          image_path:    storagePath,
          captured_on:   today,
          updated_at:    new Date().toISOString(),
        },
        { onConflict: "retailer_slug,captured_on" }
      );

      if (dbErr) throw new Error(`DB upsert: ${dbErr.message}`);
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
  const cookies = parseCookies(EARNKARO_COOKIE_STRING);
  console.log(`→ Loaded ${cookies.length} cookies from env`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",         // critical for GitHub Actions
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport:  { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  // Inject cookies so we're already logged in
  if (cookies.length > 0) {
    await context.addCookies(cookies);
    console.log("→ Cookies injected");
  } else {
    console.warn("⚠ No cookies provided — scraper may hit login wall");
  }

  try {
    let retailers = await discoverRetailers(context);
    if (MAX_RETAILERS) retailers = retailers.slice(0, Number(MAX_RETAILERS));

    const limit = pLimit(concurrency);
    await Promise.all(
      retailers.map((r) => limit(() => captureRetailer(context, r)))
    );

    console.log("✓ Done");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
