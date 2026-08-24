// =============================================================================
// dispatcher/firecrawl.js
//
// Adapter for Firecrawl's /v1/scrape endpoint. The Firecrawl WhatsApp group
// expects: "send a URL → get a structured page summary back". The dispatcher
// pulls the first URL out of the prompt and asks Firecrawl to extract
// Markdown + metadata.
//
//   POST https://api.firecrawl.dev/v1/scrape
//   Authorization: Bearer <FIRECRAWL_API_KEY>
//
// Quirks:
//   - We use /v1/scrape (sync) rather than /v1/crawl (async job). Infinity's
//     group-by-group interaction is one message at a time.
//   - Firecrawl historically accepted `X-Api-Key`; Bearer is canonical now.
//   - Default format is `markdown` so a downstream chat model could consume
//     it if needed; the WhatsApp reply is the title + first ~3500 chars.
//   - If no URL is in the prompt, we return a friendly hint string (NOT a
//     thrown error) so the WhatsApp client sends a useful nudge instead of
//     surfacing an exception to the user.
// =============================================================================

'use strict';

const { envKey, runWithRetry, trimForReply } = require('./shared.js');

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
const URL_RE = /\bhttps?:\/\/[^\s)\]"'<>]+/i;

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
 * @param {string} prompt
 * @param {object} ctx  { requestId, group, mediaPaths, baseUrl?, apiKey? }
 * @returns {Promise<string>}
 */
async function run(prompt, ctx = {}) {
  if (typeof prompt !== 'string') {
    throw new TypeError('firecrawl: prompt must be a string');
  }
  const target = extractUrl(prompt);
  if (!target) {
    return 'Firecrawl adapter needs a URL. Try: `scrape https://example.com`';
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
  return `*${title}*\n\n${head}`;
}

module.exports = { run, callFirecrawl, DEFAULT_BASE_URL, extractUrl };