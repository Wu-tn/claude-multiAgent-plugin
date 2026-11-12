import { ROLE_PROFILES, PROFILES, route } from './config.mjs';

export const ACTIVE = ['starting', 'running'];
export const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const text = (v, label, max = 6000) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : fail(`${label} must be nonempty text (max ${max})`);
const list = (v, label, max = 32) => Array.isArray(v) && v.length <= max ? v : fail(`${label} must be an array (max ${max})`);

function scopePath(p) {
  p = text(p, 'scope path', 300).replaceAll('\\', '/').replace(/\/$/, '');
  if (p === '.') return p;
  if (/^[\/]|:|[?*\[\]]/.test(p) || p.split('/').some(s => !s || s === '..' || s === '.')) fail('scope paths must be project-relative literal files/directories, without traversal or globs');
  return p;
}
function taskSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('Invalid task');
  const id = text(spec.id, 'id', 48);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) fail('Invalid task id');
  if (!Object.hasOwn(ROLE_PROFILES, spec.role)) fail(`Unknown role: ${spec.role}`);
  if (spec.profile && !PROFILES.includes(spec.profile)) fail('Unknown model profile');
  if (spec.complexity && !['simple', 'normal', 'complex'].includes(spec.complexity)) fail('Unknown complexity');
  const acceptance = list(spec.acceptance, 'acceptance', 12).map(v => text(v, 'acceptance item', 1500));
  if (!acceptance.length) fail('Every task needs explicit acceptance criteria');
  const scope = list(spec.scope ?? [], 'scope', 32).map(scopePath);
  if (['implementer', 'verifier'].includes(spec.role) && !scope.length) fail('implementer/verifier need an explicit scope (use . for the whole project)');
  return {
    id, role: spec.role, goal: text(spec.goal, 'goal'), context: spec.context ? text(spec.context, 'context', 12000) : '',
    dependsOn: list(spec.dependsOn ?? [], 'dependsOn').map(v => text(v, 'dependency', 48)),
    scope, acceptance, complexity: spec.complexity ?? 'normal', ...(spec.profile ? { profile: spec.profile } : {}),
    status: 'pending', attempts: 0, history: [],
  };
}
function validateGraph(tasks) {
  const byId = new Map();
  for (const t of tasks) { if (byId.has(t.id)) fail(`Duplicate task id: ${t.id}`); byId.set(t.id, t); }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) fail(`Missing dependency: ${id}`);
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  tasks.forEach(t => visit(t.id));
}
export function createBoard(goal, specs, config, previous, now = Date.now()) {
  if (previous && previous.tasks.some(t => !['done', 'cancelled'].includes(t.status))) fail('Finish or cancel the existing plan before replacing it');
  const tasks = list(specs, 'tasks', config.maxTasks).map(taskSpec);
  if (!tasks.length) fail('Plan must have tasks');
  validateGraph(tasks);
  return { version: 1, goal: text(goal, 'plan goal'), createdAt: now, totalSpawns: 0, tasks };
}
export function addTasks(board, specs, config) {
  const b = clone(board);
  b.tasks.push(...list(specs, 'tasks', config.maxTasks).map(taskSpec));
  if (b.tasks.length > config.maxTasks) fail('Task limit reached');
  validateGraph(b.tasks);
  return b;
}
export function getTask(board, id) { return board?.tasks.find(t => t.id === id) ?? fail(`Unknown task: ${id}`); }
function overlaps(a, b) {
  // Case-insensitive comparison is conservative and works on Windows too.
  a = a.toLowerCase(); b = b.toLowerCase();
  return a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export function conflicts(a, b) {
  const writes = t => ['implementer', 'verifier'].includes(t.role);
  // Read-only roles with no scope may read the entire project.
  return (writes(a) || writes(b)) && (a.scope.length ? a.scope : ['.']).some(x => (b.scope.length ? b.scope : ['.']).some(y => overlaps(x, y)));
}
export function reserve(board, ids, config, now = Date.now()) {
  const b = clone(board);
  list(ids, 'ids', config.maxParallel);
  if (!ids.length || new Set(ids).size !== ids.length) fail('Select unique task ids');
  const active = b.tasks.filter(t => ACTIVE.includes(t.status));
  if (active.length + ids.length > config.maxParallel) fail('Parallel limit reached');
  if (b.totalSpawns + ids.length > config.maxTotalSpawns) fail('Total spawn budget reached');
  for (const id of ids) {
    const t = getTask(b, id);
    if (t.status !== 'pending') fail(`${id} is ${t.status}, not pending`);
    if (t.attempts >= config.maxAttempts) fail(`${id} exhausted its attempts`);
    if (!t.dependsOn.every(d => getTask(b, d).status === 'done')) fail(`${id} has unaccepted dependencies`);
    if (active.some(other => conflicts(t, other))) fail(`${id} overlaps a running/selected task's scope`);
    t.attempts += 1; t.status = 'starting'; t.startedAt = now; t.route = route(t, config);
    active.push(t); b.totalSpawns += 1;
  }
  return b;
}
export function bindAgent(board, id, agentId) {
  const b = clone(board), t = getTask(b, id);
  if (t.status !== 'starting') fail(`${id} is not starting`);
  t.agentId = agentId; t.status = 'running'; return b;
}
export function complete(board, agentId, event, now = Date.now()) {
  const b = clone(board), t = b.tasks.find(t => t.agentId === agentId && ACTIVE.includes(t.status));
  if (!t) return b;
  const reason = event.reason ?? (event.isAborted ? 'aborted' : 'answer');
  t.status = reason === 'answer' && !event.isAborted ? 'reported' : 'failed';
  t.report = String(event.answer ?? '').slice(0, 12000);
  t.reportTruncated = String(event.answer ?? '').length > 12000;
  t.reason = reason; t.finishedAt = now; t.durationMs = event.durationMs ?? 0;
  // Keep only numeric usage values; no credentials or provider payloads.
  t.usage = Object.fromEntries(Object.entries(event.usage ?? {}).filter(([, v]) => typeof v === 'number'));
  return b;
}
export function spawnFailed(board, id, reason) {
  const b = clone(board), t = getTask(b, id);
  t.status = 'failed'; t.reason = 'spawn_error'; t.report = String(reason).slice(0, 12000); return b;
}
export function review(board, id, accept, evidence) {
  const b = clone(board), t = getTask(b, id);
  if (t.status !== 'reported') fail('Only reported tasks can be reviewed');
  if (typeof accept !== 'boolean') fail('accept must be a boolean');
  t.review = text(evidence, 'review evidence', 6000);
  t.status = accept ? 'done' : 'failed'; return b;
}
export function retry(board, id, feedback, config) {
  const b = clone(board), t = getTask(b, id);
  if (t.status !== 'failed') fail('Only failed/rejected tasks can be retried');
  if (t.attempts >= config.maxAttempts) fail('Attempt limit reached; cancel/replan or ask the user');
  t.feedback = text(feedback, 'retry feedback', 6000);
  t.history.push({ attempt: t.attempts, route: t.route, reason: t.reason ?? 'rejected', report: t.report, review: t.review ?? '' });
  delete t.agentId; delete t.report; delete t.review; delete t.reason; delete t.usage;
  t.status = 'pending'; return b;
}
export function cancel(board, id, reason) {
  const b = clone(board), t = getTask(b, id);
  if (ACTIVE.includes(t.status) || t.status === 'done') fail('Cannot cancel an active or accepted task');
  t.status = 'cancelled'; t.review = text(reason, 'cancellation reason'); return b;
}
export function recover(board, agents) {
  if (!board) return board;
  const b = clone(board), live = new Set(agents.filter(a => a.status === 'running').map(a => a.id));
  for (const t of b.tasks) if (ACTIVE.includes(t.status) && (!t.agentId || !live.has(t.agentId))) {
    t.status = 'failed'; t.reason = 'interrupted'; t.report = 'Session resumed without a live worker. Inspect files before retrying; previous writes may exist.';
  }
  return b;
}
export function view(board) {
  if (!board) return { plan: null };
  return { ...board, tasks: board.tasks.map(({ history, ...t }) => ({ ...t, previousAttempts: history.length, ready: t.status === 'pending' && t.dependsOn.every(id => getTask(board, id).status === 'done') })) };
}
