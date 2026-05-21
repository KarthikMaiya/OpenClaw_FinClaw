# How to Run the Budget Bot Project

> Quick reference I keep for running my personal bot instance.

## Quick Start (5 minutes)

### Step 1: Start Docker (Actual Budget Server)
```powershell
cd c:\Users\dhana\Desktop\telegram-openclaw\setup
docker compose up -d
```

Verify it's running:
```powershell
docker ps
```

You should see: `actual-budget` container running on port 5006

### Step 2: Start the Telegram Bot
Open a new PowerShell window and run:
```powershell
cd c:\Users\dhana\Desktop\telegram-openclaw
node telegram-bot.js
```

Expected output:
```
🤖 Budget Bot started! Listening for Telegram messages...
Bot Token: configured via .env
Workspace: C:\Users\dhana\.openclaw\workspace-budget-bot
```

**The terminal will stay open and log all messages.** ✅ Bot is now live!

### Step 3: Test in Telegram

Open Telegram and find your bot. Send these commands:

**First time setup:**
```
/pair
```
Response: `✅ Account Linked!`

**Check balance:**
```
/balance
```
Response: `💰 Your Balance - Checking: $1,234.56`

**View recent transactions:**
```
/recent
```
Response: Shows your last 5 transactions

**Log a transaction:**
```
50 groceries
```
Response: `✅ Logged! groceries | -$50.00`

---

## Full Setup (if starting fresh)

### Prerequisites
- ✅ Docker installed and running
- ✅ Node.js v20+ installed
- ✅ Telegram bot token (from @BotFather)

### Complete Setup Steps

#### 1. Verify Docker Setup
```powershell
cd c:\Users\dhana\Desktop\telegram-openclaw\setup
docker compose up -d
docker ps  # Should see actual-budget container
```

#### 2. Install Dependencies
```powershell
cd c:\Users\dhana\Desktop\telegram-openclaw
npm install
```

#### 3. Configure Actual Budget
Copy `.env.example` to `.env` and fill in the required values for:
- `ACTUAL_SERVER_URL`
- `ACTUAL_PASSWORD`
- `TELEGRAM_BOT_TOKEN`
- `AI_PROVIDER` and the matching AI key if you want LLM features

If you want to override the tracked budget metadata, set `ACTUAL_BUDGET_ID` in `.env`.

#### 4. Deploy OpenClaw Workspace
```powershell
# This copies workspace files to ~/.openclaw/
Copy-Item -Recurse "c:\Users\dhana\Desktop\telegram-openclaw\workspace" "$env:USERPROFILE\.openclaw\workspace-budget-bot" -Force

# Copy the bot configuration
Copy-Item "c:\Users\dhana\Desktop\telegram-openclaw\openclaw.json" "$env:USERPROFILE\.openclaw\openclaw.json" -Force
```

#### 5. Start the Bot
```powershell
cd c:\Users\dhana\Desktop\telegram-openclaw
node telegram-bot.js
```

---

## Demo Flow

### Scenario: Show budget tracking workflow

**Step 1: Pair account**
```
User: /pair
Bot: ✅ Account Linked!
```

**Step 2: Check current balance**
```
User: /balance
Bot: 💰 Your Balance
     Checking: $1,234.56
```

**Step 3: Log an expense**
```
User: 45.50 coffee
Bot: ✅ Logged!
     coffee | -$45.50
     2026-05-07
```

**Step 4: View recent transactions**
```
User: /recent
Bot: 📊 Recent Transactions
     2026-05-07 | -$45.50 | coffee
     2026-05-06 | -$25.00 | lunch
     2026-05-05 | -$100.00 | gas
```

---

## Troubleshooting

### Bot doesn't respond to commands

**Check 1: Docker running?**
```powershell
docker ps | findstr actual-budget
```
If empty, start Docker: `docker compose -f setup/docker-compose.yml up -d`

**Check 2: Bot script running?**
Check the terminal running `node telegram-bot.js` - should show active messages

**Check 3: Telegram token correct?**
```powershell
cat $env:USERPROFILE\.openclaw\openclaw.json | findstr botToken
```

### "Cannot find module" errors

Make sure dependencies are installed:
```powershell
cd c:\Users\dhana\Desktop\telegram-openclaw
npm install axios
```

### Transactions not logging

Check Actual Budget is running:
```powershell
curl http://localhost:5006/health
```

If fails, restart Docker:
```powershell
docker compose -f setup/docker-compose.yml restart
```

---

## Running Checks Before Demo

```powershell
cd c:\Users\dhana\Desktop\telegram-openclaw
node health-check.js
```

This validates:
- ✓ Docker container running
- ✓ Actual Budget API responding  
- ✓ Configuration files present
- ✓ Dependencies installed
- ✓ Workspace deployed
- ✓ Telegram bot configured

---

## Files You're Running

| File | Purpose |
|------|---------|
| `integrations/add-transaction.js` | Adds transactions to Actual Budget |
| `integrations/query-budget.js` | Queries balance and transactions |
| `telegram-bot.js` | Listens for Telegram messages and runs commands |
| `workspace/` | Agent personality, tools, and configuration |
| `setup/docker-compose.yml` | Docker setup for Actual Budget |

---

## Terminal Layout (for Demo)

```
┌─────────────────────────────────────────────────────┐
│ Terminal 1: Docker                                  │
│ $ docker compose up -d                              │
│ actual-budget running on :5006                      │
│                                                     │
│ Terminal 2: Bot (KEEP OPEN)                         │
│ $ node telegram-bot.js                              │
│ 🤖 Budget Bot started!                              │
│ [Messages logged here during demo]                  │
│                                                     │
│ Terminal 3: Telegram App                            │
│ [Send commands to bot here]                         │
└─────────────────────────────────────────────────────┘
```

---

## Quick Reference

```bash
# Start everything
docker compose -f setup/docker-compose.yml up -d
node telegram-bot.js

# Health check
node health-check.js

# View logs
docker logs actual-budget

# Stop everything
docker compose -f setup/docker-compose.yml down
```
