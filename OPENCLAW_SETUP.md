# OpenClaw + Telegram Setup

> Personal notes: this is my customized setup and documentation — maintained by me.

This project is already set up locally for Actual Budget. To connect it to OpenClaw and Telegram, use the files in `workspace/` and the example config in `openclaw.json.example`.

## What you still need

- OpenClaw installed on your machine
- A Telegram bot token from @BotFather

## 1. Create the Telegram bot

1. Open Telegram and chat with @BotFather
2. Send `/newbot`
3. Choose a bot name and a username that ends in `_bot`
4. Copy the bot token

## 2. Copy the workspace into OpenClaw

Copy the repo's `workspace/` folder into your OpenClaw workspace location.

Example:

```powershell
Copy-Item -Recurse "c:\Users\dhana\Desktop\telegram-openclaw\workspace" "$env:USERPROFILE\.openclaw\workspace-budget-bot"
```

## 3. Add the OpenClaw config

Use `openclaw.json.example` as the starting point for `~/.openclaw/openclaw.json`.

Replace the bot token placeholder with your real Telegram token.

## 4. Start OpenClaw

Restart OpenClaw after saving the config.

Then send `/pair` to the bot in Telegram.

## 5. Quick checks

- `workspace/SOUL.md` controls the personality
- `workspace/AGENTS.md` controls the budget and receipt behavior
- `workspace/TOOLS.md` contains the local Actual Budget command paths

## Current local paths

- Actual Budget config: `integrations/config.json`
- Add transaction script: `integrations/add-transaction.js`
- Query script: `workspace/skills/budget/query-budget.js`
