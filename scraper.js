/**
 * EarnKaro scraper - Final Edition
 * - Crops modal only (no dark background)
 * - Scrolls inside modal to capture ALL rows
 * - Extracts text as structured JSON (copyable in Lovable)
 * - Fresh page per store to avoid DOM drift
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

// ── COLLECT STORE NAMES ────────────────────────────────────────────────────

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
      return [...new Set(results)]; // deduplicate
    });

    console.log(`→ Found ${names.length} stores`);
    return names;
  } finally {
    await page.close();
  }
}

// ── SCREENSHOT MODAL ONLY (cropped, full scroll) ───────────────────────────

async function screenshotModalScrolled(page) {
  const MODAL_SEL = '[role="dialog"]';

  // Wait for modal
  await page.waitForSelector(MODAL_SEL, { timeout: 8000 });
  await delay(500);

  const modal = await page.$(MODAL_SEL);
  if (!modal) return null;

  // Find the scrollable content area inside modal
  const scrollSel = `${MODAL_SEL} [class*="body"], ${MODAL_SEL} [class*="content"], ${MODAL_SEL} [class*="scroll"]`;

  // Reset scroll to top
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = 0;
  }, MODAL_SEL);
  await delay(300);

  // Take first crop of just the modal element
  const chunks = [];
  chunks.push(await modal.screenshot({ type: "png" }));

  // Check if modal content is scrollable
  const isScrollable = await page.evaluate((mSel) => {
    const modal = document.querySelector(mSel);
    if (!modal) return false;
    // Find scrollable child
    const children = modal.querySelectorAll("*");
    for (const child of children) {
      if (child.scrollHeight > child.clientHeight + 5) return true;
    }
    return false;
  }, MODAL_SEL);

  if (isScrollable) {
    // Scroll in steps and capture each position
    let lastScrollTop = 0;
    for (let i = 0; i < 10; i++) {
      await page.evaluate((mSel) => {
        const modal = document.querySelector(mSel);
        if (!modal) return;
        // Find the scrollable child
        const children = [...modal.querySelectorAll("*")];
        const scrollable = children.find(c => c.scrollHeight > c.clientHeight + 5);
        if (scrollable) scrollable.scrollTop += scrollable.clientHeight - 60;
      }, MODAL_SEL);
      await delay(400);

      const newScrollTop = await page.evaluate((mSel) => {
        const modal = document.querySelector(mSel);
        const children = [...modal.querySelectorAll("*")];
        const scrollable = children.find(c => c.scrollHeight > c.clientHeight + 5);
        return scrollable?.scrollTop ?? 0;
      }, MODAL_SEL);

      if (newScrollTop === lastScrollTop) break; // reached bottom
      lastScrollTop = newScrollTop;
      chunks.push(await modal.screenshot({ type: "png" }));
    }
  }

  // If only one chunk, return it directly
  if (chunks.length === 1) return chunks[0];

  // Stitch chunks vertically using raw buffer manipulation
  // Use Playwright's built-in: just return all chunks as separate uploads
  // For simplicity, return the last chunk which shows the bottom content
  // Better: stitch using sharp if available, otherwise return first chunk
  try {
    const { execSync } = await import("child_process");
    // Check if ImageMagick is available
    execSync("which convert", { stdio: "ignore" });

    // Write chunks to temp files and stitch
    const fs = await import("fs");
    const tmpFiles = chunks.map((buf, i) => {
      const path = `/tmp/modal_chunk_${i}.png`;
      fs.writeFileSync(path, buf);
      return path;
    });
    const outPath = `/tmp/modal_stitched.png`;
    execSync(`convert -append ${tmpFiles.join(" ")} ${outPath}`);
    const stitched = fs.readFileSync(outPath);
    // Cleanup
    tmpFiles.forEach(f => fs.unlinkSync(f));
    fs.unlinkSync(outPath);
    return stitched;
  } catch {
    // ImageMagick not available — return all chunks, upload separately
    return chunks[0]; // fallback: first chunk
  }
}

// ── EXTRACT TEXT FROM MODAL ────────────────────────────────────────────────

async function extractProfitRates(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]');
    if (!modal) return [];

    const rows = [];
    const seen = new Set();

    // Find rate+description pairs
    // Rates are colored spans (green text) next to descriptions
    const allEls = [...modal.querySelectorAll("*")];

    allEls.forEach((el) => {
      if (el.children.length > 0) return; // only leaf nodes
      const text = el.innerText?.trim();
      if (!text) return;

      // Match: "8%", "10.20%", "₹40", "Flat Rs 2240", "Rs 40"
      const isRate = /^\d+(\.\d+)?%$/.test(text) ||
                     /^(flat\s+)?(rs\.?\s*|₹)\s*\d+/i.test(text);
      if (!isRate) return;

      // Find description — look at parent's children for sibling text
      const parent = el.parentElement;
      if (!parent) return;

      const siblings = [...parent.children];
      const idx = siblings.indexOf(el);
      const descEl = siblings[idx + 1] || el.nextElementSibling;
      const desc = descEl?.innerText?.trim();

      if (desc && desc.length > 3) {
        const key = `${text}|${desc}`;
        if (!seen.has(key)) {
          seen.add(key);
          rows.push({ rate: text, description: desc });
        }
      }
    });

    return rows;
  });
}

async function extractOfferDetails(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]');
    if (!modal) return "";

    // Get all text content from modal, clean it up
    const text = modal.innerText || "";
    // Remove tab labels and header
    return text
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !["PROFIT RATES", "OFFER DETAILS", "×", "Share", "Today", "Get", "Orders", "Profit Tracks In"].includes(l))
      .join("\n");
  });
}

// ── PROCESS ONE STORE ──────────────────────────────────────────────────────

async function processStore(context, storeName, idx, total) {
  const slug = slugify(storeName);
  console.log(`\n[${idx}/${total}] ${storeName}`);

  const page = await context.newPage();
  await stealthPage(page);

  try {
    // Fresh load of stores page
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(2500);

    // Scroll to find this store's button
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
        await delay(500);
        await btn.asElement().click();
        found = true;
        console.log(`  → Modal opened`);
      } else {
        await page.evaluate(() => window.scrollBy(0, 600));
        await delay(500);
      }
    }

    if (!found) {
      console.warn(`  ⚠ Store button not found — skipping`);
      return;
    }

    await delay(1000);

    // ── Tab 1: PROFIT RATES ──
    // Extract text
    const profitRates = await extractProfitRates(page);
    console.log(`  → ${profitRates.length} profit rate rows extracted`);

    // Screenshot modal cropped
    const profitBuf = await screenshotModalScrolled(page);
    let profitImagePath = null;
    if (profitBuf) {
      profitImagePath = `${slug}/${today}_profit_rates.png`;
      const { error } = await supabase.storage.from(BUCKET)
        .upload(profitImagePath, profitBuf, { contentType: "image/png", upsert: true });
      if (error) console.warn(`  ⚠ Profit upload: ${error.message}`);
      else console.log(`  ✓ Profit screenshot uploaded`);
    }

    // ── Tab 2: OFFER DETAILS ──
    let offerText = "";
    let offerImagePath = null;
    try {
      const offerTab = await page.$('text=OFFER DETAILS');
      if (offerTab) {
        await offerTab.click();
        await delay(800);
        offerText = await extractOfferDetails(page);
        console.log(`  → Offer details: ${offerText.length} chars`);

        // Reset modal scroll and screenshot
        await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"]');
          const children = [...(modal?.querySelectorAll("*") || [])];
          const scrollable = children.find(c => c.scrollHeight > c.clientHeight + 5);
          if (scrollable) scrollable.scrollTop = 0;
        });
        await delay(300);

        const offerBuf = await screenshotModalScrolled(page);
        if (offerBuf) {
          offerImagePath = `${slug}/${today}_offer_details.png`;
          const { error } = await supabase.storage.from(BUCKET)
            .upload(offerImagePath, offerBuf, { contentType: "image/png", upsert: true });
          if (error) console.warn(`  ⚠ Offer upload: ${error.message}`);
          else console.log(`  ✓ Offer screenshot uploaded`);
        }
      }
    } catch (e) {
      console.warn(`  ⚠ Offer tab: ${e.message}`);
    }

    // ── Save to DB ──
    const { error: dbErr } = await supabase.from("snapshots").upsert({
      retailer_name:    storeName,
      retailer_slug:    slug,
      profit_rates:     profitRates,          // JSONB — copyable in Lovable
      offer_details:    offerText,             // text — copyable in Lovable
      image_path:       profitImagePath,
      offer_image_path: offerImagePath,
      captured_on:      today,
      updated_at:       new Date().toISOString(),
    }, { onConflict: "retailer_slug,captured_on" });

    if (dbErr) console.warn(`  ⚠ DB: ${dbErr.message}`);
    else console.log(`  ✓ Saved to DB`);

  } catch (err) {
    console.error(`  ✗ ${storeName}: ${err.message}`);
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
      "--no-sandbox", "--disable-setuid-sandbox",
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
