#!/usr/bin/env node
// Test harness for AI categorization
// - Imports inferCategoryWithAI from integrations/add-transaction.js
// - Tests a list of merchants, prints colored output, timing, cache hit/miss
// - Saves results to integrations/ai-categorization-results.json

const fs = require('fs');
const path = require('path');
const { inferCategoryWithAI } = require('./integrations/add-transaction');

const CACHE_FILE = path.join(__dirname, 'integrations', 'merchant-category-cache.json');
const RESULTS_FILE = path.join(__dirname, 'integrations', 'ai-categorization-results.json');

// Simple ANSI color helpers (no external deps)
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
};

function color(text, code) { return code + text + colors.reset; }

const merchants = [
  { payee: 'Starbucks Coffee', notes: 'Latte', amount: -4.5 },
  { payee: 'Myntra Fashion', notes: 'Order #1234', amount: -79.99 },
  { payee: 'Netflix Subscription', notes: 'Monthly', amount: -15.99 },
  { payee: 'Apollo Pharmacy', notes: 'Medicines', amount: -23.5 },
  { payee: 'IRCTC Ticket', notes: 'Train booking', amount: -120.0 },
  { payee: 'Uber Ride', notes: 'Trip to airport', amount: -18.25 },
  { payee: 'Dominos Pizza', notes: 'Large pepperoni', amount: -12.75 },
  { payee: 'Amazon Pay', notes: 'Order 9876', amount: -45.0 },
  { payee: 'Swiggy', notes: 'Food order', amount: -9.9 },
  { payee: 'Zomato', notes: 'Delivery', amount: -11.2 },
  { payee: 'Nike Store', notes: 'Shoes', amount: -120.0 },
  { payee: 'BookMyShow', notes: 'Movie ticket', amount: -10.5 },
  { payee: 'Reliance Fresh', notes: 'Groceries', amount: -30.0 },
  { payee: 'Airtel Recharge', notes: 'Mobile topup', amount: -199.0 },
  { payee: 'Steam Games', notes: 'Game purchase', amount: -29.99 },
];

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (e) {}
  return {};
}

async function run() {
  console.log(color('AI Categorization Test Harness', colors.bright));
  const startAll = process.hrtime.bigint();
  const results = [];
  const initialCache = readCache();

  for (const m of merchants) {
    const key = (m.payee || '').toLowerCase().trim();
    const cacheBefore = Object.prototype.hasOwnProperty.call(initialCache, key);
    const t0 = process.hrtime.bigint();
    let res;
    try {
      res = await inferCategoryWithAI({ payee: m.payee, notes: m.notes, amount: m.amount });
    } catch (e) {
      res = { category: 'Other', confidence: 0, error: e.message };
    }
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;

    // Re-read cache to determine whether the call produced a cache entry
    const postCache = readCache();
    const cacheAfter = Object.prototype.hasOwnProperty.call(postCache, key);
    const cacheHit = cacheBefore && cacheAfter;
    const cacheMiss = !cacheBefore && cacheAfter;

    const out = {
      merchant: m.payee,
      category: res.category || 'Other',
      confidence: typeof res.confidence === 'number' ? res.confidence : null,
      cache: cacheHit ? 'hit' : (cacheMiss ? 'miss-created' : 'miss'),
      durationMs: Math.round(ms * 100) / 100,
      timestamp: new Date().toISOString(),
    };
    results.push(out);

    // Print colored line
    const line = `${color(m.payee, colors.cyan)} -> ${color(out.category, colors.magenta)} ` +
      `${color('(' + (out.confidence !== null ? out.confidence + '%' : 'n/a') + ')', colors.dim)} ` +
      `${out.cache === 'hit' ? color('[cache hit]', colors.green) : color('[cache miss]', colors.yellow)} ` +
      `${color(out.durationMs + 'ms', colors.dim)}`;
    console.log(line);
  }

  const endAll = process.hrtime.bigint();
  const totalMs = Number(endAll - startAll) / 1e6;
  console.log('\n' + color('Total time: ' + (Math.round(totalMs * 100) / 100) + ' ms', colors.bright));

  // Save results
  try {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf8');
    console.log(color('Results saved to ' + RESULTS_FILE, colors.green));
  } catch (e) {
    console.error('Failed to write results:', e.message);
  }
}

run().catch(e => {
  console.error('Test harness error:', e && e.message ? e.message : e);
  process.exit(1);
});
