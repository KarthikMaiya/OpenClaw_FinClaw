# Telegram Bot Setup Guide

> My personal setup guide — configured and maintained by me.

This guide will help you run the Budget Bot on your local machine and connect it to Telegram.

## Prerequisites

1. ✅ Docker - Actual Budget running on `http://localhost:5006`
2. ✅ Node.js v20+ with dependencies installed
3. ✅ Telegram bot token (created with @BotFather)
4. ✅ Configuration files deployed to `~/.openclaw/`

## Quick Start

### 1. Verify Docker is Running

```powershell
docker ps | findstr actual-budget
```

Should show the `actual-budget` container running.

### 2. Start the Bot

From the project root:

```powershell
cd c:\Users\dhana\Desktop\telegram-openclaw
node telegram-bot.js
```

You should see:
```
🤖 Budget Bot started! Listening for Telegram messages...
Bot Token: configured via .env
Workspace: C:\Users\dhana\.openclaw\workspace-budget-bot
```

### 3. Link Your Telegram Account

In Telegram, find your bot and send:
```
/pair
```

You should get confirmation:
```
✅ Account Linked!
Your Telegram account is now paired with your budget.
```

### 4. Test Commands

**Check balance:**
```
/balance
```

**View recent transactions:**
```
/recent
```

**Log a transaction:**
```
50 groceries
```

This should log a $50 expense to "groceries".

## How It Works

1. **Message received** → Bot parses command/transaction
2. **Local script execution** → Calls Actual Budget API via Node.js
3. **Response sent** → Bot replies with confirmation or data

## Troubleshooting

### Bot doesn't respond

1. Check Docker:
   ```powershell
   docker logs actual-budget
   ```

2. Check bot logs in terminal - look for error messages

3. Verify Telegram token is correct:
   ```powershell
   cat $env:USERPROFILE\.openclaw\openclaw.json | grep botToken
   ```

### "Error fetching balance"

The Docker container might not be running:

```powershell
docker compose -f setup/docker-compose.yml up -d
```

### Transaction not logging

Verify the Checking account UUID in integrations/add-transaction.js matches your actual budget setup.

## Running as a Background Service

For long-term use, you can run the bot as a Windows Service or scheduled task:

```powershell
# Option 1: Use PM2 (Node process manager)
npm install -g pm2
pm2 start telegram-bot.js --name "budget-bot"
pm2 save
pm2 startup

# Option 2: Create a Windows Scheduled Task
$taskXml = @"
<Task version="1.3">
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>node</Command>
      <Arguments>telegram-bot.js</Arguments>
      <WorkingDirectory>c:\Users\dhana\Desktop\telegram-openclaw</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
# Save to XML file and import via Task Scheduler
```

## Configuration

The bot reads configuration from:
- `~/.openclaw/openclaw.json` - Bot token and workspace path
- `integrations/config.json` - Actual Budget credentials
- `workspace/AGENTS.md` - Agent personality and accounts

To customize the bot's responses, edit `workspace/SOUL.md` and `workspace/AGENTS.md`.

