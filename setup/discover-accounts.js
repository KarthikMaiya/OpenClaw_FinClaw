#!/usr/bin/env node
/**
 * Actual Budget - Discover Budgets & Account IDs
 *
 * This helper script connects to your Actual Budget server and prints
 * all available budgets and their account UUIDs. Use these values to
 * configure your integration scripts.
 *
 * Usage: node discover-accounts.js
 *
 * Before running, set these environment variables:
 *   ACTUAL_SERVER_URL  - Your Actual Budget server URL (default: http://localhost:5006)
 *   ACTUAL_PASSWORD    - Your Actual Budget password
 *
 * Or edit the values below directly.
 */

// Polyfill for browser APIs
if (typeof navigator === 'undefined') {
  global.navigator = { platform: 'linux' };
}
if (typeof SharedArrayBuffer === 'undefined') {
  global.SharedArrayBuffer = ArrayBuffer;
}

const path = require('path');
const fs = require('fs');
const { validateRequiredConfig, printDebugSummary } = require('../config-manager');

const runtimeConfig = validateRequiredConfig({ requireActual: true, requireBudgetId: true });
if (runtimeConfig.configDebug) {
  printDebugSummary('discover-accounts');
}

const api = require(path.join(path.resolve(runtimeConfig.actualModuleDir), '@actual-app/api'));

const SERVER_URL = runtimeConfig.actualServerUrl;
const PASSWORD = runtimeConfig.actualPassword;

async function discover() {
  if (!PASSWORD) {
    console.error('Error: Set ACTUAL_PASSWORD in .env before running this script.');
    process.exit(1);
  }

  const dataDir = '/tmp/actual-discover';
  fs.mkdirSync(dataDir, { recursive: true });

  console.log(`Connecting to ${SERVER_URL}...`);
  await api.init({ serverURL: SERVER_URL, password: PASSWORD, dataDir });

  // List all budgets
  const budgets = await api.getBudgets();
  console.log('\n=== Available Budgets ===\n');
  for (const b of budgets) {
    console.log(`  Name:     ${b.name}`);
    console.log(`  Group ID: ${b.groupId}  <-- use this as "budgetId" in config.json`);
    console.log(`  Cloud ID: ${b.cloudFileId}`);
    console.log('');
  }

  if (budgets.length === 0) {
    console.log('  No budgets found. Create one in the Actual Budget UI first.');
    await api.shutdown();
    return;
  }

  // Ask which budget to inspect
  const budgetId = process.argv[2] || budgets[0].groupId;
  const budget = budgets.find(b => b.groupId === budgetId) || budgets[0];
  console.log(`Downloading budget "${budget.name}" (${budget.groupId})...`);

  await api.downloadBudget(budget.groupId);

  // List local folder
  const dirs = fs.readdirSync(dataDir).filter(f => fs.statSync(`${dataDir}/${f}`).isDirectory());
  if (dirs.length > 0) {
    console.log(`\n  Local folder: ${dirs[dirs.length - 1]}  <-- use this as BUDGET_LOCAL_ID\n`);
  }

  // List accounts
  const accounts = await api.getAccounts();
  console.log('=== Accounts ===\n');
  if (accounts.length === 0) {
    console.log('  No accounts found. Create accounts in the Actual Budget UI first.');
  } else {
    console.log('  Copy these into your ACCOUNTS object in add-transaction.js and query-budget.js:\n');
    console.log('  const ACCOUNTS = {');
    for (const a of accounts) {
      console.log(`    '${a.name.replace(/'/g, "\\'")}': '${a.id}',${a.offbudget ? '  // off-budget' : ''}`);
    }
    console.log('  };\n');
  }

  await api.shutdown();
  console.log('Done! Update your config files with the values above.');
}

discover().catch(e => {
  const message = String(e?.message || e || 'Unknown error');
  console.error('Error:', message);

  if (message.includes('invalid-password')) {
    console.error('Hint: ACTUAL_PASSWORD in .env does not match your Actual server password.');
    console.error('      Sign in at http://localhost:5006, confirm your password, update .env, then run this again.');
  } else if (message.includes('too-many-requests')) {
    console.error('Hint: Actual server is temporarily rate-limiting auth attempts. Wait 10-30 seconds and retry.');
  } else if (message.includes('network-failure')) {
    console.error('Hint: Server may still be starting. Verify Docker container status and retry in a few seconds.');
  }

  process.exit(1);
});
