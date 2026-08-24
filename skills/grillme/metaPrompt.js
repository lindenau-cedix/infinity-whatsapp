// skills/grillme/metaPrompt.js
//
// German-language meta-prompt sent to Qwen to elicit structured
// clarification questions for a user's underlying prompt. The response
// shape is JSON-only; the parser (parser.js) tolerates either pure JSON
// or a JSON block wrapped in ```json fences.

'use strict';

// Hard caps match the issue acceptance criteria:
//   * 2-4 questions total
//   * 2-4 options per question
// The WhatsApp hard limit on poll options is 12; the poll-splitter in
// index.js respects that limit and subdivides further if needed.
const QUESTIONS_MIN = 2;
const QUESTIONS_MAX = 4;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 4;

const META_PROMPT_TEMPLATE = `Du bist ein Assistent, der Rueckfragen stellt, bevor er eine Aufgabe loest.

Aufgabe des Nutzers (verbatim):
"""
{userPrompt}
"""

Liefere ausschliesslich JSON (kein Fliesstext, keine Markdown-Einleitung) im exakt folgenden Schema:

{{
  "questions": [
    {{
      "id": "q1",
      "text": "Frage auf Deutsch, kurz und neutral formuliert",
      "options": ["Option A", "Option B", "Option C"]
    }}
  ]
}}

Regeln:
- Liefere genau {questionsMin}-{questionsMax} Fragen.
- Jede Frage hat genau {optionsMin}-{optionsMax} Antwortoptionen.
- Die Fragen und Optionen sind auf Deutsch.
- Die Optionen sind kurz (maximal 60 Zeichen), gegenseitig ausschliessend und zusammen abdeckend.
- Wenn die Aufgabe des Nutzers eindeutig ist, liefere trotzdem die {questionsMin} sinnvollsten Rueckfragen, die das Ergebnis praeziser machen.
- Antworte NUR mit dem JSON-Objekt.`;

/**
 * Build the German meta-prompt sent to Qwen.
 * @param {string} userPrompt The user's original prompt (without the "Grill Me:" prefix).
 * @returns {string} The rendered meta-prompt.
 */
function buildMetaPrompt(userPrompt) {
  if (typeof userPrompt !== 'string') {
    throw new TypeError('userPrompt must be a string');
  }
  const trimmed = userPrompt.trim();
  if (!trimmed) {
    throw new Error('userPrompt must not be empty');
  }
  // Build the template once per process so we don't re-render the static
  // string on every invocation.
  if (!buildMetaPrompt._rendered) {
    buildMetaPrompt._rendered = META_PROMPT_TEMPLATE
      .replaceAll('{questionsMin}', String(QUESTIONS_MIN))
      .replaceAll('{questionsMax}', String(QUESTIONS_MAX))
      .replaceAll('{optionsMin}', String(OPTIONS_MIN))
      .replaceAll('{optionsMax}', String(OPTIONS_MAX));
  }
  return buildMetaPrompt._rendered.replace('{userPrompt}', trimmed);
}

module.exports = {
  buildMetaPrompt,
  QUESTIONS_MIN,
  QUESTIONS_MAX,
  OPTIONS_MIN,
  OPTIONS_MAX,
};