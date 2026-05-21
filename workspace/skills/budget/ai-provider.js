#!/usr/bin/env node
/**
 * Shared AI provider manager for budget workflows.
 *
 * Goals:
 * - Centralize OpenAI / Gemini / future providers behind one abstraction.
 * - Add automatic fallback, retries, backoff, health checks, and debug metrics.
 * - Standardize all AI responses to a JSON schema requested by callers.
 */

const https = require('https');
const { URL } = require('url');
const { getAiConfig } = require('../../../config-manager');

function getConfiguredProviders() {
  return getAiConfig().providers;
}

function getProviderKey(provider) {
  const { aiApiKey, openAiApiKey, googleApiKey } = getAiConfig();
  if (provider === 'gemini') {
    return googleApiKey || aiApiKey || '';
  }
  return aiApiKey || openAiApiKey || googleApiKey || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

function normalizeSchema(result, fallback = {}) {
  const content = typeof result.content === 'string' ? result.content : '';
  const parsed = result.parsed || extractJsonObject(content) || {};
  return {
    ok: true,
    provider: result.provider,
    latencyMs: result.latencyMs,
    tokenUsage: result.tokenUsage || null,
    fallbackUsed: !!result.fallbackUsed,
    content,
    parsed,
    ...fallback,
  };
}

async function callOpenAI({ key, messages, model, maxTokens, temperature }) {
  const body = JSON.stringify({ model: model || 'gpt-4o-mini', messages, max_tokens: maxTokens || 500, temperature: temperature ?? 0 });
  const response = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${key}`,
      },
    }, (res) => {
      let data = '';
      const headers = res.headers || {};
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`OpenAI HTTP ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          err.headers = headers;
          return reject(err);
        }
        return resolve({ statusCode: res.statusCode, body: data, headers });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const parsed = JSON.parse(response.body || '{}');
  const content = parsed?.choices?.[0]?.message?.content || '';
  return {
    content,
    tokenUsage: parsed.usage || null,
  };
}

async function callGemini({ key, messages, model, maxTokens, temperature }) {
  const endpoint = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || 'gemini-1.5-flash')}:generateContent`);
  endpoint.searchParams.set('key', key);

  const parts = [];
  for (const message of messages) {
    const role = message.role === 'system' ? 'user' : message.role;
    if (role === 'system') {
      parts.push({ role: 'user', parts: [{ text: `SYSTEM INSTRUCTIONS:\n${message.content}` }] });
    } else {
      parts.push({ role, parts: [{ text: String(message.content || '') }] });
    }
  }

  const body = JSON.stringify({
    contents: parts,
    generationConfig: {
      temperature: temperature ?? 0,
      maxOutputTokens: maxTokens || 500,
      responseMimeType: 'application/json',
    },
  });

  const response = await new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      const headers = res.headers || {};
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`Gemini HTTP ${res.statusCode}: ${data}`);
          err.statusCode = res.statusCode;
          err.headers = headers;
          return reject(err);
        }
        return resolve({ statusCode: res.statusCode, body: data, headers });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const parsed = JSON.parse(response.body || '{}');
  const content = parsed?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return {
    content,
    tokenUsage: parsed.usageMetadata || null,
  };
}

async function executeProvider(provider, payload) {
  const mockResponses = payload.mockProviderResponses || null;
  if (mockResponses && Object.prototype.hasOwnProperty.call(mockResponses, provider)) {
    const mock = typeof mockResponses[provider] === 'function' ? await mockResponses[provider](provider, payload) : mockResponses[provider];
    if (mock instanceof Error) {
      throw mock;
    }
    if (mock && typeof mock === 'object' && mock.throw) {
      throw new Error(mock.throw);
    }
    if (typeof mock === 'string') {
      return { content: mock, tokenUsage: null };
    }
    if (mock && typeof mock === 'object') {
      return { content: mock.content || JSON.stringify(mock.parsed || {}), tokenUsage: mock.tokenUsage || null };
    }
    return { content: '', tokenUsage: null };
  }

  const key = getProviderKey(provider);
  if (!key) {
    throw new Error(`Missing API key for provider ${provider}`);
  }

  if (provider === 'openai') {
    return callOpenAI({
      key,
      messages: payload.messages,
      model: payload.model,
      maxTokens: payload.maxTokens,
      temperature: payload.temperature,
    });
  }

  if (provider === 'gemini') {
    return callGemini({
      key,
      messages: payload.messages,
      model: payload.model || 'gemini-1.5-flash',
      maxTokens: payload.maxTokens,
      temperature: payload.temperature,
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

async function requestJson(payload = {}) {
  const providers = Array.isArray(payload.providers) && payload.providers.length > 0 ? payload.providers : getConfiguredProviders();
  const maxAttempts = Math.max(1, payload.retries || 3);
  const debug = !!payload.debug;
  const messages = payload.messages || [];
  const retryDelays = payload.retryDelays || [200, 500, 1000];
  const errors = [];

  for (const provider of providers) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        const raw = await executeProvider(provider, payload);
        const latencyMs = Date.now() - started;
        const parsed = extractJsonObject(raw.content) || {};
        if (debug) {
          console.error(`[ai-provider] provider=${provider} latencyMs=${latencyMs} attempt=${attempt} tokens=${JSON.stringify(raw.tokenUsage || {})}`);
        }
        return normalizeSchema({
          provider,
          latencyMs,
          tokenUsage: raw.tokenUsage,
          content: raw.content,
          parsed,
          fallbackUsed: provider !== providers[0],
        }, payload.fallback || {});
      } catch (error) {
        const latencyMs = Date.now() - started;
        // Capture error details for diagnostics
        const entry = { provider, attempt, message: error.message || String(error), latencyMs };
        if (error && error.statusCode) entry.statusCode = error.statusCode;
        if (error && error.headers) entry.headers = error.headers;
        errors.push(entry);
        if (debug) {
          console.error(`[ai-provider] fallback provider=${provider} attempt=${attempt} latencyMs=${latencyMs} error=${error.message}`);
        }
        if (attempt < maxAttempts) {
          // Prefer Retry-After header when present (seconds)
          let delay = null;
          try {
            const hdr = (error && error.headers) ? (error.headers['retry-after'] || error.headers['Retry-After']) : null;
            if (hdr) {
              const asInt = parseInt(String(hdr), 10);
              if (!Number.isNaN(asInt) && asInt > 0) {
                delay = asInt * 1000;
              }
            }
          } catch (e) {
            // ignore
          }

          // Exponential backoff with cap when no Retry-After provided
          if (delay === null) {
            delay = Math.min(500 * Math.pow(2, attempt - 1), 30000);
          }
          if (debug) console.error(`[ai-provider] retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
          await sleep(delay);
        }
      }
    }
  }

  const fallback = payload.onFallback || { ok: false, provider: null, latencyMs: 0, tokenUsage: null, fallbackUsed: true, content: '', parsed: {}, errors };
  if (debug) {
    console.error(`[ai-provider] all providers failed: ${errors.map((entry) => `${entry.provider}:${entry.message}`).join(' | ')}`);
  }
  return fallback;
}

async function healthCheck() {
  const providers = getConfiguredProviders();
  const checks = [];
  for (const provider of providers) {
    try {
      const result = await requestJson({
        providers: [provider],
        messages: [{ role: 'user', content: 'Return JSON {"ok":true}' }],
        maxTokens: 20,
        retries: 1,
        debug: false,
      });
      checks.push({ provider, ok: !!result, latencyMs: result.latencyMs || 0 });
    } catch (error) {
      checks.push({ provider, ok: false, error: error.message });
    }
  }
  return checks;
}

module.exports = {
  getConfiguredProviders,
  requestJson,
  healthCheck,
  extractJsonObject,
};
