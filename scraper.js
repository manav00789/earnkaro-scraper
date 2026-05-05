/**
 * EarnKaro scraper - Debug Edition
 * Heavy logging to find exactly where failure happens
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
  MAX_RETAILERS     = "3",   // only 3 stores for debug run
  START_URL         = "https://earnkaro.com/stores",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

// ── Test Supabase connection immediately ──
console.log("→ Testing Supabase connection...");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

// Quick connectivity test
const { data: testData, error: testErr } = await supabase
  .from("snapshots")
  .select("id")
  .limit(1);

if (testErr) {
  console.error("✗ Supabase connection FAILED:", testErr.message);
  process.exit(1);
} else {
  console.log("✓ Supabase connected, existing rows:", testData?.length ?? 0);
}

// ── Test storage bucket ──
console.log("→ Testing storage bucket...");
const { data: buckets, error: bucketErr } = await supabase.storage.listBuckets();
if (bucketErr) {
  console.error("✗ Storage list FAILED:", bucketErr.message);
} else {
  console.log("✓ Buckets found:", buckets.map(b => b.name).join(", "));
}

// Upload a tiny test file
const testBuf = Buffer.from("test");
const { error: uploadTestErr } = await supabase.storage
  .from("earnkaro")
  .upload("_test/connection_test.txt", testBuf, { upsert: true });
if (uploadTestErr) {
  console.error("✗ Test upload FAILED:", uploadTestErr.message);
} else {
  console.log("✓ Test upload to earnkaro bucket succeeded");
}

// ── Test DB insert ──
console.log("→ Testing DB insert...");
const { error: insertErr } = await supabase.from("snapshots").upsert({
  retailer_name: "_test_store",
  retailer_slug: "_test-store",
  profit_rates:  [{ rate: "5%", description: "Test" }],
  offer_details: "Test offer",
  image_path:    null,
  offer_image_path: null,
  captured_on:   new Date().toISOString().slice(0, 10),
  updated_at:    new Date().toISOString(),
}, { onConflict: "retailer_slug,captured_on" });

if (insertErr) {
  console.error("✗ DB insert FAILED:", insertErr.message);
  console.error("  Full error:", JSON.stringify(insertErr));
} else {
  console.log("✓ DB insert succeeded");
}

const BUCKET    = "earnkaro";
const today     = new Date().toISOString().slice(0, 10);
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

async function login(context) {
  console.log("\n→ Logging in...");
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
    console.log("✓ Logged in:", await page.url());
  } finally {
    await page.close();
  }
}

async function collectStoreNames(context) {
  const page = await context.newPage();
  await stealthPage(page);
  try {
    console.log("\n→ Loading stores page...");
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

    console.log(`✓ Found ${names.length} stores. First 5:`, names.slice(0, 5));
    return names;
  } finally {
    await page.close();
  }
}

async function processStore(context, storeName, idx, total) {
  const slug = slugify(storeName);
  console.log(`\n━━━ [${idx}/${total}] ${storeName} (${slug}) ━━━`);

  const page = await context.newPage();
  await stealthPage(page);

  try {
    console.log(`  → Loading stores page...`);
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(2500);

    // Find and click the store button
    let found = false;
    for (let attempt = 0; attempt < 30 && !found; attempt++) {
      const btn = await page.evaluateHandle((targetName) => {
        const btns = [...document.querySelectorAll("*")]
          .filter(el => el.innerText?.trim().toUpperCase() === "VIEW PROFIT RATES");
        for (const btn of btns) {
          let node = btn.parentElement;
          for (let j = 0; j < 8; j++) {
            const img = node?.querySelector("img[alt]");
            if (img?.alt?.trim().toLowerCase() === targetName.toLowerCase()) return btn;
            node = node?.parentElement;
          }
        }
        return null;
      }, storeName);

      if (btn.asElement()) {
        await btn.asElement().scrollIntoViewIfNeeded();
        await delay(400);
        await btn.asElement().click();
        found = true;
        console.log(`  ✓ Clicked VIEW PROFIT RATES`);
      } else {
        await page.evaluate(() => window.scrollBy(0, 600));
        await delay(500);
      }
    }

    if (!found) {
      console.error(`  ✗ Button not found after 30 scroll attempts`);
      return;
    }

    await delay(1500);
    console.log(`  → Current URL: ${page.url()}`);

    // Check modal appeared
    const MODAL = '[role="dialog"]';
    const modalVisible = await page.$(MODAL);
    console.log(`  → Modal visible: ${!!modalVisible}`);

    if (!modalVisible) {
      await page.screenshot({ path: `debug_no_modal_${slug}.png` });
      console.error(`  ✗ Modal did not appear — screenshot saved`);
      return;
    }

    // Screenshot modal element only
    const modal = await page.$(MODAL);
    const profitBuf = await modal.screenshot({ type: "png" });
    console.log(`  ✓ Profit screenshot: ${profitBuf.length} bytes`);

    // Extract profit rates text
    const profitRates = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"]');
      if (!modal) return [];
      const rows = [];
      const seen = new Set();
      const allEls = [...modal.querySelectorAll("*")];
      allEls.forEach((el) => {
        if (el.children.length > 0) return;
        const text = el.innerText?.trim();
        if (!text) return;
        const isRate = /^\d+(\.\d+)?%$/.test(text) ||
                       /^(flat\s+)?(rs\.?\s*|₹)\s*\d+/i.test(text);
        if (!isRate) return;
        const parent = el.parentElement;
        const siblings = [...(parent?.children || [])];
        const idx = siblings.indexOf(el);
        const desc = siblings[idx + 1]?.innerText?.trim() || el.nextElementSibling?.innerText?.trim() || "";
        if (desc && desc.length > 3) {
          const key = `${text}|${desc}`;
          if (!seen.has(key)) { seen.add(key); rows.push({ rate: text, description: desc }); }
        }
      });
      return rows;
    });
    console.log(`  ✓ Profit rows: ${profitRates.length}`, profitRates.slice(0, 2));

    // Click Offer Details tab
    let offerText = "";
    let offerBuf = null;
    try {
      const offerTab = await page.$('text=OFFER DETAILS');
      console.log(`  → Offer tab found: ${!!offerTab}`);
      if (offerTab) {
        await offerTab.click();
        await delay(800);
        offerText = await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"]');
          return modal?.innerText?.trim() || "";
        });
        console.log(`  ✓ Offer text: ${offerText.length} chars`);
        offerBuf = await modal.screenshot({ type: "png" });
      }
    } catch (e) {
      console.warn(`  ⚠ Offer tab error: ${e.message}`);
    }

    // Upload profit screenshot
    console.log(`  → Uploading profit screenshot...`);
    const profitPath = `${slug}/${today}_profit_rates.png`;
    const { error: e1 } = await supabase.storage.from(BUCKET)
      .upload(profitPath, profitBuf, { contentType: "image/png", upsert: true });
    if (e1) console.error(`  ✗ Profit upload failed: ${e1.message}`);
    else console.log(`  ✓ Profit uploaded to: ${profitPath}`);

    // Upload offer screenshot
    let offerPath = null;
    if (offerBuf) {
      offerPath = `${slug}/${today}_offer_details.png`;
      const { error: e2 } = await supabase.storage.from(BUCKET)
        .upload(offerPath, offerBuf, { contentType: "image/png", upsert: true });
      if (e2) console.error(`  ✗ Offer upload failed: ${e2.message}`);
      else console.log(`  ✓ Offer uploaded to: ${offerPath}`);
    }

    // DB upsert
    console.log(`  → Saving to DB...`);
    const upsertPayload = {
      retailer_name:    storeName,
      retailer_slug:    slug,
      profit_rates:     profitRates,
      offer_details:    offerText,
      image_path:       profitPath,
      offer_image_path: offerPath,
      captured_on:      today,
      updated_at:       new Date().toISOString(),
    };
    console.log(`  → Upsert payload keys:`, Object.keys(upsertPayload));

    const { data: upsertData, error: dbErr } = await supabase
      .from("snapshots")
      .upsert(upsertPayload, { onConflict: "retailer_slug,captured_on" })
      .select();

    if (dbErr) {
      console.error(`  ✗ DB FAILED: ${dbErr.message}`);
      console.error(`  Full DB error:`, JSON.stringify(dbErr));
    } else {
      console.log(`  ✓ DB saved! Row:`, JSON.stringify(upsertData?.[0]?.retailer_name));
    }

  } catch (err) {
    console.error(`  ✗ EXCEPTION: ${err.message}`);
    console.error(err.stack);
  } finally {
    await page.close();
  }
}

async function main() {
  console.log("\n→ Launching browser...");
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
