# Grill Me: Skill (`skills/grillme`)

Implements the **Grill Me:** skill of **Infinity WhatsApp Services Corp.**
When a WhatsApp message starts with `Grill Me:` (case-insensitive), Qwen is
asked what additional information it needs to answer well, and the resulting
clarification questions are delivered to the user as one or more WhatsApp
polls (`Umfrage` in German).

---

## User Flow — Deutsch

1. **Trigger.** Der Nutzer sendet eine Nachricht, die mit `Grill Me:` beginnt
   (Groß-/Kleinschreibung egal), z. B. `Grill Me: Plane einen Science-Fiction Roman.`
2. **Skill-Aktivierung.** Der WhatsApp-Client erkennt das Präfix und ruft
   `runGrillMe` aus `skills/grillme/index.js` auf. Das Präfix wird entfernt;
   der verbleibende Text ist die eigentliche Aufgabe.
3. **Meta-Prompt an Qwen.** Der Skill baut einen deutschen Meta-Prompt
   (`metaPrompt.js`), der Qwen anweist, ausschließlich JSON mit 2–4
   Klärungsfragen zu liefern. Jede Frage hat 2–4 Antwortoptionen auf Deutsch.
4. **Parser.** Der Parser (`parser.js`) validiert die Qwen-Antwort:
   - 2–4 Fragen insgesamt
   - 2–4 Optionen je Frage
   - Optionen ≤ 60 Zeichen, nicht leer
   - JSON darf pur, in ` ```json `-Fences oder mit etwas Prosa drumherum kommen
5. **Umfrage-Versand.** Jede Frage wird als eigene WhatsApp-Umfrage
   (`multiSelect: false`) im ursprünglichen Chat verschickt. Bei mehreren
   Fragen wird der Poll-Name mit `(1/N)` … `(N/N)` paginiert.
6. **Fallback.** Wenn `sendPoll` fehlschlägt (z. B. Rate-Limit, kein
   Poll-Support im privaten Chat), wird die Frage als nummerierte Textliste
   (`1. …`, `   a) …`) per `sendText` zugestellt.
7. **Re-Entry.** Antwortet der Nutzer auf die Umfragen, ruft der
   ReplyDispatcher den Skill erneut auf und übergibt die Antworten als
   `answeredQuestions`. Der Skill schickt sie gemeinsam mit der ursprünglichen
   Aufgabe an Qwen und gibt die endgültige Antwort als Text zurück.

## User Flow — English

1. **Trigger.** User sends a WhatsApp message starting with `Grill Me:`
   (case-insensitive), e.g. `Grill Me: Plan a science-fiction novel.`
2. **Skill activation.** The WhatsApp client detects the prefix and calls
   `runGrillMe` from `skills/grillme/index.js`. The prefix is stripped;
   the remaining text is the underlying task.
3. **Meta-prompt to Qwen.** The skill builds a German meta-prompt
   (`metaPrompt.js`) instructing Qwen to return only JSON with 2–4
   clarification questions. Each question has 2–4 answer options in German.
4. **Parser.** The parser (`parser.js`) validates Qwen's response:
   - 2–4 questions total
   - 2–4 options per question
   - Options ≤ 60 characters, non-empty
   - JSON may be pure, fenced in ` ```json `, or wrapped with stray prose
5. **Poll delivery.** Each question is sent as its own WhatsApp poll
   (`multiSelect: false`) in the originating chat. With multiple questions
   the poll name is paginated as `(1/N)` … `(N/N)`.
6. **Fallback.** When `sendPoll` fails (e.g. rate limit, poll unsupported
   in a private chat) the question is delivered as a numbered text list
   (`1. …`, `   a) …`) via `sendText`.
7. **Re-entry.** When the user answers the polls, the ReplyDispatcher
   re-invokes the skill with the answers as `answeredQuestions`. The skill
   sends them together with the original task to Qwen and returns the
   final reply as plain text.

---

## API Surface

```js
const {
  runGrillMe,
  stripGrillMePrefix,
} = require('./skills/grillme');

// Initial round:
const result = await runGrillMe({
  promptText: 'Grill Me: Plane einen Roman',
  ctx: { chatId: '120363@g.us' },
  qwen: qwenAdapter,         // { run(prompt, ctx) -> Promise<{ text }> }
  sendPoll: chatApi.sendPoll, // optional; fallback to sendText on failure
  sendText: chatApi.sendText, // required
});
// result.stage === 'questions' | 'skipped'
// result.originalPrompt — task body without the prefix
// result.polls — [{ id, deliveredAs: 'poll' | 'text' }, ...]

// Re-entry after user answers:
const final = await runGrillMe({
  promptText: '',
  ctx: { chatId: '120363@g.us' },
  originalPrompt: 'Plane einen Roman',
  answeredQuestions: [
    { id: 'q1', text: 'Genre?', options: ['Roman', 'Erzählung'], answer: 'Roman' },
    { id: 'q2', text: 'Zielgruppe?', options: ['Kinder', 'Erwachsene'], answer: 'Erwachsene' },
  ],
  qwen: qwenAdapter,
  sendText: chatApi.sendText,
});
// final.stage === 'finalized', final.text is the assistant reply
```

`stripGrillMePrefix(message)` returns the trimmed remainder when the
message starts with `Grill Me:` (case-insensitive, any whitespace after
the colon), or `null` otherwise.

---

## Qwen System Prompt (German)

The exact German meta-prompt template lives in `metaPrompt.js` and
contains these rules:

- Liefere genau 2–4 Fragen.
- Jede Frage hat genau 2–4 Antwortoptionen.
- Die Fragen und Optionen sind auf Deutsch.
- Die Optionen sind kurz (maximal 60 Zeichen), gegenseitig ausschliessend
  und zusammen abdeckend.
- Wenn die Aufgabe des Nutzers eindeutig ist, liefere trotzdem die
  sinnvollsten Rückfragen.
- Antworte **nur** mit dem JSON-Objekt (kein Fliesstext, kein Markdown-Prose).

The expected response shape:

```json
{
  "questions": [
    { "id": "q1", "text": "Frage auf Deutsch", "options": ["A", "B", "C"] },
    { "id": "q2", "text": "Frage auf Deutsch", "options": ["A", "B"] }
  ]
}
```

---

## Poll-Splitting Rules

- **One question per poll.** Each parsed question becomes its own WhatsApp
  poll so the user answers them independently.
- **Pagination header.** When more than one question is delivered, each
  poll's question text is prefixed with `(i/N)` to indicate order. With a
  single question the header is omitted.
- **WhatsApp hard limit.** A WhatsApp poll supports at most **12 options**.
  The current schema caps questions at 4 options, so a single poll is
  always sufficient. The splitting helper in `index.js` is structured so
  that an upgraded schema (e.g. up to 12 options per question) can still
  fit comfortably without further changes.
- **Fallback.** If `sendPoll` throws, the same question is re-delivered as
  a numbered text list via `sendText`. The fallback preserves question
  ordering and labels; the user sees either a poll or a text list, never
  both.

---

## Tests

Run the unit tests with Node's built-in test runner:

```bash
node --test skills/grillme/grillme.test.js
```

The suite (25 tests) covers:

- Prefix detection (canonical form, case/whitespace tolerance, missing prefix)
- Meta-prompt template (German output, count hints, input validation)
- Parser (pure JSON, fenced JSON, stray prose, count/option bounds,
  empty/oversize options, malformed input)
- Poll delivery (single-poll delivery, sendPoll failure fallback,
  no-sendPoll text fallback, numbering helper)
- End-to-end `runGrillMe` (happy path, missing prefix, unparseable Qwen
  response, re-entry with answers, dependency validation)

All Qwen responses are mocked — no network access required.

---

## Boundaries (per AGENTS.md)

- Do NOT call Perplexity or Firecrawl.
- Do NOT do transcription, TTS, or media path injection.
- Grill-me is a Qwen-only flow.

---

## Coordination Hooks

- The Endpoints Integrator owns the Qwen `EndpointAdapter`. This skill
  consumes the dispatcher via the `qwen.run(prompt, ctx)` injection —
  it does **not** import the adapter directly.
- The Integrator / Tech Lead (ReplyDispatcher) is responsible for
  detecting the `Grill Me:` prefix, calling `runGrillMe`, and
  re-invoking with `answeredQuestions` when the user replies to the
  delivered polls.