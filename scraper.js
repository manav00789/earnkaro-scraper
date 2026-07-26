/**
 * EarnKaro StoreKaro Scraper - v2 (change-detecting, direct-nav)
 * - Reads data-id for every store from /stores (no modal clicking)
 * - Visits earnkaro.com/stores/<data-id> directly
 * - Captures: short_description (hero block) + profit_rates + offer_details + logo
 * - Only INSERTS a new row when content changed vs the last stored snapshot
 * - change_index is per-retailer, per-IST-day (1st change, 2nd change, ...)
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
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

const BUCKET     = "earnkaro";
const STORE_BASE = "https://earnkaro.com/stores";
// captured_on grouped by IST day so "changes per day" matches your calendar
const today      = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const pageTimeout = Number(PAGE_TIMEOUT_MS);
const delay      = (ms) => new Promise((res) => setTimeout(res, ms));

function slugify(input) {
  return input.toLowerCase().trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashOf(short_description, profit_rates, offer_details) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ short_description, profit_rates, offer_details }))
    .digest("hex");
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

// -- COLLECT STORES: name + data-id + logo url (no clicking) -----------------
async function collectStores(context) {
  const page = await context.newPage();
  await stealthPage(page);
  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: pageTimeout });
    await delay(3000);
    let prev = 0;
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(700);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prev) break;
      prev = h;
    }
    const stores = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
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
        out.push({ dataId, name: name || dataId, logoUrl: logo });
      });
      return out;
    });
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
    const ext  = logoUrl.includes(".svg") ? "svg" : "png";
    const path = "logos/" + dataId + "." + ext;
    const { error } = await supabase.storage.from(BUCKET).upload(
      path, buf, { contentType: ext === "svg" ? "image/svg+xml" : "image/png", upsert: false });
    if (error && !/already exists/.test(error.message)) return null;
    return path;
  } catch { return null; }
}

// -- DETAIL PAGE EXTRACTORS --------------------------------------------------
// Hero block: the tagline lines shown under the logo (e.g. "You Earn Upto 8.2%...")
async function extractDescription(page) {
  return page.evaluate(() => {
    const btn = [...document.querySelectorAll("*")]
      .find((el) => el.children.length === 0 && /copy link/i.test(el.innerText || ""));
    let card = btn;
    for (let i = 0; i < 8 && card; i++) {
      if (card.querySelector && card.querySelector("img")) break;
      card = card.parentElement;
    }
    card = card || document.body;
    const drop = /copy link|share now|see profit rates|^share$|^get$|^orders$|profit tracks in|^today$|^\d+\s*(hour|day|minute)s?$/i;
    const lines = (card.innerText || "").split("\n").map((s) => s.trim())
      .filter(Boolean).filter((l) => !drop.test(l));
    return [...new Set(lines)].join(" | ");
  });
}

async function extractRates(page) {
  try {
    const link = await page.$("text=See Profit Rates");
    if (link) { await link.click(); await delay(1200); }
  } catch { /* ignore */ }
  return page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    [...document.querySelectorAll("*")].forEach((el) => {
      if (el.children.length > 0) return;
      const text = el.innerText?.trim();
      if (!text) return;
      const isRate = /^\d+(\.\d+)?%$/.test(text) || /^(flat\s+)?(rs\.?\s*|₹)\s*\d+/i.test(text);
      if (!isRate) return;
      const sib  = [...(el.parentElement?.children || [])];
      const desc = sib[sib.indexOf(el) + 1]?.innerText?.trim() || "";
      if (desc.length > 3) {
        const k = text + "|" + desc;
        if (!seen.has(k)) { seen.add(k); rows.push({ rate: text, description: desc }); }
      }
    });
    return rows;
  });
}

async function extractOffer(page) {
  return page.evaluate(() => {
    const hdr = [...document.querySelectorAll("*")]
      .find((el) => el.children.length === 0 && /^offer details$/i.test((el.innerText || "").trim()));
    if (!hdr) return "";
    let sec = hdr;
    for (let i = 0; i < 6; i++) {
      if (sec.parentElement && sec.parentElement.innerText.length > hdr.innerText.length * 3) sec = sec.parentElement;
      else break;
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
    await delay(2500);

    const logoPath          = await storeLogo(page, dataId, logoUrl);
    const short_description = await extractDescription(page);
    const profit_rates      = await extractRates(page);
    const offer_details     = await extractOffer(page);

    // Guard: empty extraction usually means a failed load - never record it as a "change"
    if (!short_description && profit_rates.length === 0 && !offer_details) {
      console.warn("  ! Empty extraction - skipping (probable load failure)");
      return;
    }

    const hash = hashOf(short_description, profit_rates, offer_details);

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

    const { count } = await supabase
      .from("snapshots")
      .select("*", { count: "exact", head: true })
      .eq("data_id", dataId)
      .eq("captured_on", today);
    const change_index = (count || 0) + 1;

    const { error } = await supabase.from("snapshots").insert({
      retailer_name:     name,
      retailer_slug:     slug,
      data_id:           dataId,
      short_description: short_description,
      profit_rates:      profit_rates,
      offer_details:     offer_details,
      logo_path:         logoPath,
      content_hash:      hash,
      captured_on:       today,
      captured_at:       new Date().toISOString(),
      change_index:      change_index,
    });

    if (error) console.error("  x DB: " + error.message);
    else console.log("  + Change #" + change_index + " saved (rates:" + profit_rates.length + ")");
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
