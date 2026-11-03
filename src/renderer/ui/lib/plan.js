const STATUS = new Set(['pending', 'in_progress', 'completed']);

export function planOf(input) {
  const todos = input?.todos;
  if (!Array.isArray(todos) || !todos.length) return null;
  const entries = todos
    .filter((t) => typeof t?.content === 'string')
    .map(({ content, status, priority, activeForm }) => ({
      content,
      status: status === 'inProgress' ? 'in_progress' : STATUS.has(status) ? status : 'pending',
      ...(priority ? { priority } : {}),
      ...(activeForm ? { activeForm } : {}),
    }));
  if (!entries.length) return null;
  const explanation = typeof input.explanation === 'string' && input.explanation.trim() ? input.explanation : undefined;
  return { entries, ...(explanation ? { explanation } : {}) };
}

export function withPlan(items, { parent, entries, explanation }) {
  const turn = items.findLast((it) => it.kind === 'user' && !it.parent)?.id ?? 'start';
  const id = parent ? `plan:${turn}:${parent}` : `plan:${turn}`;
  const plan = { id, kind: 'plan', parent: parent || null, entries, ...(explanation ? { explanation } : {}) };
  const at = items.findIndex((it) => it.id === id);
  if (at < 0) return [...items, plan];
  return items.map((it, i) => (i === at ? plan : it));
}

export const planDone = (entries) => entries.filter((e) => e.status === 'completed').length;

export const planComplete = (entries) => entries.length > 0 && planDone(entries) === entries.length;
