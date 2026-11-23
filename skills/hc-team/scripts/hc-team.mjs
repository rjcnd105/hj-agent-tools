#!/usr/bin/env node
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { appendFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { scanServers } from './servers.mjs';

const exec = promisify(execFile);
const presetId = '^[a-z0-9][a-z0-9-]{0,31}$';
const roleId = '^(?!parent$)[a-z0-9][a-z0-9_-]{0,23}$';
const serverId = '^[a-z0-9][a-z0-9_-]{0,15}$';
const runIdPattern = /^[a-z0-9]{6}$/;
const string = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: string, default: [] };
const command = { type: 'array', items: string, minItems: 1 };
const expandHome = value => (value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
export function getPresetsDir() {
  const configured = [process.env.HERDR_MOD_HJ_TEAM_DIR, process.env.HC_TEAM_PRESETS_DIR]
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  return resolve(configured ? expandHome(configured) : join(homedir(), '.herdr', 'hj-team'));
}
export function getMachineConfigPath() {
  const configured = typeof process.env.HC_TEAM_MACHINE_CONFIG === 'string' ? process.env.HC_TEAM_MACHINE_CONFIG.trim() : '';
  return resolve(configured ? expandHome(configured) : join(homedir(), '.config', 'hc-team', 'machine.json'));
}
const runsDir = join(homedir(), '.local/state/hc-team/runs');
const builtinsDir = fileURLToPath(new URL('../../../presets/', import.meta.url));
const qaSkills = new Set(['ego-browser', 'ego-recorder', 'input-replay']);
const kinds = new Set(['handoff', 'result', 'review', 'blocked', 'ask']);
const runLabel = 'hc.team.run';
const roleLabel = 'hc.team.role';
const serverLabel = 'hc.team.server';
const presetLabel = 'hc.team.preset';
const parentLabel = 'hc.team.parent';
const cwdLabel = 'hc.team.cwd';
const lastLabel = 'hc.team.last';

export const PRESET_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'hc-team preset v1',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'name', 'roles'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    id: { type: 'string', pattern: presetId },
    name: { ...string, maxLength: 80 },
    description: { type: 'string', maxLength: 400, default: '' },
    servers: {
      type: 'array', default: [], $comment: 'Server IDs must be unique.',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'command'],
        properties: {
          id: { type: 'string', pattern: serverId }, command,
          cwd: { ...string, pattern: '^(?![\\\\/]|[a-zA-Z]:)(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$))[^\\u0000\\r\\n]+$', default: '.' },
        },
      },
    },
    roles: {
      type: 'array', minItems: 1, maxItems: 12, $comment: 'Role IDs must be unique.',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'title', 'instructions'],
        oneOf: [{ required: ['route'] }, { required: ['command'] }],
        properties: {
          id: { type: 'string', pattern: roleId },
          title: { ...string, maxLength: 60 }, command, route: { type: 'string', pattern: presetId },
          default: { type: 'boolean', default: true },
          readOnly: { type: 'boolean', default: false },
          skills: strings, tools: strings, owns: strings, checkpoints: strings,
          talksTo: { ...strings, items: { type: 'string', pattern: roleId }, $comment: 'Each ID must refer to another role in the same preset.' },
          instructions: string,
        },
      },
    },
  },
};

const ROUTES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'reviewed', 'routes'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    reviewed: { ...string, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    routes: {
      type: 'object', propertyNames: { type: 'string', pattern: presetId },
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['command'],
        properties: { command, why: { type: 'string' } },
      },
    },
  },
};

const MACHINE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['schemaVersion'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    executables: { type: 'object', default: {}, additionalProperties: string },
    path: strings,
    env: { type: 'object', default: {}, additionalProperties: string },
    shell: { type: 'string', minLength: 1 },
  },
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value, pattern) => typeof value === 'string' && new RegExp(pattern).test(value);
const pointer = (path, key) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

// The printed schema owns field validation and defaults; the checks below it
// cover ID relationships that a static JSON Schema cannot express.
function validateShape(schema, value, path, issues) {
  const add = message => issues.push({ path, message });
  const matchesType = schema.type === 'object' ? isObject(value)
    : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type;
  if (!matchesType) return add(`Expected ${schema.type}`);
  if (schema.const !== undefined && value !== schema.const) add(`Must equal ${schema.const}`);
  if (schema.type === 'string') {
    const length = [...value].length;
    if (length < schema.minLength) add('Must not be empty');
    if (length > schema.maxLength) add(`Must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      add(path.endsWith('/cwd') ? 'Must be a relative path without .. segments' : `Must match ${schema.pattern}`);
    }
  } else if (schema.type === 'array') {
    if (value.length < schema.minItems) add(`Must have at least ${schema.minItems} item(s)`);
    if (value.length > schema.maxItems) add(`Must have at most ${schema.maxItems} item(s)`);
    value.forEach((item, i) => validateShape(schema.items, item, pointer(path, i), issues));
  } else if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) issues.push({ path: pointer(path, key), message: 'Required' });
    }
    if (schema.oneOf && schema.oneOf.filter(choice => choice.required.every(key => Object.hasOwn(value, key))).length !== 1) {
      add(`Specify exactly one of ${schema.oneOf.flatMap(choice => choice.required).join(' or ')}`);
    }
    for (const [key, item] of Object.entries(value)) {
      const field = schema.properties?.[key];
      const at = pointer(path, key);
      if (schema.propertyNames) validateShape(schema.propertyNames, key, at, issues);
      if (field && Object.hasOwn(schema.properties, key)) validateShape(field, item, at, issues);
      else if (isObject(schema.additionalProperties)) validateShape(schema.additionalProperties, item, at, issues);
      else if (!schema.additionalProperties) issues.push({ path: at, message: 'Unknown field' });
    }
  }
}

export function validatePreset(preset, routes = {}) {
  const issues = [];
  validateShape(PRESET_JSON_SCHEMA, preset, '', issues);
  for (const field of ['servers', 'roles']) {
    if (!Array.isArray(preset?.[field])) continue;
    const ids = new Set();
    for (const [index, row] of preset[field].entries()) {
      if (typeof row?.id !== 'string') continue;
      if (ids.has(row.id)) issues.push({ path: `/${field}/${index}/id`, message: `Duplicate ID ${row.id}` });
      ids.add(row.id);
    }
    if (field === 'roles') {
      for (const [index, role] of preset.roles.entries()) {
        if (routes !== null && isId(role?.route, presetId) && !Object.hasOwn(routes, role.route)) {
          const available = Object.keys(routes).sort().join(', ') || '(none)';
          issues.push({ path: `/roles/${index}/route`, message: `Unknown route ${role.route}; available routes: ${available}` });
        }
        if (!Array.isArray(role?.talksTo)) continue;
        for (const [i, target] of role.talksTo.entries()) {
          if (!isId(target, roleId)) continue;
          const path = `/roles/${index}/talksTo/${i}`;
          if (target === role.id) issues.push({ path, message: 'Cannot refer to this role' });
          else if (!ids.has(target)) issues.push({ path, message: `Unknown role ${target}` });
        }
      }
    }
  }
  return issues;
}

function applyDefaults(schema, value) {
  if (value === undefined) value = schema.default;
  if (schema.type === 'object') {
    return Object.fromEntries(Object.entries(schema.properties).flatMap(([key, field]) => {
      const val = applyDefaults(field, value[key]);
      return val === undefined ? [] : [[key, val]];
    }));
  }
  if (schema.type === 'array' && value !== undefined) return value.map(item => applyDefaults(schema.items, item));
  return value;
}

class CliError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.issues = issues;
  }
}

function checked(preset, context = 'Invalid preset', routes = null) {
  const issues = validatePreset(preset, routes);
  if (issues.length) throw new CliError(context, issues);
  return applyDefaults(PRESET_JSON_SCHEMA, preset);
}

export function mergePresetOverlay(globalPreset, overlayPreset) {
  const merged = structuredClone(globalPreset);
  if (!isObject(overlayPreset)) throw new CliError('Invalid overlay', [{ path: '', message: 'Expected object' }]);
  const issues = [];
  for (const [key, value] of Object.entries(overlayPreset)) {
    if (key === 'name' || key === 'description') {
      merged[key] = value;
    } else if (key === 'servers' || key === 'roles') {
      if (!Array.isArray(value)) {
        issues.push({ path: `/${key}`, message: 'Expected array' });
        continue;
      }
      const rows = new Map((merged[key] ?? []).map(row => [row.id, row]));
      const seen = new Set();
      const pattern = key === 'roles' ? roleId : serverId;
      for (const [i, row] of value.entries()) {
        const path = `/${key}/${i}`;
        if (!isObject(row)) {
          issues.push({ path, message: 'Expected object' });
          continue;
        }
        const { id, remove, ...fields } = row;
        if (!isId(id, pattern)) {
          issues.push({ path: `${path}/id`, message: `Must match ${pattern}` });
        } else if (seen.has(id)) {
          issues.push({ path: `${path}/id`, message: `Duplicate ID ${id}` });
        } else if (Object.hasOwn(row, 'remove') && (remove !== true || Object.keys(fields).length)) {
          issues.push({ path: `${path}/remove`, message: 'Removal must be { id, remove: true }' });
        } else {
          seen.add(id);
          if (remove) rows.delete(id);
          else if (key === 'servers') rows.set(id, structuredClone(row));
          else {
            const next = { ...rows.get(id), ...structuredClone(row) };
            const setsCommand = Object.hasOwn(row, 'command');
            const setsRoute = Object.hasOwn(row, 'route');
            if (setsCommand && !setsRoute) delete next.route;
            if (setsRoute && !setsCommand) delete next.command;
            rows.set(id, next);
          }
        }
      }
      merged[key] = [...rows.values()];
    } else {
      issues.push({ path: pointer('', key), message: 'Unknown overlay field' });
    }
  }
  if (issues.length) throw new CliError('Invalid overlay', issues);
  return merged;
}

const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
const oneLine = value => String(value).replace(/[\r\n\u2028\u2029]+/g, ' ');
const messageOf = error => error instanceof Error ? error.message : String(error);

function parseJson(text, source) {
  try { return JSON.parse(text); } catch { throw new CliError(`Invalid JSON in ${source}`); }
}

async function readBytes(path, optional = false) {
  try { return await readFile(path); } catch (error) {
    if (optional && error.code === 'ENOENT' && !await statFile(path)) return undefined;
    if (error.code === 'ENOENT') throw new CliError(`File not found: ${path}`);
    throw error;
  }
}

async function readJson(path, optional = false) {
  const bytes = await readBytes(path, optional);
  return bytes === undefined ? undefined : parseJson(bytes, path);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function atomicWrite(path, data, { replace = false, expectedSha } = {}) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(data); } finally { await file.close(); }
    if (expectedSha !== undefined) {
      const current = await readFile(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (current === undefined || sha256(current) !== expectedSha) {
        throw new CliError(`Conflict: ${basename(path)} changed or no longer exists; reload before saving`);
      }
    }
    if (replace) await rename(temp, path);
    else await link(temp, path);
    return true;
  } catch (error) {
    if (!replace && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function statFile(path) {
  return lstat(path).catch(error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

function assertPresetId(id) {
  if (!isId(id, presetId)) throw new CliError(`Invalid preset ID: ${id}`);
}

function assertRunId(id) {
  if (!runIdPattern.test(id)) throw new CliError(`Invalid run ID: ${id}`);
}

async function getRoot(cwd = process.cwd()) {
  const path = resolve(cwd);
  try {
    return (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: path })).stdout.replace(/\r?\n$/, '');
  } catch {
    if (!(await stat(path).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isDirectory()) {
      throw new CliError(`Not a directory: ${path}`);
    }
    return path;
  }
}

const overlayPath = (root, id) => join(root, 'docs/agent-presets', id);
const presetPath = id => join(getPresetsDir(), `${id}.json`);
const runPath = id => join(runsDir, id);

const routesPath = () => join(getPresetsDir(), '_routes.json');
const modelsPath = () => join(getPresetsDir(), '_models.md');
const toolsPath = () => join(getPresetsDir(), '_tools.md');

function checkedRoutes(raw) {
  const issues = [];
  validateShape(ROUTES_SCHEMA, raw, '', issues);
  if (!issues.length) {
    const reviewed = new Date(`${raw.reviewed}T00:00:00Z`);
    if (!Number.isFinite(+reviewed) || reviewed.toISOString().slice(0, 10) !== raw.reviewed) {
      issues.push({ path: '/reviewed', message: 'Expected a calendar date (YYYY-MM-DD)' });
    }
  }
  if (issues.length) throw new CliError('Invalid route table', issues);
  return raw;
}

async function loadRoutes(path = routesPath()) {
  const bytes = await readBytes(path, true);
  if (bytes === undefined) return { reviewed: null, routes: {}, routesSha: null };
  const { reviewed, routes } = checkedRoutes(parseJson(bytes, path));
  return { reviewed, routes, routesSha: sha256(bytes) };
}

function resolveRoutes(preset, routes) {
  return { ...preset, roles: preset.roles.map(role => {
    if (!role.route) return role;
    return Object.hasOwn(routes, role.route)
      ? { ...role, command: routes[role.route].command }
      : { ...role, routeError: `unknown route: ${role.route}` };
  }) };
}

async function getPreset(id, projectRoot, useOverlay = true) {
  assertPresetId(id);
  const path = presetPath(id);
  const bytes = await readBytes(path);
  const globalPreset = parseJson(bytes, path);
  const global = checked(globalPreset, `Invalid preset ${id}`);
  if (global.id !== id) throw new CliError(`Preset ID must match the filename: ${id}.json`);
  const overlayDir = overlayPath(projectRoot, id);
  const overlayFile = join(overlayDir, 'preset.json');
  let overlay, preset = global;
  if (useOverlay) {
    try {
      overlay = await readJson(overlayFile, true);
      if (overlay !== undefined) preset = checked(mergePresetOverlay(global, overlay), `Invalid merged preset ${id}`);
    } catch (error) {
      error.presetPath = overlayFile;
      throw error;
    }
  }
  return { globalPreset, globalSha: sha256(bytes), overlayDir, hasOverlay: overlay !== undefined, preset };
}

function listError(id, path, error) {
  return { id, path, message: [messageOf(error), ...(error.issues ?? []).map(({ path, message }) => `${path}: ${message}`)].join('; ') };
}

async function presetViews(projectRoot, routes, useOverlay = true) {
  const presets = [], errors = [];
  for (const file of await jsonFiles(getPresetsDir())) {
    const id = basename(file, '.json');
    try {
      const { preset, ...rest } = await getPreset(id, projectRoot, useOverlay);
      presets.push({ id, name: preset.name, description: preset.description, roleCount: preset.roles.length,
        defaultRoles: preset.roles.filter(role => role.default).map(role => role.id), ...rest, preset: resolveRoutes(preset, routes) });
    } catch (error) {
      errors.push(listError(id, error.presetPath ?? presetPath(id), error));
    }
  }
  return { presets, errors };
}

// Runtime snapshots may include a resolved command alongside its source route.
// Validate the authored shape without consulting today's route table.
async function readSnapshot(path) {
  const raw = await readJson(path);
  if (Array.isArray(raw?.roles)) raw.roles = raw.roles.map(role => {
    if (!isObject(role)) return role;
    const { route, routeError, ...fields } = role;
    return Object.hasOwn(fields, 'command') || route === undefined ? fields : { ...fields, route };
  });
  return resolveRoutes(checked(raw, 'Invalid run snapshot'), {});
}

async function jsonFiles(dir, optional = true) {
  const names = await readdir(dir).catch(error => {
    if (optional && error.code === 'ENOENT') return [];
    throw error;
  });
  return names.filter(name => name.endsWith('.json') && isId(basename(name, '.json'), presetId)).sort();
}

function qaTemplate() {
  return [
    '## Base URLs & Dev Server',
    'List each environment, its base URL, the dev-server command and working directory. Discover live run URLs with `hc-team servers --run <runId>` before testing; do not wait for a handoff.',
    '## Login & Test Accounts',
    'Link to approved test-account instructions and describe the login flow. Record pointers only; never write credentials, tokens or cookies here.',
    '## Key User Journeys',
    'List the starting route, prerequisites, steps, and expected result for each critical flow.',
    '## `ego-rec` Recordings Inventory',
    'List each recording name or path, which journey it covers, and its prerequisites and gaps.',
    '## `input-replay` Gesture Targets & Viewports',
    'For each target, record a route and stable selector, the wheel/swipe/tap gesture, CSS viewport or device, and expected scroll or snap result. Include carousels and horizontal scrollers where relevant.',
    '## Known Flaky Areas',
    'Record unstable paths, environmental conditions, and how to recognize and report a flake.',
  ].join('\n\n');
}

async function initProject(id, root) {
  assertPresetId(id);
  const realRoot = await realpath(root);
  const dir = overlayPath(root, id);
  for (const path of [join(root, 'docs'), dirname(dir), dir, join(dir, 'roles'), join(dir, 'tools')]) {
    if (!await statFile(path)) continue;
    const actual = await realpath(path);
    const within = relative(realRoot, actual);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new CliError(`Project directory escapes project root: ${path} → ${actual}`);
    }
    if (!(await stat(actual)).isDirectory()) throw new CliError(`Not a directory: ${path}`);
  }
  const { preset, overlayDir } = await getPreset(id, root);
  const files = [
    ['preset.json', '{}\n'],
    ['shared.md', `# ${preset.name} — shared project context\n\nLink to project conventions, required checks, and shared context.\n`],
    ...preset.roles.map(role => [`roles/${role.id}.md`, `# ${role.title}\n\n${
      role.id.includes('qa') || role.skills.some(skill => qaSkills.has(skill))
        ? qaTemplate()
        : '## Verified Commands & Process\nRecord exact working CLI commands, scripts, flags, and known gotchas so future runs execute without trial-and-error.\n\n## Ownership & Checkpoints\nAdd ownership boundaries, checkpoints, and relevant project links.'}\n`]),
    ['tools/README.md', '# Project-local helpers\n\nDocument the purpose and invocation of any executable helper scripts placed here.\n'],
  ];
  const created = [], skipped = [];
  for (const [name, content] of files) {
    const path = join(overlayDir, name);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { flag: 'wx' });
      created.push(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      skipped.push(name);
    }
  }
  return { overlayDir, created, skipped };
}

function checkedMachine(raw, message = 'Invalid machine config') {
  const issues = [];
  validateShape(MACHINE_SCHEMA, raw, '', issues);
  if (issues.length) throw new CliError(message, issues);
  return {
    schemaVersion: 1,
    executables: { ...(raw.executables ?? {}) },
    path: [...(raw.path ?? [])],
    env: { ...(raw.env ?? {}) },
    ...(raw.shell ? { shell: raw.shell } : {}),
  };
}

let machineConfigCache = null;

function loadMachineConfigSync() {
  const path = getMachineConfigPath();
  if (machineConfigCache?.path === path) return machineConfigCache.config;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') {
      machineConfigCache = { path, config: { schemaVersion: 1, executables: {}, path: [], env: {} } };
      return machineConfigCache.config;
    }
    throw error;
  }
  const config = checkedMachine(parseJson(text, path), `Invalid machine config ${path}`);
  machineConfigCache = { path, config };
  return config;
}

const SUPPORTED_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const PATH_SENTINEL = '__HC_TEAM_PATH__';
const loginShellPathCache = new Map();

function resolveUserShell(machine = loadMachineConfigSync()) {
  let passwdShell = '';
  try { passwdShell = userInfo().shell ?? ''; } catch { /* ignore */ }
  const configured = machine?.shell ? expandHome(machine.shell.trim()) : '';
  for (const candidate of [configured, process.env.SHELL, passwdShell, '/bin/sh']) {
    if (!candidate || !isAbsolute(candidate) || !isExecutableFile(candidate)) continue;
    if (SUPPORTED_SHELLS.has(basename(candidate))) return candidate;
  }
  return '/bin/sh';
}

function probeLoginShellPath(cwd = process.cwd()) {
  if (process.env.HC_TEAM_NO_LOGIN_SHELL === '1' || process.platform === 'win32') return [];
  const key = cwd || '';
  if (loginShellPathCache.has(key)) return loginShellPathCache.get(key);
  const shell = resolveUserShell();
  const args = basename(shell) === 'fish'
    ? ['-l', '-i', '-c', `printf '${PATH_SENTINEL}%s${PATH_SENTINEL}' (string join : $PATH)`]
    : ['-ilc', `printf '${PATH_SENTINEL}%s${PATH_SENTINEL}' "$PATH"`];
  let dirs = [];
  try {
    const out = execFileSync(shell, args, {
      cwd: key || undefined, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parts = out.split(PATH_SENTINEL);
    const extracted = parts.length >= 3 ? parts[1] : out;
    dirs = extracted.split(delimiter).map(part => part.trim()).filter(Boolean);
  } catch {
    dirs = [];
  }
  loginShellPathCache.set(key, dirs);
  return dirs;
}

function isExecutableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch { return false; }
}

function fallbackBinDirs() {
  const home = homedir();
  return [
    join(home, '.local/bin'), join(home, '.cache/.bun/bin'), join(home, '.bun/bin'),
    join(home, '.volta/bin'), join(home, '.cargo/bin'), join(home, '.npm-global/bin'),
    join(home, '.nix-profile/bin'), join(home, '.local/share/mise/shims'),
    '/opt/homebrew/bin', '/usr/local/bin',
  ];
}

function resolveExecutableWithSource(executable, cwd, { ignoreMachine = false, skipShellProbe = false } = {}) {
  if (executable.includes('/') || (sep === '\\' && executable.includes('\\'))) {
    const candidate = resolve(cwd, executable);
    if (isExecutableFile(candidate)) return { resolved: candidate, source: 'explicit' };
    throw new CliError(`Executable not found: ${executable}`);
  }
  const machine = ignoreMachine ? { executables: {}, path: [] } : loadMachineConfigSync();
  if (!ignoreMachine && Object.hasOwn(machine.executables, executable)) {
    const configured = resolve(cwd, expandHome(machine.executables[executable].trim()));
    if (isExecutableFile(configured)) return { resolved: configured, source: 'machine' };
    throw new CliError(`Configured executable for ${executable} not found: ${configured} (run \`hc-team machine detect --write\` or update ${getMachineConfigPath()})`);
  }
  const seen = new Set();
  const findIn = (dirs, source, skipShims = false) => {
    for (const rawDir of dirs) {
      const dir = typeof rawDir === 'string' ? expandHome(rawDir.trim()) : '';
      if (!dir || seen.has(dir)) continue;
      if (skipShims && /[\\/]shims$/.test(dir)) continue;
      seen.add(dir);
      const candidate = resolve(dir, executable);
      if (isExecutableFile(candidate)) return { resolved: candidate, source };
    }
    return null;
  };
  const activeDirs = (process.env.PATH ?? '').split(delimiter);
  const machineDirs = machine.path ?? [];
  const fallbacks = fallbackBinDirs();
  // Avoid spawning an interactive shell for `hc` itself when it already lives in ~/.local/bin (e.g. periodic servers polling).
  if (skipShellProbe) {
    const fast = findIn(activeDirs, 'PATH', true) ?? findIn(machineDirs, 'machine-path', true) ?? findIn(fallbacks, 'fallback', true);
    if (fast) return fast;
  }
  const loginDirs = probeLoginShellPath(cwd);
  // Prefer direct binaries over shims when probing, then allow shims as fallback.
  const found = findIn(activeDirs, 'PATH', true)
    ?? findIn(machineDirs, 'machine-path', true)
    ?? findIn(loginDirs, 'login-shell', true)
    ?? findIn(fallbacks, 'fallback', true)
    ?? (() => { seen.clear(); return findIn(activeDirs, 'PATH') ?? findIn(machineDirs, 'machine-path') ?? findIn(loginDirs, 'login-shell') ?? findIn(fallbacks, 'fallback'); })();
  if (found) return found;
  throw new CliError(`Executable not found: ${executable}`);
}

function resolveExecutable(executable, cwd, options) {
  return resolveExecutableWithSource(executable, cwd, options).resolved;
}

function hc(args, { timeout = 65000 } = {}) {
  const child = exec(resolveExecutable('hc', process.cwd(), { skipShellProbe: true }), args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  child.child.stdin?.on('error', () => {});
  child.child.stdin?.end();
  return child.then(({ stdout }) => stdout, error => {
    const detail = error.stderr?.trim() || error.stdout?.trim() || (error.killed ? 'timed out' : error.code);
    const failure = new CliError(`hc ${args[0]}: ${detail || 'failed'}`);
    try { failure.response = JSON.parse(error.stdout); } catch { /* Not a JSON response. */ }
    throw failure;
  });
}

async function hcJson(args, options) {
  return parseJson(await hc(args, options), `hc ${args[0]} response`);
}

function connect(method, params) {
  const maxFrame = 64 * 1024 * 1024;
  const id = 1;
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable('hc', process.cwd(), { skipShellProbe: true }), ['connect'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => finish(new CliError('hc connect: timed out')), 3000);
    let done = false, chunks = [], size = 0;
    function finish(error, response) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error);
      else resolve(response);
    }
    child.once('error', error => finish(new CliError(`hc connect: ${error.code ?? 'could not start'}`)));
    child.stdout.on('error', () => finish(new CliError('hc connect: could not read response')));
    child.stdout.on('data', chunk => {
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start);
        const frame = chunk.subarray(start, newline === -1 ? undefined : newline);
        size += frame.length;
        if (size > maxFrame) return finish(new CliError('hc connect: response frame exceeds 64 MiB'));
        chunks.push(frame);
        if (newline === -1) return;
        const line = Buffer.concat(chunks, size).toString('utf8');
        chunks = [];
        size = 0;
        if (line.trim()) {
          let response;
          try { response = parseJson(line, 'hc connect response'); } catch (error) { return finish(error); }
          if (response?.id === id) return finish(null, response);
        }
        start = newline + 1;
      }
    });
    child.once('close', () => finish(new CliError('hc connect: closed before a complete response')));
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const isLocal = address => typeof address === 'string' && address.length > 0 && !address.includes('/');
const isAgent = terminal => Boolean(terminal?.status || terminal?.reported);

async function listTerminals(runId, { includeFinished = false } = {}) {
  const params = { ...(includeFinished ? { all: true } : {}), ...(runId ? { labels: { [runLabel]: runId } } : {}) };
  const response = await connect('terminal.list', params);
  const terminals = response?.result?.terminals;
  if (!Array.isArray(terminals)) throw new CliError(response?.error?.message ?? 'hc terminal.list returned no terminals array');
  return terminals.filter(t => isLocal(t.address)
    && (t.state === 'live' || (includeFinished && t.state === 'finished'))
    && (!runId || t.labels?.[runLabel] === runId));
}

function planTerminal(row, label, { runId, id, projectRoot, parent }) {
  const cwd = label === serverLabel ? resolve(projectRoot, row.cwd) : projectRoot;
  const labels = { [runLabel]: runId, [presetLabel]: id, [label]: row.id, [cwdLabel]: projectRoot };
  if (parent !== null) labels[parentLabel] = parent;
  const name = `${runId}${label === serverLabel ? '--' : '-'}${row.id}`;
  const plan = { id: row.id, address: null, name, command: null, cwd, labels, reason: row.routeError ?? null };
  if (plan.reason) return plan;
  const [exe, ...args] = row.command;
  const end = args.indexOf('--');
  if (basename(exe) === 'codex' && !args.slice(0, end === -1 ? args.length : end).includes('--no-daemon')) args.unshift('--no-daemon');
  plan.command = [exe, ...args];
  try { plan.command[0] = resolveExecutable(exe, cwd); } catch (error) { plan.reason = messageOf(error); }
  return plan;
}

async function readTerminalTail(address) {
  try {
    const screen = await hc(['read', address], { timeout: 2000 });
    const meaningful = screen.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !/^[─━═\-_=│┃┌┐└┘├┤┬┴┼\s]+$/.test(line))
      .slice(-12)
      .slice(-3);
    const joined = oneLine(meaningful.join(' | '));
    return joined.length > 240 ? `...${joined.slice(-237)}` : joined;
  } catch { return ''; }
}

async function spawnTerminal(plan, parent) {
  if (plan.reason) throw new CliError(plan.reason);
  const machine = loadMachineConfigSync();
  const envEntries = Object.entries(machine.env ?? {})
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${value}`);
  const inner = envEntries.length > 0 ? ['/usr/bin/env', ...envEntries, ...plan.command] : plan.command;
  let argv;
  if (process.env.HC_TEAM_NO_LOGIN_SHELL !== '1' && process.platform !== 'win32') {
    const shell = resolveUserShell(machine);
    argv = basename(shell) === 'fish'
      ? [shell, '-l', '-i', '-c', 'exec $argv', '--', ...inner]
      : [shell, '-ilc', 'exec "$@"', 'hc-team', ...inner];
  } else {
    // hc treats a single argument with spaces or shell syntax as a shell line.
    argv = inner.length === 1 && /[^a-zA-Z0-9_./-]/.test(inner[0]) ? ['/usr/bin/env', inner[0]] : inner;
  }
  const { address, reason, state } = await hcJson([
    'run', '--bg', '--json', '--no-notify', '--name', plan.name, '--cwd', plan.cwd,
    ...(parent === null ? ['--no-parent'] : ['--parent', parent]),
    ...Object.entries(plan.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '--', ...argv,
  ], { timeout: 15000 });
  if (!isLocal(address)) throw new CliError(reason ?? 'hc did not return a local terminal address');
  plan.address = address;
  if (state === 'finished') {
    const tail = await readTerminalTail(address);
    const base = reason ?? 'Terminal exited during launch';
    throw new CliError(tail ? `${base} (${tail})` : base);
  }
}

async function deliver(address, text) {
  const result = await hcJson(['send', '--json', '--', address, text]).catch(error => {
    if (error.response?.started === false) return error.response;
    throw error;
  });
  // hc has already pasted and submitted the text even if it did not observe work starting.
  return result.started === false
    ? { sent: true, started: false, reason: 'submitted; did not enter working state' }
    : { sent: true, ...(result.started === true ? { started: true } : {}), reason: null };
}

async function waitForRole(address) {
  const deadline = Date.now() + 45000;
  for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
    const state = await hcJson(['wait', '--json', '--timeout', String(Math.ceil(remaining / 1000)), address], { timeout: remaining + 5000 });
    if (state.reason === 'message') continue;
    if (state.reason === 'status' && ['idle', 'done'].includes(state.status)) return;
    const detail = (state.reason === 'status' ? state.status : state.reason) ?? 'unknown';
    const tail = await readTerminalTail(address);
    throw new CliError(tail ? `Terminal not ready: ${detail} (${tail})` : `Terminal not ready: ${detail}`);
  }
  const tail = await readTerminalTail(address);
  throw new CliError(tail ? `Terminal not ready: timeout (${tail})` : 'Terminal not ready: timeout');
}

async function resolveSkillPath(skillName, projectRoot) {
  if (typeof skillName !== 'string' || !skillName || /[\\/]|^\.\.?$/.test(skillName)) return null;
  const home = homedir();
  const roots = [
    join(projectRoot, 'skills'),
    join(home, '.agents/skills'),
    join(home, '.claude/skills'),
    join(home, '.gemini/skills'),
    join(home, '.gemini/antigravity-cli/skills'),
    join(home, '.codex/skills'),
    join(home, '.pi/agent/skills'),
  ];
  for (const dir of roots) {
    const candidate = join(dir, skillName, 'SKILL.md');
    if (await statFile(candidate)) return candidate;
  }
  return null;
}

async function listOverlayTools(overlayDir) {
  const dir = join(overlayDir, 'tools');
  const names = await readdir(dir).catch(() => []);
  return names
    .filter(name => name !== 'README.md' && !name.startsWith('.'))
    .sort()
    .map(name => join(dir, name));
}

async function writeBrief(role, plan, snapshot, overlayDir, task, parent = null) {
  const runId = plan.labels[runLabel];
  const list = (label, values) => values.length ? `\n## ${label}\n${values.map(value => `- ${value}`).join('\n')}\n` : '';
  const trimmedTask = task.trim();
  const taskSection = trimmedTask || `Stand by for instructions from ${parent ? `parent (${parent})` : 'the operator'}. Read this brief and any project overlay files so you are ready, then wait without reporting a missing task.`;
  const resolvedSkills = await Promise.all((role.skills ?? []).map(async name => {
    const skillFile = await resolveSkillPath(name, plan.cwd);
    return skillFile ? `${name} -> ${skillFile}` : name;
  }));
  const userToolsFile = toolsPath();
  const hasUserTools = Boolean(await statFile(userToolsFile));
  const overlayScripts = await listOverlayTools(overlayDir);
  const contextFiles = [
    ...(hasUserTools ? [`${userToolsFile} (global verified CLI/script playbook)`] : []),
    join(overlayDir, 'shared.md'),
    join(overlayDir, 'roles', `${role.id}.md`),
    join(overlayDir, 'tools/README.md'),
    ...overlayScripts.map(file => `${file} (project helper script)`),
  ];
  const brief = `# ${role.title} (${role.id})\n\nRun: ${runId}\nProject: ${plan.cwd}\nPreset snapshot: ${snapshot}\n`
    + `\n## Task\n${taskSection}\n\n## Role instructions\n${role.instructions}\n`
    + `\n## Mode\n${role.readOnly ? 'Read-only: inspect and report; do not edit project files.' : 'Make changes only within the task and assigned scope.'}\n`
    + list('Preferred tools & scripts (use first)', role.tools ?? [])
    + list('Skills (read SKILL.md before ad-hoc commands)', resolvedSkills)
    + list('Ownership', role.owns)
    + list('Talks to', role.talksTo) + list('Checkpoints', role.checkpoints)
    + `\n## Project context & playbooks (read before probing commands)\n${contextFiles.map(file => `- ${file}`).join('\n')}\n`
    + `\n## Process discipline\n- Before guessing CLI flags or writing ad-hoc scripts, check the listed SKILL.md files, playbooks, project overlay files, and any project memory available in your harness (e.g., Hindsight).\n`
    + `- If you hit a non-obvious tool gotcha or find a faster verified command, include it briefly in your \`hc-team send --kind result\` summary so future runs skip trial-and-error.\n`
    + `\n## Coordination\nUse \`hc-team send <role|parent> "<summary>" --kind <handoff|result|review|blocked|ask>\`.\n`
    + `Use \`hc-team servers --run ${runId}\` to discover server URLs.\n`;
  await writeFile(plan.briefPath, brief, { flag: 'wx', mode: 0o600 });
}

async function waitForServers(plans, root) {
  const pending = new Map(plans.filter(plan => plan.address && !plan.reason).map(plan => [plan.address, plan]));
  if (!pending.size) return;
  const deadline = Date.now() + 15000;
  const timer = new AbortController();
  const expired = delay(15000, null, { signal: timer.signal });
  let scanFailure;
  try {
    while (pending.size && Date.now() < deadline) {
      const result = await Promise.race([
        listTerminals().then(terminals => scanServers(terminals, { runId: plans[0].labels[runLabel], raw: true }))
          .catch(error => ({ error })),
        expired,
      ]);
      if (result === null) break;
      if (result.error) {
        scanFailure = `server scan failed: ${oneLine(messageOf(result.error))}`;
        break;
      }
      for (const [address, plan] of pending) {
        if (result.listenersByTerminal[address]?.length) {
          plan.ready = true;
          plan.urls = result.byTerminal[address]?.map(row => row.url) ?? [];
          pending.delete(address);
        }
      }
      if (pending.size) await delay(Math.max(0, Math.min(500, deadline - Date.now())));
    }
  } finally {
    timer.abort();
  }
  for (const plan of pending.values()) {
    plan.reason = scanFailure ?? 'no listening socket found';
    process.stderr.write(`Warning: ${plan.name} (${root}): ${plan.reason}\n`);
  }
}

async function launch(id, options) {
  assertPresetId(id);
  const existing = options.run;
  let runId = existing;
  if (existing !== undefined) assertRunId(existing);
  else do { runId = randomBytes(3).toString('hex'); } while (await statFile(runPath(runId)));
  const runDir = runPath(runId);
  const snapshot = join(runDir, 'preset.json');
  const metaPath = join(runDir, 'meta.json');
  let meta, preset;
  if (existing) {
    meta = await readJson(metaPath);
    if (meta?.runId !== runId || typeof meta.presetId !== 'string' || typeof meta.projectRoot !== 'string'
      || !isAbsolute(meta.projectRoot) || !(meta.parent === null || (typeof meta.parent === 'string' && meta.parent))) {
      throw new CliError(`Invalid metadata for run ${runId}`);
    }
    if (meta.presetId !== id) throw new CliError(`Run ${runId} belongs to preset ${meta.presetId}, not ${id}`);
    preset = await readSnapshot(snapshot);
  } else {
    const projectRoot = await getRoot(options.cwd);
    let parent = options['no-parent'] ? null : options.parent ?? null;
    const caller = process.env.HC_TERMINAL_ID;
    if (!options['no-parent'] && options.parent === undefined && isLocal(caller)) {
      if (isAgent((await listTerminals()).find(t => t.address === caller))) parent = caller;
    }
    meta = { runId, presetId: id, projectRoot, parent };
    const { preset: authored } = await getPreset(id, projectRoot);
    const { routes } = await loadRoutes();
    preset = resolveRoutes(authored, routes);
  }
  const { projectRoot, parent } = meta;
  if (preset.id !== id) throw new CliError(`Run ${runId} belongs to preset ${preset.id}, not ${id}`);
  const prior = existing && !options['dry-run'] ? await listTerminals(runId) : [];
  if (prior.some(t => t.labels?.[cwdLabel] !== projectRoot)) throw new CliError(`Run ${runId} is already in a different project`);
  let selected = preset.roles.filter(role => role.default);
  if (options.roles !== undefined) {
    const byId = new Map(preset.roles.map(role => [role.id, role]));
    selected = [...new Set(options.roles.split(',').map(id => id.trim()))].map(role => {
      if (!byId.has(role)) throw new CliError(`Unknown role ${role} in preset ${id}`);
      return byId.get(role);
    });
  }
  const context = { runId, id, projectRoot, parent };
  const servers = options['with-servers'] ? preset.servers.map(row => ({
    ...planTerminal(row, serverLabel, context), ready: false, urls: [],
  })) : [];
  const roles = selected.map(role => ({
    ...planTerminal(role, roleLabel, context), sent: false, briefPath: join(runDir, 'briefs', `${role.id}-${randomBytes(3).toString('hex')}.md`),
  }));
  const result = { runId, presetId: id, projectRoot, parent, runDir, servers, roles };
  if (options['dry-run']) return result;
  if (!existing) {
    await mkdir(runsDir, { recursive: true });
    await mkdir(runDir, { mode: 0o700 });
    await writeFile(snapshot, pretty(preset), { flag: 'wx', mode: 0o600 });
    await atomicWrite(metaPath, pretty(meta));
  }
  const locksDir = join(runDir, 'locks');
  await Promise.all([mkdir(join(runDir, 'briefs'), { recursive: true }), mkdir(locksDir, { recursive: true })]);
  await Promise.all(servers.map(async plan => {
    const server = prior.find(t => t.labels?.[serverLabel] === plan.id);
    if (server) {
      plan.address = server.address;
      plan.reason = null;
    } else {
      try { await spawnTerminal(plan, parent); } catch (error) { plan.reason = messageOf(error); }
    }
    if (plan.reason) process.stderr.write(`Warning: ${plan.name}: ${oneLine(plan.reason)}\n`);
  }));
  await waitForServers(servers, projectRoot);
  const task = options.task ?? '';
  await Promise.all(roles.map(async (plan, index) => {
    if (plan.reason) return;
    const lockPath = join(locksDir, `${plan.id}.lock`);
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600).catch(error => {
        if (error.code === 'EEXIST') throw new CliError('Role launch is already in progress');
        throw error;
      });
      const active = (await listTerminals(runId)).find(t => t.labels?.[roleLabel] === plan.id);
      if (active) {
        plan.address = active.address;
        throw new CliError('Role is already live; stop that terminal before replacing it');
      }
      await writeBrief(selected[index], plan, snapshot, overlayPath(projectRoot, id), task, parent);
      await spawnTerminal(plan, parent);
      await waitForRole(plan.address);
      await delay(800);
      const trimmedTask = oneLine(task);
      const kickoff = trimmedTask
        ? `Read ${plan.briefPath}. Task: ${trimmedTask}`
        : `Read ${plan.briefPath}. Stand by for instructions from ${parent ? `parent (${parent})` : 'the operator'}.`;
      Object.assign(plan, await deliver(plan.address, kickoff));
    } catch (error) {
      plan.reason = messageOf(error);
    } finally {
      if (lock) {
        try { await lock.close(); } finally {
          await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
    }
  }));
  if (options['notify-parent'] && parent !== null && roles.some(role => role.sent)) {
    const readyRoles = roles.filter(role => role.sent).map((role, _i) => {
      const spec = selected.find(r => r.id === role.id);
      return `- ${role.id} (${role.address}): ${spec?.title ?? role.id}`;
    });
    const failedRoles = roles.filter(role => !role.sent).map(role => `- ${role.id}: failed (${role.reason ?? 'unknown'})`);
    const readyServers = servers.filter(srv => srv.urls?.length).map(srv => `- ${srv.id}: ${srv.urls.join(', ')}`);
    const parentMessage = [
      `[hc-team] ${existing ? 'Added roles to' : 'Launched'} ${preset.name} (${id}) · run #${runId}`,
      'Active roles:', ...readyRoles,
      ...(readyServers.length ? ['Servers:', ...readyServers] : []),
      ...(failedRoles.length ? ['Unavailable:', ...failedRoles] : []),
      `Follow the user's next message in this session and coordinate these teammates per preset ${id} (\`hc-team send <role> "<summary>" --kind handoff\`, \`hc-team status ${runId}\`, \`hc-team stop ${runId}\`).`,
    ].join('\n');
    try {
      await deliver(parent, parentMessage);
      result.parentNotified = true;
    } catch (error) {
      result.parentNotified = false;
      result.parentNoticeError = messageOf(error);
    }
  }
  return {
    ...result,
    servers: servers.map(({ id, address, name, ready, urls, reason }) => ({ id, address, name, ready, urls, reason })),
    roles: roles.map(({ id, address, name, sent, started, reason, briefPath }) => ({ id, address, name, sent, started, reason, briefPath })),
  };
}

async function send(to, summary, options) {
  if (!summary.trim()) throw new CliError('Summary must not be empty');
  const kind = options.kind ?? 'handoff';
  if (!kinds.has(kind)) throw new CliError(`Invalid message kind: ${kind}`);
  if (options.run !== undefined) assertRunId(options.run);
  const terminals = await listTerminals();
  const self = terminals.find(t => t.address === process.env.HC_TERMINAL_ID);
  const runId = options.run ?? self?.labels?.[runLabel];
  const from = options.from ?? self?.labels?.[roleLabel];
  if (!runId || !from) throw new CliError('Cannot infer run and sender; use --run and --from');
  assertRunId(runId);
  const inRun = terminals.filter(t => t.labels?.[runLabel] === runId);
  const sender = inRun.find(t => t.labels[roleLabel] === from);
  if (!sender) throw new CliError(`No live sender role ${from} in run ${runId}`);
  const preset = await readSnapshot(join(runPath(runId), 'preset.json'));
  const role = preset.roles.find(r => r.id === from);
  if (!role) throw new CliError(`Unknown sender role ${from} in run ${runId}`);
  if (to !== 'parent' && !preset.roles.some(r => r.id === to)) throw new CliError(`Unknown target role ${to} in run ${runId}`);
  if (to !== 'parent' && !role.talksTo.includes(to)) process.stderr.write(`Warning: ${from}.talksTo does not include ${to}\n`);
  const event = { ts: new Date().toISOString(), from, to, kind, summary };
  if (options.artifact !== undefined) event.artifact = options.artifact;
  const parent = sender.labels[parentLabel];
  const target = to === 'parent'
    ? (isAgent(terminals.find(t => t.address === parent)) ? parent : null)
    : inRun.find(t => t.labels[roleLabel] === to)?.address;
  if (!target && to !== 'parent') throw new CliError(`No live target role ${to} in run ${runId}`);
  const delivery = target
    ? await deliver(target, `[${kind}] ${summary}${event.artifact === undefined ? '' : ` (artifact: ${event.artifact})`}`)
    : { sent: false };
  await appendFile(join(runPath(runId), 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 }).catch(error => {
    if (!target) throw error;
    process.stderr.write(`Warning: could not append event: ${oneLine(messageOf(error))}\n`);
  });
  const labelSummary = [...oneLine(summary).replaceAll('|', '/')].slice(0, 120).join('');
  await hc(['label', sender.address, `${lastLabel}=${kind}|${to}|${labelSummary}`]);
  return { runId, ...event, address: target ?? null, ...delivery };
}

async function tailEvents(runId, count = 20) {
  const path = join(runPath(runId), 'events.jsonl');
  let file;
  try { file = await open(path); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const chunks = [];
    let lines = 0;
    let offset = (await file.stat()).size;
    while (offset > 0 && lines <= count) {
      const length = Math.min(offset, 8192);
      offset -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 10) lines++;
    }
    const rows = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).slice(-count);
    return rows.flatMap(row => {
      try { return [JSON.parse(row)]; } catch { return []; }
    });
  } finally {
    await file.close();
  }
}

async function status(runId) {
  if (runId !== undefined) assertRunId(runId);
  const runs = new Map();
  for (const t of await listTerminals(runId)) {
    const labels = t.labels ?? {};
    const id = labels[runLabel];
    if (!runIdPattern.test(id)) continue;
    if (!runs.has(id)) runs.set(id, {
      runId: id, presetId: labels[presetLabel] ?? null, projectRoot: labels[cwdLabel] ?? null,
      parent: labels[parentLabel] ?? null, roles: [], servers: [], events: [],
    });
    const info = { address: t.address, name: t.name, state: t.state, status: t.status ?? null };
    if (labels[roleLabel]) runs.get(id).roles.push({ id: labels[roleLabel], ...info, last: labels[lastLabel] ?? null });
    else if (labels[serverLabel]) runs.get(id).servers.push({ id: labels[serverLabel], ...info });
  }
  return Promise.all([...runs.values()].map(async run => {
    run.events = await tailEvents(run.runId);
    for (const role of run.roles) role.latestEvent = run.events.findLast(event => event?.from === role.id) ?? null;
    return run;
  }));
}

async function stop(runId, { force = false } = {}) {
  assertRunId(runId);
  const journal = join(runPath(runId), 'stopping.json');
  const recorded = await readJson(journal, true);
  if (recorded !== undefined && (!Array.isArray(recorded) || !recorded.every(isLocal))) {
    throw new CliError(`Invalid stop journal for run ${runId}`);
  }
  const terminals = await listTerminals(undefined, { includeFinished: true });
  const live = new Map(terminals.filter(t => t.state === 'live').map(t => [t.address, t]));
  const targets = terminals.filter(t => t.labels?.[runLabel] === runId
    || (t.state === 'finished' && recorded?.includes(t.address)));
  if (!force) {
    const killing = new Set(targets.filter(t => t.state === 'live').map(t => t.address));
    const descendants = [...live.values()].filter(t => {
      if (killing.has(t.address)) return false;
      const seen = new Set([t.address]);
      for (let parent = t.parent; parent && !seen.has(parent); parent = live.get(parent)?.parent) {
        if (killing.has(parent)) return true;
        seen.add(parent);
      }
      return false;
    });
    if (descendants.length) {
      const impacted = descendants.map(t => t.labels?.[runLabel] ? `${t.labels[runLabel]}/${t.address}` : t.address);
      throw new CliError(`Stopping run ${runId} would also end descendants: ${impacted.join(', ')}; pass --force to proceed`);
    }
  }
  if (targets.length) await atomicWrite(journal, pretty(targets.map(t => t.address)), { replace: true });
  const rows = await Promise.all(targets.map(async ({ address, state }) => {
    const killError = state === 'live' ? await hc(['kill', address]).then(() => null, error => messageOf(error)) : null;
    try {
      await hc(['rm', address]);
      return { address };
    } catch (error) {
      return { address, reason: killError ?? messageOf(error) };
    }
  }));
  const stopped = rows.filter(row => !row.reason).map(row => row.address);
  const failed = rows.filter(row => row.reason);
  if (failed.length) throw new CliError(`Could not stop ${failed.map(row => row.address).join(', ')}; stopped ${stopped.join(', ') || 'none'}`,
    failed.map(row => ({ path: pointer('/terminals', row.address), message: row.reason })));
  await unlink(journal).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { runId, stopped };
}

function parseOptions(argv, spec, options, jsonInput) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [, key, inline] = arg.match(/^--([^=]+)(?:=([\s\S]*))?$/) ?? [];
    if (key === 'json') {
      if (jsonInput && (inline !== undefined || (argv[i + 1] && !argv[i + 1].startsWith('--')))) {
        if (options.input !== undefined) throw new CliError('Duplicate --json input');
        options.input = inline ?? argv[++i];
      } else if (inline === undefined) options.json = true;
      else throw new CliError('--json does not take a value for this command');
      continue;
    }
    if (!Object.hasOwn(spec, key)) throw new CliError(`Unknown option: ${arg}`);
    if (Object.hasOwn(options, key)) throw new CliError(`Duplicate option: --${key}`);
    if (spec[key] === 'flag') {
      if (inline !== undefined) throw new CliError(`--${key} does not take a value`);
      options[key] = true;
    } else {
      if (inline === undefined && (argv[i + 1] === undefined || argv[i + 1] === '--')) {
        throw new CliError(`Missing value for --${key}`);
      }
      options[key] = inline ?? argv[++i];
    }
  }
  return positional;
}

async function presetInput(options, implicitStdin) {
  const sources = [options.file !== undefined, options.input !== undefined, Boolean(options.stdin)].filter(Boolean).length;
  if (sources > 1 || (!sources && !implicitStdin)) throw new CliError('Specify exactly one of --json <text>, --file <path>, or --stdin');
  if (options.input !== undefined) return parseJson(options.input, '--json input');
  if (options.file !== undefined) return readJson(resolve(options.file));
  if (!options.stdin && process.stdin.isTTY) throw new CliError('Use --file, --json <text>, or --stdin');
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return parseJson(text, 'stdin');
}

const usage = `Usage: hc-team <schema|seed|preset|routes|models|machine|init-project|launch|send|status|stop|servers> [options]\n`
  + `Preset commands: list, get <id>, validate, save, delete <id>\n`
  + `Routes: routes [--json] | routes save (--json <text> | --file <path> | --stdin) [--expected-sha <sha>]\n`
  + `Models: models save (--text <text> | --file <path> | --stdin) [--expected-sha <sha>]\n`
  + `Machine: machine show [--json] | machine detect [--write] [--json] | machine save (--json <text> | --file <path> | --stdin) [--expected-sha <sha>]\n`;

async function collectReferencedExecutables() {
  const names = new Set(['hc']);
  const { routes } = await loadRoutes().catch(() => ({ routes: {} }));
  for (const entry of Object.values(routes)) {
    const exe = entry?.command?.[0];
    if (exe && !exe.includes('/')) names.add(exe);
  }
  for (const file of await jsonFiles(getPresetsDir())) {
    try {
      const raw = await readJson(join(getPresetsDir(), file));
      for (const role of raw?.roles ?? []) {
        const exe = role?.command?.[0];
        if (exe && !exe.includes('/')) names.add(exe);
      }
      for (const srv of raw?.servers ?? []) {
        const exe = srv?.command?.[0];
        if (exe && !exe.includes('/')) names.add(exe);
      }
    } catch { /* Ignore malformed presets while inspecting machine executables. */ }
  }
  return [...names].sort();
}

async function inspectMachine({ detect = false, write = false } = {}) {
  const path = getMachineConfigPath();
  const rawBytes = await readBytes(path, true);
  const exists = rawBytes !== undefined;
  const current = exists ? checkedMachine(parseJson(rawBytes, path), `Invalid machine config ${path}`)
    : { schemaVersion: 1, executables: {}, path: [], env: {} };
  const names = [...new Set([...await collectReferencedExecutables(), ...Object.keys(current.executables)])].sort();
  const nextExecutables = { ...current.executables };
  const executables = names.map(name => {
    const configured = Object.hasOwn(current.executables, name) ? current.executables[name] : null;
    try {
      const probe = resolveExecutableWithSource(name, process.cwd(), { ignoreMachine: detect });
      if (detect) nextExecutables[name] = probe.resolved;
      return { name, configured, resolved: probe.resolved, ok: true, source: probe.source };
    } catch (error) {
      return { name, configured, resolved: null, ok: false, source: 'missing', error: messageOf(error) };
    }
  });
  let config = current;
  let sha = rawBytes ? sha256(rawBytes) : null;
  if (detect) {
    config = { schemaVersion: 1, executables: nextExecutables, path: current.path, env: current.env };
    if (write) {
      const data = pretty(config);
      await atomicWrite(path, data, { replace: true });
      machineConfigCache = { path, config };
      sha = sha256(data);
    }
  }
  return { path, exists: exists || Boolean(detect && write), sha, config, executables };
}

async function main(rawArgs) {
  const leadingJson = rawArgs[0] === '--json';
  const [verb, ...rest] = leadingJson ? rawArgs.slice(1) : rawArgs;
  const [sub, ...subArgs] = rest;
  if (!verb || ['-h', '--help'].includes(verb) || (['preset', 'machine'].includes(verb) && ['-h', '--help'].includes(sub))) {
    process.stdout.write(usage);
    return;
  }
  const hasSub = verb === 'preset' || verb === 'machine' || ((verb === 'routes' || verb === 'models') && sub === 'save');
  const action = hasSub ? `${verb} ${sub}` : verb;
  const args = hasSub ? subArgs : rest;
  const options = {};
  const json = () => leadingJson || options.json || options.input !== undefined;
  const inputSpec = { file: 'value', stdin: 'flag' };
  const specs = {
    schema: {}, seed: { from: 'value' },
    'preset list': { cwd: 'value' }, 'preset get': { cwd: 'value', merged: 'flag' },
    'preset validate': inputSpec,
    'preset save': { ...inputSpec, update: 'flag', 'expected-id': 'value', 'expected-sha': 'value' },
    'preset delete': {}, 'init-project': { cwd: 'value' },
    routes: {}, 'routes save': { ...inputSpec, 'expected-sha': 'value' },
    'models save': { ...inputSpec, text: 'value', 'expected-sha': 'value' },
    'machine show': {}, 'machine detect': { write: 'flag' }, 'machine save': { ...inputSpec, 'expected-sha': 'value' },
    launch: { cwd: 'value', parent: 'value', 'no-parent': 'flag', 'notify-parent': 'flag', roles: 'value', task: 'value', 'with-servers': 'flag', run: 'value', 'dry-run': 'flag' },
    send: { kind: 'value', artifact: 'value', run: 'value', from: 'value' },
    status: {}, stop: { force: 'flag' }, servers: { run: 'value', spaces: 'value' },
  };
  try {
    if (!Object.hasOwn(specs, action)) throw new CliError(`Unknown command: ${action}`);
    const jsonInput = ['preset save', 'preset validate', 'routes save', 'machine save'].includes(action);
    const positional = parseOptions(args, specs[action], options, jsonInput);
    if (options.help) { process.stdout.write(usage); return; }
    const min = action === 'send' ? 2 : ['preset get', 'preset delete', 'init-project', 'launch', 'stop'].includes(action) ? 1 : 0;
    const max = action === 'status' ? 1 : min;
    if (positional.length < min || positional.length > max) throw new CliError(`Usage: hc-team ${action}${min >= 1 ? ' <id>' : ''}${min === 2 ? ' "<summary>"' : ''} [options]`);
    const [id, summary] = positional;
    let result, output;
    switch (action) {
      case 'schema': result = PRESET_JSON_SCHEMA; break;
      case 'seed': {
        const from = resolve(options.from ?? builtinsDir);
        const presetsDir = getPresetsDir();
        const files = await jsonFiles(from, false);
        const created = [], skipped = [];
        for (const name of ['_routes.json', '_models.md', ...files]) {
          const source = join(from, name);
          const data = await readBytes(source, name.startsWith('_'));
          if (data === undefined) continue;
          const target = join(presetsDir, name);
          if (name === '_routes.json') checkedRoutes(parseJson(data, source));
          if (name.startsWith('_')) {
            await atomicWrite(target, data);
          } else {
            const raw = parseJson(data, source);
            checked(raw, `Invalid seed ${name}`);
            if (`${raw.id}.json` !== name) throw new CliError(`Seed ID must match the filename: ${name}`);
            (await atomicWrite(target, data) ? created : skipped).push(raw.id);
          }
        }
        result = { presetsDir, created, skipped };
        output = `${created.length} seeded, ${skipped.length} already present`;
        break;
      }
      case 'preset list': {
        const presetsDir = getPresetsDir();
        const projectRoot = await getRoot(options.cwd);
        const routesErrors = [];
        const { reviewed, routes, routesSha } = await loadRoutes().catch(error => {
          routesErrors.push(listError('_routes', routesPath(), error));
          return { reviewed: null, routes: {}, routesSha: null };
        });
        const { presets, errors } = await presetViews(projectRoot, routes);
        result = { presetsDir, projectRoot, routesReviewed: reviewed, routes, routesSha, presets, errors: [...routesErrors, ...errors] };
        if (!json()) for (const error of result.errors) process.stderr.write(`${error.path}: ${error.message}\n`);
        output = presets.map(preset => `${preset.id}\t${preset.name}${preset.hasOverlay ? ' (overlay)' : ''}`).join('\n');
        break;
      }
      case 'preset get': {
        const view = await getPreset(id, options.merged ? await getRoot(options.cwd) : '', options.merged === true);
        result = options.merged ? resolveRoutes(view.preset, (await loadRoutes()).routes) : view.globalPreset;
        break;
      }
      case 'preset validate':
      case 'preset save': {
        const raw = await presetInput(options, action === 'preset validate');
        const { routes } = await loadRoutes();
        checked(raw, 'Invalid preset', routes);
        if (action === 'preset save') {
          const expectedId = options['expected-id'];
          const expectedSha = options['expected-sha'];
          if (!options.update && (expectedId !== undefined || expectedSha !== undefined)) {
            throw new CliError('--expected-id and --expected-sha require --update');
          }
          if (expectedId !== undefined && raw.id !== expectedId) {
            throw new CliError(`Conflict: expected preset ID ${expectedId}, got ${raw.id}`);
          }
          const path = presetPath(raw.id);
          if (!await atomicWrite(path, pretty(raw), { replace: options.update, expectedSha })) {
            throw new CliError(`Preset ${raw.id} already exists; pass --update to overwrite it`);
          }
          result = { id: raw.id, path };
          output = `Saved ${raw.id}: ${path}`;
        } else {
          result = { valid: true, id: raw.id };
          output = `Valid preset: ${raw.id}`;
        }
        break;
      }
      case 'routes': {
        const table = await loadRoutes();
        const modelsFile = modelsPath();
        const modelsBytes = await readBytes(modelsFile, true);
        const { presets } = await presetViews('', table.routes, false);
        const usage = Object.create(null);
        for (const name of Object.keys(table.routes)) usage[name] = [];
        const literalRoles = [];
        for (const { id, preset } of presets) for (const role of preset.roles) {
          const reference = `${id}.${role.id}`;
          if (role.route) (usage[role.route] ??= []).push(reference);
          else literalRoles.push(reference);
        }
        result = {
          routesPath: routesPath(), ...table,
          modelsPath: modelsFile,
          modelsText: modelsBytes ? modelsBytes.toString('utf8') : '',
          modelsSha: modelsBytes ? sha256(modelsBytes) : null,
          usage, literalRoles,
        };
        break;
      }
      case 'routes save': {
        const table = checkedRoutes(await presetInput(options, false));
        const path = routesPath();
        const data = pretty(table);
        await atomicWrite(path, data, { replace: true, expectedSha: options['expected-sha'] });
        result = { routesPath: path, reviewed: table.reviewed, routes: table.routes, routesSha: sha256(data) };
        output = `Saved route table: ${path}`;
        break;
      }
      case 'models save': {
        const sources = [options.text !== undefined, options.file !== undefined, options.stdin === true].filter(Boolean).length;
        if (sources !== 1) throw new CliError('Provide exactly one of --text, --file, or --stdin');
        const text = options.text !== undefined ? options.text
          : options.file !== undefined ? await readFile(options.file, 'utf8')
            : await new Promise((resolvePromise, reject) => {
              const chunks = [];
              process.stdin.on('data', chunk => chunks.push(chunk));
              process.stdin.once('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
              process.stdin.once('error', reject);
            });
        const path = modelsPath();
        const data = text.endsWith('\n') || !text.length ? text : `${text}\n`;
        await atomicWrite(path, data, { replace: true, expectedSha: options['expected-sha'] });
        result = { modelsPath: path, modelsSha: sha256(data) };
        output = `Saved model profiles: ${path}`;
        break;
      }
      case 'machine show': {
        result = await inspectMachine({ detect: false });
        output = [
          `Machine config: ${result.path} (${result.exists ? 'present' : 'not saved'})`,
          ...result.executables.map(row => `${row.name}\t${row.ok ? row.resolved : 'MISSING'}\t(${row.source})`),
        ].join('\n');
        break;
      }
      case 'machine detect': {
        result = await inspectMachine({ detect: true, write: Boolean(options.write) });
        output = [
          `${options.write ? 'Saved' : 'Detected'} machine config: ${result.path}`,
          ...result.executables.map(row => `${row.name}\t${row.ok ? row.resolved : 'MISSING'}\t(${row.source})`),
        ].join('\n');
        break;
      }
      case 'machine save': {
        const config = checkedMachine(await presetInput(options, false));
        const path = getMachineConfigPath();
        const data = pretty(config);
        await atomicWrite(path, data, { replace: true, expectedSha: options['expected-sha'] });
        machineConfigCache = { path, config };
        result = { path, sha: sha256(data), config };
        output = `Saved machine config: ${path}`;
        break;
      }
      case 'preset delete':
        assertPresetId(id);
        await unlink(presetPath(id)).catch(error => {
          if (error.code === 'ENOENT') throw new CliError(`Preset not found: ${id}`);
          throw error;
        });
        result = { id, path: presetPath(id) };
        output = `Deleted ${id}`;
        break;
      case 'init-project':
        result = await initProject(id, await getRoot(options.cwd));
        output = `${result.overlayDir}: ${result.created.length} created, ${result.skipped.length} unchanged`;
        break;
      case 'launch':
        if (options.parent !== undefined && options['no-parent']) throw new CliError('Choose --parent or --no-parent');
        if (options.parent === '') throw new CliError('Parent address must not be empty');
        result = await launch(id, options);
        if (!options['dry-run']) {
          if (result.roles.length && result.roles.every(role => !role.sent)) process.exitCode = 1;
          output = [
            `Run ${result.runId}: ${result.presetId}`,
            ...result.servers.map(server => `${server.name}\t${server.address ?? '-'}\t${server.reason ?? (server.ready ? server.urls.join(', ') || 'listening' : 'not ready')}`),
            ...result.roles.map(role => `${role.name}\t${role.address ?? '-'}\t${role.reason ?? 'sent'}`),
          ].join('\n');
        }
        break;
      case 'send':
        result = await send(id, summary, options);
        output = result.sent ? `Sent to ${id} (${result.address})` : 'Recorded (no live agent parent)';
        break;
      case 'status':
        result = await status(id);
        output = result.flatMap(run => run.roles.map(role => {
          const event = role.latestEvent;
          const last = role.last ?? (event ? `${event.kind} → ${event.to}: ${oneLine(event.summary)}` : '');
          return `${run.runId}/${role.id}\t${role.address}\t${role.status?.state ?? role.state}${last ? `\t${last}` : ''}`;
        })).join('\n');
        break;
      case 'stop':
        result = await stop(id, options);
        output = result.stopped.length ? `Stopped ${result.stopped.join(', ')}` : 'No live terminals';
        break;
      case 'servers': {
        if (options.run !== undefined) assertRunId(options.run);
        const spaces = options.spaces === undefined ? [] : parseJson(options.spaces, '--spaces');
        if (!Array.isArray(spaces) || spaces.some(space => typeof space !== 'string' || !space.startsWith('/'))) {
          throw new CliError('--spaces must be a JSON array of absolute folder paths');
        }
        result = await scanServers(await listTerminals(), { runId: options.run, spaces });
        output = [
          ...Object.entries(result.byTerminal).flatMap(([address, rows]) => rows.map(row => `${address}\t${row.url}\t${row.comm}`)),
          ...result.detached.map(row => `detached\t${row.url}\t${row.cwd}`),
        ].join('\n');
        break;
      }
    }
    process.stdout.write(json() || output === undefined ? pretty(result) : output ? `${output}\n` : '');
  } catch (error) {
    process.exitCode = 1;
    const message = oneLine(messageOf(error));
    const issues = error.issues ?? [];
    if (json()) process.stdout.write(pretty({ error: { message, issues } }));
    else process.stderr.write([message, ...issues.map(issue => `${issue.path || '(root)'}: ${issue.message}`)].join('\n') + '\n');
  }
}

if (import.meta.main ?? (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]))) {
  await main(process.argv.slice(2));
}
