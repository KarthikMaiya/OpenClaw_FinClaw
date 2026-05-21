#!/usr/bin/env node

// Polyfill for browser APIs
if (typeof navigator === 'undefined') {
  global.navigator = { platform: 'linux' };
}
if (typeof SharedArrayBuffer === 'undefined') {
  global.SharedArrayBuffer = ArrayBuffer;
}

const path = require('path');
const fs = require('fs');
const { validateRequiredConfig } = require('../config-manager');

const runtimeConfig = validateRequiredConfig({ requireActual: true });
const api = require(path.join(path.resolve(runtimeConfig.actualModuleDir), '@actual-app/api'));
const SERVER_URL = runtimeConfig.actualServerUrl;
const PASSWORD = runtimeConfig.actualPassword;

async function test() {
  const dataDir = '/tmp/actual-test';
  fs.mkdirSync(dataDir, { recursive: true });

  console.log('Connecting...');
  await api.init({ serverURL: SERVER_URL, password: PASSWORD, dataDir });

  const budgets = await api.getBudgets();
  console.log('\n=== Budgets ===');
  budgets.forEach((b, i) => {
    console.log(`${i}: ${b.name} (${b.groupId})`);
  });

  // Try the second budget (might have the Checking account)
  const budget = budgets[budgets.length - 1];
  console.log(`\nDownloading budget: ${budget.name} (${budget.groupId})...`);
  await api.downloadBudget(budget.groupId);

  const dirs = fs.readdirSync(dataDir).filter(f => fs.statSync(`${dataDir}/${f}`).isDirectory());
  console.log(`Local folders: ${dirs.join(', ')}`);

  if (dirs.length > 0) {
    const localId = dirs[0];
    console.log(`\nLoading budget: ${localId}...`);
    await api.loadBudget(localId);

    const accounts = await api.getAccounts();
    console.log(`\n=== Accounts ===`);
    if (accounts.length === 0) {
      console.log('No accounts found');
    } else {
      accounts.forEach(a => {
        console.log(`${a.name}: ${a.id}`);
      });
    }
  }

  await api.shutdown();
}

test().catch(e => {
  console.error('Error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
