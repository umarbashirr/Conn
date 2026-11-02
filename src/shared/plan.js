'use strict';
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
