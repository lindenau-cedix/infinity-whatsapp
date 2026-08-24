// =============================================================================
// PaperclipBridge — the two-direction orchestrator that the WhatsApp
// dispatcher (owned by Integrator / Tech Lead) talks to.
//
//   1. Outbound events  → mirror WhatsApp activity as Paperclip comments:
//        bridge.emit({ kind: "message.received", group, messageId, ... })
//        bridge.emit({ kind: "message.replied",  group, messageId, ... })
//        bridge.emit({ kind: "poll.created",    group, pollId, ... })
//        bridge.emit({ kind: "error",           group, messageId, ... })
//
//   2. Inbound commands → parse a /paperclip … body and produce a
//        `BridgeResult` that the dispatcher hands back to the group:
//
//          bridge.handle(body, ctx) → {
//            handled: true | false,
//            reply?:   "Paperclip: …",       // shown in the chat
//            error?:   { code, message },    // user-visible error
//            paperclipEvent?: { ... },       // what got posted on the issue
//          }
//
// Default policy: events are only attached to EXISTING issues. The caller
// passes `defaultIssueId` (or per-event `issueId`) — without one, the event
// is logged as "skipped" and no Paperclip call is made.
//
// The bridge does NOT mutate the message pipeline or the reply dispatcher.
// It only consumes messages and emits results.
// =============================================================================

import { PaperclipClient, renderEventBody } from "./client.js";
import {
  parseCommand,
  isPaperclipCommand,
  HELP_TEXT,
} from "./commands.js";
import {
  PaperclipAuthError,
  PaperclipCommandError,
  PaperclipError,
} from "./errors.js";

const KNOWN_EVENT_KINDS = new Set([
  "message.received",
  "message.replied",
  "poll.created",
  "error",
  "lifecycle.startup",
  "lifecycle.error",
  "group.registration",
  "whatsapp.message",
]);

/**
 * @typedef {object} BridgeOptions
 * @property {PaperclipClient} [client]
 * @property {string} [defaultIssueId]  Attach non-targeted events here.
 *                                     If absent, events without explicit
 *                                     issueId are dropped (default policy).
 * @property {(issueId: string) => Promise<object>} [getIssue]  Used by status cmd.
 *                                     Defaults to `client._request("GET", /api/issues/{id})`.
 * @property {boolean} [silenceAuthErrors]  If true, swallow auth errors from
 *                                     outbound emit() — log only. Default false.
 */

export class PaperclipBridge {
  /** @param {BridgeOptions} [opts] */
  constructor(opts = {}) {
    this.client = opts.client ?? new PaperclipClient();
    this.defaultIssueId = opts.defaultIssueId ?? null;
    this.getIssue = opts.getIssue ?? defaultGetIssue(this.client);
    this.silenceAuthErrors = !!opts.silenceAuthErrors;
  }

  // ---- outbound --------------------------------------------------------------

  /**
   * Mirror a single event. Returns `{ status, ... }`; never throws on auth
   * errors when `silenceAuthErrors` is set, otherwise bubbles.
   *
   * @param {object} ev
   * @returns {Promise<{ status: string } & Record<string, any>>}
   */
  async emit(ev) {
    if (!ev || !KNOWN_EVENT_KINDS.has(ev.kind)) {
      // Unknown event kinds are silently dropped; the bridge shouldn't
      // throw every time a future adapter invents a new event name.
      return { status: "unknown_kind", kind: ev?.kind };
    }
    const issueId = ev.issueId ?? this.defaultIssueId;
    try {
      const result = await this.client.logEvent({ ...ev, issueId });
      return result;
    } catch (e) {
      if (e instanceof PaperclipAuthError && this.silenceAuthErrors) {
        return { status: "auth_error_silenced", error: e.message };
      }
      throw e;
    }
  }

  /**
   * Convenience: emit many events, swallowing transient errors per-event.
   * Returns `{ ok: number, failed: number }`.
   *
   * @param {object[]} events
   */
  async emitBatch(events) {
    let ok = 0, failed = 0;
    for (const ev of events) {
      try {
        await this.emit(ev);
        ok++;
      } catch (e) {
        failed++;
      }
    }
    return { ok, failed };
  }

  // ---- inbound ---------------------------------------------------------------

  /**
   * Decide whether a WhatsApp message body is a Paperclip slash command.
   * @param {string} body
   * @returns {boolean}
   */
  isCommand(body) { return isPaperclipCommand(body); }

  /**
   * Parse and execute a slash command. Result shape:
   *
   *   { handled: true,  reply: "Paperclip: …", paperclipEvent?: { ... } }
   *   { handled: true,  reply: "Paperclip: …", error: { code, message } }
   *   { handled: false }                          // not a bridge command
   *
   * On success, the dispatcher renders `reply` as a normal message in the
   * originating group. On parse error, `reply` is also set so the user
   * sees what they did wrong; `error.code === "paperclip_command"`.
   *
   * @param {string} body
   * @param {{ group?: string, messageId?: string }} [ctx]
   * @returns {Promise<{
   *   handled: boolean,
   *   reply?: string,
   *   error?: { code: string, message: string },
   *   paperclipEvent?: object,
   * }>}
   */
  async handle(body, ctx = {}) {
    if (!this.isCommand(body)) return { handled: false };

    let parsed;
    try {
      parsed = parseCommand(body);
    } catch (e) {
      if (e instanceof PaperclipCommandError) {
        return {
          handled: true,
          reply: `Paperclip: ${e.message}\n\n${HELP_TEXT}`,
          error: { code: e.code, message: e.message },
        };
      }
      throw e;
    }

    try {
      switch (parsed.verb) {
        case "help":
          return { handled: true, reply: `Paperclip: ${HELP_TEXT}` };

        case "new": {
          const created = await this.client.createIssue({
            title: parsed.title,
            body: `Opened from WhatsApp group \`${ctx.group ?? "?"}\``,
          });
          return {
            handled: true,
            reply: `Paperclip: neues Issue angelegt — ${formatRef(created)}`,
            paperclipEvent: { kind: "issue.created", issueId: created.id },
          };
        }

        case "status": {
          const issue = await this.getIssue(parsed.issueRef);
          const statusLine = formatIssueStatus(issue);
          // Mirror the status check onto the issue as a comment (idempotent
          // for repeats within 60 s by the client's LRU).
          const eventResult = await this.client.logEvent({
            kind: "message.received",
            group: ctx.group,
            messageId: ctx.messageId,
            issueId: issue?.id,
            body: `### status check — ${new Date().toISOString()}\n\n${statusLine}`,
          });
          return {
            handled: true,
            reply: `Paperclip: ${statusLine}`,
            paperclipEvent: eventResult,
          };
        }

        case "comment": {
          // Look up first so we have a canonical id, then comment.
          const issue = await this.getIssue(parsed.issueRef);
          const posted = await this.client.comment(
            issue?.id ?? parsed.issueRef, parsed.body);
          return {
            handled: true,
            reply: `Paperclip: Kommentar an ${formatRef(issue)} gesendet.`,
            paperclipEvent: { kind: "message.received", issueId: issue?.id, comment: posted },
          };
        }
      }
    } catch (e) {
      if (e instanceof PaperclipError) {
        return {
          handled: true,
          reply: `Paperclip: Fehler — ${e.message}`,
          error: { code: e.code, message: e.message },
        };
      }
      throw e;
    }

    // Unreachable.
    return { handled: false };
  }
}

// --- helpers ----------------------------------------------------------------

function defaultGetIssue(client) {
  return async (ref) => {
    if (!ref) throw new PaperclipCommandError("Issue-Referenz fehlt");
    const id = ref.includes(":") || ref.includes("-")
      ? ref
      : ref; // trust whatever the caller passed (uuid or identifier like INFA-11)
    return await client._request("GET", `/api/issues/${id}`);
  };
}

function formatRef(issue) {
  if (!issue) return "<unknown>";
  return issue.identifier ? `${issue.identifier} (${issue.id})` : issue.id;
}

function formatIssueStatus(issue) {
  if (!issue) return "<unknown>";
  const id = issue.identifier ?? issue.id ?? "?";
  const title = issue.title ?? "(no title)";
  const status = issue.status ?? "unknown";
  const assignee = issue.assigneeAgentId ?? "unassigned";
  return `${id} is ${status} — ${title} (assignee: ${assignee})`;
}