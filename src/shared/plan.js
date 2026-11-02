'use strict';
/* A provider's checklist as the input of a Claude TodoWrite call, which is the
   shape the transcript already knows how to draw. Codex spells the middle
   status inProgress, and an ACP agent may send a status of its own, so anything
   unknown reads as not started. */
const STATUS = { pending: 'pending', in_progress: 'in_progress', inProgress: 'in_progress', completed: 'completed' };

function todoInput(entries, explanation) {
  const todos = (entries || [])
    .filter((e) => typeof e?.content === 'string')
    .map(({ content, status, priority }) => ({
      content,
      status: STATUS[status] || 'pending',
      ...(priority ? { priority } : {}),
    }));
  return { todos, ...(typeof explanation === 'string' && explanation.trim() ? { explanation } : {}) };
}

module.exports = { todoInput };
