'use strict';

const OTHER = '__other__';

/**
 * @typedef {{ label: string, description?: string, preview?: string }} QuestionOption
 * @typedef {{ question: string, header?: string, options: QuestionOption[], multiSelect: boolean }} Question
 * @typedef {Record<string, string | string[]>} Picked
 * @typedef {Record<string, string>} Typed
 * @typedef {{ answers: Record<string, string>, annotations?: Record<string, { preview: string }>, complete: boolean }} Reply
 */

// Multi-select answers go back as one comma-separated string, which is what the
// tool's own output type promises the model.
function answerFor(pick, typed) {
  const chosen = Array.isArray(pick) ? pick : [pick];
  return chosen
    .filter(Boolean)
    .map((label) => (label === OTHER ? typed.trim() : label))
    .filter(Boolean)
    .join(', ');
}

/** @param {unknown} input @returns {Question[]} */
function questionsOf(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input.questions : undefined;
  if (!Array.isArray(raw)) return [];
  const questions = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.question !== 'string' || item.question.trim() === '') continue;
    const options = [];
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
        if (typeof option.label !== 'string' || option.label.trim() === '') continue;
        const kept = { label: option.label };
        if (typeof option.description === 'string' && option.description !== '') {
          kept.description = option.description;
        }
        if (typeof option.preview === 'string' && option.preview !== '') {
          kept.preview = option.preview;
        }
        options.push(kept);
      }
    }
    questions.push({
      question: item.question,
      ...(typeof item.header === 'string' && item.header !== '' ? { header: item.header } : {}),
      options,
      multiSelect: item.multiSelect === true,
    });
  }
  return questions;
}

/** @param {readonly Question[]} questions @param {Picked} picked @param {Typed} typed @returns {Reply} */
function replyOf(questions, picked, typed) {
  const answers = {};
  const annotations = {};
  for (const q of questions) {
    const answer = answerFor(picked[q.question], typed[q.question] || '');
    if (answer) answers[q.question] = answer;
    const chosen = [].concat(picked[q.question] || []);
    const preview = q.options.find((option) => chosen.includes(option.label) && option.preview)?.preview;
    if (preview) annotations[q.question] = { preview };
  }
  return {
    answers,
    ...(Object.keys(annotations).length ? { annotations } : {}),
    complete: questions.every((q) => Boolean(answers[q.question])),
  };
}

/**
 * @param {Readonly<Record<string, unknown>>} input
 * @param {Reply} reply
 * @returns {Record<string, unknown>}
 */
function withAnswers(input, reply) {
  return {
    ...input,
    answers: reply.answers,
    ...(reply.annotations ? { annotations: reply.annotations } : {}),
  };
}

module.exports = { OTHER, questionsOf, replyOf, withAnswers };
