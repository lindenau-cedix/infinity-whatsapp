// skills/grillme/grillme.test.js
//
// Node built-in test runner (node --test). No external deps.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMetaPrompt, QUESTIONS_MIN, QUESTIONS_MAX, OPTIONS_MIN, OPTIONS_MAX } =
  require('./metaPrompt');
const {
  parseQuestions,
  stripJsonFences,
  extractJsonObject,
  GrillMeParseError,
} = require('./parser');
const {
  stripGrillMePrefix,
  runGrillMe,
  deliverPolls,
  formatQuestionAsText,
} = require('./index');

// ---------------------------------------------------------------------------
// Prefix detection
// ---------------------------------------------------------------------------

test('stripGrillMePrefix handles the canonical form', () => {
  assert.equal(stripGrillMePrefix('Grill Me: Hilf mir einen Roman zu planen'), 'Hilf mir einen Roman zu planen');
});

test('stripGrillMePrefix is case-insensitive and tolerates whitespace', () => {
  assert.equal(stripGrillMePrefix('grill me:   bau eine App'), 'bau eine App');
  assert.equal(stripGrillMePrefix('  GRILL ME:foo'), 'foo');
  assert.equal(stripGrillMePrefix('GrillMe:bar'), 'bar');
});

test('stripGrillMePrefix returns null when prefix is missing', () => {
  assert.equal(stripGrillMePrefix('Plane einen Roman'), null);
  assert.equal(stripGrillMePrefix('Hello world'), null);
  assert.equal(stripGrillMePrefix(''), null);
  assert.equal(stripGrillMePrefix(null), null);
});

test('stripGrillMePrefix returns the trimmed remainder', () => {
  assert.equal(stripGrillMePrefix('Grill Me:    \n  Eine Aufgabe  \n  '), 'Eine Aufgabe');
});

// ---------------------------------------------------------------------------
// Meta-prompt template
// ---------------------------------------------------------------------------

test('buildMetaPrompt embeds the user prompt in a fenced block', () => {
  const prompt = buildMetaPrompt('Plane einen Science-Fiction Roman.');
  assert.match(prompt, /Plane einen Science-Fiction Roman\./);
  assert.match(prompt, /"""/);
  // Counts are surfaced so Qwen knows the expected size.
  assert.match(prompt, new RegExp(`genau ${QUESTIONS_MIN}-${QUESTIONS_MAX} Fragen`));
  assert.match(prompt, new RegExp(`genau ${OPTIONS_MIN}-${OPTIONS_MAX} Antwortoptionen`));
});

test('buildMetaPrompt rejects empty or non-string input', () => {
  assert.throws(() => buildMetaPrompt(''), /must not be empty/);
  assert.throws(() => buildMetaPrompt('   \n  '), /must not be empty/);
  assert.throws(() => buildMetaPrompt(null), TypeError);
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const VALID_RESPONSE = JSON.stringify({
  questions: [
    { id: 'q1', text: 'Welches Genre?', options: ['Roman', 'Erzählung', 'Drehbuch'] },
    { id: 'q2', text: 'Welche Zielgruppe?', options: ['Kinder', 'Jugendliche', 'Erwachsene'] },
    { id: 'q3', text: 'Welche Länge?', options: ['Kurz', 'Mittel', 'Lang'] },
  ],
});

test('parseQuestions accepts pure JSON', () => {
  const out = parseQuestions(VALID_RESPONSE);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].options, ['Roman', 'Erzählung', 'Drehbuch']);
  assert.equal(out[1].id, 'q2');
});

test('parseQuestions accepts fenced ```json``` blocks', () => {
  const fenced = 'Hier kommt die Antwort:\n\n```json\n' + VALID_RESPONSE + '\n```\n\nFertig.';
  const out = parseQuestions(fenced);
  assert.equal(out.length, 3);
  assert.equal(out[2].text, 'Welche Länge?');
});

test('parseQuestions tolerates stray prose around the JSON object', () => {
  const noisy = 'Antwort:\n' + VALID_RESPONSE + '\nEnde.';
  const out = parseQuestions(noisy);
  assert.equal(out.length, 3);
});

test('parseQuestions rejects responses with too few questions', () => {
  const tooFew = JSON.stringify({ questions: [{ id: 'q1', text: 'X', options: ['a', 'b'] }] });
  assert.throws(() => parseQuestions(tooFew), GrillMeParseError);
});

test('parseQuestions rejects responses with too many questions', () => {
  const tooMany = {
    questions: Array.from({ length: QUESTIONS_MAX + 1 }, (_, i) => ({
      id: `q${i + 1}`,
      text: `Frage ${i + 1}`,
      options: ['A', 'B'],
    })),
  };
  assert.throws(() => parseQuestions(JSON.stringify(tooMany)), GrillMeParseError);
});

test('parseQuestions rejects responses with too few options', () => {
  const bad = JSON.stringify({ questions: [{ id: 'q1', text: 'X', options: ['only-one'] }] });
  assert.throws(() => parseQuestions(bad), GrillMeParseError);
});

test('parseQuestions rejects responses with too many options', () => {
  const bad = JSON.stringify({
    questions: [{ id: 'q1', text: 'X', options: ['a', 'b', 'c', 'd', 'e'] }],
  });
  assert.throws(() => parseQuestions(bad), GrillMeParseError);
});

test('parseQuestions rejects empty option strings and oversize labels', () => {
  const emptyOpt = JSON.stringify({
    questions: [
      { id: 'q1', text: 'X', options: ['   ', 'b'] },
      { id: 'q2', text: 'Y', options: ['c', 'd'] },
    ],
  });
  assert.throws(() => parseQuestions(emptyOpt), /must not be empty/);

  const oversize = JSON.stringify({
    questions: [
      { id: 'q1', text: 'X', options: ['a'.repeat(61), 'b'] },
      { id: 'q2', text: 'Y', options: ['c', 'd'] },
    ],
  });
  assert.throws(() => parseQuestions(oversize), /exceeds 60 characters/);
});

test('parseQuestions rejects malformed JSON', () => {
  assert.throws(() => parseQuestions('not json at all'), GrillMeParseError);
  assert.throws(() => parseQuestions(''), GrillMeParseError);
});

test('stripJsonFences and extractJsonObject helpers', () => {
  assert.equal(stripJsonFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('{"a":1}'), '{"a":1}');
  assert.equal(extractJsonObject('hi { "a": 1 } bye'), '{ "a": 1 }');
  assert.throws(() => extractJsonObject('no braces here'), GrillMeParseError);
});

// ---------------------------------------------------------------------------
// Poll delivery (sendPoll / sendText are injected)
// ---------------------------------------------------------------------------

function makeContext(overrides = {}) {
  return { chatId: '123@g.us', locale: 'de', ...overrides };
}

const SAMPLE_QUESTIONS = [
  { id: 'q1', text: 'Genre?', options: ['Roman', 'Erzählung'] },
  { id: 'q2', text: 'Zielgruppe?', options: ['Kinder', 'Erwachsene'] },
];

test('deliverPolls invokes sendPoll once per question with multiSelect=false', async () => {
  const calls = [];
  const sendPoll = async (chatId, payload) => {
    calls.push({ chatId, payload });
  };
  const sendText = async () => {
    throw new Error('sendText should not be called when sendPoll succeeds');
  };
  const { polls } = await deliverPolls(SAMPLE_QUESTIONS, makeContext(), sendPoll, sendText);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].chatId, '123@g.us');
  assert.equal(calls[0].payload.question, '(1/2) Genre?');
  assert.equal(calls[1].payload.question, '(2/2) Zielgruppe?');
  assert.equal(calls[0].payload.multiSelect, false);
  assert.deepEqual(calls[0].payload.options, ['Roman', 'Erzählung']);
  assert.deepEqual(calls[1].payload.options, ['Kinder', 'Erwachsene']);
  assert.equal(polls.length, 2);
  assert.equal(polls[0].deliveredAs, 'poll');
  assert.equal(polls[1].deliveredAs, 'poll');
});

test('deliverPolls falls back to sendText when sendPoll rejects', async () => {
  const pollCalls = [];
  const textCalls = [];
  const sendPoll = async () => {
    pollCalls.push(true);
    throw new Error('rate limited');
  };
  const sendText = async (chatId, body) => {
    textCalls.push({ chatId, body });
  };
  const { polls } = await deliverPolls(SAMPLE_QUESTIONS, makeContext(), sendPoll, sendText);
  assert.equal(pollCalls.length, 2);
  assert.equal(textCalls.length, 2);
  assert.equal(polls.every((p) => p.deliveredAs === 'text'), true);
  // Numbered list with lettered sub-options.
  assert.match(textCalls[0].body, /^1\. Genre\?\n   a\) Roman\n   b\) Erzählung$/);
});

test('deliverPolls uses sendText when sendPoll is not provided', async () => {
  const textCalls = [];
  const sendText = async (chatId, body) => {
    textCalls.push({ chatId, body });
  };
  const { polls } = await deliverPolls(SAMPLE_QUESTIONS, makeContext(), undefined, sendText);
  assert.equal(textCalls.length, 2);
  assert.equal(polls.every((p) => p.deliveredAs === 'text'), true);
});

test('formatQuestionAsText uses a/b/c sub-options and a numeric header', () => {
  assert.equal(
    formatQuestionAsText({ text: 'T?', options: ['x', 'y', 'z'] }, 0),
    '1. T?\n   a) x\n   b) y\n   c) z'
  );
});

// ---------------------------------------------------------------------------
// End-to-end runGrillMe with mocked Qwen
// ---------------------------------------------------------------------------

test('runGrillMe happy path: asks Qwen, parses, delivers polls', async () => {
  const pollCalls = [];
  const qwen = {
    async run(prompt) {
      assert.match(prompt, /Plane einen Roman/);
      assert.match(prompt, /auf Deutsch/);
      return { text: VALID_RESPONSE };
    },
  };
  const sendPoll = async (chatId, payload) => {
    pollCalls.push({ chatId, payload });
  };
  const sendText = async () => {
    throw new Error('sendText should not be called on the happy path');
  };
  const ctx = makeContext();
  const result = await runGrillMe({
    promptText: 'Grill Me: Plane einen Roman',
    ctx,
    qwen,
    sendPoll,
    sendText,
  });
  assert.equal(result.stage, 'questions');
  assert.equal(pollCalls.length, 3);
  assert.equal(result.originalPrompt, 'Plane einen Roman');
  assert.equal(result.polls.length, 3);
  assert.equal(result.polls.every((p) => p.deliveredAs === 'poll'), true);
});

test('runGrillMe with no prefix informs the user and exits cleanly', async () => {
  const textCalls = [];
  const qwen = { async run() { throw new Error('Qwen should not be called'); } };
  const sendText = async (chatId, body) => { textCalls.push({ chatId, body }); };
  const result = await runGrillMe({
    promptText: 'Plane einen Roman',
    ctx: makeContext(),
    qwen,
    sendText,
  });
  assert.equal(result.stage, 'skipped');
  assert.equal(textCalls.length, 1);
  assert.match(textCalls[0].body, /Präfix/);
});

test('runGrillMe falls back to text when Qwen returns unparseable JSON', async () => {
  const textCalls = [];
  const qwen = { async run() { return { text: 'Sorry, kaputt.' }; } };
  const sendText = async (chatId, body) => { textCalls.push({ chatId, body }); };
  const sendPoll = async () => { throw new Error('sendPoll should not be called'); };
  const result = await runGrillMe({
    promptText: 'Grill Me: was?',
    ctx: makeContext(),
    qwen,
    sendPoll,
    sendText,
  });
  assert.equal(result.stage, 'skipped');
  assert.equal(textCalls.length, 1);
  assert.match(textCalls[0].body, /Rückfragen von Qwen nicht verarbeiten/);
});

test('runGrillMe re-entry: answeredQuestions triggers finalize and returns text', async () => {
  const textCalls = [];
  let captured;
  const qwen = {
    async run(prompt) {
      captured = prompt;
      return { text: 'Hier ist die endgültige Antwort.' };
    },
  };
  const sendText = async (chatId, body) => { textCalls.push({ chatId, body }); };
  const sendPoll = async () => { throw new Error('sendPoll should not be called on re-entry'); };
  const result = await runGrillMe({
    promptText: '',
    ctx: makeContext(),
    qwen,
    sendPoll,
    sendText,
    answeredQuestions: [
      { id: 'q1', text: 'Genre?', options: ['Roman'], answer: 'Roman' },
      { id: 'q2', text: 'Zielgruppe?', options: ['Erwachsene'], answer: 'Erwachsene' },
    ],
    originalPrompt: 'Plane einen Roman',
  });
  assert.equal(result.stage, 'finalized');
  assert.equal(result.text, 'Hier ist die endgültige Antwort.');
  assert.match(captured, /Plane einen Roman/);
  assert.match(captured, /Genre\?/);
  assert.match(captured, /Antwort: Roman/);
  assert.match(captured, /endgültige Antwort auf Deutsch/);
  assert.equal(textCalls.length, 1);
  assert.equal(textCalls[0].body, 'Hier ist die endgültige Antwort.');
});

test('runGrillMe validates required dependencies', async () => {
  await assert.rejects(
    () => runGrillMe({ ctx: {}, qwen: { run: async () => ({}) }, sendText: async () => {} }),
    /ctx.chatId is required/
  );
  await assert.rejects(
    () => runGrillMe({ ctx: { chatId: 'x' }, qwen: { run: async () => ({}) } }),
    /sendText is required/
  );
  await assert.rejects(
    () => runGrillMe({ ctx: { chatId: 'x' }, sendText: async () => {} }),
    /qwen.run is required/
  );
});