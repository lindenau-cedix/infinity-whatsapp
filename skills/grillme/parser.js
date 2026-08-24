// skills/grillme/parser.js
//
// Parses Qwen's structured response into validated Question objects.
// Tolerates either pure JSON or a JSON block wrapped in ```json fences.

'use strict';

const { QUESTIONS_MIN, QUESTIONS_MAX, OPTIONS_MIN, OPTIONS_MAX } = require('./metaPrompt');

/**
 * @typedef {Object} Question
 * @property {string} id     Stable identifier (e.g. "q1").
 * @property {string} text   The question text (German).
 * @property {string[]} options 2-4 option labels (German).
 */

class GrillMeParseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GrillMeParseError';
    if (cause) this.cause = cause;
  }
}

/**
 * Strip ```json ... ``` fences if present. Leaves pure JSON untouched.
 */
function stripJsonFences(raw) {
  if (typeof raw !== 'string') return raw;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return raw.trim();
}

/**
 * Extract the outermost {...} block from a string. Defensive helper for
 * the rare case where Qwen adds stray prose around the JSON.
 */
function extractJsonObject(raw) {
  const trimmed = stripJsonFences(raw);
  // Already starts with { -> use as-is.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new GrillMeParseError('No JSON object found in Qwen response');
  }
  return trimmed.slice(firstBrace, lastBrace + 1);
}

/**
 * Validate a single option.
 */
function validateOption(option, index) {
  if (typeof option !== 'string') {
    throw new GrillMeParseError(`options[${index}] must be a string, got ${typeof option}`);
  }
  const trimmed = option.trim();
  if (!trimmed) {
    throw new GrillMeParseError(`options[${index}] must not be empty`);
  }
  if (trimmed.length > 60) {
    throw new GrillMeParseError(`options[${index}] exceeds 60 characters`);
  }
  return trimmed;
}

/**
 * Validate a single question.
 */
function validateQuestion(rawQuestion, index) {
  if (!rawQuestion || typeof rawQuestion !== 'object') {
    throw new GrillMeParseError(`questions[${index}] must be an object`);
  }
  const id = typeof rawQuestion.id === 'string' && rawQuestion.id.trim()
    ? rawQuestion.id.trim()
    : `q${index + 1}`;
  const text = typeof rawQuestion.text === 'string' ? rawQuestion.text.trim() : '';
  if (!text) {
    throw new GrillMeParseError(`questions[${index}].text must be a non-empty string`);
  }
  if (!Array.isArray(rawQuestion.options)) {
    throw new GrillMeParseError(`questions[${index}].options must be an array`);
  }
  if (rawQuestion.options.length < OPTIONS_MIN || rawQuestion.options.length > OPTIONS_MAX) {
    throw new GrillMeParseError(
      `questions[${index}].options length must be between ${OPTIONS_MIN} and ${OPTIONS_MAX}`
    );
  }
  const options = rawQuestion.options.map((opt, i) => validateOption(opt, i));
  return { id, text, options };
}

/**
 * Parse Qwen's raw response into validated Question objects.
 * @param {string} raw
 * @returns {Question[]}
 */
function parseQuestions(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new GrillMeParseError('Qwen response must be a non-empty string');
  }
  const jsonSlice = extractJsonObject(raw);
  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    throw new GrillMeParseError(`Failed to JSON.parse Qwen response: ${err.message}`, err);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.questions)) {
    throw new GrillMeParseError('Qwen response must contain a "questions" array');
  }
  if (parsed.questions.length < QUESTIONS_MIN || parsed.questions.length > QUESTIONS_MAX) {
    throw new GrillMeParseError(
      `Qwen returned ${parsed.questions.length} questions; expected ${QUESTIONS_MIN}-${QUESTIONS_MAX}`
    );
  }
  return parsed.questions.map((q, i) => validateQuestion(q, i));
}

module.exports = {
  parseQuestions,
  stripJsonFences,
  extractJsonObject,
  GrillMeParseError,
};