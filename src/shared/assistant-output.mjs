const HAS_FINAL_ANSWER_TAG = /<\/?final_answer>/i;
const FINAL_ANSWER_TAG = /<\/?final_answer>/gi;
const FILE_REFERENCE = /^\/?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?:-\d+)?)?$/;

export function isInternalAnswerArtifact(text) {
  if (typeof text !== 'string' || !HAS_FINAL_ANSWER_TAG.test(text)) return false;

  const content = text.replace(FINAL_ANSWER_TAG, '').trim();
  if (!content) return true;

  const references = content.split(/\s+/).filter(Boolean);
  return references.length >= 2 && references.every((reference) => FILE_REFERENCE.test(reference));
}
