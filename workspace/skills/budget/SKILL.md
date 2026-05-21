# Skill: Budget Management

Query and add transactions to Actual Budget.

## Tools

### Add Transaction

Adds a single transaction to Actual Budget.

```bash
# Local Windows path for this workspace
node c:/Users/Karthik Maiya/Desktop/telegram-bott/integrations/add-transaction.js '<JSON>'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `amount` | number | Yes | Transaction amount (negative = expense, positive = income) |
| `payee` | string | Yes | Merchant or payee name |
| `notes` | string | No | Description, reference number, or context |
| `date` | string | No | YYYY-MM-DD format (defaults to today) |
| `account` | string | No | Account nickname from ACCOUNTS map (defaults to user's default) |

**Example:**
```bash
node c:/Users/Karthik Maiya/Desktop/telegram-bott/integrations/add-transaction.js \
  '{"amount":-45,"payee":"Grocery Store","notes":"Weekly groceries","date":"2026-03-01","account":"Checking"}'
```

Smart categorization is built into the transaction adder. If you omit `category`, the script infers one from the merchant description.

Examples:

- `AMAZON PAY` → Shopping
- `IRCTC` → Travel
- `DOMINOS` → Food
- `UBER` → Transport

### Query Transactions

Query your budget data from Actual Budget.

```bash
# Local Windows path for this workspace
node c:/Users/Karthik Maiya/Desktop/telegram-bott/workspace/skills/budget/query-budget.js '<JSON>'
```

#### Commands

| Command | Parameters | Description |
|---------|-----------|-------------|
| `recent` | `limit` (default: 10) | Get the most recent N transactions |
| `category` | `startDate`, `endDate` | Spending breakdown by category for a date range |
| `total` | `startDate`, `endDate` | Total spending (sum) for a date range |
| `analyze` | `month` (YYYY-MM, optional), `account` (optional) | AI expense analyst with behavior insights |
| `query` | `question` | Natural-language query answering |
| `search` | `payee`, `limit` (default: 20) | Search transactions by payee name |
| `forecast` | `horizonMonths`, `frequency` | Predict future expenses and risks |

### Architecture

- Query interpretation, financial insights, forecasting explanations, and merchant categorization all use the shared provider manager in `workspace/skills/budget/ai-provider.js`.
- The provider manager supports `openai` and `gemini` today and is designed for future providers with automatic fallback, retry/backoff, and debug logging.
- Forecasts pull real Actual Budget month data via `workspace/skills/budget/budget-metadata.js`, which caches month snapshots locally.
- Categories without budgets are handled gracefully: the forecast engine falls back to statistical estimates and reports missing budget data instead of failing.

**Examples:**
```bash
# Last 5 transactions
node c:/Users/Karthik Maiya/Desktop/telegram-bott/workspace/skills/budget/query-budget.js '{"command":"recent","limit":5}'

# Spending by category this month
node c:/Users/Karthik Maiya/Desktop/telegram-bott/workspace/skills/budget/query-budget.js \
  '{"command":"category","startDate":"2026-03-01","endDate":"2026-03-31"}'

# Total spending this month
node c:/Users/Karthik Maiya/Desktop/telegram-bott/workspace/skills/budget/query-budget.js \
  '{"command":"total","startDate":"2026-03-01","endDate":"2026-03-31"}'

# AI expense analyst for the current month
node c:/Users/Karthik Maiya/Desktop/telegram-bott/workspace/skills/budget/query-budget.js \
  '{"command":"analyze","month":"2026-03"}'

# Natural language query
node c:/Users/Karthik Maiya/Desktop/telegram-bott/workspace/skills/budget/query-budget.js \
  '{"command":"query","question":"How much did I spend on food last month?"}'

# Search for a payee
node c:/Users/Karthik Maiya/Desktop/telegram-bott/workspace/skills/budget/query-budget.js '{"command":"search","payee":"Coffee"}'
```

## Account Codes

Update this table with your Actual Budget account names and UUIDs. Run `node setup/discover-accounts.js` to find your values.

| Code | Account Name | Default For |
|------|-------------|-------------|
| Checking | Checking | Daily expenses (DEFAULT) |
| YOUR_ACCOUNT_2 | Savings | Savings & emergency fund |
| YOUR_ACCOUNT_3 | Credit Card | Credit card purchases |
| YOUR_ACCOUNT_4 | Investment | Investment account (off-budget) |

## Actual Budget Connection

| Setting | Value |
|---------|-------|
| Server URL | `http://localhost:5006` (update in `config.json`) |
| Password | Stored in `config.json` (never commit this file) |
| Budget ID | Your budget's group ID (find via `discover-accounts.js`) |
| Config file | `c:/Users/Karthik Maiya/Desktop/telegram-bott/integrations/config.json` |

## Notes

- All amounts are in your local currency as configured in USER.md
- Amounts are stored internally as cents (multiplied by 100) by the API
- The `config.json` file is gitignored -- copy `config.example.json` and fill in your values
- After first sync, a local budget folder is created in `/tmp/actual-data/`

## Forecasting & Natural Language Queries

You can ask forecasting and budget-health questions in plain English. The CLI supports a natural-language mode: pass a quoted question instead of a JSON command.

Examples:

```bash
# Will I exceed my shopping budget this month?
node workspace/skills/budget/query-budget.js "Will I exceed my shopping budget this month?"

# Predict my monthly spending
node workspace/skills/budget/query-budget.js "Predict my monthly spending"

# How much safe budget remains?
node workspace/skills/budget/query-budget.js "How much money can I safely spend this week?"
```

Flags:

- `--json` — output raw JSON instead of terminal-friendly text
- `--debug` — enable debug output (intent interpretation, inputs, AI reasoning)

Debug output includes the interpreted intent, fetched budget snapshot, forecast inputs, provider selection, latency, and fallback events when applicable.

Supported forecasting intents (handled dynamically by the interpreter): `forecast`, `overspending_risk`, `savings_projection`, `budget_health`.

Design notes:

- Forecasts are produced by `workspace/skills/budget/forecasting.js` and combine lightweight statistics with an AI explanation layer.
- The interpreter dynamically determines categories, forecast horizon, and aggregation strategy; follow-ups are supported via conversational context.
- The CLI prints a short forecast summary, category risk table, and recommendations. Use `--json` for structured output suitable for automation.
- Real Actual Budget targets and remaining balances are injected into forecast risk analysis when available.
