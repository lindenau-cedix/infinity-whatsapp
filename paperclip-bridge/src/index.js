// =============================================================================
// Public barrel.
//
//   import { PaperclipClient, PaperclipBridge, createClient,
//            parseCommand, isPaperclipCommand, HELP_TEXT,
//            PaperclipError, PaperclipAuthError,
//            PaperclipTransientError, PaperclipProtocolError,
//            PaperclipCommandError } from "infinity-paperclip-bridge";
//
// Defaults: nothing is created on import. `createClient()` and
// `new PaperclipBridge()` are explicit so tests can inject a fake fetch.
// =============================================================================

export { PaperclipClient, createClient, renderEventBody } from "./client.js";
export { PaperclipBridge } from "./bridge.js";
export {
  parseCommand,
  isPaperclipCommand,
  HELP_TEXT,
  KNOWN_COMMANDS,
} from "./commands.js";
export {
  PaperclipError,
  PaperclipAuthError,
  PaperclipTransientError,
  PaperclipProtocolError,
  PaperclipCommandError,
} from "./errors.js";