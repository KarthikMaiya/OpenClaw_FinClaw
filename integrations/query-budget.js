#!/usr/bin/env node
/**
 * Actual Budget - Query Budget
 *
 * Query transactions, balances, and spending summaries from your Actual Budget.
 *
 * Commands:
 *   recent  - Get recent transactions (optionally filtered by account)
 *   balance - Get current balance for all accounts
 *   summary - Get spending summary by category for a given month
 *   search  - Search transactions by payee or notes text
 */

// Polyfill for browser APIs
if (typeof navigator === 'undefined') {
  global.navigator = { platform: 'linux' };
}
if (typeof SharedArrayBuffer === 'undefined') {
  global.SharedArrayBuffer = ArrayBuffer;
}

const fs = require('fs');
const api = require('@actual-app/api');
const { getActualBudgetConfig, validateRequiredConfig, printDebugSummary, resolveActualBudget } = require('../config-manager');
const SHOULD_SHUTDOWN = require.main === module;

// Only configured account for this workspace.
const ACCOUNTS = {
  'Karthik Maiya': 'ade5ff91-e560-4988-be90-b56344158a29',
};

const ACCOUNT_NAMES = Object.fromEntries(
  Object.entries(ACCOUNTS).map(([name, id]) => [id, name])
);

let apiInitPromise = null;
let apiReady = false;
let lastInitAttempt = 0;
let initFailureCount = 0;
let resolvedBudgetCache = null;

const ACTUAL_INIT_TIMEOUT_MS = Number(process.env.ACTUAL_INIT_TIMEOUT_MS || 20000);
const ACTUAL_INIT_MAX_RETRIES = Number(process.env.ACTUAL_INIT_MAX_RETRIES || 3);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function isRetryableActualConnectionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('network-failure') ||
    message.includes('network failure') ||
    message.includes('timeout') ||
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable')
  );
}

async function resetActualConnection() {
  try {
    await api.shutdown();
  } catch {
    // Ignore shutdown errors while recovering the connection.
  } finally {
    apiReady = false;
  }
}

function buildActualServerCandidates(serverUrl) {
  const base = String(serverUrl || '').trim();
  if (!base) {
    return [];
  }

  const candidates = new Set([base]);

  try {
    const parsed = new URL(base);
    if (parsed.hostname === 'localhost') {
      const ipv4 = new URL(base);
      ipv4.hostname = '127.0.0.1';
      candidates.add(ipv4.toString());
    } else if (parsed.hostname === '127.0.0.1') {
      const localhost = new URL(base);
      localhost.hostname = 'localhost';
      candidates.add(localhost.toString());
    }
  } catch {
    if (/localhost/i.test(base)) {
      candidates.add(base.replace(/localhost/ig, '127.0.0.1'));
    } else if (/127\.0\.0\.1/.test(base)) {
      candidates.add(base.replace(/127\.0\.0\.1/g, 'localhost'));
    }
  }

  return [...candidates];
}

function formatMoney(amount) {
  return `₹${amount.toFixed(2)}`;
}

function parseTransactionDate(value) {
  if (!value) return null;

  const isoMatch = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (isoMatch) {
    return new Date(
      Number(isoMatch[1]),
      Number(isoMatch[2]) - 1,
      Number(isoMatch[3]),
      Number(isoMatch[4] || 0),
      Number(isoMatch[5] || 0),
      Number(isoMatch[6] || 0)
    );
  }

  const fallback = new Date(value);
  if (Number.isNaN(fallback.getTime())) {
    return null;
  }
  return fallback;
}

function getTransactionHour(transaction) {
  const candidates = [
    transaction.time,
    transaction.hour,
    transaction.timestamp,
    transaction.createdAt,
    transaction.importedAt,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string') {
      const match = candidate.match(/(?:T|\s)(\d{2}):(\d{2})/);
      if (match) {
        return Number(match[1]);
      }
    }
  }

  const parsed = parseTransactionDate(transaction.date);
  return parsed ? parsed.getHours() : null;
}

function getMonthRange(targetMonth) {
  const [year, month] = targetMonth.split('-').map(Number);
  const startDate = `${targetMonth}-01`;
  const endDay = new Date(year, month, 0).getDate();
  const endDate = `${targetMonth}-${String(endDay).padStart(2, '0')}`;
  return { startDate, endDate };
}

function shiftMonth(targetMonth, offset) {
  const [year, month] = targetMonth.split('-').map(Number);
  const shifted = new Date(year, month - 1 + offset, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;
}

function isWeekend(date) {
  const parsed = parseTransactionDate(date);
  if (!parsed) return false;
  const day = parsed.getDay();
  return day === 0 || day === 6;
}

function addCategoryStats(stats, category, amount) {
  if (!stats[category]) {
    stats[category] = { total: 0, count: 0 };
  }
  stats[category].total += amount;
  stats[category].count += 1;
}

function summarizeSpendingInsights(transactions) {
  const byCategory = {};
  const byPayee = {};
  const payeeByHour = new Map();

  const totals = {
    expense: 0,
    income: 0,
    weekendExpense: 0,
    weekdayExpense: 0,
    nightExpense: 0,
    dayExpense: 0,
    timeSampleCount: 0,
    nightSampleCount: 0,
  };

  for (const transaction of transactions) {
    const amount = (transaction.amount || 0) / 100;
    const category = transaction.category || 'Uncategorized';
    const payee = transaction.payee_name || transaction.payee || 'Unknown';

    if (amount < 0) {
      totals.expense += Math.abs(amount);
      addCategoryStats(byCategory, category, Math.abs(amount));
    } else {
      totals.income += amount;
    }

    byPayee[payee] = byPayee[payee] || { total: 0, count: 0 };
    byPayee[payee].total += Math.abs(amount);
    byPayee[payee].count += 1;

    if (amount < 0) {
      if (isWeekend(transaction.date)) {
        totals.weekendExpense += Math.abs(amount);
      } else {
        totals.weekdayExpense += Math.abs(amount);
      }
    }

    const hour = getTransactionHour(transaction);
    if (hour !== null) {
      totals.timeSampleCount += 1;
      if (amount < 0) {
        if (hour >= 20) {
          totals.nightExpense += Math.abs(amount);
          totals.nightSampleCount += 1;
          if (!payeeByHour.has(payee)) {
            payeeByHour.set(payee, { nightTotal: 0, count: 0 });
          }
          const nightStats = payeeByHour.get(payee);
          nightStats.nightTotal += Math.abs(amount);
          nightStats.count += 1;
        } else {
          totals.dayExpense += Math.abs(amount);
        }
      }
    }
  }

  return { byCategory, byPayee, payeeByHour, totals };
}

function buildCategoryInsights(currentByCategory, previousByCategory) {
  const changes = Object.entries(currentByCategory)
    .map(([category, stats]) => {
      const current = stats.total || 0;
      const previous = previousByCategory[category]?.total || 0;
      const delta = current - previous;
      const percent = previous > 0 ? (delta / previous) * 100 : null;
      return { category, current, previous, delta, percent };
    })
    .filter((entry) => entry.current > 0 && entry.delta > 0)
    .sort((a, b) => b.delta - a.delta);

  const insights = [];
  for (const change of changes.slice(0, 2)) {
    if (change.previous > 0 && change.percent !== null) {
      insights.push(
        `You spent ${Math.round(change.percent)}% more on ${change.category} this month (${formatMoney(change.current)} vs ${formatMoney(change.previous)} last month).`
      );
    } else {
      insights.push(
        `${change.category} is a new spending area this month at ${formatMoney(change.current)}.`
      );
    }
  }

  return insights;
}

function buildBehaviorInsights(currentStats, previousStats) {
  const insights = [];
  const { totals, byPayee, payeeByHour } = currentStats;
  const previousTotals = previousStats?.totals || {
    expense: 0,
    weekendExpense: 0,
    weekdayExpense: 0,
    nightExpense: 0,
  };

  if (totals.weekendExpense > 0 && totals.weekdayExpense > 0) {
    const weekendRatio = totals.weekendExpense / totals.weekdayExpense;
    if (weekendRatio >= 1.2 && totals.weekendExpense >= 25) {
      const percent = Math.round((weekendRatio - 1) * 100);
      insights.push(`Your weekend spending is ${percent}% higher than weekday spending.`);
    }
  }

  if (
    totals.nightExpense > 0 &&
    totals.timeSampleCount > 0 &&
    totals.nightSampleCount > 0 &&
    (totals.nightExpense >= previousTotals.nightExpense * 1.2 || previousTotals.nightExpense === 0)
  ) {
    const nightPayees = [...payeeByHour.entries()]
      .sort((a, b) => b[1].nightTotal - a[1].nightTotal)
      .slice(0, 2)
      .map(([payee]) => payee)
      .filter((name) => name && name !== 'Unknown');

    if (nightPayees.length > 0) {
      const nightShare = Math.round((totals.nightExpense / totals.expense) * 100);
      insights.push(
        `Late-night spending is up and makes up ${nightShare}% of your expenses, mostly at ${nightPayees.join(' and ')}.`
      );
    }
  }

  const topPayees = Object.entries(byPayee)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 3)
    .map(([payee]) => payee)
    .filter((name) => name && name !== 'Unknown');

  if (topPayees.length > 0 && insights.length === 0) {
    insights.push(`Your spending is concentrated around ${topPayees.join(', ')}.`);
  }

  return insights;
}

function buildSpendingInsights(currentTransactions, previousTransactions) {
  const currentStats = summarizeSpendingInsights(currentTransactions);
  const previousStats = summarizeSpendingInsights(previousTransactions);
  const insights = [
    ...buildCategoryInsights(currentStats.byCategory, previousStats.byCategory),
    ...buildBehaviorInsights(currentStats, previousStats),
  ];

  if (insights.length === 0) {
    insights.push('Not enough history yet to spot a strong spending pattern.');
  }

  const totalExpense = currentStats.totals.expense;
  const totalIncome = currentStats.totals.income;

  return {
    totalExpense: -totalExpense,
    totalIncome,
    net: totalIncome - totalExpense,
    transactionCount: currentTransactions.length,
    byCategory: currentStats.byCategory,
    insights,
  };
}

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

function getCurrentMonthKey(referenceDate = new Date()) {
  return `${referenceDate.getFullYear()}-${String(referenceDate.getMonth() + 1).padStart(2, '0')}`;
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

function getPreviousWeekRange(referenceDate = new Date()) {
  const currentWeek = getWeekRange(referenceDate);
  const startDate = parseTransactionDate(currentWeek.startDate);
  const endDate = parseTransactionDate(currentWeek.endDate);
  startDate.setDate(startDate.getDate() - 7);
  endDate.setDate(endDate.getDate() - 7);
  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

function getMonthRangeFromKey(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const startDate = `${monthKey}-01`;
  const endDay = new Date(year, month, 0).getDate();
  const endDate = `${monthKey}-${String(endDay).padStart(2, '0')}`;
  return { startDate, endDate };
}

function getPeriodForMonthName(monthName, year = new Date().getFullYear()) {
  const monthNumber = MONTH_NAME_LOOKUP[monthName.toLowerCase()];
  if (monthNumber === undefined) {
    return null;
  }
  const monthKey = `${year}-${String(monthNumber + 1).padStart(2, '0')}`;
  return { monthKey, ...getMonthRangeFromKey(monthKey) };
}

function parseMonthReferences(question) {
  const matches = [];
  const pattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/gi;
  let match;
  while ((match = pattern.exec(question)) !== null) {
    const monthName = match[1].toLowerCase();
    const year = match[2] ? Number(match[2]) : new Date().getFullYear();
    const period = getPeriodForMonthName(monthName, year);
    if (period) {
      matches.push(period);
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

function matchesCategory(transaction, categoryKey) {
  const aliases = CATEGORY_ALIASES[categoryKey] || [categoryKey];
  const haystack = normalizeQueryText([
    transaction.category || '',
    transaction.payee_name || transaction.payee || '',
    transaction.notes || '',
  ].join(' '));
  return aliases.some((alias) => haystack.includes(alias));
}

function summarizePeriodTransactions(transactions) {
  const expenses = [];
  const byCategory = {};
  let totalExpense = 0;
  let totalIncome = 0;

  for (const transaction of transactions) {
    const amount = (transaction.amount || 0) / 100;
    const category = transaction.category || 'Uncategorized';
    const payee = transaction.payee_name || transaction.payee || 'Unknown';

    if (amount < 0) {
      const expenseAmount = Math.abs(amount);
      totalExpense += expenseAmount;
      expenses.push({
        date: transaction.date,
        payee,
        category,
        amount: expenseAmount,
      });
      if (!byCategory[category]) {
        byCategory[category] = { total: 0, count: 0 };
      }
      byCategory[category].total += expenseAmount;
      byCategory[category].count += 1;
    } else {
      totalIncome += amount;
    }
  }

  expenses.sort((a, b) => b.amount - a.amount);

  return {
    expenses,
    byCategory,
    totalExpense,
    totalIncome,
    net: totalIncome - totalExpense,
  };
}

async function getTransactionsForRange({ startDate, endDate, account } = {}) {
  await initBudget();
  const accountEntries = account ? [[account, ACCOUNTS[account]]] : Object.entries(ACCOUNTS);
  const allTransactions = [];

  for (const [code, id] of accountEntries) {
    if (!id) continue;
    const txs = await api.getTransactions(id, startDate, endDate);
    allTransactions.push(...txs.map((transaction) => ({ ...transaction, accountCode: code })));
  }

  return allTransactions;
}

async function getNaturalLanguageQuery({ question, account } = {}) {
  await initBudget();

  const originalQuestion = question || '';
  const normalized = normalizeQueryText(originalQuestion);
  const categoryKey = getCategoryKeyFromQuestion(originalQuestion);
  const monthReferences = parseMonthReferences(originalQuestion);
  const currentMonthKey = getCurrentMonthKey();

  const useCurrentMonth = /\bthis month\b/.test(normalized);
  const useLastMonth = /\blast month\b/.test(normalized);
  const useThisWeek = /\bthis week\b/.test(normalized);
  const useLastWeek = /\blast week\b/.test(normalized);

  if (monthReferences.length >= 2 && /\b(compare|vs|versus)\b/.test(normalized)) {
    const [firstPeriod, secondPeriod] = monthReferences;
    const [firstTransactions, secondTransactions] = await Promise.all([
      getTransactionsForRange({ startDate: firstPeriod.startDate, endDate: firstPeriod.endDate, account }),
      getTransactionsForRange({ startDate: secondPeriod.startDate, endDate: secondPeriod.endDate, account }),
    ]);

    const firstSummary = summarizePeriodTransactions(firstTransactions);
    const secondSummary = summarizePeriodTransactions(secondTransactions);
    const delta = secondSummary.totalExpense - firstSummary.totalExpense;
    const percent = firstSummary.totalExpense > 0 ? Math.round((Math.abs(delta) / firstSummary.totalExpense) * 100) : null;
    const direction = delta >= 0 ? 'more' : 'less';

    return {
      ok: true,
      command: 'query',
      question: originalQuestion,
      answer: `${formatMonthKey(firstPeriod.monthKey)}: ${formatMoney(firstSummary.totalExpense)} spent. ${formatMonthKey(secondPeriod.monthKey)}: ${formatMoney(secondSummary.totalExpense)} spent. ${percent !== null ? `That is ${Math.abs(percent)}% ${direction}.` : 'Comparison complete.'}`,
    };
  }

  if (/\bhighest expenses\b|\btop expenses\b/.test(normalized) && useThisWeek) {
    const range = getWeekRange();
    const transactions = await getTransactionsForRange({ startDate: range.startDate, endDate: range.endDate, account });
    const topExpenses = summarizePeriodTransactions(transactions).expenses.slice(0, 5);

    if (topExpenses.length === 0) {
      return {
        ok: true,
        command: 'query',
        question: originalQuestion,
        answer: 'I could not find any expenses for this week yet.',
      };
    }

    const lines = topExpenses.map((expense, index) => `${index + 1}. ${expense.payee} - ${formatMoney(expense.amount)} (${expense.category})`);
    return {
      ok: true,
      command: 'query',
      question: originalQuestion,
      answer: `Highest expenses this week:\n${lines.join('\n')}`,
    };
  }

  if (/\boverspend\b|\boverspent\b|\boverdid\b|\bover spent\b/.test(normalized) || /\bdid i overspend\b/.test(normalized)) {
    const targetCategory = categoryKey || 'shopping';
    const currentRange = useThisWeek
      ? getWeekRange()
      : useLastWeek
        ? getPreviousWeekRange()
        : useLastMonth
          ? getMonthRangeFromKey(shiftMonth(currentMonthKey, -1))
          : getMonthRangeFromKey(currentMonthKey);
    const previousRange = useThisWeek
      ? getPreviousWeekRange()
      : useLastWeek
        ? getPreviousWeekRange(shiftDateRangeByDays(getWeekRange().startDate, -7))
        : getMonthRangeFromKey(shiftMonth(currentRange.startDate.slice(0, 7), -1));

    const [currentTransactions, previousTransactions] = await Promise.all([
      getTransactionsForRange({ startDate: currentRange.startDate, endDate: currentRange.endDate, account }),
      getTransactionsForRange({ startDate: previousRange.startDate, endDate: previousRange.endDate, account }),
    ]);

    const currentCategoryTransactions = currentTransactions.filter((transaction) => matchesCategory(transaction, targetCategory));
    const previousCategoryTransactions = previousTransactions.filter((transaction) => matchesCategory(transaction, targetCategory));
    const currentSummary = summarizePeriodTransactions(currentCategoryTransactions);
    const previousSummary = summarizePeriodTransactions(previousCategoryTransactions);
    const delta = currentSummary.totalExpense - previousSummary.totalExpense;
    const percent = previousSummary.totalExpense > 0 ? Math.round((delta / previousSummary.totalExpense) * 100) : null;
    const overspent = percent !== null ? percent > 10 : delta > 0;

    return {
      ok: true,
      command: 'query',
      question: originalQuestion,
      answer: overspent
        ? `Yes. ${targetCategory[0].toUpperCase() + targetCategory.slice(1)} spending is ${percent !== null ? `${Math.abs(percent)}% higher` : 'higher'} than the previous period (${formatMoney(currentSummary.totalExpense)} vs ${formatMoney(previousSummary.totalExpense)}).`
        : `No. ${targetCategory[0].toUpperCase() + targetCategory.slice(1)} spending is not higher than the previous period (${formatMoney(currentSummary.totalExpense)} vs ${formatMoney(previousSummary.totalExpense)}).`,
    };
  }

  if ((/\bhow much\b|\bwhat did i spend\b|\bshow me\b/.test(normalized) && (categoryKey || useCurrentMonth || useLastMonth || useThisWeek)) || /\bspend on\b/.test(normalized)) {
    const period = useLastMonth
      ? getMonthRangeFromKey(shiftMonth(currentMonthKey, -1))
      : useThisWeek
        ? getWeekRange()
        : useLastWeek
          ? getPreviousWeekRange()
          : getMonthRangeFromKey(currentMonthKey);
    const transactions = await getTransactionsForRange({ startDate: period.startDate, endDate: period.endDate, account });
    const filteredTransactions = categoryKey
      ? transactions.filter((transaction) => matchesCategory(transaction, categoryKey))
      : transactions;
    const summary = summarizePeriodTransactions(filteredTransactions);
    const periodLabel = period.startDate.slice(0, 7) === period.endDate.slice(0, 7)
      ? formatMonthKey(period.startDate.slice(0, 7))
      : `${period.startDate} to ${period.endDate}`;
    const categoryLabel = categoryKey ? ` on ${categoryKey}` : '';

    return {
      ok: true,
      command: 'query',
      question: originalQuestion,
      answer: `You spent ${formatMoney(summary.totalExpense)}${categoryLabel} during ${periodLabel}.`,
    };
  }

  if (/\bdid i overspend\b/.test(normalized) && categoryKey) {
    const currentRange = getMonthRangeFromKey(currentMonthKey);
    const previousRange = getMonthRangeFromKey(shiftMonth(currentMonthKey, -1));
    const [currentTransactions, previousTransactions] = await Promise.all([
      getTransactionsForRange({ startDate: currentRange.startDate, endDate: currentRange.endDate, account }),
      getTransactionsForRange({ startDate: previousRange.startDate, endDate: previousRange.endDate, account }),
    ]);
    const currentSummary = summarizePeriodTransactions(currentTransactions.filter((transaction) => matchesCategory(transaction, categoryKey)));
    const previousSummary = summarizePeriodTransactions(previousTransactions.filter((transaction) => matchesCategory(transaction, categoryKey)));
    const delta = currentSummary.totalExpense - previousSummary.totalExpense;
    const percent = previousSummary.totalExpense > 0 ? Math.round((delta / previousSummary.totalExpense) * 100) : null;

    return {
      ok: true,
      command: 'query',
      question: originalQuestion,
      answer: delta > 0
        ? `Yes. ${categoryKey[0].toUpperCase() + categoryKey.slice(1)} spending is up ${percent !== null ? `${Math.abs(percent)}%` : 'from the previous month'} (${formatMoney(currentSummary.totalExpense)} vs ${formatMoney(previousSummary.totalExpense)}).`
        : `No. ${categoryKey[0].toUpperCase() + categoryKey.slice(1)} spending is not higher than last month (${formatMoney(currentSummary.totalExpense)} vs ${formatMoney(previousSummary.totalExpense)}).`,
    };
  }

  return {
    ok: true,
    command: 'query',
    question: originalQuestion,
    answer: "I couldn't confidently answer that yet. Try asking about food, shopping, this week, last month, or compare March vs April spending.",
  };
}

function shiftDateRangeByDays(dateString, days) {
  const date = parseTransactionDate(dateString);
  date.setDate(date.getDate() + days);
  return date;
}

async function initBudget() {
  const runtimeConfig = validateRequiredConfig({ requireActual: true, requireBudgetId: true });
  const actualConfig = getActualBudgetConfig();
  if (runtimeConfig.configDebug) {
    printDebugSummary('query-budget');
  }
  const dataDir = 'C:\\tmp\\actual-data';
  const serverCandidates = buildActualServerCandidates(actualConfig.serverUrl);
  fs.mkdirSync(dataDir, { recursive: true });
  if (apiReady) {
    return;
  }

  // Implement exponential backoff: 2^failureCount seconds, max 30s
  const timeSinceLastAttempt = Date.now() - lastInitAttempt;
  const backoffMs = Math.min(Math.pow(2, initFailureCount) * 1000, 30000);
  if (timeSinceLastAttempt < backoffMs && initFailureCount > 0) {
    const waitTime = backoffMs - timeSinceLastAttempt;
    console.warn(`[query-budget] Rate-limited; waiting ${Math.round(waitTime / 1000)}s before retry...`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  if (!apiInitPromise) {
    apiInitPromise = (async () => {
      const maxRetries = Math.max(1, ACTUAL_INIT_MAX_RETRIES);

      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        let lastAttemptError;
        try {
          lastInitAttempt = Date.now();
          console.log('INITIALIZING ACTUAL BUDGET');

          for (const serverURL of serverCandidates) {
            try {
              console.log(`[query-budget] Trying Actual server: ${serverURL}`);
              await withTimeout(
                api.init({ serverURL, password: actualConfig.password, dataDir }),
                ACTUAL_INIT_TIMEOUT_MS,
                'Actual API init'
              );
              lastAttemptError = null;
              break;
            } catch (hostError) {
              lastAttemptError = hostError;
              await resetActualConnection();
              if (!isRetryableActualConnectionError(hostError)) {
                throw hostError;
              }
              console.warn(`[query-budget] Failed to connect using ${serverURL}: ${hostError.message}`);
            }
          }

          if (lastAttemptError) {
            throw lastAttemptError;
          }

          if (!resolvedBudgetCache) {
            resolvedBudgetCache = await withTimeout(
              resolveActualBudget(api, { dataDir }),
              ACTUAL_INIT_TIMEOUT_MS,
              'Actual budget resolve'
            );
          }

          await withTimeout(
            api.loadBudget(resolvedBudgetCache.localBudgetId),
            ACTUAL_INIT_TIMEOUT_MS,
            'Actual budget load'
          );

          apiReady = true;
          initFailureCount = 0;
          console.log('ACTUAL CONNECTION SUCCESS');
          console.log(`[query-budget] Budget API initialized successfully (${resolvedBudgetCache.budgetName})`);
          return;
        } catch (error) {
          apiReady = false;
          initFailureCount += 1;
          console.log('ACTUAL CONNECTION FAILED');
          console.error(`[query-budget] Init failed (attempt ${attempt}/${maxRetries}):`, error.message);

          const canRetry = attempt < maxRetries && isRetryableActualConnectionError(error);
          if (!canRetry) {
            throw error;
          }

          await resetActualConnection();
          const retryDelayMs = Math.min(1000 * attempt, 5000);
          console.warn(`[query-budget] Retrying init in ${retryDelayMs}ms...`);
          await sleep(retryDelayMs);
        }
      }
    })().finally(() => {
      apiInitPromise = null;
    });
  }

  await apiInitPromise;
}

async function getRecentTransactions({ account, limit = 10 }) {
  await initBudget();
  const accountId = account ? ACCOUNTS[account] : null;
  let transactions;

  if (accountId) {
    transactions = await api.getTransactions(accountId, undefined, undefined);
  } else {
    const allTransactions = [];
    for (const [code, id] of Object.entries(ACCOUNTS)) {
      const txs = await api.getTransactions(id, undefined, undefined);
      allTransactions.push(...txs.map(t => ({ ...t, accountCode: code })));
    }
    transactions = allTransactions;
  }

  transactions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  transactions = transactions.slice(0, limit).map(t => ({
    date: t.date,
    amount: (t.amount || 0) / 100,
    payee: t.payee_name || t.payee || '',
    notes: t.notes || '',
    account: t.accountCode || ACCOUNT_NAMES[t.account] || t.account,
    category: t.category || '',
    cleared: t.cleared,
  }));

  if (SHOULD_SHUTDOWN) {
    await api.shutdown();
  }
  return { ok: true, command: 'recent', count: transactions.length, transactions };
}

async function getBalance() {
  await initBudget();
  const balances = {};
  for (const [code, id] of Object.entries(ACCOUNTS)) {
    const txs = await api.getTransactions(id, undefined, undefined);
    balances[code] = txs.reduce((sum, t) => sum + (t.amount || 0), 0) / 100;
  }
  if (SHOULD_SHUTDOWN) {
    await api.shutdown();
  }
  return { ok: true, command: 'balance', balances };
}

async function getSummary({ month, account }) {
  await initBudget();
  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const { startDate, endDate } = getMonthRange(targetMonth);

  const allTransactions = [];
  const accountEntries = account ? [[account, ACCOUNTS[account]]] : Object.entries(ACCOUNTS);

  for (const [code, id] of accountEntries) {
    if (!id) continue;
    const txs = await api.getTransactions(id, startDate, endDate);
    allTransactions.push(...txs.map(t => ({ ...t, accountCode: code })));
  }

  const byCategory = {};
  let totalExpense = 0;
  let totalIncome = 0;

  for (const transaction of allTransactions) {
    const category = transaction.category || 'Uncategorized';
    const amount = (transaction.amount || 0) / 100;
    if (!byCategory[category]) byCategory[category] = { total: 0, count: 0 };
    byCategory[category].total += amount;
    byCategory[category].count += 1;
    if (amount < 0) totalExpense += amount;
    else totalIncome += amount;
  }

  if (SHOULD_SHUTDOWN) {
    await api.shutdown();
  }
  return {
    ok: true,
    command: 'summary',
    month: targetMonth,
    totalExpense,
    totalIncome,
    net: totalIncome + totalExpense,
    transactionCount: allTransactions.length,
    byCategory,
  };
}

async function getExpenseAnalysis({ month, account } = {}) {
  await initBudget();
  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const previousMonth = shiftMonth(targetMonth, -1);
  const currentRange = getMonthRange(targetMonth);
  const previousRange = getMonthRange(previousMonth);

  const accountEntries = account ? [[account, ACCOUNTS[account]]] : Object.entries(ACCOUNTS);
  const [currentTransactions, previousTransactions] = await Promise.all([
    Promise.all(
      accountEntries.map(async ([code, id]) => {
        if (!id) return [];
        const txs = await api.getTransactions(id, currentRange.startDate, currentRange.endDate);
        return txs.map((t) => ({ ...t, accountCode: code }));
      })
    ).then((groups) => groups.flat()),
    Promise.all(
      accountEntries.map(async ([code, id]) => {
        if (!id) return [];
        const txs = await api.getTransactions(id, previousRange.startDate, previousRange.endDate);
        return txs.map((t) => ({ ...t, accountCode: code }));
      })
    ).then((groups) => groups.flat()),
  ]);

  const analysis = buildSpendingInsights(currentTransactions, previousTransactions);

  if (SHOULD_SHUTDOWN) {
    await api.shutdown();
  }

  return {
    ok: true,
    command: 'analyze',
    month: targetMonth,
    previousMonth,
    period: currentRange,
    previousPeriod: previousRange,
    ...analysis,
  };
}

async function searchTransactions({ query, limit = 20 }) {
  await initBudget();
  const allTransactions = [];
  for (const [code, id] of Object.entries(ACCOUNTS)) {
    const txs = await api.getTransactions(id, undefined, undefined);
    allTransactions.push(...txs.map(t => ({ ...t, accountCode: code })));
  }

  const q = (query || '').toLowerCase();
  const matches = allTransactions
    .filter(t => {
      const payee = (t.payee_name || t.payee || '').toLowerCase();
      const notes = (t.notes || '').toLowerCase();
      return payee.includes(q) || notes.includes(q);
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, limit)
    .map(t => ({
      date: t.date,
      amount: (t.amount || 0) / 100,
      payee: t.payee_name || t.payee || '',
      notes: t.notes || '',
      account: t.accountCode,
    }));

  if (SHOULD_SHUTDOWN) {
    await api.shutdown();
  }
  return { ok: true, command: 'search', query, count: matches.length, transactions: matches };
}

const input = process.argv[2];
if (input) {
  const params = JSON.parse(input);
  const handlers = {
    recent: getRecentTransactions,
    balance: getBalance,
    summary: getSummary,
    analyze: getExpenseAnalysis,
    query: getNaturalLanguageQuery,
    search: searchTransactions,
  };

  const handler = handlers[params.command];
  if (!handler) {
    console.error(JSON.stringify({
      ok: false,
      error: `Unknown command: ${params.command}. Use: recent, balance, summary, analyze, query, search`,
    }));
    process.exit(1);
  }

  handler(params)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exit(1);
    });
}

module.exports = { getRecentTransactions, getBalance, getSummary, getExpenseAnalysis, getNaturalLanguageQuery, searchTransactions, buildSpendingInsights };
