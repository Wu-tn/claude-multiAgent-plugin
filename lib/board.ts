import { COMPLEXITIES, PROFILES, isRole, route } from './config.ts';
import type { Complexity, Config, Profile, Role, Route } from './config.ts';
import { isOneOf, isRecord } from './validation.ts';

interface AttemptRecord {
  attempt: number;
  route: Route;
  reason: string;
  report: string;
  review: string;
}

interface TaskFields {
  id: string;
  role: Role;
  goal: string;
  context: string;
  dependsOn: string[];
  scope: string[];
  acceptance: string[];
  complexity: Complexity;
  profile?: Profile;
  attempts: number;
  history: AttemptRecord[];
  feedback?: string;
  route?: Route;
  agentId?: string;
  report?: string;
  reportTruncated?: boolean;
  reason?: string;
  review?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  usage?: Record<string, number>;
}

type Started = { route: Route; startedAt: number };
type Reported = Started & { agentId: string; report: string; reason: string };
export type Task = TaskFields & (
  | { status: 'pending'; agentId?: never }
  | (Started & { status: 'starting'; agentId?: never })
  | (Started & { status: 'running'; agentId: string })
  | (Reported & { status: 'reported' })
  | (Reported & { status: 'done'; review: string })
  | (Started & { status: 'failed'; report: string; reason: string })
  | { status: 'cancelled'; review: string }
);

export interface Board {
  version: 1;
  goal: string;
  createdAt: number;
  totalSpawns: number;
  notifiedSpawns?: number;
  tasks: Task[];
}

export interface Completion {
  answer?: string;
  reason?: string;
  isAborted?: boolean;
  durationMs?: number;
  usage?: object;
}

export function isActive(task: Task): task is Extract<Task, { status: 'starting' | 'running' }> {
  return task.status === 'starting' || task.status === 'running';
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function fail(message: string): never {
  throw new Error(message);
}

function text(value: unknown, label: string, max = 6000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(label + ' must be nonempty text (max ' + max + ')');
  }
  return value.trim();
}

function list(value: unknown, label: string, max = 32): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(label + ' must be an array (max ' + max + ')');
  return value;
}

export function taskIds(value: unknown, max: number): string[] {
  return list(value, 'ids', max).map(id => {
    if (typeof id !== 'string') fail('Task ids must be strings');
    return id;
  });
}

function scopePath(value: unknown): string {
  const path = text(value, 'scope path', 300).replaceAll('\\', '/').replace(/\/$/, '');
  if (path === '.') return path;
  if (/^[\/]|:|[?*\[\]]/.test(path) || path.split('/').some(part => !part || part === '..' || part === '.')) {
    fail('scope paths must be project-relative literal files/directories, without traversal or globs');
  }
  return path;
}

function taskSpec(spec: unknown): Task {
  if (!isRecord(spec)) fail('Invalid task');
  const id = text(spec.id, 'id', 48);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) fail('Invalid task id');
  const role = spec.role;
  if (!isRole(role)) fail('Unknown role: ' + String(role));
  const profile = spec.profile || undefined;
  if (profile !== undefined && !isOneOf(PROFILES, profile)) fail('Unknown model profile');
  const complexity = spec.complexity ?? 'normal';
  if (!isOneOf(COMPLEXITIES, complexity)) fail('Unknown complexity');
  const acceptance = list(spec.acceptance, 'acceptance', 12).map(item => text(item, 'acceptance item', 1500));
  if (!acceptance.length) fail('Every task needs explicit acceptance criteria');
  const scope = list(spec.scope ?? [], 'scope', 32).map(scopePath);
  if ((role === 'implementer' || role === 'verifier') && !scope.length) {
    fail('implementer/verifier need an explicit scope (use . for the whole project)');
  }
  return {
    id, role, goal: text(spec.goal, 'goal'), context: spec.context ? text(spec.context, 'context', 12000) : '',
    dependsOn: list(spec.dependsOn ?? [], 'dependsOn').map(dep => text(dep, 'dependency', 48)),
    scope, acceptance, complexity, ...(profile ? { profile } : {}),
    status: 'pending', attempts: 0, history: [],
  };
}

function validateGraph(tasks: Task[]): void {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) fail('Duplicate task id: ' + task.id);
    byId.set(task.id, task);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) fail('Dependency cycle at ' + id);
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) fail('Missing dependency: ' + id);
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach(task => visit(task.id));
}

export function createBoard(goal: unknown, specs: unknown, config: Config, previous?: Board | null, now = Date.now()): Board {
  if (previous?.tasks.some(task => task.status !== 'done' && task.status !== 'cancelled')) {
    fail('Finish or cancel the existing plan before replacing it');
  }
  const tasks = list(specs, 'tasks', config.maxTasks).map(taskSpec);
  if (!tasks.length) fail('Plan must have tasks');
  validateGraph(tasks);
  return { version: 1, goal: text(goal, 'plan goal'), createdAt: now, totalSpawns: 0, tasks };
}

export function addTasks(board: Board, specs: unknown, config: Config): Board {
  const next = clone(board);
  next.tasks.push(...list(specs, 'tasks', config.maxTasks).map(taskSpec));
  if (next.tasks.length > config.maxTasks) fail('Task limit reached');
  validateGraph(next.tasks);
  return next;
}

export function getTask(board: Board, id: unknown): Task {
  return board.tasks.find(task => task.id === id) ?? fail('Unknown task: ' + String(id));
}

function overlaps(first: string, second: string): boolean {
  // Case-insensitive comparison is conservative and works on Windows too.
  const a = first.toLowerCase(), b = second.toLowerCase();
  return a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

type WorkScope = Pick<Task, 'role' | 'scope'>;

export function conflicts(a: WorkScope, b: WorkScope): boolean {
  const writes = (task: WorkScope) => task.role === 'implementer' || task.role === 'verifier';
  // Read-only roles with no scope may read the entire project.
  return (writes(a) || writes(b)) && (a.scope.length ? a.scope : ['.']).some(x => (b.scope.length ? b.scope : ['.']).some(y => overlaps(x, y)));
}

function replaceTask(board: Board, task: Task): void {
  const index = board.tasks.findIndex(current => current.id === task.id);
  if (index === -1) fail('Unknown task: ' + task.id);
  board.tasks[index] = task;
}

export function reserve(board: Board, ids: readonly string[], config: Config, now = Date.now()): Board {
  list(ids, 'ids', config.maxParallel);
  if (!ids.length || new Set(ids).size !== ids.length) fail('Select unique task ids');
  const next = clone(board);
  const active = next.tasks.filter(isActive);
  if (active.length + ids.length > config.maxParallel) fail('Parallel limit reached');
  if (next.totalSpawns + ids.length > config.maxTotalSpawns) fail('Total spawn budget reached');
  for (const id of ids) {
    const task = getTask(next, id);
    if (task.status !== 'pending') fail(id + ' is ' + task.status + ', not pending');
    if (task.attempts >= config.maxAttempts) fail(id + ' exhausted its attempts');
    if (!task.dependsOn.every(dep => getTask(next, dep).status === 'done')) fail(id + ' has unaccepted dependencies');
    if (active.some(other => conflicts(task, other))) fail(id + ' overlaps a running/selected task\'s scope');
    const attempts = task.attempts + 1;
    const started = { ...task, attempts, status: 'starting' as const, startedAt: now, route: route({ ...task, attempts }, config) };
    replaceTask(next, started);
    active.push(started);
    next.totalSpawns += 1;
  }
  return next;
}

export function bindAgent(board: Board, id: string, agentId: string): Board {
  const next = clone(board);
  const task = getTask(next, id);
  if (task.status !== 'starting') fail(id + ' is not starting');
  replaceTask(next, { ...task, agentId, status: 'running' });
  return next;
}

export function complete(board: Board, agentId: string, event: Completion, now = Date.now()): Board {
  const next = clone(board);
  const task = next.tasks.find(task => task.status === 'running' && task.agentId === agentId);
  if (!task || task.status !== 'running') return next;
  const reason = event.reason ?? (event.isAborted ? 'aborted' : 'answer');
  const answer = String(event.answer ?? '');
  // Keep only numeric usage values; no credentials or provider payloads.
  const usage = Object.fromEntries(Object.entries(event.usage ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  replaceTask(next, {
    ...task, status: reason === 'answer' && !event.isAborted ? 'reported' : 'failed',
    report: answer.slice(0, 12000), reportTruncated: answer.length > 12000,
    reason, finishedAt: now, durationMs: event.durationMs ?? 0, usage,
  });
  return next;
}

export function spawnFailed(board: Board, id: string, reason: string): Board {
  const next = clone(board);
  const task = getTask(next, id);
  if (!isActive(task)) return next;
  replaceTask(next, { ...task, status: 'failed', reason: 'spawn_error', report: reason.slice(0, 12000) });
  return next;
}

export function review(board: Board, id: unknown, accept: unknown, evidence: unknown): Board {
  const next = clone(board);
  const task = getTask(next, id);
  if (task.status !== 'reported') fail('Only reported tasks can be reviewed');
  if (typeof accept !== 'boolean') fail('accept must be a boolean');
  replaceTask(next, { ...task, status: accept ? 'done' : 'failed', review: text(evidence, 'review evidence', 6000) });
  return next;
}

export function retry(board: Board, id: unknown, feedback: unknown, config: Config): Board {
  const next = clone(board);
  const task = getTask(next, id);
  if (task.status !== 'failed') fail('Only failed/rejected tasks can be retried');
  if (task.attempts >= config.maxAttempts) fail('Attempt limit reached; cancel/replan or ask the user');
  const { agentId, report, review, reason, usage, ...previous } = task;
  replaceTask(next, {
    ...previous, status: 'pending', feedback: text(feedback, 'retry feedback', 6000),
    history: [...task.history, { attempt: task.attempts, route: task.route, reason, report, review: review ?? '' }],
  });
  return next;
}

export function cancel(board: Board, id: unknown, reason: unknown): Board {
  const next = clone(board);
  const task = getTask(next, id);
  if (isActive(task) || task.status === 'done') fail('Cannot cancel an active or accepted task');
  replaceTask(next, { ...task, status: 'cancelled', review: text(reason, 'cancellation reason') });
  return next;
}

export function recover(board: Board | null, agents: readonly { id: string; status: string }[]): Board | null {
  if (!board) return null;
  const next = clone(board);
  const live = new Set(agents.filter(agent => agent.status === 'running').map(agent => agent.id));
  next.tasks = next.tasks.map(task => {
    if (!isActive(task) || (task.agentId && live.has(task.agentId))) return task;
    return { ...task, status: 'failed', reason: 'interrupted', report: 'Session resumed without a live worker. Inspect files before retrying; previous writes may exist.' };
  });
  return next;
}

export function view(board: Board | null) {
  if (!board) return { plan: null };
  return {
    ...board,
    tasks: board.tasks.map(({ history, ...task }) => ({
      ...task,
      previousAttempts: history.length,
      ready: task.status === 'pending' && task.dependsOn.every(id => getTask(board, id).status === 'done'),
    })),
  };
}
