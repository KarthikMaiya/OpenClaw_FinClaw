#!/usr/bin/env node

// Polyfill for browser APIs
if (typeof navigator === 'undefined') {
  global.navigator = { platform: 'linux' };
}
if (typeof SharedArrayBuffer === 'undefined') {
  global.SharedArrayBuffer = ArrayBuffer;
}

const { addTransaction } = require('./add-transaction.js');

addTransaction({
  amount: -50,
  payee: 'Test Transaction',
  notes: 'Setup test',
  date: '2026-05-07',
  account: 'Checking'
})
  .then(result => {
    console.log('✅ Transaction added successfully!');
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
