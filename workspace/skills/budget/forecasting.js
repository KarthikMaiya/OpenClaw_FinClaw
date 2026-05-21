#!/usr/bin/env node
/**
 * Forecasting module
 * ------------------
 * Provides `predictFutureExpenses(transactions, budgets, options)` which
 * combines lightweight statistical forecasting with LLM reasoning to produce
 * dynamic, confidence-scored expense forecasts, category breakdowns, risk
 * estimates, and actionable recommendations.
 *
 * Design goals:
 * - No hardcoded rules. Use statistical detection + AI reasoning.
 * - Modular architecture: ForecastEngine, TrendAnalyzer, BudgetRiskAnalyzer,
 *   RecommendationGenerator.
 * - Async/await, caching, debug mode, and production-quality comments.
 */

const fs = require('fs');
const path = require('path');
const { requestJson } = require('./ai-provider');

const CACHE_FILE = path.join(__dirname, 'forecasting-cache.json');
let forecastingCache = null;

function loadForecastingCache() {
  if (forecastingCache) return forecastingCache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      forecastingCache = new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))));
    } else forecastingCache = new Map();
  } catch (e) { forecastingCache = new Map(); }
  return forecastingCache;
}

function saveForecastingCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(loadForecastingCache()), null, 2), 'utf8'); } catch (e) {}
}

// Utility: simple linear regression (least squares) for trend slope
function linearRegression(xs, ys) {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const meanX = xs.reduce((a,b)=>a+b,0)/n;
  const meanY = ys.reduce((a,b)=>a+b,0)/n;
  let num = 0, den=0;
  for (let i=0;i<n;i++){ num += (xs[i]-meanX)*(ys[i]-meanY); den += (xs[i]-meanX)*(xs[i]-meanX); }
  const slope = den === 0 ? 0 : num/den;
  const intercept = meanY - slope*meanX;
  return { slope, intercept };
}

// TrendAnalyzer: derive seasonal and trend signals from transactions
function TrendAnalyzer(transactions) {
  // transactions: array with {date:'YYYY-MM-DD', amount:number, category, payee}
  // Build monthly aggregates and hour/weekday patterns
  const monthly = {}; // YYYY-MM -> sum expenses
  const byCategory = {};
  const hourly = Array(24).fill(0);
  const weekday = {0:0,1:0,2:0,3:0,4:0,5:0,6:0};

  for (const t of transactions) {
    const d = new Date(t.date);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const amt = Math.abs(typeof t.amount === 'number' ? t.amount : (t.amount/100));
    monthly[monthKey] = (monthly[monthKey]||0) + (t.amount<0?amt:0);
    const cat = t.category || 'Other';
    byCategory[cat] = (byCategory[cat]||0) + (t.amount<0?amt:0);
    hourly[d.getHours()] += (t.amount<0?amt:0);
    weekday[d.getDay()] += (t.amount<0?amt:0);
  }

  const months = Object.keys(monthly).sort();
  const xs = months.map((m,i)=>i);
  const ys = months.map(m=>monthly[m]);
  const lr = linearRegression(xs, ys);

  return {
    monthly,
    byCategory,
    hourly,
    weekday,
    trendSlopePerMonth: lr.slope,
    months,
  };
}

// ForecastEngine: combine moving averages and trend projection
function ForecastEngine(summary, horizonMonths=1) {
  // summary.monthly is map YYYY-MM -> amount
  const months = Object.keys(summary.monthly).sort();
  const amounts = months.map(m=>summary.monthly[m]||0);
  const n = amounts.length;
  const last = amounts[n-1]||0;
  const ma3 = n>=3 ? (amounts.slice(-3).reduce((a,b)=>a+b,0)/3) : last;
  const ma6 = n>=6 ? (amounts.slice(-6).reduce((a,b)=>a+b,0)/6) : ma3;
  const slope = summary.trendSlopePerMonth || 0;

  // naive forecast: baseline = ma3, then trend adjustment
  const forecast = Math.max(0, Math.round((ma3 + slope*horizonMonths)*100)/100);

  // category forecasts proportional to recent shares
  const totalRecent = Object.values(summary.byCategory||{}).reduce((a,b)=>a+b,0) || 1;
  const categoryForecasts = {};
  for (const [cat,val] of Object.entries(summary.byCategory||{})) {
    const share = val / totalRecent;
    categoryForecasts[cat] = Math.round(forecast*share*100)/100;
  }

  return { forecast, categoryForecasts, ma3, ma6, slope };
}

// BudgetRiskAnalyzer: given budgets and forecast, compute overspending risk
function BudgetRiskAnalyzer(forecasts, budgets) {
  // budgets: { category: budgetAmount, total: amount }
  const categoryRisks = {};
  let overspendingRisk = 0;
  for (const [cat, predicted] of Object.entries(forecasts.categoryForecasts||{})) {
    const budgetEntry = (budgets && budgets[cat]) || null;
    const limit = budgetEntry && typeof budgetEntry === 'object' ? Number(budgetEntry.limit ?? budgetEntry.budgeted ?? budgetEntry.amount ?? 0) : Number(budgetEntry || 0);
    const remaining = budgetEntry && typeof budgetEntry === 'object' ? Number(budgetEntry.remaining ?? budgetEntry.balance ?? budgetEntry.leftover ?? null) : null;
    const riskBasis = limit > 0 ? limit : (remaining > 0 ? remaining : 0);
    const risk = riskBasis ? (predicted - riskBasis) / riskBasis : 0;
    categoryRisks[cat] = { predicted, budget: limit || null, remaining: Number.isFinite(remaining) ? remaining : null, risk };
    if (riskBasis && predicted > riskBasis) overspendingRisk += (predicted - riskBasis);
  }
  const totalBudgetEntry = budgets && budgets.total;
  const totalLimit = totalBudgetEntry && typeof totalBudgetEntry === 'object' ? Number(totalBudgetEntry.limit ?? totalBudgetEntry.budgeted ?? totalBudgetEntry.amount ?? 0) : Number(totalBudgetEntry || 0);
  const totalRemaining = totalBudgetEntry && typeof totalBudgetEntry === 'object' ? Number(totalBudgetEntry.remaining ?? totalBudgetEntry.balance ?? totalBudgetEntry.leftover ?? null) : null;
  const safeBasis = Number.isFinite(totalRemaining) && totalRemaining !== null ? totalRemaining : totalLimit;
  const remainingSafeBudget = safeBasis ? safeBasis - forecasts.forecast : null;
  return { categoryRisks, overspendingRisk: Math.round(overspendingRisk*100)/100, remainingSafeBudget };
}

// RecommendationGenerator: simple suggestions based on risks
function RecommendationGenerator(riskAnalysis) {
  const recs = [];
  for (const [cat, info] of Object.entries(riskAnalysis.categoryRisks || {})) {
    if (info.budget && info.predicted > info.budget) {
      recs.push(`At current pace, ${cat} may exceed its budget by ${Math.round((info.predicted - info.budget)*100)/100}. Consider reviewing recent ${cat} purchases.`);
    }
  }
  if (riskAnalysis.remainingSafeBudget !== null && riskAnalysis.remainingSafeBudget < 0) {
    recs.push(`Your total budgets may be exceeded by ${Math.abs(Math.round(riskAnalysis.remainingSafeBudget*100)/100)} based on the forecast.`);
  }
  return recs;
}

// AI explanation helper: ask LLM to produce dynamic explanations
async function aiExplainForecast(inputs, options = {}) {
  const result = await requestJson({
    purpose: 'forecasting-explanation',
    providers: options.providers,
    model: options.model,
    maxTokens: 400,
    temperature: 0,
    retries: 3,
    debug: !!options.debug,
    messages: [
      {
        role: 'system',
        content: 'You are a financial analyst. Given concise forecast inputs, produce JSON with explanation_short, explanation_detailed, confidence (0-100). Base reasoning only on the provided inputs.',
      },
      { role: 'user', content: `Inputs: ${JSON.stringify(inputs)}` },
    ],
    onFallback: {
      ok: true,
      provider: null,
      latencyMs: 0,
      tokenUsage: null,
      fallbackUsed: true,
      content: JSON.stringify({
        explanation_short: `Forecast: ${inputs?.forecast?.forecast ?? inputs?.forecast?.predictedSpend ?? 0}`,
        explanation_detailed: 'Statistical forecast produced without AI explanation.',
        confidence: 50,
      }),
      parsed: {
        explanation_short: `Forecast: ${inputs?.forecast?.forecast ?? inputs?.forecast?.predictedSpend ?? 0}`,
        explanation_detailed: 'Statistical forecast produced without AI explanation.',
        confidence: 50,
      },
    },
  });

  return result.parsed || {};
}

/**
 * predictFutureExpenses
 * - transactions: array of transaction objects ({date, amount, category, payee})
 * - budgets: optional object with category budgets and total
 * - options: { horizonDays, horizonMonths, frequency: 'daily'|'weekly'|'monthly', cacheKey }
 *
 * Returns structured JSON per spec.
 */
async function predictFutureExpenses(transactions, budgets = {}, options = {}) {
  const cacheKey = options.cacheKey || `${(options.horizonMonths||1)}:${transactions.length}:${Math.round(transactions.reduce((s,t)=>s+Math.abs(t.amount||0),0))}`;
  const cache = loadForecastingCache();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  // Prepare summary and trend
  const trend = TrendAnalyzer(transactions);
  const horizonMonths = options.horizonMonths || 1;
  const forecastEngineOut = ForecastEngine(trend, horizonMonths);
  const risk = BudgetRiskAnalyzer(forecastEngineOut, budgets);
  const recommendations = RecommendationGenerator(risk);

  // Build inputs for AI explanation
  const aiInputs = {
    forecast: forecastEngineOut,
    risk,
    recommendations,
    samples: trend.byCategory ? Object.entries(trend.byCategory).slice(0,5) : [],
    horizonMonths,
    frequency: options.frequency || 'monthly',
  };

  let aiExplanation = null;
  try {
    aiExplanation = await aiExplainForecast(aiInputs, { providers: options.providers, mockProviderResponses: options.mockProviderResponses, debug: !!options.debug });
  } catch (e) {
    aiExplanation = { explanation_short: `Forecast: ${forecastEngineOut.forecast}`, explanation_detailed: `Statistical forecast produced without AI explanation.`, confidence: 50 };
  }

  const out = {
    forecastPeriod: `${horizonMonths} month(s)`,
    predictedSpend: forecastEngineOut.forecast,
    categoryForecasts: forecastEngineOut.categoryForecasts,
    overspendingRisk: risk.overspendingRisk,
    remainingSafeBudget: risk.remainingSafeBudget,
    confidence: aiExplanation.confidence || 0,
    recommendations: recommendations.concat(aiExplanation.explanation_short ? [aiExplanation.explanation_short] : []),
    explanation_detailed: aiExplanation.explanation_detailed || '',
    inputs: { trend },
  };

  cache.set(cacheKey, out);
  saveForecastingCache();
  return out;
}

module.exports = { predictFutureExpenses, TrendAnalyzer, ForecastEngine, BudgetRiskAnalyzer, RecommendationGenerator };
