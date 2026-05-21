#!/usr/bin/env node

// Polyfill for browser APIs
if (typeof navigator === 'undefined') {
  global.navigator = { platform: 'linux' };
}
if (typeof SharedArrayBuffer === 'undefined') {
  global.SharedArrayBuffer = ArrayBuffer;
}

const queryBudget = require('./query-budget.js');

(async () => {
  try {
    console.log('📊 Fetching recent transactions...\n');
    const recent = await queryBudget.getRecentTransactions({ limit: 5 });
    console.log('Recent transactions:');
    console.log(JSON.stringify(recent, null, 2));

    console.log('\n💰 Fetching account balances...\n');
    const balances = await queryBudget.getBalance();
    console.log('Account balances:');
    console.log(JSON.stringify(balances, null, 2));

    console.log('\n📈 Fetching spending insights...\n');
    const insights = await queryBudget.getExpenseAnalysis();
    console.log('Spending insights:');
    console.log(JSON.stringify(insights, null, 2));
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
})();
