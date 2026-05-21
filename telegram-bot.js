#!/usr/bin/env node

/**
 * OpenClaw Budget Bot - Telegram Integration
 * Bridges Telegram messages to the budget agent and Actual Budget API
 */

const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWorker } = require("tesseract.js");
const {
  validateRequiredConfig,
  getTelegramConfig,
  printDebugSummary,
} = require("./config-manager");

// Global safety: log unhandled rejections and uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});

const WORKSPACE_DIR = path.join(
  process.env.USERPROFILE,
  ".openclaw",
  "workspace-budget-bot"
);
const BOT_LOCK_FILE = path.join(os.tmpdir(), "telegram-budget-bot.lock");

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireBotLock() {
  try {
    fs.writeFileSync(BOT_LOCK_FILE, String(process.pid), { flag: "wx" });
    return;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  const existingPid = Number(String(fs.readFileSync(BOT_LOCK_FILE, "utf8") || "").trim());
  if (existingPid && isPidRunning(existingPid)) {
    console.error(`Another local telegram-bot.js process is running (PID ${existingPid}). Stop it and run only one instance.`);
    process.exit(1);
  }

  // Stale lock; take ownership.
  fs.writeFileSync(BOT_LOCK_FILE, String(process.pid), "utf8");
}

function releaseBotLock() {
  try {
    if (fs.existsSync(BOT_LOCK_FILE)) {
      const ownerPid = Number(String(fs.readFileSync(BOT_LOCK_FILE, "utf8") || "").trim());
      if (!ownerPid || ownerPid === process.pid) {
        fs.unlinkSync(BOT_LOCK_FILE);
      }
    }
  } catch {
    // Ignore lock cleanup errors during shutdown.
  }
}

process.on("exit", releaseBotLock);
process.on("SIGINT", () => {
  releaseBotLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseBotLock();
  process.exit(0);
});

let runtimeConfig;
try {
  runtimeConfig = validateRequiredConfig({
    requireTelegram: true,
    requireActual: true,
    requireBudgetId: true,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (runtimeConfig.configDebug) {
  printDebugSummary("telegram-bot");
}

acquireBotLock();

// Load workspace metadata (optional for logging/context)
let AGENTS = "";
let SOUL = "";
let TOOLS = "";
try {
  if (fs.existsSync(path.join(WORKSPACE_DIR, "AGENTS.md"))) {
    AGENTS = fs.readFileSync(path.join(WORKSPACE_DIR, "AGENTS.md"), "utf8");
  }
  if (fs.existsSync(path.join(WORKSPACE_DIR, "SOUL.md"))) {
    SOUL = fs.readFileSync(path.join(WORKSPACE_DIR, "SOUL.md"), "utf8");
  }
  if (fs.existsSync(path.join(WORKSPACE_DIR, "TOOLS.md"))) {
    TOOLS = fs.readFileSync(path.join(WORKSPACE_DIR, "TOOLS.md"), "utf8");
  }
} catch (e) {
  console.warn("Warning: Could not load workspace metadata files");
}

const botToken = getTelegramConfig().botToken;
const TELEGRAM_API = `https://api.telegram.org/bot${botToken}`;

// State tracking
const userSessions = new Map(); // userId -> context
let ocrWorkerPromise = null;
let lastApiCall = 0; // Track last API call time
const MIN_API_CALL_INTERVAL_MS = 5000; // Wait at least 5s between API calls

async function throttleApiCall() {
  const timeSinceLastCall = Date.now() - lastApiCall;
  if (timeSinceLastCall < MIN_API_CALL_INTERVAL_MS) {
    const waitTime = MIN_API_CALL_INTERVAL_MS - timeSinceLastCall;
    console.log(`[throttle] Waiting ${waitTime}ms before next API call...`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  lastApiCall = Date.now();
}

function getActualErrorResponse(error, fallbackMessage) {
  const message = String(error?.message || error || "").toLowerCase();

  if (message.includes("invalid-password")) {
    return "❌ Actual Budget authentication failed. Update `ACTUAL_PASSWORD` in your `.env` to match the password you use at http://localhost:5006, then restart the bot.";
  }

  if (message.includes("too-many-requests")) {
    return "⏱️ Actual Budget is rate-limiting requests. Wait a few seconds and try again.";
  }

  if (message.includes("could not find actual budget named") || message.includes("missing budget selection")) {
    return "❌ Budget not found. Check `ACTUAL_BUDGET_NAME` or `ACTUAL_BUDGET_ID` in `.env` and restart the bot.";
  }

  return fallbackMessage;
}

/**
 * Send message to Telegram
 */
async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      ...options,
    };
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return response.data;
  } catch (error) {
    console.error(
      "Failed to send Telegram message:",
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Parse user command/message
 */
function parseCommand(text) {
  if (!text) return null;
  const trimmed = text.trim().toLowerCase();

  if (trimmed === "/start" || trimmed === "/help") {
    return { type: "help" };
  } else if (trimmed === "/balance") {
    return { type: "balance" };
  } else if (trimmed === "/recent") {
    return { type: "recent" };
  } else if (
    trimmed === "/insights" ||
    trimmed === "/analyze" ||
    trimmed === "/spending" ||
    /(?:analy[sz]e|insights?|spending behavior|spending analysis|expense analysis|how did i spend)/i.test(trimmed)
  ) {
    return { type: "insights" };
  } else if (
    trimmed === "/query" ||
    trimmed === "/ask" ||
    /(?:how much|show my highest expenses|compare|did i overspend|what did i spend|highest expenses|spend on)/i.test(trimmed)
  ) {
    return { type: "nlq", text: trimmed };
  } else if (trimmed === "/pair") {
    return { type: "pair" };
  } else if (
    trimmed.match(/^\d+\s+.+$/) ||
    trimmed.match(/^send\s+\d+\s+.+$/i)
  ) {
    return { type: "add_transaction", text: trimmed };
  }
  return { type: "message", text: trimmed };
}

/**
 * Parse transaction amount and payee from text
 * Supports flexible, natural-language formats
 */
function parseTransaction(text) {
  const { parseTransactionMessage } = require(path.join(
    path.dirname(__filename),
    'integrations',
    'transaction-parser.js'
  ));
  
  const result = parseTransactionMessage(text, { debug: false });
  
  if (!result.ok) {
    return null;
  }
  
  return {
    amount: result.amount,
    payee: result.payee,
    category: result.category,
    categoryConfidence: result.categoryConfidence,
    amountConfidence: result.amountConfidence,
  };
}

function normalizeText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseDateFromText(text) {
  const candidates = [
    /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/,
    /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/,
    /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/,
    /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/,
  ];

  for (const pattern of candidates) {
    const match = text.match(pattern);
    if (!match) continue;

    let date;
    if (pattern === candidates[0]) {
      date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    } else if (pattern === candidates[1]) {
      date = new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
    } else if (pattern === candidates[2]) {
      date = new Date(`${match[1]} ${match[2]} ${match[3]}`);
    } else {
      date = new Date(`${match[1]} ${match[2]} ${match[3]}`);
    }

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }

  return null;
}

function detectAccountFromText(text) {
  const lower = text.toLowerCase();
  if (/visa|mastercard|amex|discover|credit card|card ending|pos|tap to pay/.test(lower)) {
    return "Karthik Maiya";
  }
  if (/savings|deposit|interest/.test(lower)) {
    return "Karthik Maiya";
  }
  return "Karthik Maiya";
}

function extractAmountFromText(text) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const amountPatterns = [
    /(?:total|amount|paid|charge|charged|debit|withdrawn|sent|transfer|payment|balance due|grand total)\D*([-+]?\$?\d[\d,]*\.\d{1,2}|[-+]?\$?\d[\d,]*)/i,
    /([-+]?\$?\d[\d,]*\.\d{1,2}|[-+]?\$?\d[\d,]*)\s*(?:usd|thb|baht|dollars?|บาท)?\s*$/i,
  ];

  for (const line of lines) {
    for (const pattern of amountPatterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const numeric = Number(match[1].replace(/[$,]/g, ""));
      if (Number.isFinite(numeric) && numeric !== 0) {
        return numeric;
      }
    }
  }

  const fallbackMatches = normalizeText(text).match(/[-+]?\$?\d[\d,]*\.\d{1,2}|[-+]?\$?\d[\d,]*/g) || [];
  const values = fallbackMatches
    .map((value) => Number(value.replace(/[$,]/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 100000000);

  if (values.length === 0) {
    return null;
  }

  return values[values.length - 1];
}

function guessPayeeFromText(text) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^(receipt|transaction|payment|date|time|amount|total|balance|approved|declined|auth|ref|invoice|order|card|debit|credit|cash)/i.test(line)) {
      continue;
    }
    if (/\d{2,}/.test(line)) {
      continue;
    }
    if (/[A-Za-z]{3,}/.test(line)) {
      return line.replace(/[:|]/g, " ").trim();
    }
  }

  return null;
}

function extractNotesFromText(text) {
  const matches = [];
  const refPatterns = [
    /\b(?:ref|reference|txn|transaction|auth|order|invoice|receipt|rrn|trace)[:#\s-]*([A-Z0-9-]{3,})\b/gi,
    /\b(?:ending|last 4|last4)[:#\s-]*([0-9]{4})\b/gi,
  ];

  for (const pattern of refPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      matches.push(match[0].replace(/\s+/g, " ").trim());
    }
  }

  return matches.join(", ");
}

function detectTransactionType(text) {
  const lower = text.toLowerCase();
  if (/salary|deposit|credited|refund|received|incoming/.test(lower)) {
    return 1;
  }
  if (/expense|debit|withdrawn|paid|purchase|spent|charge|payment|transfer|sent|total/.test(lower)) {
    return -1;
  }
  return -1;
}

function parseReceiptText(text, fallbackCaption = "") {
  const combined = normalizeText([fallbackCaption, text].filter(Boolean).join("\n"));
  const amount = extractAmountFromText(combined);
  const payee = guessPayeeFromText(combined);
  const date = parseDateFromText(combined) || new Date().toISOString().slice(0, 10);
  const notes = extractNotesFromText(combined);
  const account = detectAccountFromText(combined);

  if (amount === null || !payee) {
    return null;
  }

  const sign = detectTransactionType(combined);
  const normalizedAmount = Math.abs(amount) * sign;

  return {
    amount: normalizedAmount,
    payee,
    date,
    account,
    notes,
    rawText: combined,
  };
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await createWorker("eng");
      return worker;
    })();
  }

  return ocrWorkerPromise;
}

async function recognizeImageText(imagePath) {
  const worker = await getOcrWorker();
  const result = await worker.recognize(imagePath);
  return normalizeText(result?.data?.text || "");
}

async function downloadTelegramFile(fileId, extension = ".jpg") {
  const fileResponse = await axios.get(`${TELEGRAM_API}/getFile`, {
    params: { file_id: fileId },
  });

  const filePath = fileResponse.data?.result?.file_path;
  if (!filePath) {
    throw new Error("Could not resolve Telegram file path");
  }

  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const imageResponse = await axios.get(fileUrl, { responseType: "arraybuffer" });
  const tempFilePath = path.join(
    os.tmpdir(),
    `openclaw-receipt-${Date.now()}${extension}`
  );
  fs.writeFileSync(tempFilePath, Buffer.from(imageResponse.data));
  return tempFilePath;
}

async function processReceiptImage(message) {
  const photoSizes = Array.isArray(message.photo) ? message.photo : [];
  const bestPhoto = photoSizes[photoSizes.length - 1];
  const document = message.document;

  let fileId = null;
  let extension = ".jpg";

  if (bestPhoto?.file_id) {
    fileId = bestPhoto.file_id;
  } else if (document?.file_id && /^image\//i.test(document.mime_type || "")) {
    fileId = document.file_id;
    if (document.file_name) {
      extension = path.extname(document.file_name) || ".png";
    }
  }

  if (!fileId) {
    return null;
  }

  const tempFilePath = await downloadTelegramFile(fileId, extension);
  try {
    const ocrText = await recognizeImageText(tempFilePath);
    return parseReceiptText(ocrText, message.caption || "");
  } finally {
    fs.unlink(tempFilePath, () => {});
  }
}

/**
 * Execute agent action
 */
async function executeAction(action, userId) {
  const integrationDir = path.join(__dirname, "integrations");

  // Clear the require cache for fresh data each time
  delete require.cache[path.join(integrationDir, "query-budget.js")];
  delete require.cache[path.join(integrationDir, "add-transaction.js")];

  // Throttle API calls to avoid rate limiting
  await throttleApiCall();

  switch (action.type) {
    case "help":
      return {
        response: `💸 **Penny - Budget Bot**

I help you track expenses and manage your budget!

**Commands:**
/balance - Show your balance
/recent - Recent transactions
/pair - Link your account
/insights - Spending analysis

**Quick Expense Logging:**
Just type amount and what it's for:
• 10 recharge
• 10 pizza
• 250 uber
• 120 coffee
• paid 450 for dinner
• spent 99 on cookies

**Send Receipt Photos** 📸
I'll scan and log them automatically!`,
      };

    case "balance":
      try {
        const { getBalance } = require(path.join(
          integrationDir,
          "query-budget.js"
        ));
        const result = await getBalance();
        const balances = result.balances;
        let message = "💰 **Your Balance**\n\n";
        Object.entries(balances).forEach(([account, balance]) => {
          message += `${account}: ₹${balance.toFixed(2)}\n`;
        });
        return { response: message };
      } catch (error) {
        console.error("Balance error:", error);
        return {
          response: getActualErrorResponse(error, "❌ Error fetching balance. Please try again."),
        };
      }

    case "recent":
      try {
        const { getRecentTransactions } = require(path.join(
          integrationDir,
          "query-budget.js"
        ));
        const result = await getRecentTransactions({ limit: 5 });
        const transactions = result.transactions || [];
        if (transactions.length === 0) {
          return { response: "📊 **No recent transactions**" };
        }
        let message = "📊 **Recent Transactions**\n\n";
        transactions.forEach((t) => {
          const sign = t.amount < 0 ? "-" : "+";
          message += `${t.date} | ${sign}₹${Math.abs(t.amount).toFixed(2)} | ${t.payee}\n`;
        });
        return { response: message };
      } catch (error) {
        console.error("Recent transactions error:", error);
        return {
          response: getActualErrorResponse(error, "❌ Error fetching transactions."),
        };
      }

    case "nlq":
      try {
        const { getNaturalLanguageQuery } = require(path.join(
          integrationDir,
          "query-budget.js"
        ));
        console.log(`[NLQ] Processing question: "${action.text}"`);
        const result = await getNaturalLanguageQuery({ question: action.text });
        console.log(`[NLQ] Got result:`, JSON.stringify(result));
        return { response: result.answer || result.response || "I couldn't answer that yet." };
      } catch (error) {
        console.error("Natural language query error:", error.message);
        console.error("Natural language query stack:", error.stack);
        return {
          response: getActualErrorResponse(error, "❌ Error handling that question. Please try again."),
        };
      }

    case "insights":
      try {
        const { getExpenseAnalysis } = require(path.join(
          integrationDir,
          "query-budget.js"
        ));
        const result = await getExpenseAnalysis();
        const insights = result.insights || [];
        const monthLabel = new Date(`${result.month}-01T00:00:00`).toLocaleString(
          "en-US",
          { month: "long", year: "numeric" }
        );

        let message = `📈 **Spending Insights**\n\n${monthLabel}\n\n`;
        if (typeof result.totalExpense === "number") {
          message += `Spent: ₹${Math.abs(result.totalExpense).toFixed(2)}\n`;
        }
        if (typeof result.totalIncome === "number") {
          message += `Income: ₹${result.totalIncome.toFixed(2)}\n`;
        }
        if (typeof result.net === "number") {
          message += `Net: ₹${result.net.toFixed(2)}\n`;
        }

        message += `\n`;
        insights.forEach((insight) => {
          message += `- ${insight}\n`;
        });

        return { response: message.trim() };
      } catch (error) {
        console.error("Insights error:", error);
        return {
          response: getActualErrorResponse(error, "❌ Error fetching spending insights. Please try again."),
        };
      }

    case "pair":
      return {
        response:
          "✅ **Account Linked!**\n\nYour Telegram account is now paired with your budget. You can start logging transactions!",
      };

    case "add_transaction":
      try {
        const parsed = parseTransaction(action.text);
        if (!parsed) {
          return {
            response:
              "❌ Couldn't parse this. Try formats like:\n• 10 recharge\n• 250 uber\n• spent 99 on cookies",
          };
        }

        const { addTransaction } = require(path.join(
          integrationDir,
          "add-transaction.js"
        ));
        const result = await addTransaction({
          amount: parsed.amount,
          payee: parsed.payee,
          account: "Karthik Maiya",
          category: parsed.category,
        });

        const amount = Math.abs(result.amount).toFixed(0);
        const categoryLabel = result.category && result.category !== 'Other' 
          ? ` (${result.category})` 
          : '';

        return {
          response: `✅ **Logged!**\n\n₹${amount} for ${result.payee}${categoryLabel}\n📅 ${result.date}`,
        };
      } catch (error) {
        console.error("Add transaction error:", error);
        return {
          response: getActualErrorResponse(error, "❌ Couldn't save transaction. Try again in a moment."),
        };
      }

    case "message":
    default:
      return {
        response: `I'm Penny, your budget bot! 💸\n\nTry:\n/balance - Show your balance\n/recent - Recent transactions\n/insights - Spending behavior\n/help - Full command list`,
      };
  }
}

/**
 * Handle Telegram webhook/polling
 */
async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text;
  const hasImage = Boolean(message.photo?.length) || /^image\//i.test(message.document?.mime_type || "");

  console.log(
    `[${new Date().toISOString()}] ${message.from.first_name}: ${text}`
  );

  try {
    if (hasImage) {
      const parsed = await processReceiptImage(message);
      if (!parsed) {
        await sendTelegramMessage(
          chatId,
          "❌ I could not read that image clearly. Please send a sharper receipt photo or add a text caption with the amount and payee."
        );
        return;
      }

      const { addTransaction } = require(path.join(
        __dirname,
        "integrations",
        "add-transaction.js"
      ));

      const result = await addTransaction({
        amount: parsed.amount,
        payee: parsed.payee,
        date: parsed.date,
        account: parsed.account,
        notes: parsed.notes,
      });

      await sendTelegramMessage(
        chatId,
        `✅ **Receipt scanned**\n\n${result.payee} | ${result.amount < 0 ? "-" : "+"}₹${Math.abs(result.amount).toFixed(2)}\n${result.date}${result.category ? `\n🏷️ ${result.category}` : ""}${result.notes ? `\n📝 ${result.notes}` : ""}`
      );
      return;
    }

    if (!text) return;

    const command = parseCommand(text);
    console.log(`[DEBUG] Parsed command:`, JSON.stringify(command));
    
    const result = await executeAction(command, userId);
    console.log(`[DEBUG] Action result:`, JSON.stringify(result));

    await sendTelegramMessage(chatId, result.response);
    console.log(`[DEBUG] Response sent to chat ${chatId}`);
  } catch (error) {
    console.error("Error handling message:", error.message);
    console.error("Stack:", error.stack);
    try {
      await sendTelegramMessage(
        chatId,
        "❌ Something went wrong. Please try again."
      );
    } catch (sendError) {
      console.error("Failed to send error message:", sendError.message);
    }
  }
}

/**
 * Long polling for Telegram updates
 */
async function startPolling() {
  let offset = 0;
  let pollAttempts = 0;

  try {
    await axios.post(`${TELEGRAM_API}/deleteWebhook`, {
      drop_pending_updates: false,
    });
    console.log("🔧 Cleared Telegram webhook to enable long polling");
  } catch (error) {
    console.warn(
      "⚠️ Could not clear Telegram webhook:",
      error.response?.data?.description || error.message
    );
  }

  console.log("🤖 Budget Bot started! Listening for Telegram messages...");
  console.log(`Bot Token: ${botToken.substring(0, 10)}...`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);
  console.log("📡 Starting message polling (will log updates when received)...\n");

  while (true) {
    try {
      pollAttempts += 1;
      const response = await axios.post(
        `${TELEGRAM_API}/getUpdates`,
        { offset, timeout: 30 },
        { timeout: 35000 }
      );

      const updates = response.data.result;
      if (updates && updates.length > 0) {
        console.log(`[Poll #${pollAttempts}] Received ${updates.length} update(s)`);
        for (const update of updates) {
          await handleUpdate(update);
          offset = update.update_id + 1;
        }
      } else if (pollAttempts % 10 === 0) {
        console.log(`[Poll #${pollAttempts}] Still listening (no new messages)...`);
      }
    } catch (error) {
      const statusCode = error.response?.status;
      const description = String(error.response?.data?.description || "");

      if (statusCode === 409) {
        console.error("Polling conflict (409):", description || error.message);

        if (/webhook/i.test(description)) {
          try {
            await axios.post(`${TELEGRAM_API}/deleteWebhook`, {
              drop_pending_updates: false,
            });
            console.log("🔧 Re-cleared Telegram webhook after 409 conflict");
          } catch (webhookError) {
            console.error(
              "Failed to clear webhook after 409:",
              webhookError.response?.data?.description || webhookError.message
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }

        if (/terminated by other getupdates request/i.test(description)) {
          console.error(
            "Another bot process is already polling this token. Stop duplicate telegram-bot.js instances and run only one."
          );
          await new Promise((resolve) => setTimeout(resolve, 7000));
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      if (error.code !== "ECONNABORTED") {
        console.error("Polling error:", error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Retry after 5s
    }
  }
}

// Start the bot
startPolling().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
