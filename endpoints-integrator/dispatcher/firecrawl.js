// =============================================================================
// dispatcher/firecrawl.js
//
// Adapter for Firecrawl's /v1/scrape endpoint. Per INFA-22 the Firecrawl
// WhatsApp group now accepts a free-form prompt: instead of requiring a
// literal URL, we let the local Qwen CLI pick the URL that best answers
// the user's question, then call Firecrawl to extract Markdown + metadata.
//
//   POST https://api.firecrawl.dev/v1/scrape
//   Authorization: Bearer <FIRECRAWL_API_KEY>
//
// Two execution paths:
//
//   1. Direct URL: if the prompt already contains a URL, we scrape it
//      immediately. No extra model call.
//
//   2. Qwen delegation: when no URL is present we call the local Qwen CLI
//      (`qwen -m … -p …`, same shape used by dispatcher/qwen.js) and ask
//      it to pick a single URL. The Qwen reply is a single JSON line:
//        {"url":"https://…"}            — use this URL
//        {"url":null,"reason":"…"}      — abort with a friendly message
//      We parse defensively: code fences, leading prose, and non-JSON
//      replies are tolerated, but every claim has to parse to a usable
//      http(s) URL or we surface a clear operator-friendly error.
//
// Quirks:
//   - We use /v1/scrape (sync) rather than /v1/crawl (async job). Infinity's
//     group-by-group interaction is one message at a time.
//   - Firecrawl historically accepted `X-Api-Key`; Bearer is canonical now.
//   - Default format is `markdown` so a downstream chat model could consume
//     it if needed; the WhatsApp reply is the title + first ~3500 chars.
//   - Stub fallback (INFA-20): if FIRECRAWL_API_KEY is missing we still
//     return a friendly hint instead of throwing AuthError so the group
//     never goes silently dead. Qwen problems surface inline.
// =============================================================================

'use strict';

const { envKey, runWithRetry, trimForReply } = require('./shared.js');
const qwen = require('./qwen.js');

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
const URL_RE = /\bhttps?:\/\/[^\s)\]"'<>]+/i;
const MAX_PROMPT_CHARS = 4_000;

function extractUrl(prompt) {
  const match = prompt.match(URL_RE);
  return match ? match[0].replace(/[.,;:!?)]+$/, '') : null;
}

async function callFirecrawl({ apiKey, baseUrl, url, requestId, signal }) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/scrape`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
    }),
    signal,
  });

  if (res.status === 401 || res.status === 403) {
    const e = new Error(`provider rejected key (HTTP ${res.status}). Rotate at https://firecrawl.dev`);
    e.status = res.status;
    throw e;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * Build the planning prompt we send to Qwen. The instruction is strict: Qwen
 * must reply with one JSON line and nothing else. We let the dispatcher
 * surface the same prompt verbatim so behaviour is identical whether Qwen
 * is invoked from the TS adapter or the JS dispatcher.
 */
function buildQwenPlanningPrompt(userPrompt) {
  const trimmed = String(userPrompt || '').slice(0, MAX_PROMPT_CHARS);
  return [
    'Du bist ein URL-Auswähler. Wähle EINE einzelne https-URL aus, die die',
    'folgende Nutzerfrage am besten beantwortet (offizielle Doku, Hersteller-',
    'Seite oder Wikipedia zuerst). Antworte AUSSCHLIESSLICH mit einer einzigen',
    'Zeile JSON im Format:',
    '{"url":"https://…"}',
    'Wenn du keine passende Seite kennst, antworte stattdessen mit:',
    '{"url":null,"reason":"kurze Begründung"}',
    'Keine Erklärungen, kein Markdown, kein zusätzlicher Text.',
    '',
    `Nutzerfrage: ${trimmed}`,
  ].join('\n');
}

/**
 * Strip code fences / surrounding prose and parse the first JSON object out
 * of Qwen's reply. Returns null if no valid object can be extracted.
 */
function parseQwenPick(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  let obj;
  try {
    obj = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const url = obj.url;
  const reason = obj.reason;
  if (url == null) {
    return { url: null, reason: typeof reason === 'string' ? reason : null };
  }
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  return { url, reason: typeof reason === 'string' ? reason : null };
}

/**
 * Ask the local Qwen CLI to pick a URL. We deliberately do NOT swallow errors
 * — the caller decides how to surface them. The CLI itself is invoked with
 * `dispatcher/qwen.run(...)` so timeout / retry / sanitisation rules are
 * identical to the standalone Qwen group.
 */
async function planUrlWithQwen(prompt, ctx) {
  const planningPrompt = buildQwenPlanningPrompt(prompt);
  const raw = await qwen.run(planningPrompt, {
    ...ctx,
    requestId: ctx.requestId ? `${ctx.requestId}-qwen-plan` : 'firecrawl-qwen-plan',
  });
  const parsed = parseQwenPick(raw);
  if (!parsed) {
    const e = new Error(
      `qwen returned an unparseable planning reply: ${String(raw).trim().slice(0, 200)}`,
    );
    e.code = 'EPLAN';
    throw e;
  }
  return parsed;
}

/**
 * @param {string} prompt
 * @param {object} ctx  { requestId, group, mediaPaths, baseUrl?, apiKey?, qwenBin?, qwenModel? }
 * @returns {Promise<string>}
 */
async function run(prompt, ctx = {}) {
  if (typeof prompt !== 'string') {
    throw new TypeError('firecrawl: prompt must be a string');
  }
  // Stub fallback (INFA-20): if no API key is configured, return a friendly
  // visible reply instead of throwing AuthError. Mirrors the contract used
  // by the Perplexity adapter so non-Qwen groups never look silently dead.
  if (!ctx.apiKey && !process.env.FIRECRAWL_API_KEY) {
    return stubMissingCredential(extractUrl(prompt));
  }

  // Resolve the target URL: either from the prompt (fast path) or by asking
  // the local Qwen CLI to pick one (INFA-22 delegation).
  let target = extractUrl(prompt);
  let planningNote = null;
  if (!target) {
    try {
      const pick = await planUrlWithQwen(prompt, ctx);
      if (!pick.url) {
        return (
          `Qwen konnte zu deiner Anfrage keine passende URL finden.\n\n` +
          `Grund: ${pick.reason || '(keine Begründung)'}\n\n` +
          `Tipp: schick eine konkrete URL, z.B. \`scrape https://example.com\`.`
        );
      }
      target = pick.url;
      planningNote = pick.reason;
    } catch (planErr) {
      const reason = planErr && planErr.message ? planErr.message : String(planErr);
      return (
        `Firecrawl braucht entweder eine URL im Prompt oder ein laufendes Qwen-CLI, ` +
        `um eine URL aus deiner Frage abzuleiten.\n\n` +
        `Fehler bei der Qwen-Planung: ${reason}`
      );
    }
  }

  const apiKey = ctx.apiKey || envKey('FIRECRAWL_API_KEY', {
    adapter: 'firecrawl',
    hint: 'issue a key at https://firecrawl.dev and set FIRECRAWL_API_KEY',
  });
  const baseUrl = ctx.baseUrl || process.env.FIRECRAWL_BASE_URL || DEFAULT_BASE_URL;
  const requestId = ctx.requestId || `firecrawl-${Date.now()}`;

  const json = await runWithRetry(
    ({ signal }) => callFirecrawl({ apiKey, baseUrl, url: target, requestId, signal }),
    {
      adapter: 'firecrawl',
      attempts: 3,
      baseDelayMs: 300,
      timeoutMs: 45_000,
    },
  );

  const md = json?.data?.markdown || '';
  const title = json?.data?.metadata?.title || target;
  const head = trimForReply(md);
  const header = planningNote
    ? `*${title}*\n_Quelle gewählt von Qwen: ${target}_\n_Qwen-Grund: ${planningNote}_\n\n`
    : `*${title}*\n\n`;
  return `${header}${head}`;
}

/**
 * Visible stub reply used when no FIRECRAWL_API_KEY is configured. Echoes
 * the URL (if any) back so the operator can confirm the routing works and
 * surfaces the missing-key hint inline. INFA-20 contract: never leave a
 * configured group silent.
 */
function stubMissingCredential(target) {
  const urlLine = target
    ? `Erkannte URL: ${target}\n\n`
    : 'Tipp: schick eine URL wie `scrape https://example.com` — oder stelle eine freie Frage und Qwen wählt eine passende Quelle aus.\n\n';
  return (
    `🔧 *Firecrawl* (Stub)\n\n` +
    `Dieser Endpoint ist verdrahtet, aber es fehlt der API-Key.\n\n` +
    urlLine +
    `So aktivierst du ihn:\n` +
    `  1. Key holen: https://firecrawl.dev\n` +
    `  2. Setzen:  \`export FIRECRAWL_API_KEY=…\`\n` +
    `  3. WhatsApp-Client neu starten.\n\n` +
    `Bis dahin bekommst du diesen Stub statt einer echten Antwort.`
  );
}

module.exports = {
  run,
  callFirecrawl,
  planUrlWithQwen,
  buildQwenPlanningPrompt,
  parseQwenPick,
  DEFAULT_BASE_URL,
  extractUrl,
  stubMissingCredential,
};
