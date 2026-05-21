#!/usr/bin/env node
/**
 * AI Finance Assistant smoke test and demo runner.
 *
 * This script validates the end-to-end budget intelligence stack without
 * modifying production data by default. It exercises the same production
 * modules with deterministic mock provider responses and a realistic sample
 * budget snapshot.
 *
 * Features validated:
 * - Provider selection and fallback behavior
 * - OpenAI/Gemini-style responses through the shared provider manager
 * - Transaction categorization cache behavior
 * - Forecasting and budget-risk analysis
 * - Natural-language query interpretation and execution
 * - Actual Budget metadata loading and cache behavior
 * - AI explanation generation, malformed response handling, and low-confidence responses
 *
 * Usage:
 *   node smoke-test.js
 *   node smoke-test.js --debug
 *   node smoke-test.js --demo
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const { requestJson } = require('./workspace/skills/budget/ai-provider');
const { fetchBudgetMonth, attachBudgetContextToQuery } = require('./workspace/skills/budget/budget-metadata');
const { predictFutureExpenses } = require('./workspace/skills/budget/forecasting');
const { inferCategoryWithAI } = require('./integrations/add-transaction');
const budgetQueries = require('./workspace/skills/budget/query-budget');

const REPORT_FILE = path.join(__dirname, 'smoke-test-report.json');
const DEBUG = process.argv.includes('--debug');
const DEMO = process.argv.includes('--demo');
const statusCounts = { pass: 0, fail: 0, warnings: 0 };

const sampleTransactions = [
  { date: '2026-04-02', amount: -180, payee: 'Swiggy', notes: 'Lunch', category: 'Food', account: 'Checking' },
  { date: '2026-04-03', amount: -950, payee: 'IRCTC', notes: 'Train ticket', category: 'Travel', account: 'Checking' },
  { date: '2026-04-04', amount: -2400, payee: 'Amazon Pay', notes: 'Office chair', category: 'Shopping', account: 'Checking' },
  { date: '2026-04-05', amount: -650, payee: 'Netflix', notes: 'Monthly subscription', category: 'Subscriptions', account: 'Checking' },
  { date: '2026-04-06', amount: -780, payee: 'Apollo Pharmacy', notes: 'Medicines', category: 'Healthcare', account: 'Checking' },
  { date: '2026-04-07', amount: -1200, payee: 'Uber', notes: 'Airport ride', category: 'Transport', account: 'Checking' },
  { date: '2026-04-01', amount: 85000, payee: 'ACME Corp', notes: 'Salary', category: 'Income', account: 'Checking' },
  { date: '2026-04-10', amount: -320, payee: 'Swiggy', notes: 'Dinner', category: 'Food', account: 'Checking' },
  { date: '2026-04-12', amount: -1450, payee: 'MakeMyTrip', notes: 'Hotel', category: 'Travel', account: 'Checking' },
  { date: '2026-04-15', amount: -2100, payee: 'Lifestyle Store', notes: 'Clothes', category: 'Shopping', account: 'Checking' },
];

const sampleBudgetMonth = {
  month: '2026-04',
  incomeAvailable: 50000,
  lastMonthOverspent: 0,
  forNextMonth: 6000,
  totalBudgeted: 42000,
  toBudget: 5400,
  fromLastMonth: 2000,
  totalIncome: 85000,
  totalSpent: 7960,
  totalBalance: 5400,
  categoryGroups: [
    {
      id: 'grp-1',
      name: 'Living',
      is_income: 0,
      categories: [
        { id: 'food', name: 'Food', budgeted: 12000, spent: 9800, balance: 2200, carryover: false, hidden: false, is_income: 0 },
        { id: 'travel', name: 'Travel', budgeted: 8000, spent: 5400, balance: 2600, carryover: false, hidden: false, is_income: 0 },
        { id: 'transport', name: 'Transport', budgeted: 5000, spent: 2800, balance: 2200, carryover: false, hidden: false, is_income: 0 },
      ],
    },
    {
      id: 'grp-2',
      name: 'Lifestyle',
      is_income: 0,
      categories: [
        { id: 'shopping', name: 'Shopping', budgeted: 10000, spent: 4600, balance: 5400, carryover: false, hidden: false, is_income: 0 },
        { id: 'subscriptions', name: 'Subscriptions', budgeted: 3000, spent: 650, balance: 2350, carryover: false, hidden: false, is_income: 0 },
        { id: 'healthcare', name: 'Healthcare', budgeted: 4000, spent: 780, balance: 3220, carryover: false, hidden: false, is_income: 0 },
      ],
    },
    {
      id: 'grp-3',
      name: 'Income',
      is_income: 1,
      categories: [
        { id: 'salary', name: 'Salary', budgeted: 85000, spent: 0, balance: 85000, carryover: false, hidden: false, is_income: 1 },
      ],
    },
  ],
};

function makeBudgetApi(snapshot) {
  let calls = 0;
  return {
    calls: () => calls,
    async getBudgetMonth(monthKey) {
      calls += 1;
      if (monthKey !== snapshot.month) {
        return { ...snapshot, month: monthKey };
      }
      return snapshot;
    },
  };
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function pass(label, details = '') {
  statusCounts.pass += 1;
  console.log(`[PASS] ${label}${details ? ` — ${details}` : ''}`);
}

function fail(label, details = '') {
  statusCounts.fail += 1;
  console.log(`[FAIL] ${label}${details ? ` — ${details}` : ''}`);
}

function warn(message) {
  statusCounts.warnings += 1;
  console.log(`[WARN] ${message}`);
}

function approxGreaterThan(valueA, valueB, epsilon = 0) {
  return Number(valueA) >= Number(valueB) - epsilon;
}

async function testProviderResponses(report, metrics) {
  printSection('Provider Validation');

  const openAIStart = performance.now();
  const openAI = await requestJson({
    providers: ['openai'],
    maxTokens: 32,
    messages: [{ role: 'user', content: 'Return JSON {"provider":"openai","ok":true}' }],
    mockProviderResponses: {
      openai: {
        content: JSON.stringify({ provider: 'openai', ok: true }),
        parsed: { provider: 'openai', ok: true },
        tokenUsage: { prompt_tokens: 12, completion_tokens: 8 },
      },
    },
    onFallback: { ok: false, provider: null, fallbackUsed: true, latencyMs: 0, parsed: {} },
  });
  const openAILatency = performance.now() - openAIStart;
  if (openAI.provider === 'openai' && openAI.parsed.ok) pass('OpenAI response path', `provider=${openAI.provider}`); else fail('OpenAI response path', JSON.stringify(openAI));

  const gemini = await requestJson({
    providers: ['gemini'],
    maxTokens: 32,
    messages: [{ role: 'user', content: 'Return JSON {"provider":"gemini","ok":true}' }],
    mockProviderResponses: {
      gemini: {
        content: JSON.stringify({ provider: 'gemini', ok: true }),
        parsed: { provider: 'gemini', ok: true },
        tokenUsage: { promptTokenCount: 11, candidatesTokenCount: 7 },
      },
    },
    onFallback: { ok: false, provider: null, fallbackUsed: true, latencyMs: 0, parsed: {} },
  });
  if (gemini.provider === 'gemini' && gemini.parsed.ok) pass('Gemini response path', `provider=${gemini.provider}`); else fail('Gemini response path', JSON.stringify(gemini));

  const fallback = await requestJson({
    providers: ['openai', 'gemini'],
    maxTokens: 32,
    messages: [{ role: 'user', content: 'Return JSON {"provider":"fallback","ok":true}' }],
    mockProviderResponses: {
      openai: () => { throw new Error('simulated provider failure'); },
      gemini: { content: JSON.stringify({ provider: 'gemini', ok: true }), parsed: { provider: 'gemini', ok: true } },
    },
    onFallback: { ok: false, provider: null, fallbackUsed: true, latencyMs: 0, parsed: {} },
  });
  if (fallback.provider === 'gemini' && fallback.fallbackUsed) pass('Provider fallback behavior', `provider=${fallback.provider}`); else fail('Provider fallback behavior', JSON.stringify(fallback));

  const malformed = await requestJson({
    providers: ['openai'],
    maxTokens: 32,
    messages: [{ role: 'user', content: 'Return malformed content' }],
    mockProviderResponses: {
      openai: { content: 'not-json at all', parsed: {} },
    },
    onFallback: { ok: false, provider: null, fallbackUsed: true, latencyMs: 0, parsed: {} },
  });
  if (malformed.provider === 'openai' && Object.keys(malformed.parsed || {}).length === 0) pass('Malformed response handling', 'graceful parse fallback');
  else fail('Malformed response handling', JSON.stringify(malformed));

  const lowConfidence = await requestJson({
    providers: ['openai'],
    maxTokens: 32,
    messages: [{ role: 'user', content: 'Return low confidence JSON' }],
    mockProviderResponses: {
      openai: { content: JSON.stringify({ ok: true, confidence: 21, note: 'uncertain' }), parsed: { ok: true, confidence: 21, note: 'uncertain' } },
    },
    onFallback: { ok: false, provider: null, fallbackUsed: true, latencyMs: 0, parsed: {} },
  });
  if (Number(lowConfidence.parsed.confidence) <= 30) pass('Low-confidence AI result', `confidence=${lowConfidence.parsed.confidence}`); else fail('Low-confidence AI result', JSON.stringify(lowConfidence));

  metrics.providerLatencyMs = Math.max(metrics.providerLatencyMs, openAI.latencyMs || 0, gemini.latencyMs || 0, fallback.latencyMs || 0, malformed.latencyMs || 0, lowConfidence.latencyMs || 0);
  metrics.fallbackCount += Number(!!fallback.fallbackUsed) + Number(!!malformed.fallbackUsed);

  report.sections.push({
    name: 'provider-validation',
    results: { openAI, gemini, fallback, malformed, lowConfidence },
  });
  report.performance.providerLatencyMs = metrics.providerLatencyMs;
  report.performance.fallbackCount = metrics.fallbackCount;
  report.performance.openAIDurationMs = openAILatency;
}

async function testMetadataCache(report, metrics) {
  printSection('Budget Metadata Loading');
  const mockApi = makeBudgetApi(sampleBudgetMonth);

  const firstStart = performance.now();
  const first = await fetchBudgetMonth(mockApi, '2026-04', { force: false });
  const firstDuration = performance.now() - firstStart;
  const secondStart = performance.now();
  const second = await fetchBudgetMonth(mockApi, '2026-04', { force: false });
  const secondDuration = performance.now() - secondStart;

  if (first.month === '2026-04' && first.categories.length >= 6) pass('Actual Budget metadata loading', `categories=${first.categories.length}`); else fail('Actual Budget metadata loading', JSON.stringify(first));
  if (secondDuration <= firstDuration || mockApi.calls() === 1) pass('Budget metadata cache behavior', `apiCalls=${mockApi.calls()}`); else warn(`Budget metadata cache was not obviously faster (${firstDuration.toFixed(1)}ms vs ${secondDuration.toFixed(1)}ms)`);

  metrics.cacheHits += mockApi.calls() === 1 ? 1 : 0;
  report.sections.push({
    name: 'metadata-cache',
    results: { first, second, apiCalls: mockApi.calls(), firstDuration, secondDuration },
  });
}

async function testCategorizationAndForecastCache(report, metrics) {
  printSection('Categorization and Forecasting');

  const categoryCalls = { openai: 0 };
  const smokePayee = `Smoky Swiggy ${Date.now()}`;
  const categoryOptions = {
    providers: ['openai'],
    mockProviderResponses: {
      openai: () => {
        categoryCalls.openai += 1;
        return { content: JSON.stringify({ category: 'Food', confidence: 96 }), parsed: { category: 'Food', confidence: 96 } };
      },
    },
  };

  const firstCategory = await inferCategoryWithAI({ payee: smokePayee, notes: 'Dinner order', amount: -420 }, categoryOptions);
  const secondCategory = await inferCategoryWithAI({ payee: smokePayee, notes: 'Dinner order', amount: -420 }, categoryOptions);
  if (firstCategory.category === 'Food' && secondCategory.category === 'Food' && categoryCalls.openai === 1) pass('Transaction categorization cache', `providerCalls=${categoryCalls.openai}`); else fail('Transaction categorization cache', JSON.stringify({ firstCategory, secondCategory, categoryCalls }));

  const forecastCalls = { openai: 0 };
  const forecastOptions = {
    horizonMonths: 1,
    cacheKey: `smoke-forecast-${Date.now()}`,
    providers: ['openai'],
    mockProviderResponses: {
      openai: () => {
        forecastCalls.openai += 1;
        return {
          content: JSON.stringify({ explanation_short: 'Spend is increasing modestly.', explanation_detailed: 'Forecast is driven by food and shopping growth.', confidence: 84 }),
          parsed: { explanation_short: 'Spend is increasing modestly.', explanation_detailed: 'Forecast is driven by food and shopping growth.', confidence: 84 },
        };
      },
    },
  };

  const budgetMap = {
    Food: { limit: 12000, remaining: 2200 },
    Travel: { limit: 8000, remaining: 2600 },
    Shopping: { limit: 10000, remaining: 5400 },
    Transport: { limit: 5000, remaining: 2200 },
    Subscriptions: { limit: 3000, remaining: 2350 },
    Healthcare: { limit: 4000, remaining: 3220 },
    total: { limit: 42000, remaining: 5400 },
  };

  const firstForecastStart = performance.now();
  const firstForecast = await predictFutureExpenses(sampleTransactions, budgetMap, forecastOptions);
  const firstForecastDuration = performance.now() - firstForecastStart;
  const secondForecastStart = performance.now();
  const secondForecast = await predictFutureExpenses(sampleTransactions, budgetMap, forecastOptions);
  const secondForecastDuration = performance.now() - secondForecastStart;

  if (firstForecast.predictedSpend >= 0 && firstForecast.categoryForecasts.Food !== undefined) pass('Forecasting with budget risk analysis', `predicted=${firstForecast.predictedSpend}`); else fail('Forecasting with budget risk analysis', JSON.stringify(firstForecast));
  if (forecastCalls.openai <= 1) pass('Forecast cache behavior', `providerCalls=${forecastCalls.openai}`); else fail('Forecast cache behavior', `providerCalls=${forecastCalls.openai}`);
  if (secondForecastDuration <= firstForecastDuration) pass('Forecast cache speed-up', `${firstForecastDuration.toFixed(1)}ms -> ${secondForecastDuration.toFixed(1)}ms`); else warn(`Forecast cache did not speed up clearly (${firstForecastDuration.toFixed(1)}ms vs ${secondForecastDuration.toFixed(1)}ms)`);

  metrics.cacheHits += forecastCalls.openai === 1 ? 1 : 0;
  report.sections.push({
    name: 'forecast-cache',
    results: { firstForecast, secondForecast, forecastCalls: forecastCalls.openai, firstForecastDuration, secondForecastDuration },
  });
}

async function testNaturalLanguageQueries(report, metrics) {
  printSection('Natural Language Queries');

  const queryCalls = { openai: 0 };
  const mockProviderResponses = {
    openai: (provider, payload) => {
      queryCalls.openai += 1;
      if (payload.purpose === 'query-interpretation') {
        return {
          content: JSON.stringify({
            queryObject: {
              intent: 'forecast',
              filters: { category: 'Food' },
              horizonMonths: 1,
              outputFormat: 'detailed',
              categories: ['Food'],
            },
            confidence: 91,
          }),
          parsed: {
            queryObject: {
              intent: 'forecast',
              filters: { category: 'Food' },
              horizonMonths: 1,
              outputFormat: 'detailed',
              categories: ['Food'],
            },
            confidence: 91,
          },
        };
      }
      if (payload.purpose === 'forecasting-explanation') {
        return {
          content: JSON.stringify({ explanation_short: 'Food spend may exceed budget if current pace continues.', explanation_detailed: 'Food spend is driven by recurring food deliveries.', confidence: 87 }),
          parsed: { explanation_short: 'Food spend may exceed budget if current pace continues.', explanation_detailed: 'Food spend is driven by recurring food deliveries.', confidence: 87 },
        };
      }
      if (payload.purpose === 'query-answer') {
        return {
          content: JSON.stringify({ answer_short: 'Food spending looks likely to overshoot this month.', answer_detailed: 'The model sees elevated food spend.', confidence: 86 }),
          parsed: { answer_short: 'Food spending looks likely to overshoot this month.', answer_detailed: 'The model sees elevated food spend.', confidence: 86 },
        };
      }
      return { content: JSON.stringify({ ok: true }), parsed: { ok: true } };
    },
  };

  const sampleBudgetContext = attachBudgetContextToQuery({
    intent: 'forecast',
    filters: { category: 'Food' },
    horizonMonths: 1,
    followUp: false,
  }, {
    ...sampleBudgetMonth,
    categories: sampleBudgetMonth.categoryGroups.flatMap((group) => group.categories),
    categoryMap: Object.fromEntries(sampleBudgetMonth.categoryGroups.flatMap((group) => group.categories).map((category) => [category.name.toLowerCase(), category])),
  });

  const result = await budgetQueries.processFinancialQueryCore(
    'Will I exceed my food budget?',
    sampleTransactions,
    {
      ...sampleBudgetContext.budgetContext,
      ...sampleBudgetMonth,
      categories: sampleBudgetMonth.categoryGroups.flatMap((group) => group.categories),
      categoryMap: Object.fromEntries(sampleBudgetMonth.categoryGroups.flatMap((group) => group.categories).map((category) => [category.name.toLowerCase(), category])),
    },
    {
      providers: ['openai'],
      mockProviderResponses,
      debug: DEBUG,
    },
  );

  if (result.ok && result.structured && result.structured.intent === 'forecast' && result.exec && result.exec.type === 'forecast') {
    pass('Natural language query pipeline', `intent=${result.structured.intent}`);
  } else {
    fail('Natural language query pipeline', JSON.stringify(result));
  }
  if (result.answer && result.answer.answer_short) pass('AI explanation generation', result.answer.answer_short); else fail('AI explanation generation', JSON.stringify(result.answer || {}));

  metrics.providerLatencyMs = Math.max(metrics.providerLatencyMs, result.exec?.forecast?.latencyMs || 0);
  metrics.fallbackCount += Number(!!result.exec?.forecast?.fallbackUsed);
  report.sections.push({
    name: 'nlq',
    results: { result, queryCalls: queryCalls.openai },
  });
}

async function testEdgeCases(report) {
  printSection('Edge Cases');

  const noTransactions = await predictFutureExpenses([], {}, {
    horizonMonths: 1,
    providers: ['openai'],
    mockProviderResponses: {
      openai: { content: JSON.stringify({ explanation_short: 'No history available.', explanation_detailed: 'Unable to learn a trend from zero transactions.', confidence: 42 }), parsed: { explanation_short: 'No history available.', explanation_detailed: 'Unable to learn a trend from zero transactions.', confidence: 42 } },
    },
  });
  if (noTransactions.predictedSpend === 0) pass('No transactions scenario', 'predicted spend is zero'); else fail('No transactions scenario', JSON.stringify(noTransactions));

  const missingBudgets = await predictFutureExpenses(sampleTransactions, {}, {
    horizonMonths: 1,
    providers: ['openai'],
    mockProviderResponses: {
      openai: { content: JSON.stringify({ explanation_short: 'Budget missing, using statistical estimate.', explanation_detailed: 'No budget limits were available.', confidence: 55 }), parsed: { explanation_short: 'Budget missing, using statistical estimate.', explanation_detailed: 'No budget limits were available.', confidence: 55 } },
    },
  });
  if (missingBudgets && missingBudgets.predictedSpend >= 0) pass('Missing budgets scenario', 'graceful fallback'); else fail('Missing budgets scenario', JSON.stringify(missingBudgets));

  const emptyCategoryData = await budgetQueries.processFinancialQueryCore(
    'How much did I spend on an unknown category?',
    sampleTransactions,
    {
      ...sampleBudgetMonth,
      categoryGroups: [],
      categories: [],
      categoryMap: {},
    },
    {
      providers: ['openai'],
      mockProviderResponses: {
        openai: (provider, payload) => {
          if (payload.purpose === 'query-interpretation') {
            return { content: JSON.stringify({ queryObject: { intent: 'forecast', filters: { category: 'Unknown' }, horizonMonths: 1 }, confidence: 76 }), parsed: { queryObject: { intent: 'forecast', filters: { category: 'Unknown' }, horizonMonths: 1 }, confidence: 76 } };
          }
          return { content: JSON.stringify({ answer_short: 'No category budget found.', answer_detailed: 'The category data set was empty.', confidence: 48 }), parsed: { answer_short: 'No category budget found.', answer_detailed: 'The category data set was empty.', confidence: 48 } };
        },
      },
    },
  );
  if (emptyCategoryData.ok) pass('Empty category data scenario', 'handled without crash'); else fail('Empty category data scenario', JSON.stringify(emptyCategoryData));

  const malformed = await requestJson({
    providers: ['openai'],
    messages: [{ role: 'user', content: 'malformed' }],
    mockProviderResponses: { openai: 'this is not json' },
    onFallback: { ok: true, provider: null, fallbackUsed: true, latencyMs: 0, parsed: { recovered: true } },
  });
  if (malformed.parsed.recovered || Object.keys(malformed.parsed || {}).length === 0) pass('Malformed response scenario', 'handled gracefully'); else fail('Malformed response scenario', JSON.stringify(malformed));

  report.sections.push({
    name: 'edge-cases',
    results: { noTransactions, missingBudgets, emptyCategoryData, malformed },
  });
}

async function runDemo() {
  printSection('Demo Mode');
  const demoQueries = [
    'Will I exceed my food budget?',
    'How much did I spend on Swiggy last month?',
    'Predict my monthly expenses.',
    'Am I overspending this week?',
  ];

  const providerMocks = {
    openai: (provider, payload) => {
      if (payload.purpose === 'query-interpretation') {
        const queryText = String(payload.messages?.[1]?.content || '').toLowerCase();
        if (queryText.includes('swiggy')) {
          return { content: JSON.stringify({ queryObject: { intent: 'total', filters: { payee: 'Swiggy' }, dateRange: 'previous_month', aggregation: 'sum', outputFormat: 'detailed' }, confidence: 94 }), parsed: { queryObject: { intent: 'total', filters: { payee: 'Swiggy' }, dateRange: 'previous_month', aggregation: 'sum', outputFormat: 'detailed' }, confidence: 94 } };
        }
        if (queryText.includes('overspending')) {
          return { content: JSON.stringify({ queryObject: { intent: 'overspending_risk', horizonMonths: 1, filters: { category: 'Food' } }, confidence: 93 }), parsed: { queryObject: { intent: 'overspending_risk', horizonMonths: 1, filters: { category: 'Food' } }, confidence: 93 } };
        }
        if (queryText.includes('safe')) {
          return { content: JSON.stringify({ queryObject: { intent: 'budget_health', horizonMonths: 1 }, confidence: 92 }), parsed: { queryObject: { intent: 'budget_health', horizonMonths: 1 }, confidence: 92 } };
        }
        return { content: JSON.stringify({ queryObject: { intent: 'forecast', horizonMonths: 1 }, confidence: 90 }), parsed: { queryObject: { intent: 'forecast', horizonMonths: 1 }, confidence: 90 } };
      }
      if (payload.purpose === 'forecasting-explanation') {
        return { content: JSON.stringify({ explanation_short: 'Your pace suggests a mild overspend risk.', explanation_detailed: 'Food and shopping are the main drivers.', confidence: 84 }), parsed: { explanation_short: 'Your pace suggests a mild overspend risk.', explanation_detailed: 'Food and shopping are the main drivers.', confidence: 84 } };
      }
      if (payload.purpose === 'query-answer') {
        return { content: JSON.stringify({ answer_short: 'Your spending looks manageable, but food is trending up.', answer_detailed: 'The forecast sees food as the primary driver.', confidence: 83 }), parsed: { answer_short: 'Your spending looks manageable, but food is trending up.', answer_detailed: 'The forecast sees food as the primary driver.', confidence: 83 } };
      }
      return { content: JSON.stringify({ ok: true }), parsed: { ok: true } };
    },
  };

  for (const query of demoQueries) {
    const result = await budgetQueries.processFinancialQueryCore(query, sampleTransactions, {
      ...sampleBudgetMonth,
      categories: sampleBudgetMonth.categoryGroups.flatMap((group) => group.categories),
      categoryMap: Object.fromEntries(sampleBudgetMonth.categoryGroups.flatMap((group) => group.categories).map((category) => [category.name.toLowerCase(), category])),
    }, {
      providers: ['openai'],
      mockProviderResponses: providerMocks,
      debug: DEBUG,
    });

    console.log(`\n> ${query}`);
    console.log(`Intent: ${result.structured?.intent || 'unknown'} | Confidence: ${result.confidence || 0}`);
    if (result.exec?.type === 'forecast' && result.exec.forecast) {
      console.log(`Forecast: ${result.exec.forecast.predictedSpend} over ${result.exec.forecast.forecastPeriod}`);
      console.log(`Safe budget remaining: ${result.exec.forecast.remainingSafeBudget}`);
    }
    if (result.answer?.answer_short) {
      console.log(`Answer: ${result.answer.answer_short}`);
    }
  }
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    mode: DEMO ? 'demo' : 'smoke-test',
    summary: { pass: 0, fail: 0, warnings: 0 },
    performance: { totalMs: 0, providerLatencyMs: 0, fallbackCount: 0, cacheHits: 0 },
    sections: [],
    warnings: [],
  };

  const started = performance.now();
  const metrics = { providerLatencyMs: 0, fallbackCount: 0, cacheHits: 0 };

  if (DEMO) {
    await runDemo();
    report.performance.totalMs = Math.round(performance.now() - started);
    report.summary = { ...statusCounts };
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nDemo complete. Report written to ${REPORT_FILE}`);
    return;
  }

  try {
    await testProviderResponses(report, metrics);
    await testMetadataCache(report, metrics);
    await testCategorizationAndForecastCache(report, metrics);
    await testNaturalLanguageQueries(report, metrics);
    await testEdgeCases(report);
  } catch (error) {
    fail('Smoke test runner', error.message);
    report.warnings.push(error.message);
  }

  report.performance.totalMs = Math.round(performance.now() - started);
  report.performance.providerLatencyMs = metrics.providerLatencyMs;
  report.performance.fallbackCount = metrics.fallbackCount;
  report.performance.cacheHits = metrics.cacheHits;
  report.summary = { ...statusCounts };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nSmoke test complete. Report written to ${REPORT_FILE}`);
  console.log(`Timing: ${report.performance.totalMs}ms | Provider latency: ${report.performance.providerLatencyMs}ms | Cache hits: ${report.performance.cacheHits} | Fallbacks: ${report.performance.fallbackCount}`);
}

main().catch((error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exit(1);
});
