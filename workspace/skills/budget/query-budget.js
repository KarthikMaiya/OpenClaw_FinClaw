#!/usr/bin/env node
/**
 * Actual Budget - Query Transactions
 *
 * Queries your Actual Budget instance for transaction data.
 *
 * Usage:
 *   node query-budget.js '{"command":"recent","limit":10}'
 *   node query-budget.js '{"command":"category","startDate":"2026-03-01","endDate":"2026-03-31"}'
 *   node query-budget.js '{"command":"total","startDate":"2026-03-01","endDate":"2026-03-31"}'
 *   node query-budget.js '{"command":"search","payee":"Coffee","limit":20}'
 *
 * Commands:
 *   recent   - Get the most recent N transactions (default limit: 10)
 *   category - Spending breakdown by category for a date range
 *   total    - Total spending for a date range
 *   analyze  - AI expense analyst with behavior insights
 *   search   - Search transactions by payee name
 *
 * Setup:
 *   1. Copy config.example.json to config.json in the integrations/ directory
 *   2. Run: node setup/discover-accounts.js to find your account UUIDs
 *   3. Update the ACCOUNTS map below with your real UUIDs
 *   4. Update the config path below to point to your integrations/ directory
 */

const path = require('path');
const fs = require('fs');
const { requestJson } = require('./ai-provider');
const { fetchBudgetMonth, attachBudgetContextToQuery, getMonthKey } = require('./budget-metadata');

// -----------------------------------------------------------------------
// UPDATE THIS PATH to point to your integrations/config.json
// Example: 'c:/Users/dhana/Desktop/telegram-openclaw/integrations/config.json'
// -----------------------------------------------------------------------
const config = require(path.resolve(__dirname, '../../../integrations/config.json'));

// Path to the directory containing @actual-app/api
// If you installed locally: use a path relative to the integrations/ directory
// or an absolute path to your node_modules
const MODULE_DIR = path.resolve(__dirname, '../../../integrations/node_modules');
const api = require(path.join(MODULE_DIR, '@actual-app/api'));
const forecasting = require(path.join(__dirname, 'forecasting'));

// -----------------------------------------------------------------------
// Replace these with your actual account UUIDs from Actual Budget.
// Run: node setup/discover-accounts.js to discover them automatically.
// The keys are friendly nicknames you'll use in queries.
// -----------------------------------------------------------------------
const ACCOUNTS = {
  'Checking':    'YOUR_CHECKING_ACCOUNT_UUID',     // e.g. 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  'Savings':     'YOUR_SAVINGS_ACCOUNT_UUID',
  'Credit Card': 'YOUR_CREDIT_CARD_ACCOUNT_UUID',
};

// The local budget folder name created after first sync/download.
// Check your dataDir (e.g. /tmp/actual-data/) after running discover-accounts.js
// to find the folder name, which looks like 'My-Budget-abc1234'.
const BUDGET_LOCAL_ID = 'YOUR_BUDGET_LOCAL_FOLDER_ID';

async function initAPI() {
  const dataDir = '/tmp/actual-data';
  fs.mkdirSync(dataDir, { recursive: true });
  await api.init({ serverURL: config.serverUrl, password: config.password, dataDir });
  await api.loadBudget(BUDGET_LOCAL_ID);
}

// ---------------------
// Command: recent
// ---------------------
async function getRecent(limit = 10) {
  await initAPI();

  // Query all accounts for recent transactions
  const accounts = await api.getAccounts();
  let allTransactions = [];

  for (const acct of accounts) {
    const txns = await api.getTransactions(acct.id);
    for (const t of txns) {
      allTransactions.push({
        date: t.date,
        amount: t.amount / 100,
        payee: t.payee_name || t.payee || '',
        notes: t.notes || '',
        account: acct.name,
        cleared: t.cleared,
      });
    }
  }

  // Sort by date descending, then take the limit
  allTransactions.sort((a, b) => b.date.localeCompare(a.date));
  const result = allTransactions.slice(0, limit);

  await api.shutdown();
  return result;
}

// ---------------------
// Command: category
// ---------------------
async function getCategorySpending(startDate, endDate) {
  await initAPI();

  const accounts = await api.getAccounts();
  const categories = {};

  for (const acct of accounts) {
    const txns = await api.getTransactions(acct.id);
    for (const t of txns) {
      if (t.date >= startDate && t.date <= endDate && t.amount < 0) {
        const cat = t.category || 'Uncategorized';
        categories[cat] = (categories[cat] || 0) + t.amount;
      }
    }
  }

  // Convert to array and sort by amount (most spent first)
  const result = Object.entries(categories)
    .map(([category, amount]) => ({ category, amount: amount / 100 }))
    .sort((a, b) => a.amount - b.amount);

  await api.shutdown();
  return result;
}

// ---------------------
// Command: total
// ---------------------
async function getTotal(startDate, endDate) {
  await initAPI();

  const accounts = await api.getAccounts();
  let totalExpenses = 0;
  let totalIncome = 0;
  let txCount = 0;

  for (const acct of accounts) {
    const txns = await api.getTransactions(acct.id);
    for (const t of txns) {
      if (t.date >= startDate && t.date <= endDate) {
        txCount++;
        if (t.amount < 0) {
          totalExpenses += t.amount;
        } else {
          totalIncome += t.amount;
        }
      }
    }
  }

  await api.shutdown();
  return {
    period: `${startDate} to ${endDate}`,
    expenses: totalExpenses / 100,
    income: totalIncome / 100,
    net: (totalIncome + totalExpenses) / 100,
    transactionCount: txCount,
  };
}

// ---------------------
// Command: analyze
// ---------------------
function parseDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getMonthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const startDate = `${month}-01`;
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate };
}

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const shifted = new Date(year, monthNumber - 1 + offset, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;
}

function buildInsights(currentTransactions, previousTransactions) {
  // Replaced manual heuristics with a generalized AI-driven insights pipeline.
  // This function is kept for compatibility but now delegates to the
  // `generateFinancialInsights` function which summarizes transactions and
  // asks an LLM for observations, recommendations, and confidence scores.
  // It returns a compact object compatible with the previous shape.
  return generateFinancialInsights(currentTransactions, { previousTransactions })
    .then(ai => ({
      totalExpense: ai.summary ? ai.summary.totalExpense : 0,
      net: ai.summary ? ai.summary.net : 0,
      transactionCount: currentTransactions.length,
      insights: ai.insights_short || (ai.insights_detailed || []).slice(0, 3),
      recommendations: ai.recommendations || [],
      confidence: ai.confidence || 0,
      raw: ai,
    }))
    .catch(() => ({
      totalExpense: 0,
      net: 0,
      transactionCount: currentTransactions.length,
      insights: ['Not enough history yet to spot a strong spending pattern.'],
      recommendations: [],
      confidence: 0,
    }));
}

const ANALYSIS_CACHE_FILE = require('path').join(__dirname, 'analysis-cache.json');
let analysisCache = null;

function loadAnalysisCache() {
  if (analysisCache) return analysisCache;
  try {
    if (fs.existsSync(ANALYSIS_CACHE_FILE)) {
      analysisCache = new Map(Object.entries(JSON.parse(fs.readFileSync(ANALYSIS_CACHE_FILE, 'utf8'))));
    } else {
      analysisCache = new Map();
    }
  } catch (e) {
    analysisCache = new Map();
  }
  return analysisCache;
}

function saveAnalysisCache() {
  try {
    const obj = Object.fromEntries(loadAnalysisCache());
    fs.writeFileSync(ANALYSIS_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    // non-fatal
  }
}

function summarizeTransactionsForAI(transactions) {
  // Reduce token usage by sending aggregated statistics instead of raw lists.
  const byCategory = {};
  const byPayee = {};
  const hours = Array(24).fill(0);
  const weekday = { weekday: 0, weekend: 0 };
  let expenseCount = 0;
  let expenseSum = 0;

  for (const t of transactions) {
    const amount = typeof t.amount === 'number' ? t.amount : (t.amount / 100);
    const isExpense = amount < 0;
    const abs = Math.abs(amount);
    const cat = (t.category || 'Other');
    const payee = (t.payee || t.payee_name || 'Unknown');
    const d = parseDate(t.date);

    byCategory[cat] = (byCategory[cat] || 0) + abs;
    byPayee[payee] = (byPayee[payee] || 0) + abs;
    if (d) {
      hours[d.getHours()] += abs;
      const day = d.getDay();
      if (day === 0 || day === 6) weekday.weekend += abs; else weekday.weekday += abs;
    }
    if (isExpense) {
      expenseCount += 1;
      expenseSum += abs;
    }
  }

  return {
    totalTransactions: transactions.length,
    expenseCount,
    totalExpense: expenseSum,
    byCategory,
    byPayeeTop: Object.entries(byPayee).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([p,a])=>({payee:p,amount:a})),
    hours,
    weekday,
  };
}

async function callAIForInsights(summary, options = {}) {
  const result = await requestJson({
    purpose: 'financial-insights',
    providers: options.providers,
    model: options.model,
    maxTokens: 400,
    temperature: 0,
    retries: 3,
    debug: !!options.debug,
    messages: [
      {
        role: 'system',
        content: 'You are a concise financial analyst. Given compact aggregated statistics about a user\'s transactions, produce JSON with insights_short (array of 1-4 short observations), insights_detailed (array of detailed explanations), recommendations (array of actionable suggestions), and confidence (0-100). Avoid hallucination and base findings on the provided summary.',
      },
      {
        role: 'user',
        content: `Summary: ${JSON.stringify(summary)}\nOptions: ${JSON.stringify(options)}\nRespond ONLY with valid JSON.`,
      },
    ],
    onFallback: {
      ok: true,
      provider: null,
      latencyMs: 0,
      tokenUsage: null,
      fallbackUsed: true,
      content: JSON.stringify(fallbackInsights(summary, options)),
      parsed: fallbackInsights(summary, options),
    },
  });

  return result.parsed || fallbackInsights(summary, options);
}

function fallbackInsights(summary, options = {}) {
  // Conservative, rule-based fallback that summarizes obvious statistics without hardcoded templates.
  const insights_short = [];
  const insights_detailed = [];
  const recommendations = [];
  const conf = 50;

  // Simple spike detection: compare top category vs average
  const catValues = Object.values(summary.byCategory || {});
  const avgCat = catValues.length ? (catValues.reduce((a,b)=>a+b,0)/catValues.length) : 0;
  const topCat = Object.entries(summary.byCategory || {}).sort((a,b)=>b[1]-a[1])[0];
  if (topCat && avgCat > 0 && topCat[1] > avgCat * 1.5) {
    insights_short.push(`${topCat[0]} is your largest spend category this period.`);
    insights_detailed.push(`The top category ${topCat[0]} accounts for $${Math.round(topCat[1])} which is significantly above the average category spend.`);
    recommendations.push(`Review ${topCat[0]} transactions and consider reducing discretionary purchases.`);
  }

  // Weekday vs weekend
  const wday = summary.weekday || { weekday:0, weekend:0 };
  if (wday.weekend > wday.weekday * 1.2 && wday.weekend > 0) {
    insights_short.push('Weekend spending is higher than weekdays.');
    insights_detailed.push(`Weekend total $${Math.round(wday.weekend)} vs weekday $${Math.round(wday.weekday)}.`);
  }

  // Late-night: use hours vector
  const late = (summary.hours || []).slice(20).reduce((a,b)=>a+b,0) + (summary.hours || [])[0] + (summary.hours || [])[1];
  const total = (summary.totalExpense || 0);
  if (late > 0 && total > 0 && late / total > 0.15) {
    insights_short.push('Substantial late-night spending detected.');
    insights_detailed.push(`Approximately ${(late/total*100).toFixed(0)}% of expenses occur after 8 PM.`);
    recommendations.push('Consider limiting late-night ordering or set a weekly limit.');
  }

  return { insights_short, insights_detailed, recommendations, confidence: conf, summary };
}

async function generateFinancialInsights(transactions, options = {}) {
  // Cache key derived from options (e.g., month) and transaction counts/sums
  const key = (options.cacheKey) || (`${options.month||''}:${transactions.length}:${Math.round((transactions.reduce((s,t)=>s+Math.abs(t.amount||0),0))||0)}`);
  const cache = loadAnalysisCache();
  if (cache.has(key)) return cache.get(key);

  const summary = summarizeTransactionsForAI(transactions);
  try {
    const ai = await callAIForInsights(summary, options);
    const out = { ...ai, summary };
    cache.set(key, out);
    saveAnalysisCache();
    return out;
  } catch (e) {
    const fallback = fallbackInsights(summary, options);
    cache.set(key, fallback);
    saveAnalysisCache();
    return fallback;
  }
}

async function getAnalyze(month = null, account = null) {
  await initAPI();

  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const previousMonth = shiftMonth(targetMonth, -1);
  const currentRange = getMonthRange(targetMonth);
  const previousRange = getMonthRange(previousMonth);
  const accountEntries = account ? [[account, ACCOUNTS[account]]] : Object.entries(ACCOUNTS);

  const currentTransactions = [];
  const previousTransactions = [];

  for (const [code, id] of accountEntries) {
    if (!id) continue;

    const current = await api.getTransactions(id);
    const previous = current;

    for (const transaction of current) {
      if (transaction.date >= currentRange.startDate && transaction.date <= currentRange.endDate) {
        currentTransactions.push({ ...transaction, account: code });
      }
      if (transaction.date >= previousRange.startDate && transaction.date <= previousRange.endDate) {
        previousTransactions.push({ ...transaction, account: code });
      }
    }
  }

  const result = buildInsights(currentTransactions, previousTransactions);

  await api.shutdown();
  return {
    ok: true,
    command: 'analyze',
    month: targetMonth,
    previousMonth,
    period: `${currentRange.startDate} to ${currentRange.endDate}`,
    previousPeriod: `${previousRange.startDate} to ${previousRange.endDate}`,
    ...result,
  };
}

// ---------------------
// Command: query
// ---------------------
const MONTH_NAME_LOOKUP = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const CATEGORY_ALIASES = {
  food: ['food', 'grocer', 'grocery', 'restaurant', 'meal', 'dining', 'coffee', 'swiggy', 'zomato'],
  shopping: ['shopping', 'amazon', 'mall', 'store', 'purchase', 'buy'],
  transport: ['transport', 'fuel', 'gas', 'petrol', 'uber', 'lyft', 'taxi', 'ride', 'metro', 'bus', 'train'],
  travel: ['travel', 'trip', 'flight', 'hotel', 'vacation', 'airport'],
  bills: ['bill', 'bills', 'utility', 'utilities', 'rent', 'internet', 'phone', 'electricity'],
  health: ['health', 'doctor', 'pharmacy', 'medical', 'clinic'],
  entertainment: ['entertainment', 'movie', 'movies', 'games', 'fun', 'netflix'],
};

function normalizeQueryText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMonthKey(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(monthKey, offset) {
  const [year, month] = monthKey.split('-').map(Number);
  const shifted = new Date(year, month - 1 + offset, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthRange(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const startDate = `${monthKey}-01`;
  const endDay = new Date(year, month, 0).getDate();
  const endDate = `${monthKey}-${String(endDay).padStart(2, '0')}`;
  return { startDate, endDate };
}

function getWeekRange(referenceDate = new Date()) {
  const endDate = new Date(referenceDate);
  endDate.setHours(23, 59, 59, 999);
  const offsetToMonday = (endDate.getDay() + 6) % 7;
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - offsetToMonday);
  startDate.setHours(0, 0, 0, 0);
  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

function parseMonthReferences(question) {
  const matches = [];
  const pattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/gi;
  let match;
  while ((match = pattern.exec(question)) !== null) {
    const monthName = match[1].toLowerCase();
    const year = match[2] ? Number(match[2]) : new Date().getFullYear();
    const monthNumber = MONTH_NAME_LOOKUP[monthName];
    if (monthNumber !== undefined) {
      const monthKey = `${year}-${String(monthNumber + 1).padStart(2, '0')}`;
      matches.push({ monthKey, ...getMonthRange(monthKey) });
    }
  }
  return matches;
}

function getCategoryKeyFromQuestion(question) {
  const normalized = normalizeQueryText(question);
  for (const [categoryKey, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return categoryKey;
    }
  }
  return null;
}

async function getAllTransactions() {
  const accounts = await api.getAccounts();
  const allTransactions = [];

  for (const acct of accounts) {
    const txns = await api.getTransactions(acct.id);
    for (const transaction of txns) {
      allTransactions.push({
        date: transaction.date,
        amount: transaction.amount / 100,
        payee: transaction.payee_name || transaction.payee || '',
        notes: transaction.notes || '',
        category: transaction.category || 'Uncategorized',
        account: acct.name,
      });
    }
  }

  return allTransactions;
}

function matchesCategory(transaction, categoryKey) {
  const aliases = CATEGORY_ALIASES[categoryKey] || [categoryKey];
  const haystack = normalizeQueryText([
    transaction.category || '',
    transaction.payee || '',
    transaction.notes || '',
  ].join(' '));
  return aliases.some((alias) => haystack.includes(alias));
}

function summarizeTransactions(transactions) {
  const expenses = [];
  let totalExpense = 0;
  let totalIncome = 0;

  for (const transaction of transactions) {
    if (transaction.amount < 0) {
      totalExpense += Math.abs(transaction.amount);
      expenses.push(transaction);
    } else {
      totalIncome += transaction.amount;
    }
  }

  expenses.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return { expenses, totalExpense, totalIncome, net: totalIncome - totalExpense };
}

// New AI-driven natural language query pipeline
// -----------------------------
// This replaces the previous regex-based handlers with a generalized
// pipeline that interprets user queries into a structured query schema,
// executes the structured query against transaction data, and returns
// a natural-language response produced by the model (with fallback).

const QUERY_CACHE_FILE = require('path').join(__dirname, 'query-interpretation-cache.json');
const QUERY_CONTEXT_FILE = require('path').join(__dirname, 'query-context.json');
let queryCache = null;
let queryContext = null;

function loadQueryCache() {
  if (queryCache) return queryCache;
  try {
    if (fs.existsSync(QUERY_CACHE_FILE)) {
      queryCache = new Map(Object.entries(JSON.parse(fs.readFileSync(QUERY_CACHE_FILE, 'utf8'))));
    } else {
      queryCache = new Map();
    }
  } catch (e) { queryCache = new Map(); }
  return queryCache;
}

function saveQueryCache() {
  try { fs.writeFileSync(QUERY_CACHE_FILE, JSON.stringify(Object.fromEntries(loadQueryCache()), null, 2), 'utf8'); } catch (e) {}
}

function loadQueryContext() {
  if (queryContext) return queryContext;
  try {
    if (fs.existsSync(QUERY_CONTEXT_FILE)) {
      queryContext = JSON.parse(fs.readFileSync(QUERY_CONTEXT_FILE, 'utf8'));
    } else {
      queryContext = { lastQuery: null, history: [] };
    }
  } catch (e) { queryContext = { lastQuery: null, history: [] }; }
  return queryContext;
}

function saveQueryContext() {
  try { fs.writeFileSync(QUERY_CONTEXT_FILE, JSON.stringify(loadQueryContext(), null, 2), 'utf8'); } catch (e) {}
}

/**
 * interpretQueryWithAI
 * - Converts free-form user queries into a structured query object.
 * - Returns { queryObject, confidence }
 */
async function interpretQueryWithAI(userQuery, context = {}) {
  const cacheKey = userQuery.trim().toLowerCase();
  const cache = loadQueryCache();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const result = await requestJson({
    purpose: 'query-interpretation',
    providers: context.providers,
    mockProviderResponses: context.mockProviderResponses,
    maxTokens: 300,
    temperature: 0,
    retries: 3,
    debug: !!context.debug,
    messages: [
      {
        role: 'system',
        content: `You are a query interpreter for a personal finance assistant. Convert the user's natural language question into a JSON object matching this schema:\n{ intent, filters, dateRange, aggregation, grouping, comparison, outputFormat, horizonMonths, categories, followUp, confidence }\n- intent: one of ['total','comparison','trend','top','list','forecast','overspending_risk','savings_projection','budget_health','advice']\n- filters: free-form filters (category, payee, amountRange, budgetAmounts)\n- dateRange: either ['start','end'] ISO dates or tokens like 'current_month','previous_month','this_year','this_week'\n- aggregation: 'sum'|'average'|'count' etc.\n- grouping: 'category'|'payee'|'month'|'week'\n- comparison: { left: dateRange, right: dateRange } or null\n- horizonMonths: optional integer indicating forecast horizon\n- categories: optional array of categories the user mentioned or that you infer\n- followUp: boolean true if the query appears to be a conversational follow-up\nReturn a JSON object only.`,
      },
      {
        role: 'user',
        content: `User query: "${userQuery}"\nContext: ${JSON.stringify(context || {})}`,
      },
    ],
    onFallback: {
      ok: true,
      provider: null,
      latencyMs: 0,
      tokenUsage: null,
      fallbackUsed: true,
      content: JSON.stringify({ queryObject: { intent: 'unknown' }, confidence: 0 }),
      parsed: { queryObject: { intent: 'unknown' }, confidence: 0 },
    },
  });

  const out = result.parsed || { queryObject: { intent: 'unknown' }, confidence: 0 };
  cache.set(cacheKey, out);
  saveQueryCache();
  return out;
}

function resolveDateRangeSpec(spec) {
  // spec may be tokens like 'current_month' or explicit {start,end}
  if (!spec) return null;
  if (typeof spec === 'string') {
    const now = new Date();
    if (spec === 'current_month') return getMonthRange(now.toISOString().slice(0,7));
    if (spec === 'previous_month') return getMonthRange(shiftMonth(now.toISOString().slice(0,7), -1));
    if (spec === 'this_year') return { startDate: `${now.getFullYear()}-01-01`, endDate: `${now.getFullYear()}-12-31` };
    if (spec === 'last_year') return { startDate: `${now.getFullYear()-1}-01-01`, endDate: `${now.getFullYear()-1}-12-31` };
    if (spec === 'this_week') return getWeekRange(now);
  }
  if (spec.start && spec.end) return { startDate: spec.start, endDate: spec.end };
  return null;
}

function applyFilters(transactions, filters = {}) {
  // filters may include category, payee, amountRange {min,max}
  return transactions.filter(t => {
    if (filters.category) {
      const cat = (t.category || '').toLowerCase();
      if (!cat.includes(filters.category.toLowerCase())) return false;
    }
    if (filters.payee) {
      const pay = (t.payee || '').toLowerCase();
      if (!pay.includes(filters.payee.toLowerCase())) return false;
    }
    if (filters.amountRange) {
      const amt = t.amount;
      if (typeof filters.amountRange.min === 'number' && amt < filters.amountRange.min) return false;
      if (typeof filters.amountRange.max === 'number' && amt > filters.amountRange.max) return false;
    }
    return true;
  });
}

function aggregateTransactions(transactions, aggregation = 'sum') {
  if (aggregation === 'sum') return transactions.reduce((s,t)=>s + (t.amount<0?Math.abs(t.amount):0), 0);
  if (aggregation === 'average') return transactions.reduce((s,t)=>s + (t.amount<0?Math.abs(t.amount):0),0) / (transactions.length || 1);
  if (aggregation === 'count') return transactions.length;
  return null;
}

function groupBy(transactions, key) {
  const out = {};
  for (const t of transactions) {
    let k;
    if (key === 'category') k = t.category || 'Uncategorized';
    else if (key === 'payee') k = t.payee || 'Unknown';
    else if (key === 'month') k = (t.date || '').slice(0,7);
    else k = 'other';
    out[k] = out[k] || [];
    out[k].push(t);
  }
  return out;
}

function interpretToExecutionPlan(structured) {
  // Minimal mapping from structured query to execution plan
  const plan = { dateRange: null, filters: structured.filters || {}, aggregation: structured.aggregation || 'sum', grouping: structured.grouping || null, comparison: structured.comparison || null };
  if (structured.dateRange) plan.dateRange = resolveDateRangeSpec(structured.dateRange);
  if (structured.comparison && structured.comparison.left && structured.comparison.right) {
    plan.comparison = { left: resolveDateRangeSpec(structured.comparison.left), right: resolveDateRangeSpec(structured.comparison.right) };
  }
  return plan;
}

function executeStructuredQuery(structuredQuery, transactions) {
  // Execute the structured query against supplied transactions.
  const plan = interpretToExecutionPlan(structuredQuery);
  const debug = !!process.env.QUERY_DEBUG;
  if (debug) console.error('Execution plan:', JSON.stringify(plan, null, 2));

  const applyRange = (txns, range) => {
    if (!range) return txns;
    return txns.filter(t => t.date >= range.startDate && t.date <= range.endDate);
  };

  if (structuredQuery.intent === 'comparison' && plan.comparison) {
    const left = applyRange(transactions, plan.comparison.left);
    const right = applyRange(transactions, plan.comparison.right);
    const leftAgg = aggregateTransactions(applyFilters(left, plan.filters), plan.aggregation);
    const rightAgg = aggregateTransactions(applyFilters(right, plan.filters), plan.aggregation);
    const delta = rightAgg - leftAgg;
    const pct = leftAgg > 0 ? ((delta / leftAgg) * 100) : null;
    return { type: 'comparison', left: leftAgg, right: rightAgg, delta, percentChange: pct };
  }

  // Default: aggregate over dateRange
  const range = plan.dateRange || null;
  const inRange = applyRange(transactions, range);
  const filtered = applyFilters(inRange, plan.filters);

  if (plan.grouping) {
    const groups = groupBy(filtered, plan.grouping);
    const aggregated = Object.fromEntries(Object.entries(groups).map(([k,v])=>[k, aggregateTransactions(v, plan.aggregation)]));
    return { type: 'grouped', groups: aggregated };
  }

  const agg = aggregateTransactions(filtered, plan.aggregation);
  return { type: 'aggregate', value: agg, count: filtered.length };
}

async function processFinancialQuery(userQuery, transactions, options = {}) {
  // High-level orchestration: interpret -> plan -> execute -> summarize
  const context = loadQueryContext();
  const budgetMonthKey = options.month || getMonthKey();
  let budgetSnapshot = null;
  try {
    await initAPI();
    budgetSnapshot = await fetchBudgetMonth(api, budgetMonthKey, { force: !!options.debug });
  } catch (error) {
    budgetSnapshot = null;
  }

  const interpretation = await interpretQueryWithAI(userQuery, {
    context: context.lastQuery,
    providers: options.providers,
    mockProviderResponses: options.mockProviderResponses,
    debug: !!options.debug,
  });
  return processFinancialQueryCore(userQuery, transactions, budgetSnapshot, {
    ...options,
    structuredInterpretation: interpretation,
    queryContext: context,
  });
}

async function processFinancialQueryCore(userQuery, transactions, budgetSnapshot, options = {}) {
  const interpretation = options.structuredInterpretation || await interpretQueryWithAI(userQuery, {
    context: options.queryContext && options.queryContext.lastQuery,
    providers: options.providers,
    mockProviderResponses: options.mockProviderResponses,
    debug: !!options.debug,
  });
  const confidence = interpretation.confidence || 0;
  const context = options.queryContext || loadQueryContext();
  const structured = attachBudgetContextToQuery(interpretation.queryObject || interpretation, budgetSnapshot);

  if (process.env.QUERY_DEBUG || options.debug) {
    console.error('Interpreted intent:', structured.intent || 'unknown');
    console.error('Structured query object:', JSON.stringify(structured, null, 2));
    if (budgetSnapshot) {
      console.error('Fetched budget snapshot:', JSON.stringify({
        month: budgetSnapshot.month,
        totalBudgeted: budgetSnapshot.totalBudgeted,
        totalSpent: budgetSnapshot.totalSpent,
        totalBalance: budgetSnapshot.totalBalance,
        toBudget: budgetSnapshot.toBudget,
        categories: (budgetSnapshot.categories || []).map((item) => ({ name: item.name, budgeted: item.budgeted, spent: item.spent, balance: item.balance })),
      }, null, 2));
    }
  }

  if (!structured || !structured.intent) {
    return { ok: false, reason: 'Could not interpret query', confidence: 0 };
  }

  try {
    if ((structured.followUp || !structured.filters || Object.keys(structured.filters || {}).length === 0) && context.lastQuery && context.lastQuery.structured) {
      const prev = context.lastQuery.structured || {};
      structured.filters = Object.assign({}, prev.filters || {}, structured.filters || {});
      if (!structured.intent || structured.intent === 'unknown') structured.intent = prev.intent;
    }
  } catch (e) { /* ignore context merge errors */ }

  const forecastIntents = ['forecast', 'overspending_risk', 'savings_projection', 'budget_health'];
  let exec = null;
  let answer = null;

  if (forecastIntents.includes(structured.intent)) {
    let txnsForForecast = transactions;
    if (structured.filters && structured.filters.category) {
      txnsForForecast = transactions.filter(t => matchesCategory(t, structured.filters.category));
    }

    const horizonMonths = structured.horizonMonths || 1;
    const budgets = {};
    if (budgetSnapshot && Array.isArray(budgetSnapshot.categories)) {
      for (const category of budgetSnapshot.categories) {
        const key = String(category.name || '').trim();
        if (!key) continue;
        budgets[key] = {
          limit: Number(category.budgeted || 0),
          remaining: Number(category.balance ?? category.remaining ?? 0),
          spent: Number(category.spent || 0),
        };
      }
      budgets.total = {
        limit: Number(budgetSnapshot.totalBudgeted || 0),
        remaining: Number(budgetSnapshot.toBudget ?? budgetSnapshot.totalBalance ?? 0),
      };
    }
    if (structured.filters && structured.filters.budgets) {
      Object.assign(budgets, structured.filters.budgets);
    } else if (structured.filters && structured.filters.budgetAmount) {
      budgets[structured.filters.category || 'total'] = { limit: structured.filters.budgetAmount, remaining: structured.filters.budgetAmount };
    }

    try {
      const forecastOut = await forecasting.predictFutureExpenses(txnsForForecast, budgets, { horizonMonths, frequency: structured.frequency || 'monthly', cacheKey: options.cacheKey, debug: !!options.debug, providers: options.providers, mockProviderResponses: options.mockProviderResponses });
      exec = { type: 'forecast', forecast: forecastOut, inputFilters: structured.filters || {} };
      answer = { answer_short: forecastOut.recommendations && forecastOut.recommendations[0] ? forecastOut.recommendations[0] : `Predicted spend: ${forecastOut.predictedSpend} (${forecastOut.forecastPeriod})`, answer_detailed: forecastOut.explanation_detailed || '', confidence: forecastOut.confidence || 0 };
      if (structured.intent === 'budget_health' && budgetSnapshot) {
        answer.answer_short = `You have ${budgetSnapshot.toBudget} remaining to budget this month.`;
      }
      context.lastQuery = { userQuery, structured, timestamp: new Date().toISOString() };
      context.history = (context.history || []).slice(-50).concat(context.lastQuery);
      saveQueryContext();
      return { ok: true, structured, confidence: forecastOut.confidence || confidence, exec, answer };
    } catch (e) {
      exec = { type: 'error', message: e.message };
    }
  }

  exec = executeStructuredQuery(structured, transactions);
  context.lastQuery = { userQuery, structured, timestamp: new Date().toISOString() };
  context.history = (context.history || []).slice(-50).concat(context.lastQuery);
  saveQueryContext();

  try {
    const aiSummary = await requestJson({
      purpose: 'query-answer',
      providers: options.providers,
      mockProviderResponses: options.mockProviderResponses,
      maxTokens: 300,
      temperature: 0,
      retries: 3,
      debug: !!options.debug,
      messages: [
        {
          role: 'system',
          content: 'You are a concise financial assistant. Given the user\'s query and the execution result, produce a short human-friendly answer and a detailed explanation. Respond with JSON: { answer_short, answer_detailed, confidence }',
        },
        {
          role: 'user',
          content: `Query: ${JSON.stringify(structured)}\nResult: ${JSON.stringify(exec)}`,
        },
      ],
      onFallback: {
        ok: true,
        provider: null,
        latencyMs: 0,
        tokenUsage: null,
        fallbackUsed: true,
        content: JSON.stringify({ answer_short: '', answer_detailed: '', confidence: confidence }),
        parsed: { answer_short: '', answer_detailed: '', confidence: confidence },
      },
    });
    answer = aiSummary.parsed || null;
  } catch (e) {
    /* ignore AI summarization errors */
  }

  return { ok: true, structured, confidence, exec, answer };
}

// Replace previous CLI caller to use processFinancialQuery in getNaturalLanguageQuery wrapper
async function getNaturalLanguageQuery(question) {
  await initAPI();
  const allTransactions = await getAllTransactions();
  const result = await processFinancialQuery(question, allTransactions);
  await api.shutdown();
  if (!result.ok) {
    return { ok: true, command: 'query', question, answer: "I couldn't confidently interpret that question." };
  }
  // If AI provided a human answer, use it; otherwise synthesize a simple text
  const answerText = result.answer && result.answer.answer_short
    ? result.answer.answer_short
    : JSON.stringify(result.exec, null, 2);
  return { ok: true, command: 'query', question, answer: answerText, structured: result.structured, confidence: result.confidence };
}

// ---------------------
// Command: search
// ---------------------
async function searchByPayee(payee, limit = 20) {
  await initAPI();

  const accounts = await api.getAccounts();
  const matches = [];
  const searchTerm = payee.toLowerCase();

  for (const acct of accounts) {
    const txns = await api.getTransactions(acct.id);
    for (const t of txns) {
      const payeeName = (t.payee_name || t.payee || '').toLowerCase();
      if (payeeName.includes(searchTerm)) {
        matches.push({
          date: t.date,
          amount: t.amount / 100,
          payee: t.payee_name || t.payee || '',
          notes: t.notes || '',
          account: acct.name,
        });
      }
    }
  }

  matches.sort((a, b) => b.date.localeCompare(a.date));
  const result = matches.slice(0, limit);

  await api.shutdown();
  return result;
}

function renderForecastConsole(forecastOut) {
  // Simple terminal-friendly summary and category risk table
  console.log('Forecast period:', forecastOut.forecastPeriod);
  console.log('Predicted spend:', forecastOut.predictedSpend);
  console.log('Overspending risk:', forecastOut.overspendingRisk || 0);
  if (forecastOut.remainingSafeBudget !== null) console.log('Remaining safe budget:', forecastOut.remainingSafeBudget);
  if (forecastOut.recommendations && forecastOut.recommendations.length) {
    console.log('\nRecommendations:');
    for (const r of forecastOut.recommendations) console.log(' -', r);
  }
  if (forecastOut.categoryForecasts) {
    console.log('\nCategory risks:');
    const rows = Object.entries(forecastOut.categoryForecasts).sort((a,b)=>b[1]-a[1]);
    for (const [cat, val] of rows) {
      console.log(` - ${cat}: ${val}`);
    }
  }
}

async function runCLI() {
  // CLI entry point supports two modes:
  //  - JSON command object (legacy)
  //  - Natural language query: node query-budget.js "Will I exceed my shopping budget?" [--json] [--debug]
  const rawArgs = process.argv.slice(2);
  if (!rawArgs || rawArgs.length === 0) {
    console.error('Usage: node query-budget.js \"Will I exceed my shopping budget?\" [--json] [--debug]');
    console.error('Or: node query-budget.js \"{\"command\":\"recent\",\"limit\":10}\"');
    process.exit(1);
  }

  // Detect JSON input vs natural language
  const first = rawArgs[0];
  let isJson = false;
  try { JSON.parse(first); isJson = true; } catch (e) { isJson = false; }

  if (isJson) {
    const params = JSON.parse(first);
    try {
      let result;
      switch (params.command) {
        case 'recent': result = await getRecent(params.limit || 10); break;
        case 'category':
          if (!params.startDate || !params.endDate) { console.error('Error: category command requires startDate and endDate'); process.exit(1); }
          result = await getCategorySpending(params.startDate, params.endDate); break;
        case 'total':
          if (!params.startDate || !params.endDate) { console.error('Error: total command requires startDate and endDate'); process.exit(1); }
          result = await getTotal(params.startDate, params.endDate); break;
        case 'search':
          if (!params.payee) { console.error('Error: search command requires payee'); process.exit(1); }
          result = await searchByPayee(params.payee, params.limit || 20); break;
        case 'analyze': result = await getAnalyze(params.month || null, params.account || null); break;
        case 'query': result = await getNaturalLanguageQuery(params.question || ''); break;
        default: console.error(`Unknown command: ${params.command}`); process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); }
    return;
  }

  // Natural language mode
  const flags = new Set(rawArgs.filter(a => a.startsWith('--')).map(a => a.toLowerCase()));
  const question = rawArgs.filter(a => !a.startsWith('--')).join(' ').trim();
  const wantJson = flags.has('--json');
  const wantDebug = flags.has('--debug');
  if (wantDebug) process.env.QUERY_DEBUG = '1';

  try {
    const result = await getNaturalLanguageQuery(question);
    if (!result.ok) { console.error(result.answer || 'Could not process query'); process.exit(1); }
    // If the structured intent resulted in a forecast, pretty-print
    const structured = result.structured || {};
    const exec = (result.exec) || {};
    if (wantJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    // Terminal-friendly
    console.log('Question:', question);
    console.log('Interpreted intent:', structured.intent || 'unknown', 'confidence:', result.confidence || 0);
    if (exec.type === 'forecast' && exec.forecast) {
      renderForecastConsole(exec.forecast);
      if (process.env.QUERY_DEBUG) {
        console.error('\nDebug: trend inputs:', JSON.stringify(exec.forecast.inputs || {}, null, 2));
      }
      return;
    }

    // Default answer path
    if (result.answer) {
      console.log('\nAnswer:');
      console.log(result.answer);
    } else {
      console.log('\nResult:');
      console.log(JSON.stringify(result.exec || result, null, 2));
    }
  } catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); }
}

if (require.main === module) {
  runCLI();
}

module.exports = {
  getRecent,
  getCategorySpending,
  getTotal,
  getAnalyze,
  getNaturalLanguageQuery,
  interpretQueryWithAI,
  processFinancialQuery,
  processFinancialQueryCore,
  generateFinancialInsights,
  summarizeTransactionsForAI,
  fallbackInsights,
  executeStructuredQuery,
  getAllTransactions,
};
