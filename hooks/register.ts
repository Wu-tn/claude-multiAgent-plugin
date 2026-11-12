import type { EngineInterface, On } from 'claude-code';
import { resolveConfig } from '../lib/config.ts';
import type { Config } from '../lib/config.ts';
import { isActive, clone, createBoard, addTasks, reserve, bindAgent, complete, spawnFailed, review, retry, cancel, recover, view, getTask, taskIds } from '../lib/board.ts';
import type { Board, Completion, Task } from '../lib/board.ts';
import { PLANNER_PROMPT, roleSpecs, workerPrompt, TASK_TOOL } from '../lib/prompts.ts';
import { isRecord } from '../lib/validation.ts';

interface SessionState {
  version: 1;
  enabled: boolean;
  cwd: string;
  board: Board | null;
  continuationError?: string;
}

let config: Config;
let state: SessionState;
let key: string;
let boot: Promise<void> | undefined;
let configError: string | undefined;
let tail = Promise.resolve();
let spawning = 0;
const earlyCompletions = new Map<string, Completion>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSessionState(saved: unknown): saved is SessionState {
  if (!isRecord(saved) || saved.version !== 1 || typeof saved.enabled !== 'boolean' || typeof saved.cwd !== 'string') {
    return false;
  }
  const board = saved.board;
  return board === null || (isRecord(board) && board.version === 1 && Array.isArray(board.tasks));
}

function requireBoard(board: Board | null): Board {
  if (!board) throw new Error('Create a plan first');
  return board;
}

// One loaded mod belongs to one session. Serialize all updates, including
// parallel tool calls and worker completion events, before persisting them.
async function update($: EngineInterface, fn: (current: SessionState) => SessionState): Promise<SessionState> {
  const before = tail;
  let release = () => {};
  tail = new Promise<void>(resolve => { release = resolve; });
  await before;
  try {
    const nextState = fn(clone(state));
    await $.store.set(key, nextState);
    state = nextState;
    return clone(state);
  } finally { release(); }
}

async function initialize($: EngineInterface): Promise<void> {
  if (boot) return boot;
  boot = initializeOnce($);
  return boot;
}
async function initializeOnce($: EngineInterface): Promise<void> {
  key = `session:${await $.session.id()}`;
  const cwd = await $.session.cwd();
  const settings = await $.settings.read();
  const env = {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL'),
    ANTHROPIC_DEFAULT_SONNET_MODEL: await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL'),
    CLAUDE_CODE_SUBAGENT_MODEL: await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'),
  };
  let custom: unknown = {};
  try { custom = JSON.parse(await $.fs.read('.claude/multiagent.json')); }
  catch (error) {
    const message = errorMessage(error);
    if (!/ENOENT|no such file|not found/i.test(message)) configError = 'Cannot read .claude/multiagent.json: ' + message;
  }
  try { config = resolveConfig(settings, env, custom); }
  catch (error) { configError = errorMessage(error); config = resolveConfig(settings, env); }
  const saved = await $.store.get(key);
  state = isSessionState(saved) ? saved : { version: 1, enabled: false, cwd, board: null };
  state.board = recover(state.board, await $.agent.list());
  if (configError) state.enabled = false;
  await $.store.set(key, state);
  await $.command.register({ name: 'ma', description: 'Multi-agent planner: run/resume/on/off/status/config/reset', argumentHint: '[run <goal>|resume|on|off|status|config|reset]' });
  await $.tool.register(TASK_TOOL);
  for (const spec of roleSpecs(config)) await $.agent.register(spec);
  if (configError) await $.ui.log(`[multiagent] Disabled: ${configError}`);
}

function status() {
  return { enabled: state.enabled, ...(configError ? { error: configError } : {}), ...(state.continuationError ? { continuationError: state.continuationError, recovery: 'Use /ma resume after resolving the interruption or host limit.' } : {}), ...view(state.board) };
}

function toolResult(data: unknown, isError = false) {
  return { result: JSON.stringify(data), ...(isError ? { isError: true as const } : {}) };
}
async function ensureProject($: EngineInterface): Promise<void> {
  if ((await $.session.cwd()).replaceAll('\\', '/').toLowerCase() !== state.cwd.replaceAll('\\', '/').toLowerCase()) {
    throw new Error('The working directory changed. Start a new session in the target project before running this plan.');
  }
  if (configError) throw new Error(configError);
}

async function notifyIfSettled($: EngineInterface): Promise<void> {
  let notify = false;
  await update($, s => {
    const b = s.board;
    if (s.enabled && b && b.totalSpawns > 0 && b.notifiedSpawns !== b.totalSpawns && !b.tasks.some(isActive)) {
      b.notifiedSpawns = b.totalSpawns; notify = true;
    }
    return s;
  });
  // Do not await the new turn from a hook that the current turn is waiting on.
  if (notify) queueContinuation($, '[multiagent] Worker batch finished. Inspect the task board, review reported results against acceptance criteria, and continue ready tasks. If blocked, explain the blocker.');
}

function queueContinuation($: EngineInterface, text: string): void {
  // Run outside the current command or tool hook. The session must be free to
  // consume the queued turn before prompt.submit can resolve.
  $.clock.after(10, async () => {
    if (state.enabled) await submitContinuation($, text);
  });
}

async function submitContinuation($: EngineInterface, text: string): Promise<void> {
  try {
    // The command and prompt hooks attach the planner instructions to the conversation.
    const result = await $.prompt.submit({ text });
    if (result.drop) await update($, s => ({ ...s, continuationError: result.drop }));
    else if (state.continuationError) await update($, s => { delete s.continuationError; return s; });
  } catch (error) {
    // An interruption/host turn limit is not permission to retry indefinitely.
    await update($, s => ({ ...s, continuationError: errorMessage(error).slice(0, 1000) }));
  }
}

function workerName(board: Board, task: Task): string {
  return 'ma-' + board.createdAt + '-' + task.id + '-' + task.attempts;
}

async function findWorkerTask($: EngineInterface, agentId: string): Promise<Task | undefined> {
  const board = state.board;
  if (!board) return undefined;
  const task = board.tasks.find(task => task.agentId === agentId);
  if (task || spawning === 0) return task;
  // The first request can start before $.agent.spawn returns the agent id.
  const agent = (await $.agent.list()).find(agent => agent.id === agentId);
  if (!agent?.name) return undefined;
  return board.tasks.find(task => task.status === 'starting' && workerName(board, task) === agent.name);
}

async function runTasks($: EngineInterface, rawIds: unknown, signal: AbortSignal) {
  const ids = taskIds(rawIds, config.maxParallel);
  await update($, s => ({ ...s, board: reserve(requireBoard(s.board), ids, config) }));
  // Reservations are persisted before any spawn, preventing duplicate dispatch.
  for (const id of ids) {
    if (signal.aborted || !state.enabled) {
      await update($, s => ({ ...s, board: spawnFailed(requireBoard(s.board), id, 'Dispatch interrupted before this worker started') }));
      continue;
    }
    const board = requireBoard(state.board);
    const task = getTask(board, id);
    const name = workerName(board, task);
    spawning += 1;
    try {
      const result = await $.agent.spawn({
        // The native Agent input accepts Claude aliases in its model field.
        // The request hook applies the resolved gateway model ID.
        subagentType: 'multiagent:' + task.role,
        description: `${id}: ${task.goal.slice(0, 90)}`,
        prompt: workerPrompt(task, board), cwd: state.cwd, name,
      });
      if (result.deny) throw new Error(result.deny);
      // Some hook chains return only the model; locate the uniquely named
      // worker in the host's live registry instead of inventing an id.
      const agentId = result.agentId ?? (await $.agent.list()).find(a => a.name === name)?.id;
      if (!agentId) throw new Error('Host returned no agent id and no matching worker was registered');
      await update($, s => {
        s.board = bindAgent(requireBoard(s.board), id, agentId);
        const early = earlyCompletions.get(agentId);
        if (early) { s.board = complete(s.board, agentId, early); earlyCompletions.delete(agentId); }
        return s;
      });
    } catch (error) {
      await update($, s => ({ ...s, board: spawnFailed(requireBoard(s.board), id, errorMessage(error)) }));
    } finally { spawning -= 1; }
  }
  await notifyIfSettled($);
  return toolResult({ ...status(), instruction: 'Workers run in the background. End this turn with a short progress update; the plugin queues a continuation when the batch finishes. Do not poll or relaunch.' });
}

export function register(on: On): void {
  on('session.start', async ($, event, next) => {
    await initialize($);
    return next(event);
  });

  on('command.run', { command: 'ma' }, async ($, e) => {
    await initialize($);
    try {
      const args = e.args.trim(), command = args.split(/\s/)[0] || 'status';
      if (command === 'config') return { text: JSON.stringify({ ...config, ...(configError ? { error: configError } : {}) }, null, 2) };
      if (command === 'status') return { text: JSON.stringify(status(), null, 2) };
      if (command === 'off') {
        await update($, s => ({ ...s, enabled: false }));
        return { text: 'Multiagent disabled. Running workers remain tracked; no new work will be launched.' };
      }
      await ensureProject($);
      if (command === 'reset') {
        if (state.board?.tasks.some(isActive)) throw new Error('Cannot reset while workers are active');
        await update($, s => ({ ...s, board: null }));
        return { text: 'Task board cleared. Existing file changes were preserved.' };
      }
      if (command === 'on' || command === 'run' || command === 'resume') {
        const goal = args.slice(command.length).trim();
        if (command === 'run' && !goal) throw new Error('Usage: /ma run <goal>');
        await update($, s => ({ ...s, enabled: true }));
        if (command === 'run') queueContinuation($, goal);
        if (command === 'resume') queueContinuation($, 'Resume the multiagent task board: inspect status, review reports, and continue ready tasks.');
        return { text: `Multiagent enabled. Planner model: ${config.models.planning}`, context: [PLANNER_PROMPT] };
      }
      return { text: 'Usage: /ma run <goal> | resume | on | off | status | config | reset' };
    } catch (error) { return { text: '[multiagent] ' + errorMessage(error) }; }
  });

  on('prompt.submit', async ($, e, next) => {
    await initialize($);
    if (!state.enabled || e.text.startsWith('/') || e.context?.includes(PLANNER_PROMPT)) return next(e);
    return next({ ...e, context: [...(e.context ?? []), PLANNER_PROMPT] });
  });

  on('turn.step', async function* ($, e, next) {
    await initialize($);
    if (e.agentId) {
      const task = await findWorkerTask($, e.agentId);
      if (task && isActive(task)) return yield* next({ ...e, model: task.route.model, ...(task.route.effort ? { effort: task.route.effort } : {}) });
    } else if (state.enabled && !configError) {
      return yield* next({ ...e, model: config.models.planning, ...(config.effort.planning ? { effort: config.effort.planning } : {}) });
    }
    return yield* next(e);
  });

  on('tool.call', { tool: 'mcp__multiagent__tasks' }, async ($, e, next) => {
    await initialize($);
    if (e.agentId) return { deny: 'Only the main planner can manage tasks' };
    try {
      if (e.action === 'status') return toolResult(status());
      await ensureProject($);
      if (!state.enabled) throw new Error('Enable the planner with /ma on or /ma run <goal>');
      if (e.action === 'create') {
        await update($, s => ({ ...s, board: createBoard(e.goal, e.tasks, config, s.board) }));
      } else {
        if (!state.board) throw new Error('Create a plan first');
        if (e.action === 'run') return await runTasks($, e.ids, next.signal);
        await update($, s => {
          const board = requireBoard(s.board);
          if (e.action === 'add') s.board = addTasks(board, e.tasks, config);
          else if (e.action === 'review') s.board = review(board, e.id, e.accept, e.evidence);
          else if (e.action === 'retry') s.board = retry(board, e.id, e.feedback, config);
          else if (e.action === 'cancel') s.board = cancel(board, e.id, e.evidence);
          else throw new Error(`Unknown action: ${e.action}`);
          return s;
        });
      }
      return toolResult(status());
    } catch (error) { return toolResult({ ...status(), error: errorMessage(error) }, true); }
  });

  // The planner needs this schema even on gateways without ToolSearch support.
  on('tool.describe', { tool: 'mcp__multiagent__tasks' }, ($, e) => ({
    description: e.description,
    isDeferred: false,
  }));

  // Separate hooks still run inside children spawned by the task-tool hook.
  on('tool.call', async ($, e, next) => {
    if (e.agentId && ['Agent', 'Task'].includes(e.tool)) {
      const tracked = state?.board?.tasks.some(t => t.agentId === e.agentId);
      if (tracked) return { deny: 'Managed workers cannot spawn nested agents' };
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId;
    if (!agentId) return next(e);
    await initialize($);
    await update($, s => {
      if (s.board?.tasks.some(t => t.agentId === agentId)) s.board = complete(s.board, agentId, e);
      else if (spawning > 0) {
        earlyCompletions.set(agentId, { answer: e.answer, reason: e.reason, isAborted: e.isAborted, durationMs: e.durationMs, usage: e.usage });
        if (earlyCompletions.size > 64) {
          const oldest = earlyCompletions.keys().next();
          if (!oldest.done) earlyCompletions.delete(oldest.value);
        }
      }
      return s;
    });
    await notifyIfSettled($);
    return next(e);
  });
}
