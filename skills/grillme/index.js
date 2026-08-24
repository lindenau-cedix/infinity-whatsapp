// skills/grillme/index.js
//
// Grill Me: skill — detects the "Grill Me:" prefix, asks Qwen which
// clarification questions would unblock the answer, and delivers them
// back as WhatsApp polls (Umfrage in German). On user answers, the
// answers are routed back to Qwen alongside the original prompt and
// the final reply is returned as plain text.
//
// Public surface:
//   stripGrillMePrefix(message)
//   runGrillMe({ promptText, ctx, sendPoll, sendText, qwen })
//
// Dependencies (injected so this module is unit-testable):
//   qwen.run(prompt, ctx) -> Promise<{ text: string }>
//   sendPoll(chatId, { question, options, multiSelect }) -> Promise<void>
//   sendText(chatId, text) -> Promise<void>
//
// WhatsApp hard limit: a poll may carry at most 12 options. We deliver
// one question per poll (2-4 options each), so each poll is well under
// that limit, but the design also documents the splitting rule for
// future skills that may produce longer option lists.

'use strict';

const { buildMetaPrompt } = require('./metaPrompt');
const { parseQuestions, GrillMeParseError } = require('./parser');

const PREFIX_REGEX = /^\s*Grill\s*Me\s*:\s*/i;

/**
 * Strip the "Grill Me:" prefix (case-insensitive) from a message body.
 * Returns the trimmed remainder or null when the prefix is absent.
 */
function stripGrillMePrefix(message) {
  if (typeof message !== 'string') return null;
  const match = message.match(PREFIX_REGEX);
  if (!match) return null;
  return message.slice(match[0].length).trim();
}

/**
 * Build a numbered fallback text for a question when poll delivery
 * fails. Used when `sendPoll` rejects (e.g. WhatsApp rate-limit, missing
 * poll capability in a private chat).
 */
function formatQuestionAsText(question, index) {
  const head = `${index + 1}. ${question.text}`;
  const lines = question.options.map((opt, i) => `   ${String.fromCharCode(97 + i)}) ${opt}`);
  return [head, ...lines].join('\n');
}

/**
 * Send a single question as a WhatsApp poll. Falls back to a numbered
 * text list when `sendPoll` rejects or is not provided.
 *
 * Returns { deliveredAs: 'poll' | 'text', pollCount } so callers can
 * log delivery mode without scraping logs.
 */
async function deliverQuestion(question, index, total, ctx, sendPoll, sendText) {
  const header = total > 1 ? `(${index + 1}/${total}) ` : '';
  const pollName = `${header}${question.text}`;
  // whatsapp-web.js limits poll names to ~255 chars; defensively truncate.
  const safePollName = pollName.length > 255 ? `${pollName.slice(0, 252)}...` : pollName;

  if (typeof sendPoll === 'function') {
    try {
      await sendPoll(ctx.chatId, {
        question: safePollName,
        options: question.options,
        // WhatsApp polls support multi-select; the Grill-me flow is
        // single-select by intent (user picks one answer per question).
        multiSelect: false,
      });
      return { deliveredAs: 'poll', pollCount: 1 };
    } catch (err) {
      // Fall through to text fallback.
      // eslint-disable-next-line no-console
      console.warn(`[grillme] sendPoll failed, falling back to text: ${err.message}`);
    }
  }
  const body = formatQuestionAsText(question, index);
  await sendText(ctx.chatId, body);
  return { deliveredAs: 'text', pollCount: 0 };
}

/**
 * Deliver parsed questions as polls, splitting per the WhatsApp 12-option
 * hard limit. The current schema caps each question at 4 options, so a
 * single poll per question is always sufficient; the splitting rule is
 * documented and tested for the broader case (e.g. an upgraded schema
 * with up to 12 options per question).
 *
 * @returns {Promise<{ polls: Array<{ id: string, deliveredAs: 'poll'|'text' }> }>}
 */
async function deliverPolls(questions, ctx, sendPoll, sendText) {
  // Each question is its own poll because they are independent choices.
  // We still group them so a single pagination header tracks them.
  const polls = [];
  for (let i = 0; i < questions.length; i++) {
    const result = await deliverQuestion(questions[i], i, questions.length, ctx, sendPoll, sendText);
    polls.push({ id: questions[i].id, deliveredAs: result.deliveredAs });
  }
  return { polls };
}

/**
 * Route the user's poll answers back to Qwen alongside the original
 * prompt. Returns the final assistant reply as text.
 *
 * @param {string} originalPrompt
 * @param {Array<{ id: string, text: string, options: string[], answer: string | string[] }>} answered
 * @param {Object} ctx
 * @param {{ run: (prompt: string, ctx: Object) => Promise<{ text: string }> }} qwen
 * @returns {Promise<{ text: string }>}
 */
async function finalizeWithAnswers(originalPrompt, answered, ctx, qwen) {
  const lines = answered.map((a) => {
    const ans = Array.isArray(a.answer) ? a.answer.join(', ') : a.answer;
    return `- ${a.text}\n    Antwort: ${ans}`;
  }).join('\n');
  const finalPrompt = [
    'Ursprüngliche Aufgabe des Nutzers:',
    originalPrompt,
    '',
    'Beantwortete Rückfragen:',
    lines,
    '',
    'Liefere jetzt die endgültige Antwort auf Deutsch.',
  ].join('\n');
  return qwen.run(finalPrompt, ctx);
}

/**
 * Run the Grill-me skill.
 *
 * @param {Object} args
 * @param {string} args.promptText              The user's full message body (must start with "Grill Me:").
 * @param {Object} args.ctx                     Runtime context (chatId, senderId, locale, ...).
 * @param {(chatId: string, payload: { question: string, options: string[], multiSelect: boolean }) => Promise<void>} [args.sendPoll]
 * @param {(chatId: string, text: string) => Promise<void>} args.sendText
 * @param {{ run: (prompt: string, ctx: Object) => Promise<{ text: string }> }} args.qwen
 * @param {Array<{ id: string, text: string, options: string[], answer: string | string[] }>} [args.answeredQuestions]
 *        When the user answers a previous round, pass their answers here
 *        to skip the question-generation step and finalize the reply.
 * @returns {Promise<{ stage: 'questions'|'finalized'|'skipped', polls?: Array, text?: string }>}
 */
async function runGrillMe(args) {
  const { promptText, ctx, sendPoll, sendText, qwen, answeredQuestions } = args || {};
  if (!ctx || typeof ctx.chatId !== 'string') {
    throw new TypeError('runGrillMe: ctx.chatId is required');
  }
  if (typeof sendText !== 'function') {
    throw new TypeError('runGrillMe: sendText is required');
  }
  if (!qwen || typeof qwen.run !== 'function') {
    throw new TypeError('runGrillMe: qwen.run is required');
  }

  // Re-entry path: the user has answered our previous round of polls.
  if (Array.isArray(answeredQuestions) && answeredQuestions.length > 0) {
    const originalPrompt = (args && args.originalPrompt) || '';
    if (!originalPrompt) {
      throw new Error('runGrillMe: answeredQuestions provided without originalPrompt');
    }
    const final = await finalizeWithAnswers(originalPrompt, answeredQuestions, ctx, qwen);
    await sendText(ctx.chatId, final.text);
    return { stage: 'finalized', text: final.text };
  }

  // Initial path: strip the prefix and ask Qwen what it needs.
  const stripped = stripGrillMePrefix(promptText);
  if (stripped === null) {
    // The dispatcher should not have invoked us without the prefix.
    // Surface the situation as a plain text reply and exit cleanly.
    await sendText(ctx.chatId, 'Hinweis: Dieser Skill erwartet das Präfix „Grill Me:".');
    return { stage: 'skipped' };
  }

  const metaPrompt = buildMetaPrompt(stripped);
  const qwenReply = await qwen.run(metaPrompt, ctx);
  let questions;
  try {
    questions = parseQuestions(qwenReply.text);
  } catch (err) {
    if (err instanceof GrillMeParseError) {
      await sendText(
        ctx.chatId,
        'Konnte die Rückfragen von Qwen nicht verarbeiten. Bitte formuliere deine Anfrage konkreter.'
      );
      return { stage: 'skipped' };
    }
    throw err;
  }

  const { polls } = await deliverPolls(questions, ctx, sendPoll, sendText);
  return { stage: 'questions', polls, originalPrompt: stripped };
}

module.exports = {
  stripGrillMePrefix,
  runGrillMe,
  deliverPolls,
  formatQuestionAsText,
  // Re-exported for convenience / tests.
  buildMetaPrompt,
  parseQuestions,
  GrillMeParseError,
};