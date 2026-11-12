import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, route } from '../lib/config.mjs';
import { createBoard, addTasks, reserve, bindAgent, complete, review, retry, cancel, recover, view, conflicts } from '../lib/board.mjs';
const config = resolveConfig();
const task = (id, extra = {}) => ({ id, role: 'explorer', goal: `Inspect ${id}`, acceptance: ['Return concrete evidence'], ...extra });
const board = (tasks = [task('a')]) => createBoard('Example goal', tasks, config);

test('resolves aliases, explicit override and process precedence without leaking secrets', () => {
  const c = resolveConfig({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast-v1', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_DEFAULT_OPUS_MODEL: 'strong' } },
    { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast-v2' }, { models: { coding: 'custom-coder' } });
  assert.equal(c.models.fast, 'fast-v2'); assert.equal(c.models.planning, 'strong'); assert.equal(c.models.coding, 'custom-coder');
  assert.ok(!JSON.stringify(c).includes('secret'));
});
test('rejects malformed config and unknown keys', () => {
  for (const custom of [{ maxParallel: 0 }, { models: { nope: 'x' } }, { effort: { fast: 'banana' } }, { maxAttempts: 50 }, { model: 'x' }]) assert.throws(() => resolveConfig({}, {}, custom));
});
test('routes complex tasks and retries to reasoning, preserves explicit first-attempt choice', () => {
  assert.equal(route({ role: 'explorer', attempts: 1 }, config).profile, 'fast');
  assert.equal(route({ role: 'implementer', complexity: 'complex', attempts: 1 }, config).profile, 'reasoning');
  assert.equal(route({ role: 'explorer', profile: 'fast', attempts: 2 }, config).profile, 'reasoning');
});
test('rejects cycles, missing dependencies, duplicates, empty acceptance and unsafe scope', () => {
  for (const specs of [[task('a', { dependsOn: ['b'] })], [task('a'), task('a')], [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })], [task('a', { acceptance: [] })], [task('a', { scope: ['../outside'] })], [task('a', { role: 'implementer' })]]) assert.throws(() => board(specs));
});
test('only explicit acceptance unlocks dependencies', () => {
  let b = board([task('a'), task('b', { dependsOn: ['a'] })]);
  assert.throws(() => reserve(b, ['b'], config), /unaccepted/);
  b = bindAgent(reserve(b, ['a'], config), 'a', 'agent-a');
  b = complete(b, 'agent-a', { answer: 'done', reason: 'answer' });
  assert.equal(b.tasks[0].status, 'reported');
  assert.throws(() => reserve(b, ['b'], config), /unaccepted/);
  b = review(b, 'a', true, 'Read the cited source; evidence matches acceptance');
  assert.equal(reserve(b, ['b'], config).tasks[1].status, 'starting');
});
test('reservations are atomic and prevent duplicate dispatch', () => {
  const b = board([task('a'), task('b', { dependsOn: ['a'] })]);
  assert.throws(() => reserve(b, ['a', 'b'], config));
  assert.equal(b.tasks[0].status, 'pending'); assert.equal(b.totalSpawns, 0);
  const reserved = reserve(b, ['a'], config);
  assert.throws(() => reserve(reserved, ['a'], config), /not pending/);
});
test('allows independent readers and disjoint writers, rejects overlapping scopes', () => {
  assert.equal(reserve(board([task('a'), task('b')]), ['a', 'b'], config).totalSpawns, 2);
  const a = task('a', { role: 'implementer', scope: ['src/a'] });
  const b = task('b', { role: 'implementer', scope: ['src/b'] });
  assert.equal(reserve(board([a, b]), ['a', 'b'], config).totalSpawns, 2);
  assert.throws(() => reserve(board([a, task('b', { scope: ['src/a/file.ts'] })]), ['a', 'b'], config), /overlaps/);
  assert.equal(conflicts({ ...a, scope: ['SRC'] }, b), true);
});
test('parallel and spawn budgets are enforced', () => {
  assert.throws(() => reserve(board([task('a'), task('b'), task('c')]), ['a', 'b', 'c'], config));
  assert.throws(() => reserve(board([task('a'), task('b')]), ['a', 'b'], { ...config, maxTotalSpawns: 1 }), /budget/);
});
test('rejection requires feedback, escalates next attempt, and preserves previous report', () => {
  let b = bindAgent(reserve(board(), ['a'], config), 'a', 'agent-a');
  b = complete(b, 'agent-a', { answer: 'insufficient', reason: 'answer' });
  b = review(b, 'a', false, 'Missing concrete evidence');
  assert.throws(() => retry(b, 'a', '', config));
  b = reserve(retry(b, 'a', 'Cite actual symbols and lines', config), ['a'], config);
  assert.equal(b.tasks[0].route.profile, 'reasoning'); assert.equal(b.tasks[0].history[0].report, 'insufficient');
  b = complete(bindAgent(b, 'a', 'agent-b'), 'agent-b', { reason: 'error', answer: 'failed' });
  assert.throws(() => retry(b, 'a', 'again', config), /limit/);
});
test('late/duplicate completion cannot reopen accepted work or a new attempt', () => {
  let b = bindAgent(reserve(board(), ['a'], config), 'a', 'old');
  b = review(complete(b, 'old', { reason: 'answer', answer: 'ok' }), 'a', true, 'Verified');
  assert.equal(complete(b, 'old', { reason: 'error' }).tasks[0].status, 'done');
});
test('aborts/errors never become reported and resume marks missing workers interrupted', () => {
  const b = bindAgent(reserve(board(), ['a'], config), 'a', 'agent-a');
  assert.equal(complete(b, 'agent-a', { reason: 'aborted', isAborted: true }).tasks[0].status, 'failed');
  assert.equal(recover(b, []).tasks[0].reason, 'interrupted');
  assert.equal(recover(b, [{ id: 'agent-a', status: 'running' }]).tasks[0].status, 'running');
});
test('bounded reports and validated replanning', () => {
  let b = bindAgent(reserve(board(), ['a'], config), 'a', 'agent-a');
  b = complete(b, 'agent-a', { reason: 'answer', answer: 'a'.repeat(13000) });
  assert.equal(b.tasks[0].report.length, 12000); assert.equal(b.tasks[0].reportTruncated, true);
  assert.throws(() => createBoard('new', [task('b')], config, b));
  b = addTasks(b, [task('b', { dependsOn: ['a'] })], config);
  b = cancel(b, 'b', 'Plan revised'); assert.equal(view(b).tasks[1].status, 'cancelled');
});
