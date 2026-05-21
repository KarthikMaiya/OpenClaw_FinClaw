#!/usr/bin/env node

/**
 * Project Health Check - Validates all components of the Budget Bot
 * Run this before demoing to ensure everything works
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getRuntimeConfig, printDebugSummary } = require("./config-manager");

if (typeof navigator === 'undefined') {
  global.navigator = { platform: 'linux' };
}
if (typeof SharedArrayBuffer === 'undefined') {
  global.SharedArrayBuffer = ArrayBuffer;
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[36m";

let checksPassed = 0;
let checksFailed = 0;

function check(name) {
  return {
    pass: (msg) => {
      console.log(`${GREEN}✓${RESET} ${name}: ${msg || "OK"}`);
      checksPassed++;
    },
    fail: (msg) => {
      console.log(`${RED}✗${RESET} ${name}: ${msg || "FAILED"}`);
      checksFailed++;
    },
    warn: (msg) => {
      console.log(`${YELLOW}⚠${RESET} ${name}: ${msg || "WARNING"}`);
    },
  };
}

function header(text) {
  console.log(`\n${BLUE}═══════════════════════════════════════${RESET}`);
  console.log(`${BLUE}${text}${RESET}`);
  console.log(`${BLUE}═══════════════════════════════════════${RESET}\n`);
}

async function runChecks() {
  header("🔍 Budget Bot - Project Health Check");
  const runtimeConfig = getRuntimeConfig();
  if (runtimeConfig.configDebug) {
    printDebugSummary("health-check");
  }

  // 1. Docker Check
  header("1️⃣  Docker & Actual Budget");
  const dockerCheck = check("Docker Container");
  try {
    const output = execSync("docker ps --format '{{.Names}}'", {
      encoding: "utf8",
    });
    if (output.includes("actual-budget")) {
      dockerCheck.pass("Actual Budget running");
    } else {
      dockerCheck.fail("Container not found");
    }
  } catch (e) {
    dockerCheck.fail("Docker not running or error");
  }

  const serverCheck = check("Actual Budget API");
  try {
    const axios = require("axios");
    const response = await axios.get("http://localhost:5006/health", {
      timeout: 5000,
    });
    if (response.status === 200 || response.status === 404) {
      // 404 is OK - means server is responding
      serverCheck.pass("Server responding on :5006");
    } else {
      serverCheck.fail("Unexpected response");
    }
  } catch (e) {
    serverCheck.fail("Server not responding");
  }

  // 2. Configuration Check
  header("2️⃣  Configuration Files");
  const configCheck = check("integrations/config.json");
  const configPath = path.join(__dirname, "integrations", "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config.budgetId) {
        configCheck.pass(`Configured: ${config.budgetName || "Budget"}`);
      } else {
        configCheck.fail("Missing budgetId");
      }
    } catch (e) {
      configCheck.fail("Invalid JSON");
    }
  } else {
    configCheck.fail("File not found");
  }

  const envCheck = check("Environment configuration");
  if (runtimeConfig.missingRequired.length === 0) {
    envCheck.pass("Required env vars present");
  } else {
    envCheck.fail(`Missing: ${runtimeConfig.missingRequired.join(", ")}`);
  }

  if (runtimeConfig.missingOptional.length > 0) {
    envCheck.warn(`Optional AI configs missing: ${runtimeConfig.missingOptional.join(", ")}`);
  } else if (runtimeConfig.aiProvider.length > 0) {
    envCheck.pass(`AI provider configured: ${runtimeConfig.aiProvider.join(", ")}`);
  }

  // 3. Dependencies Check
  header("3️⃣  Node.js Dependencies");
  const depsCheck = check("@actual-app/api");
  try {
    require("@actual-app/api");
    depsCheck.pass("Installed");
  } catch (e) {
    depsCheck.fail("Not installed");
  }

  const axiosCheck = check("axios");
  try {
    require("axios");
    axiosCheck.pass("Installed");
  } catch (e) {
    axiosCheck.fail("Not installed");
  }

  // 4. Integration Scripts Check
  header("4️⃣  Integration Scripts");
  const queryScriptCheck = check("integrations/query-budget.js");
  const queryPath = path.join(__dirname, "integrations", "query-budget.js");
  if (fs.existsSync(queryPath)) {
    try {
      const { getBalance } = require(queryPath);
      queryScriptCheck.pass("Loadable");
    } catch (e) {
      queryScriptCheck.fail("Failed to load: " + e.message);
    }
  } else {
    queryScriptCheck.fail("File not found");
  }

  const addScriptCheck = check("integrations/add-transaction.js");
  const addPath = path.join(__dirname, "integrations", "add-transaction.js");
  if (fs.existsSync(addPath)) {
    try {
      const { addTransaction } = require(addPath);
      addScriptCheck.pass("Loadable");
    } catch (e) {
      addScriptCheck.fail("Failed to load: " + e.message);
    }
  } else {
    addScriptCheck.fail("File not found");
  }

  const queryRuntimeCheck = check("query-budget runtime");
  try {
    const { getBalance, getRecentTransactions, getExpenseAnalysis, getNaturalLanguageQuery } = require(queryPath);
    await getBalance();
    await getRecentTransactions({ limit: 1 });
    await getExpenseAnalysis();
    await getNaturalLanguageQuery({ question: "How much did I spend on food last month?" });
    queryRuntimeCheck.pass("Balance, recent, insights, and natural language queries work");
  } catch (e) {
    queryRuntimeCheck.fail("Runtime query failed: " + e.message);
  }

  // 5. Workspace Check
  header("5️⃣  OpenClaw Workspace");
  const workspacePath = path.join(
    process.env.USERPROFILE,
    ".openclaw",
    "workspace-budget-bot"
  );
  const workspaceCheck = check("Workspace deployed");
  if (fs.existsSync(workspacePath)) {
    workspaceCheck.pass("Found at ~/.openclaw/workspace-budget-bot");
  } else {
    workspaceCheck.fail("Not found - run setup first");
  }

  const agentsCheck = check("workspace/AGENTS.md");
  if (fs.existsSync(path.join(workspacePath, "AGENTS.md"))) {
    agentsCheck.pass("Found");
  } else {
    agentsCheck.fail("Not found");
  }

  const soulCheck = check("workspace/SOUL.md");
  if (fs.existsSync(path.join(workspacePath, "SOUL.md"))) {
    soulCheck.pass("Found");
  } else {
    soulCheck.fail("Not found");
  }

  // 6. Telegram Bot Check
  header("6️⃣  Telegram Bot");
  const telegramBotCheck = check("telegram-bot.js");
  const botPath = path.join(__dirname, "telegram-bot.js");
  if (fs.existsSync(botPath)) {
    telegramBotCheck.pass("Script found");
  } else {
    telegramBotCheck.fail("Script not found");
  }

  // 7. Summary
  header("📊 Test Summary");
  const total = checksPassed + checksFailed;
  const passed = checksPassed;
  const failed = checksFailed;
  const percentage = total > 0 ? Math.round((passed / total) * 100) : 0;

  console.log(`Total Checks: ${total}`);
  console.log(`${GREEN}Passed: ${passed}${RESET}`);
  if (failed > 0) {
    console.log(`${RED}Failed: ${failed}${RESET}`);
  }
  console.log(`Success Rate: ${percentage}%\n`);

  if (failed === 0) {
    console.log(
      `${GREEN}✓ All systems ready for demo!${RESET}\n`
    );
    console.log("Next steps:");
    console.log("  1. Start the bot: node telegram-bot.js");
    console.log("  2. Send /pair in Telegram");
    console.log("  3. Try commands: /balance, /recent, /insights, or type '50 groceries'\n");
  } else {
    console.log(`${YELLOW}⚠ Some checks failed. Fix issues before demoing.${RESET}\n`);
  }
}

runChecks().catch(console.error);
