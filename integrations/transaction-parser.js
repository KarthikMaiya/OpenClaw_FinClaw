#!/usr/bin/env node
/**
 * Transaction Parser - Natural Language Expense Input Handler
 * 
 * Flexible parser that extracts transactions from natural language input.
 * Supports multiple formats and conversational language.
 * 
 * Examples:
 *   "10 recharge"
 *   "10 cookie"
 *   "250 uber"
 *   "799 myntra shopping"
 *   "120 coffee with friends"
 *   "paid 450 for dinner"
 *   "spent 99 on cookies"
 *   "recharged 239 airtel"
 */

const DEBUG = process.env.PARSER_DEBUG === '1';

/**
 * Common merchant patterns and their inferred categories
 */
const MERCHANT_PATTERNS = {
  'Food': {
    keywords: ['pizza', 'burger', 'lunch', 'dinner', 'breakfast', 'coffee', 'snack', 'meal', 'food', 'cookie', 'cookies', 'cake', 'restaurant', 'cafe', 'grocer', 'grocery', 'drink', 'juice', 'tea', 'food delivery', 'zomato', 'swiggy'],
    confidence: 0.85,
  },
  'Transport': {
    keywords: ['uber', 'lyft', 'taxi', 'cab', 'ride', 'bus', 'train', 'flight', 'travel', 'petrol', 'fuel', 'gas', 'parking', 'toll', 'metro', 'commute'],
    confidence: 0.85,
  },
  'Shopping': {
    keywords: ['amazon', 'flipkart', 'myntra', 'shopping', 'store', 'mall', 'clothes', 'shirt', 'dress', 'shoes', 'sneaker', 'purchase', 'buy', 'bought'],
    confidence: 0.80,
  },
  'Bills': {
    keywords: ['recharge', 'airtel', 'vodafone', 'jio', 'mobile', 'phone', 'internet', 'electricity', 'water', 'gas', 'subscription', 'premium'],
    confidence: 0.80,
  },
  'Entertainment': {
    keywords: ['movie', 'cinema', 'theatre', 'concert', 'music', 'gaming', 'game', 'book', 'netflix', 'spotify', 'youtube', 'streaming'],
    confidence: 0.80,
  },
  'Healthcare': {
    keywords: ['medicine', 'doctor', 'hospital', 'pharmacy', 'medical', 'health', 'dental', 'dentist', 'clinic'],
    confidence: 0.80,
  },
  'Travel': {
    keywords: ['hotel', 'hostel', 'vacation', 'trip', 'tour', 'flight', 'airbnb'],
    confidence: 0.75,
  },
};

/**
 * Conversational amount patterns
 */
const AMOUNT_PATTERNS = [
  /^(\d+(?:\.\d{1,2})?)\s+/,                                    // "10 recharge"
  /(?:paid|spent|spent|charge[d]?|cost|price|total)\s+(\d+(?:\.\d{1,2})?)/i,  // "paid 450 for..."
  /(?:for|on)\s+(\d+(?:\.\d{1,2})?)/i,                          // "coffee for 50"
  /₹\s*(\d+(?:\.\d{1,2})?)|rs\.?\s*(\d+(?:\.\d{1,2})?)|rs\s+(\d+(?:\.\d{1,2})?)/i, // "₹100", "RS. 100"
  /\$\s*(\d+(?:\.\d{1,2})?)/,                                   // "$10"
];

/**
 * Normalize text for parsing
 */
function normalizeInput(text) {
  return (text || '')
    .trim()
    .toLowerCase()
    .replace(/[,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract amount with high confidence
 */
function extractAmount(text) {
  const normalized = normalizeInput(text);
  
  for (const pattern of AMOUNT_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      // Find the first non-null capturing group
      const amount = match[1] || match[2] || match[3];
      if (amount) {
        const value = parseFloat(amount);
        if (Number.isFinite(value) && value > 0 && value < 1000000) {
          return { amount: -value, confidence: 0.95 };
        }
      }
    }
  }

  return null;
}

/**
 * Extract payee/merchant with confidence scoring
 */
function extractPayee(text, extractedAmount) {
  const normalized = normalizeInput(text);
  
  // Remove amount from text for payee extraction
  let withoutAmount = normalized;
  if (extractedAmount && extractedAmount.amount) {
    const amountStr = Math.abs(extractedAmount.amount).toString();
    withoutAmount = normalized
      .replace(new RegExp(`^${amountStr}\\s+`), '')
      .replace(/(?:paid|spent|charge[d]?|cost|price|total)\s+\d+(?:\.\d{1,2})?/gi, '')
      .replace(/(?:for|on)\s+\d+(?:\.\d{1,2})?/gi, '')
      .replace(/₹\s*\d+(?:\.\d{1,2})?|rs\.?\s*\d+(?:\.\d{1,2})?|rs\s+\d+(?:\.\d{1,2})?/gi, '')
      .replace(/\$\s*\d+(?:\.\d{1,2})?/g, '')
      .trim();
  }

  // Remove common prepositions and filler words
  withoutAmount = withoutAmount
    .replace(/^(?:for|on|to|at|in|with|by)\s+/i, '')
    .replace(/\s+(?:for|on|to|at|in|with|by)\s+/g, ' ')
    .trim();

  if (withoutAmount.length === 0) {
    return null;
  }

  // Split into tokens and take the first meaningful token(s)
  const tokens = withoutAmount.split(/\s+/);
  const payee = tokens.slice(0, Math.min(3, tokens.length)).join(' ').trim();

  return payee.length > 0 ? payee : null;
}

/**
 * Infer category from payee and notes
 */
function inferCategory(payee, notes = '') {
  const searchText = `${payee} ${notes}`.toLowerCase();
  const matches = [];

  for (const [category, config] of Object.entries(MERCHANT_PATTERNS)) {
    for (const keyword of config.keywords) {
      if (searchText.includes(keyword)) {
        matches.push({ category, confidence: config.confidence, keyword });
      }
    }
  }

  if (matches.length === 0) {
    return { category: 'Other', confidence: 0.3 };
  }

  // Return the highest confidence match
  const best = matches.reduce((a, b) => b.confidence - a.confidence);
  return { category: best.category, confidence: best.confidence };
}

/**
 * Main parser function
 */
function parseTransactionMessage(message, options = {}) {
  const debug = options.debug || DEBUG;
  const steps = [];
  
  function log(step, data) {
    if (debug) {
      console.log(`[Parser] ${step}:`, data);
    }
    steps.push({ step, data });
  }

  if (!message || typeof message !== 'string') {
    return { ok: false, error: 'Invalid message', steps };
  }

  log('Input', message);
  const normalized = normalizeInput(message);
  log('Normalized', normalized);

  // Extract amount
  const amountResult = extractAmount(normalized);
  if (!amountResult) {
    log('Amount extraction', 'FAILED');
    return { ok: false, error: 'Could not extract amount', steps };
  }

  log('Amount extracted', amountResult);

  // Extract payee
  const payee = extractPayee(normalized, amountResult);
  if (!payee) {
    log('Payee extraction', 'FAILED');
    return { ok: false, error: 'Could not extract payee', steps };
  }

  log('Payee extracted', payee);

  // Infer category
  const categoryResult = inferCategory(payee, '');
  log('Category inferred', categoryResult);

  const result = {
    ok: true,
    amount: amountResult.amount,
    amountConfidence: amountResult.confidence,
    payee,
    notes: '',
    category: categoryResult.category,
    categoryConfidence: categoryResult.confidence,
    steps,
  };

  log('Final result', result);
  return result;
}

/**
 * Parse multiple transaction formats
 */
function parseMultipleFormats(text) {
  // Try flexible parsing
  const flexible = parseTransactionMessage(text, { debug: DEBUG });
  return flexible;
}

/**
 * Validate parsed transaction for completeness
 */
function validateParsedTransaction(parsed) {
  if (!parsed.ok) {
    return { valid: false, issues: [parsed.error] };
  }

  const issues = [];

  if (!parsed.amount || parsed.amount >= 0 || Math.abs(parsed.amount) > 1000000) {
    issues.push('Invalid amount');
  }

  if (!parsed.payee || parsed.payee.length < 2) {
    issues.push('Payee too short');
  }

  if (parsed.amountConfidence < 0.5) {
    issues.push('Low amount confidence');
  }

  return {
    valid: issues.length === 0,
    issues,
    confidence: Math.min(parsed.amountConfidence, parsed.categoryConfidence),
  };
}

/**
 * Format parsed transaction for display
 */
function formatForDisplay(parsed) {
  if (!parsed.ok) {
    return null;
  }

  const amount = Math.abs(parsed.amount).toFixed(0);
  const payee = parsed.payee.charAt(0).toUpperCase() + parsed.payee.slice(1);
  const category = parsed.category !== 'Other' ? ` (${parsed.category})` : '';
  
  return {
    display: `₹${amount} for ${payee}${category}`,
    summary: `₹${amount} ${payee}${category}`,
  };
}

// ============================================================================
// Unit Tests
// ============================================================================

function runTests() {
  const testCases = [
    { input: '10 recharge', expectedPayee: 'recharge', expectedCategory: 'Bills', desc: 'Simple recharge' },
    { input: '10 cookie', expectedPayee: 'cookie', expectedCategory: 'Food', desc: 'Simple food' },
    { input: '10 pizza', expectedPayee: 'pizza', expectedCategory: 'Food', desc: 'Pizza ordering' },
    { input: '250 uber', expectedPayee: 'uber', expectedCategory: 'Transport', desc: 'Uber ride' },
    { input: '799 myntra shopping', expectedPayee: 'myntra shopping', expectedCategory: 'Shopping', desc: 'Shopping' },
    { input: '120 coffee with friends', expectedPayee: 'coffee with friends', expectedCategory: 'Food', desc: 'Conversational' },
    { input: 'paid 450 for dinner', expectedPayee: 'dinner', expectedCategory: 'Food', desc: 'Natural language' },
    { input: 'spent 99 on cookies', expectedPayee: 'cookies', expectedCategory: 'Food', desc: 'Spent format' },
    { input: 'recharged 239 airtel', expectedPayee: 'airtel', expectedCategory: 'Bills', desc: 'Recharge variant' },
    { input: '₹50 chai', expectedPayee: 'chai', expectedCategory: 'Food', desc: 'Rupee symbol' },
    { input: 'rs 300 fuel', expectedPayee: 'fuel', expectedCategory: 'Transport', desc: 'RS format' },
  ];

  console.log('\n📋 Transaction Parser Unit Tests\n');
  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    const result = parseTransactionMessage(test.input, { debug: false });
    
    if (!result.ok) {
      console.log(`❌ ${test.desc}: PARSE FAILED`);
      console.log(`   Input: "${test.input}"`);
      console.log(`   Error: ${result.error}\n`);
      failed++;
      continue;
    }

    const payeeMatch = result.payee.includes(test.expectedPayee.split(' ')[0]) || 
                      test.expectedPayee.includes(result.payee);
    const categoryMatch = result.category === test.expectedCategory;

    if (payeeMatch && categoryMatch) {
      console.log(`✅ ${test.desc}`);
      console.log(`   Input: "${test.input}"`);
      console.log(`   Payee: ${result.payee}, Category: ${result.category}\n`);
      passed++;
    } else {
      console.log(`⚠️  ${test.desc}: PARTIAL MATCH`);
      console.log(`   Input: "${test.input}"`);
      console.log(`   Expected: payee="${test.expectedPayee}", category="${test.expectedCategory}"`);
      console.log(`   Got:      payee="${result.payee}", category="${result.category}"\n`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// Run tests if executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--test') {
    const success = runTests();
    process.exit(success ? 0 : 1);
  } else if (args[0]) {
    const message = args.join(' ');
    console.log('\n📝 Parsing:', message);
    console.log('');
    const result = parseTransactionMessage(message, { debug: true });
    const display = { ...result, steps: result.steps.length };
    console.log('\n✅ Result:', JSON.stringify(display, null, 2));
  } else {
    console.log('Usage:');
    console.log('  node transaction-parser.js --test');
    console.log('  node transaction-parser.js "10 recharge"');
  }
}

module.exports = {
  parseTransactionMessage,
  parseMultipleFormats,
  validateParsedTransaction,
  formatForDisplay,
  normalizeInput,
  extractAmount,
  extractPayee,
  inferCategory,
  MERCHANT_PATTERNS,
};
