import { expect, test, mock } from 'claude-code/testing';

function setup(on, options = {}) {
  mock.store(on, options.saved ?? {});
  mock.env(on, {});
  on('session.id', () => ({ value: 'test-session' }));
  on('session.cwd', () => ({ value: 'C:/project' }));
  on('settings.read', () => ({ value: { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'strong-model', ANTHROPIC_DEFAULT_SONNET_MODEL: 'coding-model', CLAUDE_CODE_SUBAGENT_MODEL: 'global-wrong-model' } } }));
  on('fs.read', () => ({ value: options.configText ?? '{}' }));
  on('agent.list', () => ({ value: options.agents ?? [] }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('tool.register', ($, e) => ({ value: { tool: `mcp__multiagent__${e.name}` } }));
  on('agent.register', ($, e) => ({ value: { agent: `multiagent:${e.name}` } }));
  on('ui.log', () => ({ value: undefined }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  return mock.clock(on);
}
const spec = id => ({ id, role: 'explorer', goal: `Inspect ${id}`, scope: ['.'], acceptance: ['Cite actual paths'] });
const call = (action, extra = {}) => ({ tool: 'mcp__multiagent__tasks', action, ...extra });
const readBoard = reply => JSON.parse(reply.result);
const done = (agentId, answer = 'Found src/a.ts') => ({ agentId, turnId: `turn-${agentId}`, answer, durationMs: 10, isAborted: false, reason: 'answer' });

test('loads real host hooks, resolves model config and keeps routing opt-in', async ($, on) => {
  setup(on);
  const status = await $.command.run({ command: 'ma', args: 'status' });
  expect(JSON.parse(status.text).enabled).toBe(false);
  const config = JSON.parse((await $.command.run({ command: 'ma', args: 'config' })).text);
  expect(config.models.fast).toBe('fast-model');
  expect(config.models.planning).toBe('strong-model');
  expect(config.ignoredGlobalSubagentModel).toBe(true);
});

test('restores an accepted task saved by the JavaScript version', async ($, on) => {
  setup(on, {
    saved: {
      'session:test-session': {
        version: 1, enabled: true, cwd: 'C:/project',
        board: {
          version: 1, goal: 'Existing work', createdAt: 1, totalSpawns: 1, notifiedSpawns: 1,
          tasks: [{
            ...spec('a'), context: '', dependsOn: [], complexity: 'normal',
            attempts: 1, history: [], status: 'done', agentId: 'worker-a',
            route: { profile: 'fast', model: 'fast-model' }, startedAt: 2, finishedAt: 3,
            report: 'Found src/a.ts', reason: 'answer', review: 'Inspected the cited file',
          }],
        },
      },
    },
  });
  const status = readBoard(await $.tool.call(call('status')));
  expect(status.enabled).toBe(true);
  expect(status.tasks[0].status).toBe('done');
  expect(status.tasks[0].review).toBe('Inspected the cited file');
});

test('dispatches two workers, records completion, and queues exactly one planner continuation', async ($, on) => {
  const spawned = [], notifications = [], agents = [];
  const clock = setup(on, { agents });
  on('agent.spawn', ($, e) => { spawned.push(e); agents.push({ id: `worker-${spawned.length}`, name: e.name, status: 'running' }); return { model: 'host-default' }; });
  on('prompt.submit', ($, e) => { notifications.push(e.text); return { text: e.text }; });
  await $.command.run({ command: 'ma', args: 'on' });
  await $.tool.call(call('create', { goal: 'Inspect two modules', tasks: [spec('a'), spec('b')] }));
  const run = await $.tool.call(call('run', { ids: ['a', 'b'] }));
  expect(spawned.length).toBe(2);
  expect(spawned[0].prompt).toContain('Inspect a');
  expect(readBoard(run).tasks[0].route.model).toBe('fast-model');
  expect(readBoard(run).tasks[0].report ?? '').toBe('');
  expect(readBoard(run).tasks[0].status).toBe('running');
  await $.turn.complete(done('worker-1'));
  expect(notifications.length).toBe(0);
  await $.turn.complete(done('worker-2'));
  await clock.advance(10);
  expect(notifications.length).toBe(1);
  await $.turn.complete(done('worker-2'));
  await clock.advance(10);
  expect(notifications.length).toBe(1);
  expect(readBoard(await $.tool.call(call('status'))).tasks[0].status).toBe('reported');
});

test('guards dependencies, blocks duplicate dispatch and requires acceptance', async ($, on) => {
  const agents = [];
  setup(on, { agents });
  on('agent.spawn', ($, e) => { agents.push({ id: 'worker-a', name: e.name, status: 'running' }); return { model: 'host-default' }; });
  on('prompt.submit', ($, e) => ({ text: e.text }));
  await $.command.run({ command: 'ma', args: 'on' });
  await $.tool.call(call('create', { goal: 'Dependent work', tasks: [spec('a'), { ...spec('b'), dependsOn: ['a'] }] }));
  expect((await $.tool.call(call('run', { ids: ['b'] }))).isError).toBe(true);
  await $.tool.call(call('run', { ids: ['a'] }));
  expect((await $.tool.call(call('run', { ids: ['a'] }))).isError).toBe(true);
  await $.turn.complete(done('worker-a'));
  expect((await $.tool.call(call('run', { ids: ['b'] }))).isError).toBe(true);
  await $.tool.call(call('review', { id: 'a', accept: true, evidence: 'Inspected cited files' }));
  expect(readBoard(await $.tool.call(call('status'))).tasks[1].ready).toBe(true);
});

test('workers cannot manage the board; off prevents launches but keeps completion records', async ($, on) => {
  const agents = [];
  setup(on, { agents });
  on('agent.spawn', ($, e) => { agents.push({ id: 'worker-a', name: e.name, status: 'running' }); return { model: 'host-default' }; });
  await $.command.run({ command: 'ma', args: 'on' });
  await $.tool.call(call('create', { goal: 'Work', tasks: [spec('a')] }));
  await $.tool.call(call('run', { ids: ['a'] }));
  expect((await $.tool.call({ ...call('status'), agentId: 'worker-a' })).deny).toBe('Only the main planner can manage tasks');
  await $.command.run({ command: 'ma', args: 'off' });
  await $.turn.complete(done('worker-a'));
  expect(readBoard(await $.tool.call(call('status'))).tasks[0].status).toBe('reported');
  expect((await $.tool.call(call('retry', { id: 'a', feedback: 'retry' }))).isError).toBe(true);
});

test('completion before spawn returns is not lost', async ($, on) => {
  const agents = [];
  setup(on, { agents });
  on('prompt.submit', ($, e) => ({ text: e.text }));
  on('agent.spawn', async (_host, e) => {
    await $.turn.complete(done('very-fast-worker'));
    agents.push({ id: 'very-fast-worker', name: e.name, status: 'completed' });
    return { model: 'host-default' };
  });
  await $.command.run({ command: 'ma', args: 'on' });
  await $.tool.call(call('create', { goal: 'Fast work', tasks: [spec('a')] }));
  const result = await $.tool.call(call('run', { ids: ['a'] }));
  expect(readBoard(result).tasks[0].status).toBe('reported');
});

test('malformed config disables dispatch and shows a useful error', async ($, on) => {
  setup(on, { configText: '{ bad json' });
  const result = await $.command.run({ command: 'ma', args: 'on' });
  expect(result.text).toContain('Cannot read .claude/multiagent.json');
  expect(readBoard(await $.tool.call(call('status'))).enabled).toBe(false);
});

test('spawn denial is a failed task and retry upgrades the model', async ($, on) => {
  setup(on);
  on('agent.spawn', () => ({ deny: 'Permission denied by host' }));
  on('prompt.submit', ($, e) => ({ text: e.text }));
  await $.command.run({ command: 'ma', args: 'on' });
  await $.tool.call(call('create', { goal: 'Work', tasks: [spec('a')] }));
  const first = readBoard(await $.tool.call(call('run', { ids: ['a'] }))).tasks[0];
  expect(first.status).toBe('failed');
  expect(first.route.model).toBe('fast-model');
  await $.tool.call(call('retry', { id: 'a', feedback: 'Inspect the permission blocker; do not bypass it' }));
  const second = readBoard(await $.tool.call(call('run', { ids: ['a'] }))).tasks[0];
  expect(second.route.model).toBe('strong-model');
});

test('concurrent duplicate run calls reserve a task only once', async ($, on) => {
  const agents = [];
  setup(on, { agents });
  let count = 0;
  on('agent.spawn', ($, e) => { count++; agents.push({ id: 'worker-a', name: e.name, status: 'running' }); return { model: 'host-default' }; });
  await $.command.run({ command: 'ma', args: 'on' });
  await $.tool.call(call('create', { goal: 'Work', tasks: [spec('a')] }));
  const results = await Promise.all([$.tool.call(call('run', { ids: ['a'] })), $.tool.call(call('run', { ids: ['a'] }))]);
  expect(count).toBe(1);
  expect(results.filter(r => r.isError).length).toBe(1);
});
