#!/usr/bin/env node
/**
 * Budget metadata helper.
 *
 * Fetches Actual Budget month/category metadata and caches it locally for
 * forecasting and budget-health analysis.
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'budget-metadata-cache.json');
let metadataCache = null;

function loadCache() {
  if (metadataCache) return metadataCache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      metadataCache = new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))));
    } else {
      metadataCache = new Map();
    }
  } catch (error) {
    metadataCache = new Map();
  }
  return metadataCache;
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(loadCache()), null, 2), 'utf8');
  } catch (error) {
    // cache writes are best-effort only
  }
}

function getMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function flattenCategoryGroups(categoryGroups = []) {
  const categories = [];
  for (const group of categoryGroups) {
    const groupName = group.name || group.groupName || group.title || '';
    for (const category of group.categories || []) {
      categories.push({
        id: category.id,
        name: category.name,
        groupId: group.id,
        groupName,
        budgeted: Number(category.budgeted || 0),
        spent: Number(category.spent || 0),
        balance: Number(category.balance || 0),
        carryover: !!category.carryover,
        hidden: !!category.hidden,
        isIncome: !!category.is_income,
      });
    }
  }
  return categories;
}

async function fetchBudgetMonth(api, monthKey = getMonthKey(), options = {}) {
  const cache = loadCache();
  const cacheKey = `${monthKey}:${options.force ? 'force' : 'cached'}`;
  if (!options.force && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const monthData = await api.getBudgetMonth(monthKey);
  const categoryGroups = Array.isArray(monthData.categoryGroups) ? monthData.categoryGroups : [];
  const categories = flattenCategoryGroups(categoryGroups);
  const totals = categories.reduce((acc, category) => {
    if (!category.hidden) {
      acc.budgeted += Number(category.budgeted || 0);
      acc.spent += Number(category.spent || 0);
      acc.balance += Number(category.balance || 0);
    }
    return acc;
  }, { budgeted: 0, spent: 0, balance: 0 });

  const snapshot = {
    month: monthData.month || monthKey,
    incomeAvailable: Number(monthData.incomeAvailable || 0),
    lastMonthOverspent: Number(monthData.lastMonthOverspent || 0),
    forNextMonth: Number(monthData.forNextMonth || 0),
    totalBudgeted: Number(monthData.totalBudgeted || 0),
    toBudget: Number(monthData.toBudget || 0),
    fromLastMonth: Number(monthData.fromLastMonth || 0),
    totalIncome: Number(monthData.totalIncome || 0),
    totalSpent: Number(monthData.totalSpent || 0),
    totalBalance: Number(monthData.totalBalance || 0),
    categoryGroups,
    categories,
    categoryMap: Object.fromEntries(categories.map((category) => [category.name.toLowerCase(), category])),
    totals,
  };

  cache.set(cacheKey, snapshot);
  saveCache();
  return snapshot;
}

function attachBudgetContextToQuery(structuredQuery, budgetSnapshot) {
  if (!structuredQuery || !budgetSnapshot) return structuredQuery;
  const categories = budgetSnapshot.categories || [];
  const categoryByName = budgetSnapshot.categoryMap || {};

  const merged = { ...structuredQuery };
  const mention = Array.isArray(merged.categories) ? merged.categories : [];
  const inferredCategories = mention.length > 0 ? mention : categories.slice(0, 3).map((category) => category.name);
  merged.categories = inferredCategories;
  merged.budgetContext = {
    month: budgetSnapshot.month,
    totalBudgeted: budgetSnapshot.totalBudgeted,
    totalSpent: budgetSnapshot.totalSpent,
    totalBalance: budgetSnapshot.totalBalance,
    toBudget: budgetSnapshot.toBudget,
    categories: inferredCategories.map((name) => categoryByName[String(name).toLowerCase()] || { name, budgeted: null, spent: null, balance: null }),
  };
  return merged;
}

module.exports = {
  fetchBudgetMonth,
  attachBudgetContextToQuery,
  getMonthKey,
  flattenCategoryGroups,
};
