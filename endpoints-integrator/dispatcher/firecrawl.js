// =============================================================================
// dispatcher/firecrawl.js
//
// Adapter for Firecrawl — supports three execution paths:
//
//   1. Direct URL: a literal URL in the prompt → POST /v1/scrape and reply
//      with title + first chunk of markdown (INFA-22, kept for backward-compat).
//
//   2. Free-form pick-one (INFA-22 delegation): no URL in the prompt → ask the
//      local Qwen CLI to pick a single URL → POST /v1/scrape.
//
//   3. Recursive research (INFA-23): no URL in the prompt AND the question
//      looks like an open research question (i.e. the user wants an answer,
//      not a single page). Pipeline:
//
//        a. ask Qwen to derive a Google-style search query from the prompt;
//        b. POST Firecrawl /v2/search with `sources: ["web"]` and a small
//           `limit` (default 5) to retrieve result URLs with title/snippet;
//        c. ask Qwen to rank the results and pick the top K (default 3);
//        d. POST Firecrawl /v1/scrape for each chosen URL, accumulating
//           markdown up to a hard cap (FIRECRAWL_RECURSE_MAX_CHARS, default
//           12_000) so the final Qwen composition step stays within its
//           CLI argv budget;
//        e. ask Qwen to compose a pretty formatted German answer from the
//           accumulated material, citing each source by title + URL.
//
//      Every step has its own bounded timeout and surfaces a clear operator-
//      friendly message on failure. We do NOT silently swallow errors: if any
//      step fails we return what we have plus a hint, or — when nothing is
//      available — fall back to the single-pick path.
//
// Stub fallback (INFA-20): if FIRECRAWL_API_KEY is missing we still return a
// friendly hint instead of throwing AuthError so the group never goes silently
// dead. Qwen problems surface inline.
// =============================================================================

'use strict';

const { envKey, runWithRetry, trimForReply } = require('./shared.js');
const qwen = require('./qwen.js');

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
const URL_RE = /\bhttps?:\/\/[^\s)\]"'<>]+/i;
const MAX_PROMPT_CHARS = 4_000;

// --- INFA-23 tunables (env-overridable) -------------------------------------
const SEARCH_LIMIT = clampInt(process.env.FIRECRAWL_SEARCH_LIMIT, 5, 1, 10);
const PICK_TOP_K = clampInt(process.env.FIRECRAWL_PICK_TOP_K, 3, 1, 5);
const MAX_TOTAL_CHARS = clampInt(process.env.FIRECRAWL_RECURSE_MAX_CHARS, 12_000, 2_000, 40_000);
const SEARCH_TIMEOUT_MS = 30_000;
const SCRAPE_TIMEOUT_MS = 45_000;
const SEARCH_PATH = '/v2/search';
const SCRAPE_PATH = '/v1/scrape';
// Heuristic: if the prompt contains '?' OR a question word OR a research
// trigger (e.g. "tell me about", "explain", "list", "compare") OR is longer
// than the threshold, treat it as a research question (path 3) rather than
// a direct fetch request (path 2).
const QUESTION_HINT_RE = /\?|^(was|wie|wer|wo|wann|warum|wieso|weshalb|wem|wen|wessen|which|what|who|where|when|why|how|erkläre|erklär|beschreib|nenn|lis|vergleich|zeig|unterschied|unterschiede)\b/i;
// Imperative research triggers — these ALWAYS escalate regardless of length.
const RESEARCH_TRIGGER_RE = /\b(tell me about|explain|describe|list|compare|give me|provide|was sind|wie ist|was macht|wie funktioniert|unterschied zwischen|unterschiede zwischen|overview|summary|summarize)\b/i;
const RESEARCH_LENGTH_THRESHOLD = 60;

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function extractUrl(prompt) {
  const match = prompt.match(URL_RE);
  return match ? match[0].replace(/[.,;:!?)]+$/, '') : null;
}

function looksLikeResearchQuestion(prompt) {
  const trimmed = String(prompt || '').trim();
  if (!trimmed) return false;
  if (
    QUESTION_HINT_RE.test(trimmed) ||
    RESEARCH_TRIGGER_RE.test(trimmed) ||
    trimmed.length >= RESEARCH_LENGTH_THRESHOLD
  ) {
    // The classic "scrape …" / "fetch …" prefix means the user wants a
    // specific page; do NOT escalate to research mode even if the trigger
    // regex matches.
    if (/^(scrape|fetch|lade|hole|zeig|show|get)\b/i.test(trimmed)) return false;
    return true;
  }
  return false;
}

// --- Firecrawl HTTP helpers -------------------------------------------------

async function callFirecrawlSearch({ apiKey, baseUrl, query, requestId, limit }) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}${SEARCH_PATH}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'X-Request-Id': `${requestId}-search` } : {}),
    },
    body: JSON.stringify({
      query,
      sources: ['web'],
      limit,
      // We don't ask Firecrawl to scrape here; we want lightweight snippets
      // first, then rank with Qwen, then scrape only the chosen links.
      scrapeOptions: { formats: [] },
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    const e = new Error(`provider rejected key (HTTP ${res.status}). Rotate at https://firecrawl.dev`);
    e.status = res.status;
    throw e;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`search HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function callFirecrawlScrape({ apiKey, baseUrl, url, requestId }) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}${SCRAPE_PATH}`;
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
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
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

// --- Qwen planning prompts (INFA-23) ---------------------------------------

function buildQueryFormulationPrompt(userPrompt) {
  const trimmed = String(userPrompt || '').slice(0, MAX_PROMPT_CHARS);
  return [
    'Du bist ein Suchanfrage-Formulierer. Wandle die Nutzerfrage in EINE kurze',
    'Google-Suchanfrage (3-8 Wörter) um, die die beste Treffermenge liefert.',
    'Antworte AUSSCHLIESSLICH mit einer einzigen Zeile JSON:',
    '{"query":"<suchanfrage>"}',
    'Keine Erklärungen, kein Markdown, kein zusätzlicher Text.',
    '',
    `Nutzerfrage: ${trimmed}`,
  ].join('\n');
}

function buildRankingPrompt(userPrompt, results) {
  const lines = [
    'Du bist ein Link-Ranker. Wähle aus den Suchergebnissen die Top-K Links,',
    'die die Nutzerfrage am besten beantworten. Bevorzuge offizielle Doku,',
    'Hersteller-Seiten, Wikipedia oder seriöse Nachrichtenquellen.',
    `Antworte AUSSCHLIESSLICH mit einer einzigen Zeile JSON: {"picks":[{"url":"...","reason":"kurze Begründung"}]}.`,
    `Wähle maximal ${PICK_TOP_K} Einträge. Reihenfolge = Wichtigkeit (beste zuerst).`,
    'Wenn KEIN Ergebnis relevant ist, antworte mit: {"picks":[],"reason":"kurze Begründung"}.',
    'Keine Erklärungen, kein Markdown, kein zusätzlicher Text.',
    '',
    `Nutzerfrage: ${String(userPrompt || '').slice(0, MAX_PROMPT_CHARS)}`,
    '',
    'Suchergebnisse:',
  ];
  for (const r of results) {
    lines.push(`- ${r.title || '(ohne Titel)'} | ${r.url}`);
    if (r.description) lines.push(`    ${String(r.description).slice(0, 200)}`);
  }
  return lines.join('\n');
}

function buildCompositionPrompt(userPrompt, sources) {
  const lines = [
    'Du bist ein Antwort-Composer. Liefere eine schöne formatierte deutsche Antwort',
    'auf die Nutzerfrage, basierend NUR auf den unten gelieferten Quellenauszügen.',
    'Regeln:',
    '- Strukturiere mit Überschriften (## …) und Aufzählungspunkten wenn passend.',
    '- Bleibe sachlich, keine Spekulationen über nicht vorhandenes Material.',
    '- Zitiere am Ende unter "*Quellen*" jede verwendete Quelle als Titel + URL.',
    '- Wenn die Quellen die Frage nicht beantworten, sag das ehrlich und nenne die Quellen.',
    '- Keine Code-Blöcke, keine Hervorhebungen mit Backticks außer für URLs.',
    '',
    `Nutzerfrage: ${String(userPrompt || '').slice(0, MAX_PROMPT_CHARS)}`,
    '',
    'Quellenauszüge:',
  ];
  for (let i = 0; i < sources.length; i += 1) {
    const s = sources[i];
    lines.push(`---`);
    lines.push(`Quelle ${i + 1}: ${s.title}`);
    lines.push(`URL: ${s.url}`);
    if (s.reason) lines.push(`Grund der Auswahl: ${s.reason}`);
    lines.push('');
    lines.push(s.markdown.slice(0, MAX_TOTAL_CHARS / Math.max(sources.length, 1)));
  }
  return lines.join('\n');
}

// --- Defensive JSON parser (shared shape with INFA-22) ----------------------

function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (_) {
    return null;
  }
}

function parseQwenPick(raw) {
  const obj = parseJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const url = obj.url;
  const reason = obj.reason;
  if (url == null) return { url: null, reason: typeof reason === 'string' ? reason : null };
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  return { url, reason: typeof reason === 'string' ? reason : null };
}

function parseQwenQuery(raw) {
  const obj = parseJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const q = obj.query;
  if (typeof q !== 'string' || q.trim().length === 0) return null;
  return { query: q.trim() };
}

function parseQwenPicks(raw) {
  const obj = parseJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const picks = obj.picks;
  if (!Array.isArray(picks)) return null;
  const out = [];
  for (const p of picks) {
    if (!p || typeof p !== 'object') continue;
    const url = p.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
    const reason = typeof p.reason === 'string' ? p.reason : null;
    out.push({ url, reason });
    if (out.length >= PICK_TOP_K) break;
  }
  return { picks: out, reason: typeof obj.reason === 'string' ? obj.reason : null };
}

// --- Qwen invocation wrappers ----------------------------------------------

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

async function formulateQueryWithQwen(prompt, ctx) {
  const planningPrompt = buildQueryFormulationPrompt(prompt);
  const raw = await qwen.run(planningPrompt, {
    ...ctx,
    requestId: ctx.requestId ? `${ctx.requestId}-qwen-query` : 'firecrawl-qwen-query',
  });
  const parsed = parseQwenQuery(raw);
  if (!parsed) {
    const e = new Error(
      `qwen returned an unparseable query: ${String(raw).trim().slice(0, 200)}`,
    );
    e.code = 'EQUERY';
    throw e;
  }
  return parsed.query;
}

async function rankResultsWithQwen(prompt, results, ctx) {
  if (results.length === 0) return { picks: [], reason: 'no_results' };
  const planningPrompt = buildRankingPrompt(prompt, results.slice(0, SEARCH_LIMIT));
  const raw = await qwen.run(planningPrompt, {
    ...ctx,
    requestId: ctx.requestId ? `${ctx.requestId}-qwen-rank` : 'firecrawl-qwen-rank',
  });
  const parsed = parseQwenPicks(raw);
  if (!parsed) {
    // Fall back to top-3 by original order so we still have something useful.
    return {
      picks: results.slice(0, PICK_TOP_K).map((r) => ({ url: r.url, reason: r.title })),
      reason: 'ranking_fallback',
    };
  }
  // If Qwen picked nothing, propagate the reason for the user-facing message.
  return parsed;
}

async function composeAnswerWithQwen(prompt, sources, ctx) {
  if (sources.length === 0) {
    return 'Ich konnte leider keine Quellen abrufen, die deine Frage beantworten.';
  }
  const planningPrompt = buildCompositionPrompt(prompt, sources);
  try {
    return await qwen.run(planningPrompt, {
      ...ctx,
      requestId: ctx.requestId ? `${ctx.requestId}-qwen-compose` : 'firecrawl-qwen-compose',
    });
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    // Fall back to a raw dump so the user still gets something useful.
    return (
      'Hier sind die gefundenen Quellen — ich konnte sie aber nicht zu einer Antwort ' +
      'zusammenfassen (Qwen-Compose-Fehler).\n\n' +
      sources
        .map((s, i) => `*${i + 1}. ${s.title}*\n${s.url}${s.reason ? `\n_Grund:_ ${s.reason}` : ''}\n${s.markdown.slice(0, 800)}`)
        .join('\n\n') +
      `\n\n_Qwen-Fehler:_ ${reason}`
    );
  }
}

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

// --- Normalise search-result payloads ---------------------------------------
//
// Firecrawl /v2/search with `sources: ["web"]` returns either
//   { data: { web: [ { title, url, description } ] } }
// or, on legacy shapes, a flat `data: [ … ]`. We accept both.

function normaliseSearchResults(json) {
  const data = json && json.data;
  if (!data) return [];
  let arr = null;
  if (Array.isArray(data.web)) arr = data.web;
  else if (Array.isArray(data)) arr = data;
  if (!arr) return [];
  const out = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const url = typeof r.url === 'string' ? r.url : null;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({
      url,
      title: typeof r.title === 'string' ? r.title : url,
      description: typeof r.description === 'string' ? r.description : '',
    });
    if (out.length >= SEARCH_LIMIT) break;
  }
  return out;
}

// --- Recursive research pipeline -------------------------------------------

async function runResearch(prompt, ctx, env) {
  // Step 1: formulate a search query.
  let query;
  try {
    query = await formulateQueryWithQwen(prompt, ctx);
  } catch (err) {
    return (
      'Firecrawl-Recherche braucht ein laufendes Qwen-CLI, um eine Suchanfrage ' +
      'aus deiner Frage abzuleiten.\n\n' +
      `Fehler bei der Suchanfrage-Planung: ${err && err.message ? err.message : String(err)}`
    );
  }

  // Step 2: search via Firecrawl /v2/search.
  let searchJson;
  try {
    searchJson = await callFirecrawlSearch({
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      query,
      requestId: env.requestId,
      limit: SEARCH_LIMIT,
    });
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    return (
      `Firecrawl-Suche nach \`${query}\` fehlgeschlagen.\n\n` +
      `Fehler: ${reason}\n\n` +
      `Tipp: schick eine konkrete URL, z.B. \`scrape https://example.com\`.`
    );
  }

  const results = normaliseSearchResults(searchJson);
  if (results.length === 0) {
    return (
      `Firecrawl-Suche nach \`${query}\` hat keine Treffer geliefert.\n\n` +
      `Tipp: formuliere die Frage konkreter oder schick eine URL.`
    );
  }

  // Step 3: ask Qwen to rank the links.
  let ranked;
  try {
    ranked = await rankResultsWithQwen(prompt, results, ctx);
  } catch (err) {
    // Should not happen because rankResultsWithQwen falls back internally,
    // but if Qwen itself is broken we surface a clear message.
    const reason = err && err.message ? err.message : String(err);
    return (
      `Firecrawl hat ${results.length} Treffer für \`${query}\` gefunden, aber Qwen ` +
      `konnte sie nicht bewerten.\n\n` +
      `Fehler: ${reason}\n\n` +
      `Erste Treffer zum Anschauen:\n` +
      results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join('\n')
    );
  }

  if (!ranked.picks || ranked.picks.length === 0) {
    return (
      `Firecrawl hat ${results.length} Treffer für \`${query}\` gefunden, aber Qwen ` +
      `hält keinen davon für relevant.\n\n` +
      `Grund: ${ranked.reason || '(keine Begründung)'}\n\n` +
      `Erste Treffer zum Anschauen:\n` +
      results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join('\n')
    );
  }

  // Step 4: scrape each chosen URL, bounded by MAX_TOTAL_CHARS.
  const sources = [];
  let totalChars = 0;
  for (let i = 0; i < ranked.picks.length; i += 1) {
    const pick = ranked.picks[i];
    try {
      const scraped = await callFirecrawlScrape({
        apiKey: env.apiKey,
        baseUrl: env.baseUrl,
        url: pick.url,
        requestId: `${env.requestId || 'firecrawl'}-scrape-${i + 1}`,
      });
      const md = (scraped && scraped.data && scraped.data.markdown) || '';
      const title = (scraped && scraped.data && scraped.data.metadata && scraped.data.metadata.title) || pick.url;
      const remaining = Math.max(0, MAX_TOTAL_CHARS - totalChars);
      if (remaining <= 200) break;
      const trimmed = md.length > remaining ? md.slice(0, remaining) + '\n\n[…gekürzt…]' : md;
      totalChars += trimmed.length;
      sources.push({ url: pick.url, title, reason: pick.reason, markdown: trimmed });
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      sources.push({
        url: pick.url,
        title: pick.url,
        reason: pick.reason,
        markdown: `_Scrape fehlgeschlagen:_ ${reason}`,
      });
    }
  }

  // Step 5: ask Qwen to compose the final answer.
  return composeAnswerWithQwen(prompt, sources, ctx);
}

// --- Entry point ------------------------------------------------------------

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

  const apiKey = ctx.apiKey || envKey('FIRECRAWL_API_KEY', {
    adapter: 'firecrawl',
    hint: 'issue a key at https://firecrawl.dev and set FIRECRAWL_API_KEY',
  });
  const baseUrl = ctx.baseUrl || process.env.FIRECRAWL_BASE_URL || DEFAULT_BASE_URL;
  const requestId = ctx.requestId || `firecrawl-${Date.now()}`;
  const env = { apiKey, baseUrl, requestId };

  // Path 1: prompt contains a URL → single scrape (fast path, INFA-22).
  const directUrl = extractUrl(prompt);
  if (directUrl) {
    try {
      const json = await runWithRetry(
        ({ signal }) => callFirecrawlScrape({
          apiKey, baseUrl, url: directUrl, requestId,
          ...(signal ? { signal } : {}),
        }),
        {
          adapter: 'firecrawl',
          attempts: 3,
          baseDelayMs: 300,
          timeoutMs: 45_000,
        },
      );
      const md = json?.data?.markdown || '';
      const title = json?.data?.metadata?.title || directUrl;
      const head = trimForReply(md);
      return `*${title}*\n\n${head}`;
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      return `Firecrawl-Scrape von \`${directUrl}\` fehlgeschlagen.\n\nFehler: ${reason}`;
    }
  }

  // Path 3: looks like a research question → recursive pipeline (INFA-23).
  if (looksLikeResearchQuestion(prompt)) {
    return runResearch(prompt, ctx, env);
  }

  // Path 2: free-form single-pick (INFA-22 delegation).
  let target;
  let planningNote = null;
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

  try {
    const json = await callFirecrawlScrape({ apiKey, baseUrl, url: target, requestId });
    const md = json?.data?.markdown || '';
    const title = json?.data?.metadata?.title || target;
    const head = trimForReply(md);
    const header = planningNote
      ? `*${title}*\n_Quelle gewählt von Qwen: ${target}_\n_Qwen-Grund: ${planningNote}_\n\n`
      : `*${title}*\n\n`;
    return `${header}${head}`;
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    return `Firecrawl-Scrape von \`${target}\` fehlgeschlagen.\n\nFehler: ${reason}`;
  }
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
    : 'Tipp: schick eine URL wie `scrape https://example.com` — oder stelle eine freie Frage und Firecrawl sucht, rankt, scraped und fasst die Antwort zusammen.\n\n';
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
  callFirecrawlScrape,
  callFirecrawlSearch,
  planUrlWithQwen,
  formulateQueryWithQwen,
  rankResultsWithQwen,
  composeAnswerWithQwen,
  normaliseSearchResults,
  parseQwenPick,
  parseQwenQuery,
  parseQwenPicks,
  buildQwenPlanningPrompt,
  buildQueryFormulationPrompt,
  buildRankingPrompt,
  buildCompositionPrompt,
  looksLikeResearchQuestion,
  DEFAULT_BASE_URL,
  SEARCH_PATH,
  SCRAPE_PATH,
  SEARCH_LIMIT,
  PICK_TOP_K,
  MAX_TOTAL_CHARS,
  extractUrl,
  stubMissingCredential,
};
