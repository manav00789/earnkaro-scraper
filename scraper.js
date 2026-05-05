/**
 * EarnKaro scraper - GitHub Actions Edition
 * ---------------------------------------------------------------
 * - Logs in with email + password (no OTP, no cookies needed)
 * - Headless Chromium via Playwright
 * - Uploads screenshots to Supabase Storage
 * - Upserts metadata to `snapshots` table
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import pLimit from "p-limit";
import ws from "ws";

// ---- env -----------------------------------------------------------------

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  EARNKARO_EMAIL    = "manav.sharma@acem.edu.in",
  EARNKARO_PASSWORD = "manav11",
  CONCURRENCY       = "3",
  PAGE_TIMEOUT_MS   = "60000",
  MAX_RETAILERS,
  START_URL         = "https://earnkaro.com/stores",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

// ---- supabase ------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

// ---- constants -----------------------------------------------------------

const BUCKET      = "retailer-snapshots";
const today       = new Date().toISOString().slice(0, 10);
const pageTimeout = Number(PAGE_TIMEOUT_MS);
const concurrency = Math.max(1, Number(CONCURRENCY));
const LOGIN_URL   = "https://earnkaro.com/login";

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

// ---- login ---------------------------------------------------------------

async function login(context) {
  console.log("→ Logging in...");
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(2000);
    await page.screenshot({ path: "debug_login_start.png" });
    console.log(`→ Login page: ${page.url()}`);

    // Step 1: Enter email
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="mobile" i]',
      'input[type="text"]',
    ];

    let emailField = null;
    for (const sel of emailSelectors) {
      emailField = await page.$(sel);
      if (emailField) { console.log(`→ Email field: ${sel}`); break; }
    }

    if (!emailField) {
      await page.screenshot({ path: "debug_login_no_email.png" });
      throw new Error("Email input not found — see debug_login_no_email.png");
    }

    await emailField.click();
    await emailField.fill("");
    await emailField.type(EARNKARO_EMAIL, { delay: 60 });
    await delay(500);

    // Step 2: Click Continue / Next
    const continueSelectors = [
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Proceed")',
      'button[type="submit"]',
    ];

    let clicked = false;
    for (const sel of continueSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        clicked = true;
        console.log(`→ Clicked: ${sel}`);
        break;
      } catch { /* try next */ }
    }
    if (!clicked) {
      await emailField.press("Enter");
      console.log("→ Pressed Enter on email field");
    }

    await delay(3000);
    await page.screenshot({ path: "debug_login_after_email.png" });

    // Step 3: Enter password
    const passSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[placeholder*="password" i]',
    ];

    let passField = null;
    for (const sel of passSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        passField = await page.$(sel);
        if (passField) { console.log(`→ Password field: ${sel}`); break; }
      } catch { /* try next */ }
    }

    if (!passField) {
      await page.screenshot({ path: "debug_login_no_password.png" });
      throw new Error("Password field not found — see debug_login_no_password.png");
    }

    await passField.click();
    await passField.fill("");
    await passField.type(EARNKARO_PASSWORD, { delay: 60 });
    await delay(500);

    // Step 4: Submit
    const submitSelectors = [
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'button[type="submit"]',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        await page.click(sel, { timeout: 3000 });
        submitted = true;
        console.log(`→ Submitted with: ${sel}`);
        break;
      } catch { /* try next */ }
    }
    if (!submitted) {
      await passField.press("Enter");
      console.log("→ Pressed Enter on password field");
    }

    // Step 5: Wait until off login page
    try {
      await page.waitForFunction(
        () => !window.location.href.includes("/login"),
        { timeout: 20000 }
      );
    } catch {
      await page.screenshot({ path: "debug_login_failed.png" });
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "");
      throw new Error(`Login failed — still on ${page.url()}\n${bodyText}`);
    }

    console.log(`✓ Logged in! URL: ${page.url()}`);
    await page.screenshot({ path: "debug_login_success.png" });

  } finally {
    await page.close();
  }
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
  await delay(5000);

  await page.screenshot({ path: "debug_stores.png", fullPage: false });
  console.log(`→ Stores URL: ${page.url()}`);

  if (page.url().includes("/login") || page.url().includes("/signin")) {
    throw new Error("Redirected to login after auth — session did not persist");
  }

  const STORE_SELECTORS = [
    'a[href*="/stores/"]',
    '.store-card a',
    '.retailer-card a',
    '[class*="store"] a',
    '[class*="retailer"] a',
    'a[href*="/cashback/"]',
  ];

  let foundSelector = null;
  for (const sel of STORE_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      foundSelector = sel;
      console.log(`→ Store grid found: ${sel}`);
      break;
    } catch { /* try next */ }
  }

  if (!foundSelector) {
    const title    = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "");
    console.error(`Title: "${title}"\nBody: ${bodyText}`);
    throw new Error("Store grid not found — see debug_stores.png");
  }

  // Scroll to load all lazy-loaded stores
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
        out.set(href, { name, url: new URL(href, location.origin).toString() });
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
      await page.goto(retailer.url, { waitUntil: "domcontentloaded", timeout: pageTimeout });
      await delay(2500);

      const buffer      = await page.screenshot({ fullPage: true, type: "png" });
      const storagePath = `${slug}/${today}.png`;

      const { error: uploadErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buffer, { contentType: "image/png", upsert: true });
      if (uploadErr) throw new Error(`Upload: ${uploadErr.message}`);

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
      if (dbErr) throw new Error(`DB: ${dbErr.message}`);
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
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport:  { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  try {
    await login(context);

    let retailers = await discoverRetailers(context);
    if (MAX_RETAILERS) retailers = retailers.slice(0, Number(MAX_RETAILERS));

    const limit = pLimit(concurrency);
    await Promise.all(retailers.map((r) => limit(() => captureRetailer(context, r))));

    console.log("✓ All done");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
