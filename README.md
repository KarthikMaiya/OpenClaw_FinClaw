# OpenClaw + Actual Budget Telegram Bot

Personal finance assistant that logs transactions to Actual Budget and answers spending questions from Telegram.

This repository combines:

- Actual Budget API integrations
- Telegram polling bot
- Receipt OCR pipeline (image to transaction)
- Natural language transaction parsing and budget queries
- OpenClaw workspace files for agent behavior

## What This Project Does

- Logs expenses and income from Telegram text like `120 coffee` or `salary 5000`
- Supports common commands: `/balance`, `/recent`, `/insights`, `/pair`, `/help`
- Reads receipt photos/documents from Telegram and extracts payee, amount, date, account, and notes
- Writes transactions to Actual Budget using `@actual-app/api`
- Runs natural language budget Q&A (for example: "How much did I spend this month?")
- Uses keyword-first category detection and AI fallback categorization with cache
- Includes smoke tests and health checks for local validation

## Architecture

1. Telegram sends messages and images to local bot polling process
2. Bot parses command or transaction input
3. Integration scripts query or write data in Actual Budget
4. Bot returns formatted responses to Telegram
5. Optional OpenClaw workspace provides agent instructions and skill files

## Current Repository Layout

- `telegram-bot.js`: main Telegram polling bot
- `config-manager.js`: centralized environment/config loading and validation
- `integrations/add-transaction.js`: adds transactions and resolves category
- `integrations/query-budget.js`: balance, recent, summary, insights, search, NLQ
- `integrations/transaction-parser.js`: natural language parser for text transactions
- `setup/discover-accounts.js`: prints budget/account IDs from Actual Budget
- `setup/docker-compose.yml`: starts Actual Budget server
- `health-check.js`: local readiness checks
- `smoke-test.js`: AI and query workflow smoke test with report output
- `workspace/`: OpenClaw workspace config and skills
- `openclaw.json.example`: example OpenClaw channel/agent binding config

## Prerequisites

- Windows with PowerShell
- Docker Desktop running
- Node.js 18+
- Telegram bot token from BotFather
- Actual Budget password

## 1) Install Dependencies

From repository root:

```powershell
npm install
```

## 2) Start Actual Budget Server

```powershell
cd setup
docker compose up -d
```

Then open `http://localhost:5006`, create/login to your budget, and ensure at least one account exists.

## 3) Create Environment File

Create `.env` in the repository root and set values like this:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
ACTUAL_SERVER_URL=http://localhost:5006
ACTUAL_PASSWORD=your_actual_password

# Required unless already present in integrations/config.json
ACTUAL_BUDGET_ID=your_budget_group_id

# Optional naming/module overrides
ACTUAL_BUDGET_NAME=My Budget
ACTUAL_MODULE_DIR=./node_modules

# AI provider setup (optional but recommended)
AI_PROVIDER=openai
AI_API_KEY=
OPENAI_API_KEY=
GOOGLE_API_KEY=

# Optional debug
CONFIG_DEBUG=0
```

Notes:

- `config-manager.js` validates required configuration on startup.
- If `ACTUAL_BUDGET_ID` is missing, `integrations/config.json` must contain a valid `budgetId`.

## 4) Discover Budget and Account IDs

```powershell
node setup/discover-accounts.js
```

Use the output to set your real values in integration constants:

- `integrations/add-transaction.js`
  - `ACCOUNTS`
  - `BUDGET_LOCAL_ID`
- `integrations/query-budget.js`
  - `ACCOUNTS`
  - `BUDGET_LOCAL_ID`

If you use OpenClaw budget skill CLI directly, also update:

- `workspace/skills/budget/query-budget.js`
  - `ACCOUNTS`
  - `BUDGET_LOCAL_ID`
  - ensure config path targets your local `integrations/config.json`

## 5) Run the Telegram Bot

```powershell
node telegram-bot.js
```

Expected startup logs include:

- bot started and listening
- masked bot token prefix
- workspace path at `%USERPROFILE%\.openclaw\workspace-budget-bot`

## Telegram Usage

### Commands

- `/help` or `/start`: command help and input examples
- `/pair`: account link confirmation
- `/balance`: account balances
- `/recent`: latest transactions
- `/insights`: monthly insights summary

### Natural Language Query Examples

- "How much did I spend this month?"
- "How much did I spend on food last month?"
- "Show my highest expenses this week"
- "Did I overspend on shopping?"
- "Compare March vs April spending"

### Transaction Message Examples

- `10 recharge`
- `250 uber`
- `799 myntra shopping`
- `paid 450 for dinner`
- `spent 99 on cookies`
- `rs 300 fuel`

### Receipt OCR

Send an image/photo/document in Telegram. The bot:

1. Downloads the file from Telegram
2. Extracts text using `tesseract.js`
3. Detects amount/payee/date/account/notes
4. Adds transaction in Actual Budget
5. Replies with a formatted confirmation

## Local Validation and Testing

### Project Health Check

```powershell
node health-check.js
```

Checks include:

- Docker + Actual Budget health endpoint
- environment configuration presence
- key dependencies installed
- integration scripts load and basic runtime query checks
- OpenClaw workspace files present

### AI Categorization Test

```powershell
npm run test:ai
```

Writes result file to:

- `integrations/ai-categorization-results.json`

### Smoke Test

```powershell
npm run smoke-test
npm run smoke-test -- --debug
npm run demo
```

Generates:

- `smoke-test-report.json`

## OpenClaw Integration (Optional)

If you are using OpenClaw channel routing:

1. Copy `workspace/` into your OpenClaw workspace directory
2. Use `openclaw.json.example` as base for your OpenClaw config
3. Keep bot token sourced from environment (`USE_TELEGRAM_BOT_TOKEN_ENV`)
4. Restart OpenClaw and pair from Telegram

## Scripts at Root

- `npm run test:ai` -> AI categorization harness
- `npm run smoke-test` -> full smoke test
- `npm run demo` -> smoke test demo mode

## Troubleshooting

### Missing configuration error on startup

- Ensure `.env` exists in repo root
- Confirm required values: `TELEGRAM_BOT_TOKEN`, `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, budget ID source

### Actual Budget rate-limit errors (`too-many-requests`)

- Retry after a short delay
- Bot already applies throttling between API-heavy actions
- Query init flow includes exponential backoff

### No transactions returned

- Re-check account UUIDs in both integration scripts
- Confirm `BUDGET_LOCAL_ID` matches the downloaded local budget folder name
- Re-run account discovery after budget/account changes

### OCR result quality is poor

- Send clearer, high-contrast images
- Include a text caption with amount/payee for fallback context

## Security Notes

- Keep `.env` local and uncommitted
- Rotate tokens/keys if exposed
- Do not hardcode secrets in JSON config files
- Cache files in this repo are local artifacts

## License and Ownership

This is a personal maintained setup and customization on top of OpenClaw + Actual Budget components.