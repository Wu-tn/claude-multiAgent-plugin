import { isOneOf, isRecord } from './validation.ts';

export const ROLE_PROFILES = Object.freeze({
  explorer: 'fast', debugger: 'reasoning', implementer: 'coding',
  verifier: 'coding', reviewer: 'review',
} as const);
export const PROFILES = ['fast', 'coding', 'reasoning', 'planning', 'review'] as const;
export const COMPLEXITIES = ['simple', 'normal', 'complex'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Role = keyof typeof ROLE_PROFILES;
export type Profile = typeof PROFILES[number];
export type Complexity = typeof COMPLEXITIES[number];
export type Effort = typeof EFFORTS[number];

export interface Config {
  models: Record<Profile, string>;
  effort: Partial<Record<Profile, Effort>>;
  maxParallel: number;
  maxTasks: number;
  maxAttempts: number;
  maxTotalSpawns: number;
  maxTurns: number;
  ignoredGlobalSubagentModel: boolean;
}

export interface Route {
  profile: Profile;
  model: string;
  effort?: Effort;
}

interface RouteInput {
  role: Role;
  attempts: number;
  complexity?: Complexity;
  profile?: Profile;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.hasOwn(ROLE_PROFILES, value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be ${min}..${max}`);
  return n;
}

/** Only model-selection fields leave this function; never copy credentials into state. */
export function resolveConfig(
  settings: Readonly<Record<string, unknown>> = {},
  processEnv: Readonly<Record<string, string | undefined>> = {},
  custom: unknown = {},
): Config {
  const input = record(custom, 'config');
  const keys = ['models', 'effort', 'maxParallel', 'maxTasks', 'maxAttempts', 'maxTotalSpawns', 'maxTurns'];
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`Unknown config key: ${key}`);

  const settingsEnv = isRecord(settings.env) ? settings.env : {};
  const env = (key: string): string | undefined => {
    const value = processEnv[key] || settingsEnv[key];
    return typeof value === 'string' ? value : undefined;
  };
  const aliases = new Map([
    ['haiku', env('ANTHROPIC_DEFAULT_HAIKU_MODEL') || 'haiku'],
    ['sonnet', env('ANTHROPIC_DEFAULT_SONNET_MODEL') || 'sonnet'],
    ['opus', env('ANTHROPIC_DEFAULT_OPUS_MODEL') || 'opus'],
  ]);
  const modelFor = (name: string) => aliases.get(name) ?? name;
  const models: Record<Profile, string> = {
    fast: modelFor('haiku'), coding: modelFor('sonnet'), reasoning: modelFor('opus'),
    planning: modelFor('opus'), review: modelFor('opus'),
  };
  for (const [profile, value] of Object.entries(record(input.models ?? {}, 'models'))) {
    if (!isOneOf(PROFILES, profile)) throw new Error(`Unknown model profile: ${profile}`);
    if (typeof value !== 'string' || !value.trim() || value.length > 160 || /\s/.test(value)) throw new Error(`Invalid model for ${profile}`);
    models[profile] = modelFor(value);
  }
  const effort: Config['effort'] = {};
  for (const [profile, value] of Object.entries(record(input.effort ?? {}, 'effort'))) {
    if (!isOneOf(PROFILES, profile)) throw new Error(`Unknown effort profile: ${profile}`);
    if (!isOneOf(EFFORTS, value)) throw new Error(`Invalid effort for ${profile}`);
    effort[profile] = value;
  }
  return {
    models, effort,
    maxParallel: integer(input.maxParallel, 2, 1, 6, 'maxParallel'),
    maxTasks: integer(input.maxTasks, 16, 1, 32, 'maxTasks'),
    maxAttempts: integer(input.maxAttempts, 2, 1, 3, 'maxAttempts'),
    maxTotalSpawns: integer(input.maxTotalSpawns, 24, 1, 64, 'maxTotalSpawns'),
    maxTurns: integer(input.maxTurns, 30, 1, 100, 'maxTurns'),
    ignoredGlobalSubagentModel: Boolean(env('CLAUDE_CODE_SUBAGENT_MODEL')),
  };
}

export function chooseProfile(task: RouteInput): Profile {
  if (task.profile) return task.profile;
  if (task.attempts > 1 || task.complexity === 'complex') return 'reasoning';
  return ROLE_PROFILES[task.role];
}

export function route(task: RouteInput, config: Config): Route {
  // An explicit profile is honoured on the first attempt; retries escalate.
  const profile = task.attempts > 1 ? 'reasoning' : chooseProfile(task);
  const effort = config.effort[profile];
  return { profile, model: config.models[profile], ...(effort ? { effort } : {}) };
}
