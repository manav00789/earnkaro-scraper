/**
 * EarnKaro StoreKaro Scraper - Final Production Version
 * - Scrapes profit rates + offer details as TEXT daily
 * - Stores logo once per retailer (never re-downloads)
 * - No screenshots — text only saves storage
 * - Fresh page per store, 45s timeout per store
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
const delay       = (ms) => new Promise((res) => setTimeout(res, ms));

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

// ── LOGO: store once, reuse forever ───────────────────────────────────────
async function captureAndStoreLogo(page, storeName, slug) {
  try {
    // Check if logo already exists — never re-download
    const { data: existing } = await supabase.storage
      .from(BUCKET)
      .list("logos", { search: `${slug}` });
    if (existing && existing.length > 0) {
      console.log(`  → Logo exists, skipping`);
      return `logos/${existing[0].name}`;
    }

    // Find this store's logo src on the page
    const logoUrl = await page.evaluate((targetName) => {
      const btns = [...document.querySelectorAll("*")]
        .filter(el => el.innerText?.trim().toUpperCase() === "VIEW PROFIT RATES");
      for (const btn of btns) {
        let node = btn.parentElement;
        for (let j = 0; j < 8; j++) {
          const img = node?.querySelector("img[alt]");
          if (img?.alt?.trim().toLowerCase() === targetName.toLowerCase()) {
            return img.src;
          }
          node = node?.parentElement;
        }
      }
      return null;
    }, storeName);

    if (!logoUrl) { console.warn(`  ⚠ Logo not found`); return null; }

    // Download and upload to Supabase
    const response = await page.request.get(logoUrl);
    if (!response.ok()) { console.warn(`  ⚠ Logo download failed`); return null; }

    const buffer    = await response.body();
    const ext       = logoUrl.includes(".svg") ? "svg" : "png";
    const mimeType  = ext === "svg" ? "image/svg+xml" : "image/png";
    const logoPath  = `logos/${slug}.${ext}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(logoPath, buffer, { contentType: mimeType, upsert: false });

    if (error && !error.message.includes("already exists")) {
      console.warn(`  ⚠ Logo upload failed: ${error.message}`);
      return null;
    }
    console.log(`  ✓ Logo stored: ${logoPath}`);
    return logoPath;
  } catch (e) {
    console.warn(`  ⚠ Logo error: ${e.message}`);
    return null;
  }
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

// ── COLLECT ALL STORE NAMES ────────────────────────────────────────────────
async function collectStoreNames(context) {
  const page = await context.newPage();
  await stealthPage(page);
  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(3000);
    let prevHeight = 0;
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(700);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prevHeight) break;
      prevHeight = h;
    }
    const names = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll("*").forEach((el) => {
        if (el.innerText?.trim().toUpperCase() !== "VIEW PROFIT RATES") return;
        let node = el.parentElement;
        for (let j = 0; j < 8; j++) {
          const img = node?.querySelector("img[alt]");
          if (img?.alt?.trim()) { results.push(img.alt.trim()); return; }
          node = node?.parentElement;
        }
      });
      return [...new Set(results)];
    });
    console.log(`✓ Found ${names.length} stores`);
    return names;
  } finally {
    await page.close();
  }
}

// ── FIND MODAL ELEMENT ─────────────────────────────────────────────────────
async function findModalEl(page) {
  const SELECTORS = [
    "#streInforpp > div",
    "[class*='popupOverlay'] > div",
    "[role='dialog']",
    "[class*='modal']:not([class*='backdrop'])",
    "[class*='popup'] > div",
  ];
  for (const sel of SELECTORS) {
    try {
      const el  = await page.$(sel);
      if (!el) continue;
      const box = await el.boundingBox();
      if (box && box.width > 200 && box.height > 100) {
        console.log(`  ✓ Modal: ${sel}`);
        return { el, sel };
      }
    } catch { /* try next */ }
  }
  // Text fallback
  const handle = await page.evaluateHandle(() =>
    [...document.querySelectorAll("*")].find(el => {
      const s = window.getComputedStyle(el);
      return el.innerText?.includes("PROFIT RATES") &&
             el.innerText?.includes("OFFER DETAILS") &&
             (s.position === "fixed" || s.position === "absolute") &&
             el.getBoundingClientRect().width > 200;
    }) || null
  );
  if (handle.asElement()) {
    console.log("  ✓ Modal: text fallback");
    return { el: handle.asElement(), sel: "text-based" };
  }
  return null;
}

// ── PROCESS ONE STORE ──────────────────────────────────────────────────────
async function processStore(context, storeName, idx, total) {
  const slug = slugify(storeName);
  console.log(`\n[${idx}/${total}] ${storeName}`);
  const page = await context.newPage();
  await stealthPage(page);

  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(2500);

    // ── Find and click VIEW PROFIT RATES button ──
    let found = false;
    for (let attempt = 0; attempt < 30 && !found; attempt++) {
      const btn = await page.evaluateHandle((name) => {
        const btns = [...document.querySelectorAll("*")]
          .filter(el => el.innerText?.trim().toUpperCase() === "VIEW PROFIT RATES");
        for (const btn of btns) {
          let node = btn.parentElement;
          for (let j = 0; j < 8; j++) {
            const img = node?.querySelector("img[alt]");
            if (img?.alt?.trim().toLowerCase() === name.toLowerCase()) return btn;
            node = node?.parentElement;
          }
        }
        return null;
      }, storeName);

      if (btn.asElement()) {
        // Capture logo while we have page loaded (before modal opens)
        const logoPath = await captureAndStoreLogo(page, storeName, slug);
        await btn.asElement().scrollIntoViewIfNeeded();
        await delay(600);
        await btn.asElement().click();
        found = true;

        await delay(2000);

        // ── Find modal ──
        const modal = await findModalEl(page);
        if (!modal) { console.error("  ✗ Modal not found"); return; }
        const { sel } = modal;

        // ── Extract PROFIT RATES ──
        const profitRates = await page.evaluate((sel) => {
          const modal = sel === "text-based"
            ? [...document.querySelectorAll("*")].find(el =>
                el.innerText?.includes("PROFIT RATES") &&
                window.getComputedStyle(el).position !== "static")
            : document.querySelector(sel);
          if (!modal) return [];
          const rows = [];
          const seen = new Set();
          [...modal.querySelectorAll("*")].forEach((el) => {
            if (el.children.length > 0) return;
            const text = el.innerText?.trim();
            if (!text) return;
            const isRate = /^\d+(\.\d+)?%$/.test(text) ||
                           /^(flat\s+)?(rs\.?\s*|₹)\s*\d+/i.test(text);
            if (!isRate) return;
            const siblings = [...(el.parentElement?.children || [])];
            const desc = siblings[siblings.indexOf(el) + 1]?.innerText?.trim() || "";
            if (desc.length > 3) {
              const key = `${text}|${desc}`;
              if (!seen.has(key)) { seen.add(key); rows.push({ rate: text, description: desc }); }
            }
          });
          return rows;
        }, sel);
        console.log(`  ✓ Profit rows: ${profitRates.length}`);

        // ── Extract OFFER DETAILS ──
        let offerText = "";
        try {
          const offerTab = await page.$("text=OFFER DETAILS");
          if (offerTab) {
            await offerTab.click();
            await delay(800);
            offerText = await page.evaluate((sel) => {
              const modal = sel === "text-based"
                ? [...document.querySelectorAll("*")].find(el =>
                    el.innerText?.includes("OFFER DETAILS") &&
                    window.getComputedStyle(el).position !== "static")
                : document.querySelector(sel);
              return (modal?.innerText || "")
                .split("\n")
                .map(l => l.trim())
                .filter(l => l.length > 0)
                .filter(l => !["PROFIT RATES", "OFFER DETAILS", "×",
                               "Share", "Today", "Get", "Orders",
                               "Profit Tracks In"].includes(l))
                .join("\n");
            }, sel);
            console.log(`  ✓ Offer text: ${offerText.length} chars`);
          }
        } catch (e) {
          console.warn(`  ⚠ Offer tab: ${e.message}`);
        }

        // ── Save to DB ──
        const { error: dbErr } = await supabase.from("snapshots").upsert({
          retailer_name:    storeName,
          retailer_slug:    slug,
          profit_rates:     profitRates,
          offer_details:    offerText,
          logo_path:        logoPath,
          image_path:       null,
          offer_image_path: null,
          captured_on:      today,
          updated_at:       new Date().toISOString(),
        }, { onConflict: "retailer_slug,captured_on" });

        if (dbErr) console.error(`  ✗ DB: ${dbErr.message}`);
        else console.log(`  ✓ Saved to DB ✓`);

      } else {
        await page.evaluate(() => window.scrollBy(0, 600));
        await delay(500);
      }
    }
    if (!found) console.error("  ✗ Button not found");

  } catch (err) {
    console.error(`  ✗ Exception: ${err.message}`);
  } finally {
    await page.close();
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
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
    let storeNames = await collectStoreNames(context);
    if (!storeNames.length) throw new Error("No stores found");
    if (MAX_RETAILERS) storeNames = storeNames.slice(0, Number(MAX_RETAILERS));

    console.log(`\n→ Processing ${storeNames.length} stores...\n`);
    for (let i = 0; i < storeNames.length; i++) {
      try {
        await Promise.race([
          processStore(context, storeNames[i], i + 1, storeNames.length),
          new Promise((_, rej) => setTimeout(() => rej(new Error("45s timeout")), 45000)),
        ]);
      } catch (err) {
        console.error(`  ✗ Skipped: ${err.message}`);
      }
    }
    console.log("\n✓ All done");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
