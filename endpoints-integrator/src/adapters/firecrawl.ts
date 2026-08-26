// =============================================================================
// Adapter: Firecrawl (web scrape + structured extraction) with Qwen planning.
//
// Per INFA-22, the Firecrawl WhatsApp group now accepts a *free-form* prompt
// instead of requiring a literal URL. The flow is:
//
//   1. Extract a URL directly from the prompt if one is present. This is the
//      fast path — no extra model call.
//   2. If no URL is present, ask the local Qwen CLI to pick a URL that best
//      answers the user's request. Qwen is told to reply with a single JSON
//      line `{"url":"https://…"}` (or `{"url":null,"reason":"…"}` if it
//      cannot pick a URL). We only accept a well-formed JSON response with a
//      parseable http(s) URL.
//   3. Call Firecrawl `/v1/scrape` with the resolved URL and return markdown
//      + metadata.
//
// The model produces *no* media; we return mediaRefs empty.
//
// Quirks:
//   - Two endpoints: /v1/scrape (single URL, sync) and /v1/crawl (multi-URL
//     async job). We use /v1/scrape because Infinity's group-by-group
//     interaction is per-message.
//   - Auth: `Authorization: Bearer <FIRECRAWL_API_KEY>`. Note: Firecrawl
//     historically accepted `X-Api-Key` too; Bearer is canonical now.
//   - Qwen runs as a local child process (`qwen -m … -p …`) — the same CLI
//     shape used by `dispatcher/qwen.js`. We shell out via `child_process`
//     to keep this adapter independent of the JS dispatcher's wiring.
//   - We deliberately do NOT base64-inject media into the prompt; if the
//     caller passed media paths in `ctx.mediaPaths`, we ignore them here
//     because the Firecrawl use case is plain URL → markdown.
//   - When Qwen itself fails (CLI missing, non-zero exit, bad JSON, no URL),
//     we surface a clear, operator-friendly message — we do NOT silently
//     fall back to a wrong URL.
// =============================================================================

import { spawn } from "node:child_process";
import type { EndpointAdapter, PromptContext, Reply } from "../types.js";
import { AuthError } from "../credentials.js";

const URL_RE = /\bhttps?:\/\/[^\s)\]]+/i;
const DEFAULT_QWEN_MODEL = "qwen3:30b-a3b";
const MAX_PROMPT_CHARS = 4_000; // bound the planning prompt we hand to Qwen
const PLANNING_TIMEOUT_MS = 30_000;

interface QwenPick {
  url: string | null;
  reason?: string;
}

/**
 * Ask the local Qwen CLI to pick a single URL that best answers the user's
 * prompt. Returns `{ url: null, reason }` if Qwen cannot decide.
 *
 * The prompt is intentionally strict: Qwen must reply with one JSON line
 * and nothing else. We strip fences/code blocks before parsing.
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

/**
 * Strip code fences / surrounding text and parse the first JSON object out
 * of Qwen's reply. Returns null if no valid object can be extracted.
 */
function parseQwenPick(raw: string): QwenPick | null {
  let text = (raw || "").trim();
  if (!text) return null;
  // Strip ```json fences if Qwen wrapped the JSON.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // Find the first {...} block.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const url = (obj as Record<string, unknown>).url;
  const reason = (obj as Record<string, unknown>).reason;
  if (url == null) {
    return { url: null, reason: typeof reason === "string" ? reason : undefined };
  }
  if (typeof url !== "string") return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, reason: typeof reason === "string" ? reason : undefined };
}

export class FirecrawlAdapter implements EndpointAdapter {
  readonly name = "firecrawl";

  async run(prompt: string, ctx: PromptContext): Promise<Reply> {
    const { apiKey, baseUrl } = ctx.credentials.firecrawl;
    if (!apiKey) throw new AuthError("FIRECRAWL_API_KEY", this.name,
      "issue a key at https://firecrawl.dev");

    // Fast path: prompt already contains a URL.
    let target: string | null = null;
    let planningNote: string | null = null;
    const direct = prompt.match(URL_RE);
    if (direct) {
      target = direct[0];
    } else {
      // Delegate the planning step to Qwen. We pull the binary / model name
      // from the same env vars dispatcher/qwen.js uses, so operators have
      // a single knob for both groups.
      const qwenBin = process.env.QWEN_BIN || "qwen";
      const qwenModel = process.env.QWEN_MODEL || DEFAULT_QWEN_MODEL;
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
    }

    const url = `${baseUrl.replace(/\/$/, "")}/v1/scrape`;
    const res = await fetch(url, {
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

    if (res.status === 401 || res.status === 403) {
      throw new AuthError("FIRECRAWL_API_KEY", this.name,
        `provider rejected key (HTTP ${res.status}). Rotate at https://firecrawl.dev`);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`firecrawl: HTTP ${res.status} ${res.statusText} — ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      data?: { markdown?: string; metadata?: { title?: string; description?: string } };
    };
    const md = json.data?.markdown ?? "";
    const title = json.data?.metadata?.title ?? target;
    const head = md.length > 3500 ? md.slice(0, 3500) + "\n\n[…truncated…]" : md;
    const header = planningNote
      ? `*${title}*\n_Quelle gewählt von Qwen: ${target}_\n_Qwen-Grund: ${planningNote}_\n\n`
      : `*${title}*\n\n`;
    return {
      text: `${header}${head}`,
      mediaRefs: [],
    };
  }
}
