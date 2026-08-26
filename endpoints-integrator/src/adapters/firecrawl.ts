// =============================================================================
// Adapter: Firecrawl (web scrape + structured extraction) with Qwen planning.
//
// The Firecrawl WhatsApp group accepts three execution paths (INFA-22 + INFA-23):
//
//   1. URL-in-prompt (fast path):
//        A literal URL in the prompt → POST /v1/scrape → reply with title
//        + first ~3500 chars of markdown. No model call.
//
//   2. Free-form pick-one (INFA-22 delegation):
//        No URL, prompt is a short imperative → ask the local Qwen CLI to
//        pick a single URL → POST /v1/scrape → reply.
//
//   3. Recursive research (INFA-23):
//        No URL, prompt looks like an open research question →
//        a. ask Qwen to derive a Google-style search query,
//        b. POST Firecrawl /v2/search with sources:["web"], small limit,
//        c. ask Qwen to rank the results and pick the top K (default 3),
//        d. POST /v1/scrape for each chosen URL, bounded by
//           FIRECRAWL_RECURSE_MAX_CHARS so the final Qwen step stays within
//           its CLI argv budget,
//        e. ask Qwen to compose a pretty-formatted German answer with
//           *Quellen* block at the end, citing each source by title + URL.
//
// The model produces *no* media; we return mediaRefs empty.
//
// Quirks:
//   - Three endpoints in play: /v1/scrape (single URL, sync), /v2/search
//     (multi-source web search, sync), and /v1/crawl (multi-URL async job —
//     not used here; Infinity's interaction is per-message).
//   - Auth: `Authorization: Bearer <FIRECRAWL_API_KEY>`. Note: Firecrawl
//     historically accepted `X-Api-Key` too; Bearer is canonical now.
//   - Qwen runs as a local child process (`qwen -m … -p …`) — the same CLI
//     shape used by `dispatcher/qwen.js`. We shell out via `child_process`
//     to keep this adapter independent of the JS dispatcher's wiring.
//   - We deliberately do NOT base64-inject media into the prompt; if the
//     caller passed media paths in `ctx.mediaPaths`, we ignore them here
//     because the Firecrawl use case is plain URL → markdown.
//   - When Qwen itself fails (CLI missing, non-zero exit, bad JSON, no URL,
//     no ranked picks), we surface a clear, operator-friendly message — we
//     do NOT silently fall back to a wrong URL.
//   - When Firecrawl returns a provider error, we surface a friendly inline
//     message instead of throwing — keeps the WhatsApp group visibly alive.
//     The TS implementation also mirrors this (no throws after auth check).
// =============================================================================

import { spawn } from "node:child_process";
import type { EndpointAdapter, PromptContext, Reply } from "../types.js";
import { AuthError } from "../credentials.js";

const URL_RE = /\bhttps?:\/\/[^\s)\]]+/i;
const DEFAULT_QWEN_MODEL = "qwen3:30b-a3b";
const MAX_PROMPT_CHARS = 4_000; // bound the planning prompt we hand to Qwen
const PLANNING_TIMEOUT_MS = 30_000;

// --- INFA-23 tunables (env-overridable) -------------------------------------
const SEARCH_LIMIT = clampInt(process.env.FIRECRAWL_SEARCH_LIMIT, 5, 1, 10);
const PICK_TOP_K = clampInt(process.env.FIRECRAWL_PICK_TOP_K, 3, 1, 5);
const MAX_TOTAL_CHARS = clampInt(process.env.FIRECRAWL_RECURSE_MAX_CHARS, 12_000, 2_000, 40_000);
const RESEARCH_LENGTH_THRESHOLD = 60;

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

interface QwenPick {
  url: string | null;
  reason?: string;
}

interface QwenQuery {
  query: string;
}

interface QwenRank {
  url: string;
  reason: string | null;
}

/**
 * Ask the local Qwen CLI to pick a single URL that best answers the user's
 * prompt. Returns `{ url: null, reason }` if Qwen cannot decide.
 */
function askQwenForUrl(prompt: string, qwenBin: string, qwenModel: string): Promise<QwenPick> {
  const system = [
    "Du bist ein URL-Auswähler. Wähle EINE einzelne https-URL aus, die die",
    "folgende Nutzerfrage am besten beantwortet (offizielle Doku, Hersteller-",
    "Seite oder Wikipedia zuerst). Antworte AUSSCHLIESSLICH mit einer einzigen",
    "Zeile JSON im Format:",
    '{"url":"https://…"}',
    'Wenn du keine passende Seite kennst, antworte stattdessen mit:',
    '{"url":null,"reason":"kurze Begründung"}',
    "Keine Erklärungen, kein Markdown, kein zusätzlicher Text.",
  ].join(" ");

  const user = `Nutzerfrage: ${prompt.slice(0, MAX_PROMPT_CHARS)}`;
  const fullPrompt = `${system}\n\n${user}`;

  return new Promise<QwenPick>((resolve, reject) => {
    const child = spawn(qwenBin, ["-m", qwenModel, "-p", fullPrompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("qwen: planning call timed out after 30s"));
    }, PLANNING_TIMEOUT_MS);

    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));

    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(
          `qwen CLI not found at "${qwenBin}". Set QWEN_BIN or install qwen (https://github.com/QwenLM/Qwen3-Coder).`,
        ));
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(
          `qwen: planning call exited with code ${code}: ${stderr.trim().slice(0, 300)}`,
        ));
        return;
      }
      const parsed = parseQwenPick(stdout);
      if (!parsed) {
        reject(new Error(
          `qwen: planning reply was not parseable JSON. raw=${stdout.trim().slice(0, 200)}`,
        ));
        return;
      }
      resolve(parsed);
    });
  });
}

function askQwenForQuery(prompt: string, qwenBin: string, qwenModel: string): Promise<string> {
  const fullPrompt = [
    "Du bist ein Suchanfrage-Formulierer. Wandle die Nutzerfrage in EINE kurze",
    "Google-Suchanfrage (3-8 Wörter) um, die die beste Treffermenge liefert.",
    "Antworte AUSSCHLIESSLICH mit einer einzigen Zeile JSON:",
    '{"query":"<suchanfrage>"}',
    "Keine Erklärungen, kein Markdown, kein zusätzlicher Text.",
    "",
    `Nutzerfrage: ${prompt.slice(0, MAX_PROMPT_CHARS)}`,
  ].join("\n");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(qwenBin, ["-m", qwenModel, "-p", fullPrompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("qwen: query-formulation timed out after 30s"));
    }, PLANNING_TIMEOUT_MS);
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`qwen: query exited with code ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      const obj = parseJsonObject(stdout);
      const q = obj && typeof obj === "object" ? (obj as Record<string, unknown>).query : null;
      if (typeof q !== "string" || q.trim().length === 0) {
        reject(new Error("qwen: query reply missing 'query' string"));
        return;
      }
      resolve(q.trim());
    });
  });
}

function askQwenForRanking(
  prompt: string,
  results: Array<{ url: string; title: string; description: string }>,
  qwenBin: string,
  qwenModel: string,
): Promise<QwenRank[]> {
  const lines = [
    "Du bist ein Link-Ranker. Wähle aus den Suchergebnissen die Top-K Links,",
    "die die Nutzerfrage am besten beantworten. Antworte AUSSCHLIESSLICH mit:",
    `{"picks":[{"url":"...","reason":"..."}]}`,
    `Wähle maximal ${PICK_TOP_K} Einträge (wichtigste zuerst).`,
    "Wenn KEIN Ergebnis relevant ist: {\"picks\":[],\"reason\":\"...\"}",
    "Keine Erklärungen, kein Markdown.",
    "",
    `Nutzerfrage: ${prompt.slice(0, MAX_PROMPT_CHARS)}`,
    "",
    "Suchergebnisse:",
  ];
  for (const r of results) {
    lines.push(`- ${r.title} | ${r.url}`);
    if (r.description) lines.push(`    ${r.description.slice(0, 200)}`);
  }

  return new Promise<QwenRank[]>((resolve, reject) => {
    const child = spawn(qwenBin, ["-m", qwenModel, "-p", lines.join("\n")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("qwen: ranking timed out after 30s"));
    }, PLANNING_TIMEOUT_MS);
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`qwen: ranking exited with code ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      const obj = parseJsonObject(stdout);
      const picks = obj && typeof obj === "object" ? (obj as Record<string, unknown>).picks : null;
      if (!Array.isArray(picks)) {
        resolve([]); // treat as "no picks" rather than throwing
        return;
      }
      const out: QwenRank[] = [];
      for (const p of picks) {
        if (!p || typeof p !== "object") continue;
        const url = (p as Record<string, unknown>).url;
        const reason = (p as Record<string, unknown>).reason;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
        out.push({ url, reason: typeof reason === "string" ? reason : null });
        if (out.length >= PICK_TOP_K) break;
      }
      resolve(out);
    });
  });
}

function askQwenForComposition(
  prompt: string,
  sources: Array<{ url: string; title: string; reason: string | null; markdown: string }>,
  qwenBin: string,
  qwenModel: string,
): Promise<string> {
  if (sources.length === 0) return Promise.resolve("Ich konnte leider keine Quellen abrufen.");
  const lines = [
    "Du bist ein Antwort-Composer. Liefere eine schöne formatierte deutsche Antwort",
    "auf die Nutzerfrage, basierend NUR auf den unten gelieferten Quellenauszügen.",
    "Strukturiere mit Überschriften (## …) wenn passend. Zitiere am Ende unter",
    "*Quellen* jede verwendete Quelle als Titel + URL.",
    "",
    `Nutzerfrage: ${prompt.slice(0, MAX_PROMPT_CHARS)}`,
    "",
    "Quellenauszüge:",
  ];
  for (let i = 0; i < sources.length; i += 1) {
    const s = sources[i];
    lines.push("---");
    lines.push(`Quelle ${i + 1}: ${s.title}`);
    lines.push(`URL: ${s.url}`);
    if (s.reason) lines.push(`Grund der Auswahl: ${s.reason}`);
    lines.push("");
    lines.push(s.markdown.slice(0, Math.floor(MAX_TOTAL_CHARS / sources.length)));
  }
  const fullPrompt = lines.join("\n");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(qwenBin, ["-m", qwenModel, "-p", fullPrompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("qwen: composition timed out after 30s"));
    }, PLANNING_TIMEOUT_MS * 2); // composition can take longer
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`qwen: composition exited with code ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Strip code fences / surrounding text and parse the first JSON object out
 * of Qwen's reply. Returns null if no valid object can be extracted.
 */
function parseJsonObject(raw: string): unknown {
  let text = (raw || "").trim();
  if (!text) return null;
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function parseQwenPick(raw: string): QwenPick | null {
  const obj = parseJsonObject(raw);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const url = o.url;
  const reason = o.reason;
  if (url == null) {
    return { url: null, reason: typeof reason === "string" ? reason : undefined };
  }
  if (typeof url !== "string") return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, reason: typeof reason === "string" ? reason : undefined };
}

// Heuristic: question mark / German+English question words / research
// triggers / long prompts → research pipeline (path 3); short imperatives
// stay on the single-pick path (path 2).
const QUESTION_HINT_RE = /\?|^(was|wie|wer|wo|wann|warum|wieso|weshalb|wem|wen|wessen|which|what|who|where|when|why|how|erkläre|erklär|beschreib|nenn|lis|vergleich|zeig|unterschied|unterschiede)\b/i;
const RESEARCH_TRIGGER_RE = /\b(tell me about|explain|describe|list|compare|give me|provide|was sind|wie ist|was macht|wie funktioniert|unterschied zwischen|unterschiede zwischen|overview|summary|summarize)\b/i;

function looksLikeResearchQuestion(prompt: string): boolean {
  const trimmed = (prompt || "").trim();
  if (!trimmed) return false;
  if (
    !QUESTION_HINT_RE.test(trimmed) &&
    !RESEARCH_TRIGGER_RE.test(trimmed) &&
    trimmed.length < RESEARCH_LENGTH_THRESHOLD
  ) {
    return false;
  }
  // "scrape …" / "fetch …" prefix = single-page intent, never research.
  if (/^(scrape|fetch|lade|hole|zeig|show|get)\b/i.test(trimmed)) return false;
  return true;
}

interface SearchResult { url: string; title: string; description: string; }

function normaliseSearchResults(json: unknown): SearchResult[] {
  const data = (json as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== "object") return [];
  let arr: unknown = null;
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.web)) arr = obj.web;
  else if (Array.isArray(data)) arr = data;
  if (!Array.isArray(arr)) return [];
  const out: SearchResult[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url : null;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({
      url,
      title: typeof o.title === "string" ? o.title : url,
      description: typeof o.description === "string" ? o.description : "",
    });
    if (out.length >= SEARCH_LIMIT) break;
  }
  return out;
}

export class FirecrawlAdapter implements EndpointAdapter {
  readonly name = "firecrawl";

  async run(prompt: string, ctx: PromptContext): Promise<Reply> {
    const { apiKey, baseUrl } = ctx.credentials.firecrawl;
    if (!apiKey) throw new AuthError("FIRECRAWL_API_KEY", this.name,
      "issue a key at https://firecrawl.dev");

    const qwenBin = process.env.QWEN_BIN || "qwen";
    const qwenModel = process.env.QWEN_MODEL || DEFAULT_QWEN_MODEL;
    const requestId = ctx.requestId;

    // Path 1: URL-in-prompt → /v1/scrape (fast path).
    const direct = prompt.match(URL_RE);
    if (direct) {
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/scrape`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-Request-Id": requestId,
          },
          body: JSON.stringify({
            url: direct[0],
            formats: ["markdown"],
            onlyMainContent: true,
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          if (res.status === 401 || res.status === 403) {
            throw new AuthError("FIRECRAWL_API_KEY", this.name,
              `provider rejected key (HTTP ${res.status}). Rotate at https://firecrawl.dev`);
          }
          throw new Error(`firecrawl: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
        }
        const json = (await res.json()) as {
          data?: { markdown?: string; metadata?: { title?: string } };
        };
        const md = json.data?.markdown ?? "";
        const title = json.data?.metadata?.title ?? direct[0];
        const head = md.length > 3500 ? md.slice(0, 3500) + "\n\n[…truncated…]" : md;
        return { text: `*${title}*\n\n${head}`, mediaRefs: [] };
      } catch (err) {
        if (err instanceof AuthError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: `Firecrawl-Scrape von \`${direct[0]}\` fehlgeschlagen.\n\nFehler: ${msg}`,
          mediaRefs: [],
        };
      }
    }

    // Path 3: research question → Qwen query → /v2/search → Qwen rank → scrape → Qwen compose.
    if (looksLikeResearchQuestion(prompt)) {
      return this.runResearch(prompt, ctx, apiKey, baseUrl, qwenBin, qwenModel);
    }

    // Path 2: free-form pick-one.
    let target: string | null = null;
    let planningNote: string | null = null;
    try {
      const pick = await askQwenForUrl(prompt, qwenBin, qwenModel);
      if (!pick.url) {
        return {
          text:
            `Qwen konnte zu deiner Anfrage keine passende URL finden.\n\n` +
            `Grund: ${pick.reason ?? "(keine Begründung)"}\n\n` +
            `Tipp: schick eine konkrete URL, z.B. \`scrape https://example.com\`.`,
          mediaRefs: [],
        };
      }
      target = pick.url;
      planningNote = pick.reason ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text:
          `Firecrawl braucht entweder eine URL im Prompt oder ein laufendes Qwen-CLI, ` +
          `um eine URL aus deiner Frage abzuleiten.\n\n` +
          `Fehler bei der Qwen-Planung: ${msg}`,
        mediaRefs: [],
      };
    }

    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/scrape`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Request-Id": ctx.requestId,
        },
        body: JSON.stringify({
          url: target,
          formats: ["markdown"],
          onlyMainContent: true,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          throw new AuthError("FIRECRAWL_API_KEY", this.name,
            `provider rejected key (HTTP ${res.status}). Rotate at https://firecrawl.dev`);
        }
        throw new Error(`firecrawl: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        data?: { markdown?: string; metadata?: { title?: string } };
      };
      const md = json.data?.markdown ?? "";
      const title = json.data?.metadata?.title ?? target;
      const head = md.length > 3500 ? md.slice(0, 3500) + "\n\n[…truncated…]" : md;
      const header = planningNote
        ? `*${title}*\n_Quelle gewählt von Qwen: ${target}_\n_Qwen-Grund: ${planningNote}_\n\n`
        : `*${title}*\n\n`;
      return { text: `${header}${head}`, mediaRefs: [] };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text: `Firecrawl-Scrape von \`${target}\` fehlgeschlagen.\n\nFehler: ${msg}`,
        mediaRefs: [],
      };
    }
  }

  private async runResearch(
    prompt: string,
    ctx: PromptContext,
    apiKey: string,
    baseUrl: string,
    qwenBin: string,
    qwenModel: string,
  ): Promise<Reply> {
    // Step 1: formulate a Google-style query.
    let query: string;
    try {
      query = await askQwenForQuery(prompt, qwenBin, qwenModel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text:
          `Firecrawl-Recherche braucht ein laufendes Qwen-CLI, um eine Suchanfrage ` +
          `aus deiner Frage abzuleiten.\n\n` +
          `Fehler bei der Suchanfrage-Planung: ${msg}`,
        mediaRefs: [],
      };
    }

    // Step 2: /v2/search.
    let searchJson: unknown;
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v2/search`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Request-Id": ctx.requestId ? `${ctx.requestId}-search` : "",
        },
        body: JSON.stringify({
          query,
          sources: ["web"],
          limit: SEARCH_LIMIT,
          scrapeOptions: { formats: [] },
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`firecrawl search: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
      }
      searchJson = await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text:
          `Firecrawl-Suche nach \`${query}\` fehlgeschlagen.\n\n` +
          `Fehler: ${msg}\n\n` +
          `Tipp: schick eine konkrete URL, z.B. \`scrape https://example.com\`.`,
        mediaRefs: [],
      };
    }

    const results = normaliseSearchResults(searchJson);
    if (results.length === 0) {
      return {
        text:
          `Firecrawl-Suche nach \`${query}\` hat keine Treffer geliefert.\n\n` +
          `Tipp: formuliere die Frage konkreter oder schick eine URL.`,
        mediaRefs: [],
      };
    }

    // Step 3: Qwen rank → picks. Falls back to top-N by source order.
    let picks: QwenRank[];
    try {
      picks = await askQwenForRanking(prompt, results, qwenBin, qwenModel);
    } catch (_err) {
      picks = results.slice(0, PICK_TOP_K).map((r) => ({ url: r.url, reason: r.title }));
    }
    if (picks.length === 0) {
      return {
        text:
          `Firecrawl hat ${results.length} Treffer für \`${query}\` gefunden, aber Qwen ` +
          `hält keinen davon für relevant.\n\n` +
          `Erste Treffer zum Anschauen:\n` +
          results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join("\n"),
        mediaRefs: [],
      };
    }

    // Step 4: scrape each chosen URL, bounded by MAX_TOTAL_CHARS.
    const sources: Array<{ url: string; title: string; reason: string | null; markdown: string }> = [];
    let total = 0;
    for (let i = 0; i < picks.length; i += 1) {
      const pick = picks[i];
      const remaining = Math.max(0, MAX_TOTAL_CHARS - total);
      if (remaining <= 200) break;
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/scrape`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-Request-Id": ctx.requestId ? `${ctx.requestId}-scrape-${i + 1}` : "",
          },
          body: JSON.stringify({
            url: pick.url,
            formats: ["markdown"],
            onlyMainContent: true,
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} — ${errText.slice(0, 200)}`);
        }
        const json = (await res.json()) as {
          data?: { markdown?: string; metadata?: { title?: string } };
        };
        const md = json.data?.markdown ?? "";
        const title = json.data?.metadata?.title ?? pick.url;
        const trimmed = md.length > remaining ? md.slice(0, remaining) + "\n\n[…gekürzt…]" : md;
        total += trimmed.length;
        sources.push({ url: pick.url, title, reason: pick.reason, markdown: trimmed });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sources.push({
          url: pick.url,
          title: pick.url,
          reason: pick.reason,
          markdown: `_Scrape fehlgeschlagen:_ ${msg}`,
        });
      }
    }

    // Step 5: Qwen compose.
    try {
      const text = await askQwenForComposition(prompt, sources, qwenBin, qwenModel);
      return { text: text || "Qwen hat eine leere Antwort zurückgegeben.", mediaRefs: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text:
          `Hier sind die gefundenen Quellen — ich konnte sie aber nicht zu einer Antwort ` +
          `zusammenfassen (Qwen-Compose-Fehler: ${msg}).\n\n` +
          sources
            .map((s, i) => `*${i + 1}. ${s.title}*\n${s.url}${s.reason ? `\n_Grund:_ ${s.reason}` : ""}\n${s.markdown.slice(0, 800)}`)
            .join("\n\n"),
        mediaRefs: [],
      };
    }
  }
}
