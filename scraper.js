/**
 * CacheKaro scraper - Updated for improved store discovery
 * ---------------------------------------------------------------
 * Standalone Node.js script designed to run on GitHub Actions.
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  EARNKARO_COOKIE_STRING,
  CONCURRENCY = "4",
  PAGE_TIMEOUT_MS = "45000",
  MAX_RETAILERS,
  START_URL = "https://earnkaro.com/stores",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
if (!EARNKARO_COOKIE_STRING) {
  throw new Error("Missing EARNKARO_COOKIE_STRING");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "retailer-snapshots";
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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

function parseCookieString(cookieString, domain = ".earnkaro.com") {
  return cookieString
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      return {
        name,
        value,
        domain,
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      };
    });
}

async function withRetry(label, fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`[retry ${i}/${attempts}] ${label}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

// ---- discovery -----------------------------------------------------------

async function discoverRetailers(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(pageTimeout);

  console.log(`Discovering retailers from ${START_URL}`);
  await page.goto(START_URL, { waitUntil: "networkidle" });

  // Wait for the grid container to ensure content is present
  try {
    await page.waitForSelector('a[href*="/stores/"], .store-card, .store-box', { timeout: 15000 });
  } catch (e) {
    console.warn("Timeout waiting for store selectors; attempting to scrape anyway.");
  }

  // Auto-scroll to trigger lazy loading
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 800;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });

  const retailers = await page.evaluate(() => {
    const out = new Map();
    // Broad selector to capture cards or direct links
    const elements = document.querySelectorAll('a[href*="/stores/"], .store-card, .store-box');
    
    elements.forEach((el) => {
      const anchor = el.tagName === 'A' ? el : el.querySelector('a');
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href || /\/stores\/?$/.test(href) || href.includes('all-stores')) return;

      // Clean name extraction: ignore profit percentage lines
      const name = anchor.innerText.split('\n').map(t => t.trim()).find(t => t.length > 0);
      if (!name) return;

      const url = new URL(href, location.origin).toString();
      if (!out.has(url)) out.set(url, { name, url });
    });
    return Array.from(out.values());
  });

  await page.close();
  console.log(`Discovered ${retailers.length} retailer links`);
  return retailers;
}

// ---- per-retailer worker -------------------------------------------------

async function captureRetailer(context, retailer) {
  const slug = slugify(retailer.name);
  const page = await context.newPage();
  page.setDefaultTimeout(pageTimeout);

  try {
    await withRetry(`goto ${retailer.url}`, () =>
      page.goto(retailer.url, { waitUntil: "networkidle" })
    );

    await page.waitForTimeout(2000); // Wait for animations/lazy elements

    const buffer = await page.screenshot({ fullPage: true, type: "png" });

    const primaryPath = `${slug}/${today}.png`;
    const browsePath = `${today}/${slug}.png`;

    await withRetry(`upload ${primaryPath}`, async () => {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(primaryPath, buffer, {
          contentType: "image/png",
          upsert: true,
        });
      if (error) throw error;
    });

    await supabase.storage
      .from(BUCKET)
      .upload(browsePath, buffer, { contentType: "image/png", upsert: true })
      .catch(() => {});

    const { error: insertErr } = await supabase.from("snapshots").upsert(
      {
        retailer_name: retailer.name,
        retailer_slug: slug,
        image_path: primaryPath,
        captured_on: today,
      },
      { onConflict: "retailer_slug,captured_on" }
    );
    if (insertErr) throw insertErr;

    const { error: updErr } = await supabase
      .from("retailers")
      .update({ last_capture_at: new Date().toISOString() })
      .eq("slug", slug);
    if (updErr) console.warn(`retailers update failed for ${slug}: ${updErr.message}`);

    console.log(`✓ ${retailer.name} -> ${primaryPath}`);
    return { ok: true, slug };
  } catch (err) {
    console.error(`✗ ${retailer.name}: ${err.message}`);
    return { ok: false, slug, error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---- main ----------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });

  await context.addCookies(parseCookieString(EARNKARO_COOKIE_STRING));

  try {
    let retailers = await discoverRetailers(context);
    if (MAX_RETAILERS) retailers = retailers.slice(0, Number(MAX_RETAILERS));
    if (retailers.length === 0) throw new Error("No retailers discovered — check cookie/auth");

    const limit = pLimit(concurrency);
    const results = await Promise.all(
      retailers.map((r) => limit(() => captureRetailer(context, r)))
    );

    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    console.log(`\nDone. ${ok} succeeded, ${failed} failed (of ${results.length}).`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
