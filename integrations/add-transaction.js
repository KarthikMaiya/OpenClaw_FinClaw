#!/usr/bin/env node
/**
 * Actual Budget - Add Transaction
 *
 * Adds a single transaction to your Actual Budget instance via the API.
 *
 * Usage:
 *   node add-transaction.js '{"amount":-90,"payee":"Restaurant","notes":"lunch","date":"2026-03-01","account":"Checking"}'
 *
 * Parameters (JSON):
 *   amount  - Transaction amount (negative = expense, positive = income)
 *   payee   - Payee / merchant name
 *   notes   - Optional description
 *   date    - YYYY-MM-DD format (defaults to today)
 *   account - Account nickname from ACCOUNTS map (defaults to 'Checking')
 *
 * Setup:
 *   1. Copy config.example.json to config.json and fill in your credentials
 *   2. Run: node setup/discover-accounts.js to find your account UUIDs
 *   3. Update the ACCOUNTS map below with your real UUIDs
 *   4. Update MODULE_DIR to point to your @actual-app/api installation
 */

// Polyfill for browser APIs
if (typeof navigator === 'undefined') {
  global.navigator = { platform: 'linux' };
}
if (typeof SharedArrayBuffer === 'undefined') {
  global.SharedArrayBuffer = ArrayBuffer;
}

// Path to the directory containing @actual-app/api
// If you installed locally: './node_modules'
// If you share node_modules with another project, use an absolute path
const MODULE_DIR = './node_modules';
const api = require('@actual-app/api');
const fs = require('fs');
const { requestJson } = require('../workspace/skills/budget/ai-provider');
const { getActualBudgetConfig, validateRequiredConfig, printDebugSummary, resolveActualBudget } = require('../config-manager');
const SHOULD_SHUTDOWN = require.main === module;

// -----------------------------------------------------------------------
// Replace these with your actual account UUIDs from Actual Budget.
// Run: node setup/discover-accounts.js to discover them automatically.
// The keys are friendly nicknames you'll use in the CLI command.
// -----------------------------------------------------------------------
const ACCOUNTS = {
  'Checking':    '312ce00d-f7be-4c00-97be-131cc0b4cc4f',
  'Savings':     'YOUR_SAVINGS_ACCOUNT_UUID',
  'Credit Card': 'YOUR_CREDIT_CARD_ACCOUNT_UUID',
};

// Local cache file for merchant->category mappings to avoid repeated AI calls.
const MERCHANT_CACHE_FILE = require('path').join(__dirname, 'merchant-category-cache.json');
let merchantCache = null;

function loadMerchantCache() {
  if (merchantCache) return merchantCache;
  try {
    if (fs.existsSync(MERCHANT_CACHE_FILE)) {
      const raw = fs.readFileSync(MERCHANT_CACHE_FILE, 'utf8');
      merchantCache = new Map(Object.entries(JSON.parse(raw)));
    } else {
      merchantCache = new Map();
    }
  } catch (e) {
    merchantCache = new Map();
  }
  return merchantCache;
}

function saveMerchantCache() {
  try {
    const obj = Object.fromEntries(loadMerchantCache());
    fs.writeFileSync(MERCHANT_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    // ignore cache write errors - non-fatal
  }
}

/**
 * inferCategoryWithAI
 * --------------------
 * Async helper that calls an AI service to classify a transaction into
 * one of the supported categories. Returns an object:
 *   { category: string, confidence: number }
 *
 * The function is tolerant: it caches results by merchant/payee (lowercased),
 * supports OpenAI/Gemini-style APIs, and falls back to { category: 'Other', confidence: 0 }
 * on error or if no sensible classification is returned.
 */
async function inferCategoryWithAI({ payee = '', notes = '', amount = 0 }, options = {}) {
  const key = (payee || '').toLowerCase().trim();
  const cache = loadMerchantCache();
  if (key && cache.has(key)) {
    return cache.get(key);
  }

  // Allowed output categories
  const CATEGORIES = [
    'Food', 'Travel', 'Transport', 'Shopping', 'Fashion', 'Bills', 'Entertainment', 'Healthcare', 'Income', 'Other'
  ];

  // Construct a classification prompt
  const prompt = `Classify the following transaction into one of these categories: ${CATEGORIES.join(', ')}.\n` +
    `Payee: "${payee}"\nNotes: "${notes}"\nAmount: ${amount}\nRespond with JSON: {"category":"<one of categories>","confidence":<0-100>} and nothing else.`;

  try {
    const aiResult = await requestJson({
      purpose: 'merchant-categorization',
      providers: options.providers,
      mockProviderResponses: options.mockProviderResponses,
      maxTokens: 80,
      temperature: 0,
      retries: 3,
      messages: [{ role: 'user', content: prompt }],
      onFallback: null,
    });
    const parsedJSON = aiResult.parsed || {};
    if (parsedJSON && parsedJSON.category) {
      const category = String(parsedJSON.category).trim();
      const confidence = Number(parsedJSON.confidence) || 0;
      const out = { category, confidence };
      if (key) {
        cache.set(key, out);
        saveMerchantCache();
      }
      return out;
    }
  } catch (e) {
    // swallow and fall through to safe fallback
  }

  // Safe fallback
  const fallback = { category: 'Other', confidence: 0 };
  if ((payee || '').trim()) {
    loadMerchantCache().set((payee || '').toLowerCase().trim(), fallback);
    saveMerchantCache();
  }
  return fallback;
}

// -----------------------------
// Keyword-based category rules (fast path)
// -----------------------------
const CATEGORY_RULES = [
  {
    name: 'Food',
    keywords: [
      'lunch', 'dinner', 'breakfast', 'brunch', 'coffee', 'cafe', 'restaurant',
      'grocer', 'grocery', 'meal', 'snack', 'food', 'burger', 'pizza', 'drink',
      'dominos', 'domino\'s',
    ],
  },
  {
    name: 'Travel',
    keywords: [
      'travel', 'traveling', 'trip', 'flight', 'hotel', 'train', 'bus', 'taxi',
      'lyft', 'metro', 'subway', 'airport', 'toll', 'ride', 'vacation', 'irctc',
    ],
  },
  {
    name: 'Fashion',
    keywords: [
      'cloth', 'clothes', 'clothing', 'apparel', 'fashion', 'shirt', 'pants',
      'dress', 'shoes', 'sneaker', 'sneakers', 'jeans', 'jacket', 'skirt',
    ],
  },
  {
    name: 'Transport',
    keywords: ['fuel', 'gas', 'petrol', 'parking', 'commute', 'fare', 'ride share', 'uber'],
  },
  {
    name: 'Shopping',
    keywords: ['shopping', 'store', 'mall', 'amazon', 'amazon pay', 'purchase', 'buy'],
  },
];

let categoryIndex = null;
let expenseGroupId = null;
let apiInitPromise = null;
let apiReady = false;

async function loadCategoryIndex() {
  if (categoryIndex && expenseGroupId) {
    return;
  }

  const groups = await api.getCategoryGroups();
  categoryIndex = new Map();

  for (const group of groups) {
    if (!group.is_income && !expenseGroupId) {
      expenseGroupId = group.id;
    }

    for (const category of group.categories || []) {
      if (!category.hidden && !category.tombstone) {
        categoryIndex.set(category.name.toLowerCase(), category);
      }
    }
  }

  if (!expenseGroupId) {
    expenseGroupId = await api.createCategoryGroup({
      name: 'Expenses',
      is_income: false,
      hidden: false,
    });
  }
}

async function inferCategoryName({ payee = '', notes = '', amount = 0 }) {
  // Fast path: keyword rules are checked first for speed and determinism.
  const haystack = `${payee} ${notes}`.toLowerCase();

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      return rule.name;
    }
  }

  // Quick rule: positive amounts are income
  if (amount > 0) {
    return 'Income';
  }

  // Slow path: ask AI for a classification (cached by merchant/payee)
  try {
    const aiResult = await inferCategoryWithAI({ payee, notes, amount });
    if (aiResult && aiResult.category) {
      // Normalize category to one of the known buckets if possible
      const normalized = String(aiResult.category).trim();
      return normalized || 'Other';
    }
  } catch (e) {
    // ignore and fall through to safe default
  }

  // Safe fallback when neither keywords nor AI produced a category
  return 'Other';
}

async function resolveCategoryId(categoryName) {
  if (!categoryName) {
    return null;
  }

  await loadCategoryIndex();
  const normalizedName = categoryName.trim().toLowerCase();
  const existing = categoryIndex.get(normalizedName);

  if (existing) {
    return existing.id;
  }

  const newCategoryId = await api.createCategory({
    name: categoryName.trim(),
    group_id: expenseGroupId,
    is_income: false,
    hidden: false,
  });

  categoryIndex.set(normalizedName, {
    id: newCategoryId,
    name: categoryName.trim(),
    group: expenseGroupId,
  });

  return newCategoryId;
}

async function addTransaction({ amount, payee, notes, date, account = 'Checking', category: categoryName }) {
  const runtimeConfig = validateRequiredConfig({ requireActual: true, requireBudgetId: true });
  const actualConfig = getActualBudgetConfig();
  if (runtimeConfig.configDebug) {
    printDebugSummary('add-transaction');
  }
  const dataDir = 'C:\\tmp\\actual-data';
  fs.mkdirSync(dataDir, { recursive: true });

  if (!apiReady) {
    if (!apiInitPromise) {
      apiInitPromise = (async () => {
        await api.init({ serverURL: actualConfig.serverUrl, password: actualConfig.password, dataDir });
        const resolvedBudget = await resolveActualBudget(api, { dataDir });
        await api.loadBudget(resolvedBudget.localBudgetId);
        apiReady = true;
      })().finally(() => {
        apiInitPromise = null;
      });
    }

    await apiInitPromise;
  }

  const inferredCategoryName = categoryName || await inferCategoryName({ payee, notes, amount: parseFloat(amount) });
  const categoryId = await resolveCategoryId(inferredCategoryName);

  const accountId = ACCOUNTS[account] || ACCOUNTS['Checking'];
  const amountCents = Math.round(parseFloat(amount) * 100);
  const txDate = date || new Date().toISOString().split('T')[0];

  const ids = await api.addTransactions(accountId, [{
    date: txDate,
    amount: amountCents,
    payee_name: payee || '',
    notes: notes || '',
    category: categoryId || undefined,
    cleared: true,
  }]);

  // Attempt sync, but don't fail if it errors (transaction was already added)
  try {
    await api.sync();
  } catch (syncError) {
    console.warn('⚠️ Sync warning (transaction still saved):', syncError.message || syncError);
  }

  if (SHOULD_SHUTDOWN) {
    await api.shutdown();
  }
  return { ok: true, id: ids[0], account, amount: amountCents / 100, payee, date: txDate, notes, category: inferredCategoryName };
}

// CLI mode
const input = process.argv[2];
if (require.main === module && input) {
  const params = JSON.parse(input);
  addTransaction(params)
    .then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}

module.exports = { addTransaction, inferCategoryWithAI };
