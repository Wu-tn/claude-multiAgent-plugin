export const ROLE_PROFILES = Object.freeze({
  explorer: 'fast', debugger: 'reasoning', implementer: 'coding',
  verifier: 'coding', reviewer: 'review',
});
export const PROFILES = ['fast', 'coding', 'reasoning', 'planning', 'review'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function known(value, keys, label) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label}: ${key}`);
}
function integer(value, fallback, min, max, label) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be ${min}..${max}`);
  return n;
}

/** Only model-selection fields leave this function; never copy credentials into state. */
export function resolveConfig(settings = {}, processEnv = {}, custom = {}) {
  record(custom, 'config');
  known(custom, ['models', 'effort', 'maxParallel', 'maxTasks', 'maxAttempts', 'maxTotalSpawns', 'maxTurns'], 'config key');
  const env = { ...settings.env };
  for (const [key, value] of Object.entries(processEnv)) if (value) env[key] = value;
  const aliases = {
    haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'haiku',
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'sonnet',
    opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'opus',
  };
  const models = { fast: aliases.haiku, coding: aliases.sonnet, reasoning: aliases.opus, planning: aliases.opus, review: aliases.opus };
  record(custom.models ?? {}, 'models');
  known(custom.models ?? {}, PROFILES, 'model profile');
  for (const [profile, value] of Object.entries(custom.models ?? {})) {
    if (typeof value !== 'string' || !value.trim() || value.length > 160 || /\s/.test(value)) throw new Error(`Invalid model for ${profile}`);
    models[profile] = aliases[value] || value;
  }
  const effort = { ...custom.effort };
  record(custom.effort ?? {}, 'effort');
  known(effort, PROFILES, 'effort profile');
  for (const [profile, value] of Object.entries(effort)) if (!EFFORTS.includes(value)) throw new Error(`Invalid effort for ${profile}`);
  return {
    models, effort,
    maxParallel: integer(custom.maxParallel, 2, 1, 6, 'maxParallel'),
    maxTasks: integer(custom.maxTasks, 16, 1, 32, 'maxTasks'),
    maxAttempts: integer(custom.maxAttempts, 2, 1, 3, 'maxAttempts'),
    maxTotalSpawns: integer(custom.maxTotalSpawns, 24, 1, 64, 'maxTotalSpawns'),
    maxTurns: integer(custom.maxTurns, 30, 1, 100, 'maxTurns'),
    ignoredGlobalSubagentModel: Boolean(env.CLAUDE_CODE_SUBAGENT_MODEL),
  };
}

export function chooseProfile(task) {
  if (task.profile) return task.profile;
  if (task.attempts > 1 || task.complexity === 'complex') return 'reasoning';
  return ROLE_PROFILES[task.role];
}

export function route(task, config) {
  // An explicit profile is honoured on the first attempt; retries escalate.
  const profile = task.attempts > 1 ? 'reasoning' : chooseProfile(task);
  return { profile, model: config.models[profile], ...(config.effort[profile] ? { effort: config.effort[profile] } : {}) };
}
