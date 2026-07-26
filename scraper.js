/**
 * EarnKaro StoreKaro Scraper - v3 (reads __NEXT_DATA__, change-detecting)
 *
 * FIX vs v2: store list is read from the page's embedded __NEXT_DATA__ JSON
 * (props.pageProps.allStores.data) instead of walking the DOM for
 * a.all_stores_more[data-id]. Every store's slug = attributes.unique_identifier.
 * This is deterministic and returns all ~274 stores without scrolling.
 *
 * Detail-page extractors now use the real CSS classes seen in the page source
 * (.store_description, .store_off_details, .cshbackst-value/.cshbackst-data)
 * with heuristic fallbacks.
 *
 * DB columns used (all present after migration.sql):
 *   retailer_name, retailer_slug, data_id, description, profit_rates,
 *   offer_details, logo_path, content_hash, captured_on, captured_at
 * Change number for the frontend is derived from row order (captured_at ASC),
 * so no change_index / short_description columns are needed.
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import ws from "ws";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  EARNKARO_EMAIL    = "manav.sharma@acem.edu.in",
  EARNKARO_PASSWORD = "manav11",
  PAGE_TIMEOUT_MS   = "30000",
  MAX_RETAILERS,
  START_URL         = "https://earnkaro.com/stores",
  STORE_BASE        = "https://earnkaro.com/stores",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

const BUCKET      = "earnkaro";
const today       = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); // IST day
const pageTimeout = Number(PAGE_TIMEOUT_MS);
const delay       = (ms) => new Promise((res) => setTimeout(res, ms));

function slugify(input) {
  return (input || "").toLowerCase().trim()
    .replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function hashOf(description, profit_rates, offer_details) {
  const canonical = JSON.stringify({
    description:  (description || "").replace(/\s+/g, " ").trim(),
    profit_rates: (profit_rates || [])
                    .map((r) => `${r.rate}|${(r.description || "").replace(/\s+/g, " ").trim()}`).sort(),
    offer_details:(offer_details || "").replace(/\s+/g, " ").trim(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function stealthPage(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });
}

// -- LOGIN -------------------------------------------------------------------
async function login(context) {
  console.log("-> Logging in...");
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
    console.log("Logged in");
  } finally {
    await page.close();
  }
}

// -- COLLECT STORES FROM __NEXT_DATA__ (deterministic) -----------------------
async function collectStores(context) {
  const page = await context.newPage();
  await stealthPage(page);
  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(1500);

    let stores = await page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return [];
      let json;
      try { json = JSON.parse(el.textContent); } catch { return []; }
      const arr = json?.props?.pageProps?.allStores?.data || [];
      return arr.map((s) => ({
        dataId:   s?.attributes?.unique_identifier,
        name:     s?.attributes?.name,
        logoUrl:  s?.attributes?.image_url,
        headline: s?.attributes?.cashback_button_text || "",
      })).filter((s) => s.dataId && s.name);
    });

    // Fallback: DOM anchors, only if __NEXT_DATA__ was empty
    if (!stores.length) {
      console.warn("  ! __NEXT_DATA__ empty - falling back to DOM anchors");
      stores = await page.evaluate(() => {
        const out = [], seen = new Set();
        document.querySelectorAll("a.all_stores_more[data-id]").forEach((a) => {
          const dataId = a.getAttribute("data-id");
          if (!dataId || seen.has(dataId)) return;
          let node = a.parentElement, name = "", logo = "";
          for (let j = 0; j < 8 && node; j++) {
            const img = node.querySelector("img[alt]");
            if (img && img.alt.trim()) { name = img.alt.trim(); logo = img.src; break; }
            node = node.parentElement;
          }
          seen.add(dataId);
          out.push({ dataId, name: name || dataId, logoUrl: logo, headline: "" });
        });
        return out;
      });
    }

    console.log("Found " + stores.length + " stores");
    return stores;
  } finally {
    await page.close();
  }
}

// -- LOGO: store once per data-id, reuse forever -----------------------------
async function storeLogo(page, dataId, logoUrl) {
  if (!logoUrl) return null;
  try {
    const { data: existing } = await supabase.storage.from(BUCKET).list("logos", { search: dataId });
    if (existing && existing.length > 0) return "logos/" + existing[0].name;
    const resp = await page.request.get(logoUrl);
    if (!resp.ok()) return null;
    const buf  = await resp.body();
    const ext  = /\.svg(\?|$)/i.test(logoUrl) ? "svg" : /\.jpe?g(\?|$)/i.test(logoUrl) ? "jpg" : "png";
    const path = "logos/" + dataId + "." + ext;
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : "image/png";
    const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: mime, upsert: false });
    if (error && !/already exists/i.test(error.message)) return null;
    return path;
  } catch { return null; }
}

// -- DETAIL PAGE EXTRACTORS (real classes, heuristic fallback) ---------------
async function extractDescription(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".store_description") ||
               document.querySelector(".storetop_right");
    if (el && el.innerText.trim()) {
      return el.innerText.split("\n").map((s) => s.trim()).filter(Boolean).join(" | ");
    }
    // fallback: hero block above the COPY LINK button
    const btn = [...document.querySelectorAll("*")]
      .find((e) => e.children.length === 0 && /copy link/i.test(e.innerText || ""));
    let card = btn;
    for (let i = 0; i < 6 && card; i++) card = card.parentElement;
    if (!card) return "";
    return (card.innerText || "").split("\n").map((s) => s.trim())
      .filter(Boolean).filter((l) => !/copy link|share now/i.test(l)).join(" | ");
  });
}

async function extractRates(page) {
  // open the profit-rates view if it's behind a toggle
  for (const sel of ['text=See Profit Rates', '.store_profit a', 'text=VIEW PROFIT RATES']) {
    try { const t = await page.$(sel); if (t) { await t.click(); await delay(1000); break; } } catch { /* next */ }
  }
  return page.evaluate(() => {
    // primary: EarnKaro rate list rows
    let rows = [...document.querySelectorAll(".streinfovalwrp li, .store_pops_trk_dtls li")].map((li) => ({
      rate: (li.querySelector(".cshbackst-value")?.innerText || "").trim(),
      description: (li.querySelector(".cshbackst-data")?.innerText || "").trim(),
    })).filter((r) => r.rate);
    if (rows.length) return rows;

    // fallback: regex over leaf nodes
    const out = [], seen = new Set();
    [...document.querySelectorAll("*")].forEach((el) => {
      if (el.children.length > 0) return;
      const text = (el.innerText || "").trim();
      if (!text) return;
      const isRate = /^\d+(\.\d+)?%$/.test(text) || /^(flat\s+)?(rs\.?\s*|₹)\s*\d+/i.test(text);
      if (!isRate) return;
      const sib = [...(el.parentElement?.children || [])];
      const desc = (sib[sib.indexOf(el) + 1]?.innerText || "").trim();
      if (desc.length > 3) { const k = text + "|" + desc; if (!seen.has(k)) { seen.add(k); out.push({ rate: text, description: desc }); } }
    });
    return out;
  });
}

async function extractOffer(page) {
  // ensure the Offer Details tab/section is shown
  try { const t = await page.$("text=OFFER DETAILS") || await page.$("text=Offer Details"); if (t) { await t.click(); await delay(700); } } catch { /* ignore */ }
  return page.evaluate(() => {
    const el = document.querySelector(".store_off_details") ||
               document.querySelector(".storeinfo_off_dtls_in") ||
               document.querySelector(".store_off_details_wrp");
    if (el && el.innerText.trim()) {
      return el.innerText.split("\n").map((s) => s.trim())
        .filter(Boolean).filter((l) => !/^offer details$/i.test(l)).join("\n");
    }
    const hdr = [...document.querySelectorAll("*")]
      .find((e) => e.children.length === 0 && /^offer details$/i.test((e.innerText || "").trim()));
    if (!hdr) return "";
    let sec = hdr;
    for (let i = 0; i < 6; i++) {
      if (sec.parentElement && sec.parentElement.innerText.length > hdr.innerText.length * 3) sec = sec.parentElement; else break;
    }
    return (sec.innerText || "").split("\n").map((s) => s.trim())
      .filter(Boolean).filter((l) => !/^offer details$/i.test(l)).join("\n");
  });
}

// -- PROCESS ONE STORE -------------------------------------------------------
async function processStore(context, store, idx, total) {
  const { dataId, name, logoUrl } = store;
  const slug = slugify(name);
  const url  = STORE_BASE + "/" + dataId;
  console.log("\n[" + idx + "/" + total + "] " + name + " -> " + url);
  const page = await context.newPage();
  await stealthPage(page);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(2200);

    const logoPath      = await storeLogo(page, dataId, logoUrl);
    const description   = await extractDescription(page);
    const profit_rates  = await extractRates(page);
    const offer_details = await extractOffer(page);
    console.log("  rates:" + profit_rates.length + " offer:" + offer_details.length + "c desc:" + description.length + "c");

    if (!description && profit_rates.length === 0 && !offer_details) {
      console.warn("  ! Empty extraction - skipping (probable load failure)");
      return;
    }

    const hash = hashOf(description, profit_rates, offer_details);

    const { data: last } = await supabase
      .from("snapshots")
      .select("content_hash")
      .eq("data_id", dataId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (last && last.content_hash === hash) {
      console.log("  = No change - skipped");
      return;
    }

    const { error } = await supabase.from("snapshots").insert({
      retailer_name: name,
      retailer_slug: slug,
      data_id:       dataId,
      description:   description,
      profit_rates:  profit_rates,
      offer_details: offer_details,
      logo_path:     logoPath,
      content_hash:  hash,
      captured_on:   today,
      captured_at:   new Date().toISOString(),
    });

    if (error) console.error("  x DB: " + error.message);
    else console.log("  + CHANGE saved (rates:" + profit_rates.length + ")");
  } catch (err) {
    console.error("  x Exception: " + err.message);
  } finally {
    await page.close();
  }
}

// -- MAIN --------------------------------------------------------------------
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
    let stores = await collectStores(context);
    if (!stores.length) throw new Error("No stores found");
    if (MAX_RETAILERS) stores = stores.slice(0, Number(MAX_RETAILERS));

    console.log("\n-> Processing " + stores.length + " stores (IST day " + today + ")...\n");
    for (let i = 0; i < stores.length; i++) {
      try {
        await Promise.race([
          processStore(context, stores[i], i + 1, stores.length),
          new Promise((_, rej) => setTimeout(() => rej(new Error("45s timeout")), 45000)),
        ]);
      } catch (err) {
        console.error("  x Skipped: " + err.message);
      }
    }
    console.log("\nAll done");
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
