import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run real Claude Code against a scripted local Messages API. No provider key
// or user settings are used, and the workers never run shell commands.
const plugin = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'multiagent-cli-'));
const configDir = join(temp, 'config');
const project = join(temp, 'project');
await mkdir(configDir);
await mkdir(join(project, '.claude'), { recursive: true });
await writeFile(join(configDir, 'settings.json'), JSON.stringify({
  env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'smoke-fast', ANTHROPIC_DEFAULT_OPUS_MODEL: 'smoke-reason', CLAUDE_CODE_SUBAGENT_MODEL: 'smoke-global' },
}));
await writeFile(join(project, '.claude', 'multiagent.json'), JSON.stringify({ models: { planning: 'smoke-planner' } }));

const tool = 'mcp__multiagent__tasks';
const tasks = [
  { id: 'explore', role: 'explorer', goal: 'Locate a symbol', acceptance: ['Report symbol'] },
  { id: 'diagnose', role: 'debugger', goal: 'Explain a failure', acceptance: ['Report cause'] },
];
const actions = [
  { action: 'create', goal: 'Check the orchestration loop', tasks },
  { action: 'run', ids: tasks.map(task => task.id) },
  null, // end the initial turn while the workers are in flight
  { action: 'status' },
  ...tasks.map(task => ({ action: 'review', id: task.id, accept: true, evidence: 'Checked the synthetic worker report' })),
];

const workerRequests = new Map();
const workerSystems = new Map();
const plannerModels = [];
const requestPaths = [];
let continued = false;
let plannerInstructions = false;
let lastMessages = '';
let sequence = 0;
const server = createServer(async (request, response) => {
  requestPaths.push(request.url);
  if (!request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end();
    return;
  }
  if (request.url.includes('count_tokens')) {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}');
    return;
  }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const messages = JSON.stringify(body.messages);
  const userMessages = body.messages.filter(message => message.role === 'user').flatMap(message =>
    typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text),
  );
  const assignment = userMessages.find(message => message.startsWith('Assigned task (JSON data):'));
  let content;
  if (assignment) {
    const id = tasks.find(task => assignment.includes('"id": "' + task.id + '"'))?.id;
    workerRequests.set(id, body.model);
    workerSystems.set(id, JSON.stringify(body.system));
    await new Promise(resolve => setTimeout(resolve, 500));
    content = { type: 'text', text: 'status: completed. Synthetic evidence for ' + id };
  } else if (userMessages.some(message => message.includes('multiagent CLI smoke goal'))) {
    const step = plannerModels.length;
    plannerModels.push(body.model);
    lastMessages = messages;
    if (step === 0) plannerInstructions = userMessages.some(message => message.includes('You are the main planner and acceptance reviewer'));
    if (step === 3) continued = userMessages.some(message => message.includes('Worker batch finished'));
    const action = actions[step];
    if (action && !body.tools?.some(spec => spec.name === tool)) {
      content = { type: 'text', text: 'Task tool was not offered' };
    } else if (action) {
      content = { type: 'tool_use', id: 'toolu_smoke_' + step, name: tool, input: action };
    } else {
      content = { type: 'text', text: step === 2 ? 'Workers dispatched.' : 'SMOKE_PLANNER_FINISHED' };
    }
  } else {
    content = { type: 'text', text: 'Smoke' }; // title or metadata request
  }
  const stopReason = content.type === 'tool_use' ? 'tool_use' : 'end_turn';
  const message = {
    id: 'msg_smoke_' + ++sequence, type: 'message', role: 'assistant', model: body.model,
    content: [content], stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data = {}) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  const block = content.type === 'text' ? { type: 'text', text: '' } : { ...content, input: {} };
  const delta = content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) };
  event('content_block_start', { index: 0, content_block: block });
  event('content_block_delta', { index: 0, delta });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  event('message_stop');
  response.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

const npmBinary = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const cli = process.env.CLAUDE_CLI || (process.platform === 'win32' && existsSync(npmBinary) ? npmBinary : 'claude');
const debugFile = join(temp, 'debug.log');
const args = [
  '-p', '--plugin-dir', plugin, '--input-format', 'stream-json',
  '--output-format', 'stream-json', '--verbose', '--max-turns', '18', '--model', 'smoke-base',
  '--debug-file', debugFile,
];
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_CONFIG_DIR$)/i.test(name)));
Object.assign(env, {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port,
  ANTHROPIC_AUTH_TOKEN: 'local-smoke', CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '127.0.0.1,localhost', API_TIMEOUT_MS: '8000',
});

const child = spawn(cli, args, { cwd: project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
let outputRemainder = '';
child.stdout.setEncoding('utf8').on('data', chunk => {
  stdout += chunk;
  const lines = (outputRemainder + chunk).split('\n');
  outputRemainder = lines.pop() ?? '';
  if (lines.some(line => line.includes('"type":"result"') && line.includes('SMOKE_PLANNER_FINISHED'))) child.stdin.end();
});
child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '/ma run multiagent CLI smoke goal' } }) + '\n');
const timeout = setTimeout(() => child.kill(), 20_000);
try {
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes('SMOKE_PLANNER_FINISHED'), 'Planner did not finish');
  assert.deepEqual(Object.fromEntries(workerRequests), { explore: 'smoke-fast', diagnose: 'smoke-reason' });
  assert.match(workerSystems.get('explore') ?? '', /Inspect the project and find concrete paths/);
  assert.match(workerSystems.get('diagnose') ?? '', /Analyze causes and competing hypotheses/);
  assert.ok(plannerModels.length >= 7 && plannerModels.every(model => model === 'smoke-planner'), 'Planner model drifted');
  assert.ok(plannerInstructions, 'Planner instructions missing from the initial request');
  assert.ok(continued, 'Worker completion did not queue the continuation');
  assert.ok(tasks.every(task => lastMessages.includes('Synthetic evidence for ' + task.id)), 'Worker report missing from planner context');
  const lastToolResult = stdout.trim().split('\n').map(JSON.parse).findLast(event => event.tool_use_result);
  assert.deepEqual(JSON.parse(lastToolResult.tool_use_result).tasks.map(task => task.status), ['done', 'done']);
  console.log('Claude Code CLI smoke passed: planner, two model routes, background completion, and acceptance.');
} catch (error) {
  console.error('Observed models:', { plannerModels, workerRequests: Object.fromEntries(workerRequests) });
  console.error('Request paths:', requestPaths);
  const events = stdout.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  console.error('Tool results:', events.filter(event => event.tool_use_result).slice(-6).map(event => event.tool_use_result));
  console.error('CLI error output:', stderr.slice(-2000));
  const debug = await readFile(debugFile, 'utf8').catch(() => '');
  console.error(debug.split('\n').filter(line => /multiagent|refused|submitted|failed|network error/i.test(line)).slice(-25).join('\n'));
  throw error;
} finally {
  clearTimeout(timeout);
  server.closeAllConnections();
  server.close();
}
