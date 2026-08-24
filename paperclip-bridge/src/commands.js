// =============================================================================
// Slash-command parser.
//
// Grammar (case-insensitive on the verb):
//
//   /paperclip status <ISSUE-OR-UUID>            → look up and post status as comment
//   /paperclip comment <ISSUE-OR-UUID> <body...> → add comment with body
//   /paperclip new <title...>                    → create new issue (opt-in)
//   /paperclip help                              → usage text
//
// Accepted prefixes (mirrors real-world WhatsApp):
//   /paperclip …  | paperclip: …  | @paperclip …
//
// The bridge itself only needs to *recognize* and *parse* the command —
// dispatching the result back to the group is the message pipeline's job
// (owned by Integrator / Tech Lead).
// =============================================================================

import { PaperclipCommandError } from "./errors.js";

const PREFIXES = [/^\s*\/?paperclip[:\s]+/i, /^\s*@paperclip[:\s]+/i];

export const KNOWN_COMMANDS = ["status", "comment", "new", "help"];

/**
 * Detect whether a body is a slash command for the Paperclip bridge.
 * @param {string} body
 * @returns {boolean}
 */
export function isPaperclipCommand(body) {
  if (typeof body !== "string") return false;
  return PREFIXES.some((rx) => rx.test(body));
}

/**
 * Parse a command body into a structured action. Throws PaperclipCommandError
 * on unknown / malformed input.
 *
 * @param {string} body
 * @returns {{ verb: "status"|"comment"|"new"|"help", issueRef?: string, body?: string, title?: string, raw: string }}
 */
export function parseCommand(body) {
  if (typeof body !== "string" || body.length === 0) {
    throw new PaperclipCommandError("Leere Nachricht");
  }
  const stripped = stripPrefix(body);
  if (!stripped) {
    throw new PaperclipCommandError("Erwarte einen Befehl nach /paperclip");
  }

  const tokens = stripped.split(/\s+/);
  const verb = (tokens.shift() || "").toLowerCase();
  if (!KNOWN_COMMANDS.includes(verb)) {
    throw new PaperclipCommandError(`Unbekannter Befehl: ${verb}`);
  }

  switch (verb) {
    case "help":
      return { verb: "help", raw: body };

    case "status": {
      const ref = tokens.shift();
      if (!ref) throw new PaperclipCommandError("/paperclip status <ISSUE>");
      return { verb: "status", issueRef: ref, raw: body };
    }

    case "comment": {
      const ref = tokens.shift();
      if (!ref) throw new PaperclipCommandError(
        "/paperclip comment <ISSUE> <body...>");
      const rest = tokens.join(" ").trim();
      if (!rest) throw new PaperclipCommandError(
        "/paperclip comment: leerer Kommentar");
      return { verb: "comment", issueRef: ref, body: rest, raw: body };
    }

    case "new": {
      const title = tokens.join(" ").trim();
      if (!title) throw new PaperclipCommandError("/paperclip new <title>");
      return { verb: "new", title, raw: body };
    }
  }
}

function stripPrefix(body) {
  for (const rx of PREFIXES) {
    const m = body.match(rx);
    if (m) return body.slice(m[0].length).trim();
  }
  return null;
}

/**
 * Usage text returned for /paperclip help. Stable for the demo script.
 */
export const HELP_TEXT = [
  "*Paperclip-Bridge Befehle*",
  "",
  "• `/paperclip status <ISSUE>` — Status eines Issues abrufen",
  "• `/paperclip comment <ISSUE> <body>` — Kommentar an ein Issue anhängen",
  "• `/paperclip new <title>` — Neues Issue erstellen",
  "• `/paperclip help` — diese Hilfe",
  "",
  "Akzeptiert auch `paperclip:` und `@paperclip` als Präfix.",
  "Antwort erscheint als `Paperclip: …`.",
].join("\n");