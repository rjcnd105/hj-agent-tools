import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import test from 'node:test';
import { PRESET_JSON_SCHEMA, mergePresetOverlay, validatePreset } from '../skills/hc-team/scripts/hc-team.mjs';
import { attributeListeners, dnsHost, parseLsofCwd, parseLsofListen, parsePs, probeTls } from '../skills/hc-team/scripts/servers.mjs';

const cli = fileURLToPath(new URL('../skills/hc-team/scripts/hc-team.mjs', import.meta.url));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const routeTable = (routes = { implement: { command: ['node'] } }) => ({ schemaVersion: 1, reviewed: '2026-11-21', routes });
const readLog = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const role = (id, more = {}) => ({ id, title: id, ...('route' in more ? {} : { command: ['node'] }), instructions: `Implement ${id}.`, ...more });
const preset = (more = {}) => ({ schemaVersion: 1, id: 'example', name: 'Example', roles: [role('dev')], ...more });
const launchLabels = (runId, id, cwd, parent) => ({
  'hc.team.run': runId, 'hc.team.preset': 'example', 'hc.team.role': id, 'hc.team.cwd': cwd,
  ...(parent ? { 'hc.team.parent': parent } : {}),
});

function sandbox(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'hc-team-test-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const home = join(cwd, 'home');
  const config = join(cwd, 'fake.json');
  const log = join(cwd, 'fake.jsonl');
  const bin = join(cwd, 'bin');
  const presets = join(home, '.herdr/hj-team');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(config, '{}');
  writeFileSync(log, '');
  const env = { ...process.env, HOME: home, HERDR_MOD_HJ_TEAM_DIR: '', HC_TEAM_PRESETS_DIR: '', HC_TEAM_MACHINE_CONFIG: '', HC_TEAM_NO_LOGIN_SHELL: '1', HC_TERMINAL_ID: '', HC_FAKE_CONFIG: config, HC_FAKE_LOG: log, PATH: `${bin}:${process.env.PATH}` };
  const command = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', cwd, timeout: 25000, ...options, env: { ...env, ...options.env },
  });
  const commandAsync = (args, overrides = {}) => new Promise(resolve => {
    execFile(process.execPath, [cli, ...args], { cwd, timeout: 25000, env: { ...env, ...overrides } }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });
  const run = (args, options) => {
    const result = command(args, options);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.error ?? result.stderr}\n${result.stdout}`);
    return result;
  };
  const json = (args, options) => JSON.parse(run([...args, '--json'], options).stdout);
  const save = (obj, options = {}) => run(['preset', 'save', '--json', JSON.stringify(obj)], options);
  const executable = (name, body, dir = bin) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  };
  return { cwd, home, env, presets, command, commandAsync, run, json, save, executable, log, config };
}

function mockHc(box, config = {}) {
  writeFileSync(box.config, JSON.stringify(config));
  box.executable('hc', String.raw`
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const [verb, ...rest] = args;
const cfg = JSON.parse(readFileSync(process.env.HC_FAKE_CONFIG, 'utf8'));
const log = process.env.HC_FAKE_LOG;
const before = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const request = verb === 'connect' ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
appendFileSync(log, JSON.stringify({ args, request }) + '\n');
const flag = key => args[args.indexOf(key) + 1];
const send = object => console.log(JSON.stringify(object));
if (verb === 'connect') {
  const filters = request.params.labels ?? {};
  const scanned = before.some(x => x.args[0] === 'lsof');
  const started = cfg.runningServer && scanned && before.some(x => x.args[0] === 'run' && x.args.includes('hc.team.server=web'));
  const terminals = [...(cfg.terminals ?? [])];
  const readLabels = launched => Object.fromEntries(launched.args.flatMap((arg, i) => arg === '--label' ? [launched.args[i + 1].split('=')] : []));
  if (started) {
    const launched = before.find(x => x.args[0] === 'run' && x.args.includes('hc.team.server=web'));
    const labels = readLabels(launched);
    terminals.push({ address: 'tweb', pid: 99, cwd: cfg.cwd, state: 'live', labels: { ...labels, ...(!cfg.rawServer && { 'hj.url': 'http://localhost:4010' }) } });
  }
  if (cfg.trackRuns) for (const launched of before.filter(x => x.args[0] === 'run')) {
    const labels = readLabels(launched);
    const id = labels['hc.team.role'];
    if (id) terminals.push({ address: 't' + id, state: 'live', labels });
  }
  send({ jsonrpc: '2.0', id: request.id, result: { terminals: terminals.filter(t => (request.params.all || t.state === 'live') && Object.entries(filters).every(([key, value]) => t.labels?.[key] === value)) } });
} else if (verb === 'run') {
  const label = args.find(x => /^hc\.team\.(role|server)=/.test(x));
  const id = label.split('=')[1];
  if (cfg.failSpawn === id || (label.startsWith('hc.team.server=') && cfg.failServer === id)) {
    console.error('spawn_failed: test failure');
    process.exitCode = 1;
  } else {
    send({ address: 't' + id, name: flag('--name'), state: 'live' });
  }
} else if (verb === 'wait') {
  const target = rest.at(-1);
  const first = !before.some(x => x.args[0] === 'wait' && x.args.at(-1) === target);
  if ((cfg.exitDuringWait ?? []).includes(target)) send({ reason: 'exited', ended: true, exit_code: 1 });
  else if (first && (cfg.messageDuringWait ?? []).includes(target)) send({ reason: 'message', ended: false });
  else send({ status: 'idle', reason: 'status', ended: true, turn: 0 });
} else if (verb === 'read') {
  const target = rest.at(-1);
  console.log((cfg.readText ?? {})[target] ?? '');
} else if (verb === 'send') {
  const address = rest.at(-2);
  if (cfg.failSend === address) {
    process.exitCode = 1;
    console.error('target is blocked');
  } else {
    send({ started: !(cfg.notStarted ?? []).includes(address), turn: 0 });
  }
} else if (['label', 'kill', 'rm'].includes(verb)) {
  if (verb === 'rm' && cfg.failRm === rest[0]) {
    process.exitCode = 1;
    console.error('rm failed');
  } else send({});
} else {
  throw Error('Unexpected mock call: ' + args.join(' '));
}
`);
}

function mockProcesses(box, { ps, listeners, cwds = '' }) {
  box.executable('ps', `if (JSON.stringify(process.argv.slice(2)) !== '["-axo","pid=,ppid=,args="]') process.exit(9); process.stdout.write(${JSON.stringify(ps)});`);
  box.executable('lsof', `
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.HC_FAKE_LOG, JSON.stringify({ args: ['lsof', ...args] }) + '\\n');
if (args.join(' ') === '+c 0 -nP -iTCP -sTCP:LISTEN -F pcfnt') process.stdout.write(${JSON.stringify(listeners)});
else if (args.slice(0, 4).join(' ') === '-a -d cwd -p' && args[5] === '-Fpn') process.stdout.write(${JSON.stringify(cwds)});
else process.exit(9);`);
}

test('preset validation follows the exported schema and reports exact JSON pointers', t => {
  const box = sandbox(t);
  assert.deepEqual(box.json(['schema']), PRESET_JSON_SCHEMA);
  assert.deepEqual(validatePreset(preset()), []);
  assert.deepEqual(validatePreset([]), [{ path: '', message: 'Expected object' }]);
  const bad = preset({
    schemaVersion: 2, id: 'Bad_ID', name: 'x'.repeat(81), description: 1, 'a~/b': null,
    servers: [{ id: 'web', command: ['bun', ''], cwd: 'one/../two' }, { id: 'web', command: [] }],
    roles: [role('dev', { title: '', skills: [''], talksTo: ['dev', 'missing'], 'readyPattern': 'ready' }),
      role('dev'), role('parent', { default: 'true', readOnly: 'false' })],
  });
  const errors = validatePreset(bad);
  for (const path of ['/schemaVersion', '/id', '/name', '/description', '/a~0~1b', '/servers/0/command/1',
    '/servers/0/cwd', '/servers/1/id', '/servers/1/command', '/roles/0/title', '/roles/0/skills/0',
    '/roles/0/readyPattern', '/roles/0/talksTo/0', '/roles/0/talksTo/1', '/roles/1/id', '/roles/2/id', '/roles/2/default', '/roles/2/readOnly']) {
    assert.ok(errors.some(issue => issue.path === path && issue.message), `missing issue ${path}`);
  }
  for (const cwd of ['/absolute', '../outside', 'nested/..', 'C:\\outside', 'one\\..\\two', '']) {
    assert.ok(validatePreset(preset({ servers: [{ id: 'web', command: ['bun'], cwd }] })).some(x => x.path === '/servers/0/cwd'), cwd);
  }
  assert.ok(validatePreset(preset({ roles: [] })).some(x => x.path === '/roles'));
  assert.ok(validatePreset(preset({ roles: Array.from({ length: 13 }, (_, i) => role(`r${i}`)) })).some(x => x.path === '/roles'));
  const result = box.command(['preset', 'validate', '--json', JSON.stringify(bad)]);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).error.issues, errors);
});

test('overlay shallow-merges roles, replaces servers and arrays, and validates final references at launch', t => {
  const box = sandbox(t);
  const global = preset({
    roles: [role('dev', { talksTo: ['qa'], owns: ['src/**'], skills: ['existing'], checkpoints: ['old'] }), role('qa')],
    servers: [{ id: 'web', command: ['bun', 'dev'], cwd: 'app' }, { id: 'api', command: ['node', 'api.js'] }],
  });
  const merged = mergePresetOverlay(global, {
    name: 'Project name', description: '',
    roles: [{ id: 'dev', default: false, command: ['codex'], skills: [], owns: ['new/**'], talksTo: ['review'], checkpoints: ['new'] },
      { id: 'qa', remove: true }, role('review')],
    servers: [{ id: 'web', command: ['node', 'web.js'] }, { id: 'api', remove: true }, { id: 'extra', command: ['bun'] }],
  });
  assert.deepEqual(merged, {
    ...global, name: 'Project name', description: '',
    roles: [role('dev', { default: false, command: ['codex'], skills: [], owns: ['new/**'], talksTo: ['review'], checkpoints: ['new'] }), role('review')],
    servers: [{ id: 'web', command: ['node', 'web.js'] }, { id: 'extra', command: ['bun'] }],
  });
  assert.deepEqual(validatePreset(merged), []);
  assert.deepEqual(global.roles[0].skills, ['existing']);
  assert.throws(() => mergePresetOverlay(global, { id: 'x' }), /Invalid overlay/);
  box.save(global);
  const { overlayDir } = box.json(['init-project', global.id]);
  writeFileSync(join(overlayDir, 'preset.json'), JSON.stringify({ roles: [{ id: 'qa', remove: true }] }));
  const result = box.command(['launch', global.id, '--dry-run', '--json']);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).error.issues, [{ path: '/roles/0/talksTo/0', message: 'Unknown role qa' }]);
});

test('seed and preset CRUD honor HERDR_MOD_HJ_TEAM_DIR and HC_TEAM_PRESETS_DIR, validate all input forms, and never overwrite implicitly', t => {
  const box = sandbox(t);
  const dir = join(box.cwd, 'custom presets');
  const legacyDir = join(box.cwd, 'legacy presets');
  const env = { HERDR_MOD_HJ_TEAM_DIR: dir, HC_TEAM_PRESETS_DIR: legacyDir };
  const options = { env };
  assert.equal(box.json(['preset', 'list'], { env: { HERDR_MOD_HJ_TEAM_DIR: '   ', HC_TEAM_PRESETS_DIR: legacyDir } }).presetsDir, legacyDir);
  // Every shipped preset (`_` files are routing data, not presets), so adding one doesn't break this test.
  const expected = readdirSync(fileURLToPath(new URL('../presets/', import.meta.url)))
    .filter(name => name.endsWith('.json') && !name.startsWith('_')).map(name => name.slice(0, -5)).sort();
  assert.deepEqual(box.json(['seed'], options), { presetsDir: dir, created: expected, skipped: [] });
  const list = box.json(['preset', 'list'], options);
  assert.equal(list.presetsDir, dir);
  assert.equal(list.projectRoot, box.cwd);
  assert.deepEqual(list.presets.map(x => x.id), expected);
  assert.ok(list.presets.every(x => x.defaultRoles.length > 0 && !x.hasOverlay && x.globalPreset && x.preset));
  assert.match(list.routesReviewed, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(list.routesSha, sha(join(dir, '_routes.json')));
  assert.deepEqual(new Set(list.presets.flatMap(x => x.preset.roles.map(y => y.command[0]))), new Set(['pi', 'claude', 'agy', 'codex']));
  assert.deepEqual(box.json(['preset', 'list']), { presetsDir: box.presets, projectRoot: box.cwd, routesReviewed: null, routes: {}, routesSha: null, presets: [], errors: [] });
  const stored = box.json(['preset', 'get', 'web-feature-squad'], options);
  assert.deepEqual(stored, readJson(join(dir, 'web-feature-squad.json')));
  const altered = { ...stored, name: 'Personal preset' };
  const input = JSON.stringify(altered);
  const denied = box.command(['preset', 'save', '--json', input], options);
  assert.equal(denied.status, 1);
  assert.match(JSON.parse(denied.stdout).error.message, /--update/);
  assert.deepEqual(box.json(['preset', 'get', stored.id], options), stored);
  box.run(['preset', 'save', '--stdin', '--update'], { input, env });
  assert.deepEqual(box.json(['seed'], options).skipped, expected);
  assert.equal(box.json(['preset', 'get', stored.id], options).name, altered.name);
  const path = join(dir, 'web-feature-squad.json');
  assert.deepEqual(box.json(['preset', 'validate', '--file', path], options), { valid: true, id: stored.id });
  assert.deepEqual(box.json(['preset', 'validate', '--stdin'], { env, input }), { valid: true, id: stored.id });
  assert.equal(box.command(['preset', 'validate', '--file', path, '--stdin', '--json'], { env, input }).status, 1);
  const newFile = join(box.cwd, 'arbitrary.json');
  writeFileSync(newFile, JSON.stringify(preset()));
  assert.equal(box.json(['preset', 'save', '--file', newFile], options).path, join(dir, 'example.json'));
  assert.deepEqual(box.json(['preset', 'delete', 'example'], options), { id: 'example', path: join(dir, 'example.json') });
  assert.deepEqual(readdirSync(dir).sort(), ['_models.md', '_routes.json', ...expected.map(id => `${id}.json`)]);
});

test('init-project finds the Git root and is idempotent, with QA sections by ID or skill', t => {
  const box = sandbox(t);
  execFileSync('git', ['init', '-q', box.cwd]);
  const subdir = join(box.cwd, 'nested', 'feature');
  mkdirSync(subdir, { recursive: true });
  box.save(preset({ roles: [role('web-qa'), role('browser-verifier', { skills: ['ego-recorder'] }), role('dev')] }));
  const init = box.json(['init-project', 'example', '--cwd', subdir]);
  assert.equal(init.overlayDir, join(box.cwd, 'docs/agent-presets/example'));
  assert.deepEqual(init.created, ['preset.json', 'shared.md', 'roles/web-qa.md', 'roles/browser-verifier.md', 'roles/dev.md', 'tools/README.md']);
  assert.deepEqual(init.skipped, []);
  for (const id of ['web-qa', 'browser-verifier']) {
    const text = readFileSync(join(init.overlayDir, `roles/${id}.md`), 'utf8');
    for (const section of ['Base URLs & Dev Server', 'Login & Test Accounts', 'Key User Journeys', '`ego-rec` Recordings Inventory',
      '`input-replay` Gesture Targets & Viewports', 'Known Flaky Areas', 'hc-team servers --run', 'never write credentials', 'selector']) {
      assert.ok(text.includes(section), `missing ${section}`);
    }
  }
  assert.doesNotMatch(readFileSync(join(init.overlayDir, 'roles/dev.md'), 'utf8'), /Key User Journeys/);
  writeFileSync(join(init.overlayDir, 'shared.md'), 'Keep my edit.');
  writeFileSync(join(init.overlayDir, 'preset.json'), '{"name":"Overlay name","roles":[{"id":"dev","default":false}]}');
  assert.deepEqual(box.json(['init-project', 'example', '--cwd', subdir]), { ...init, created: [], skipped: init.created });
  assert.equal(readFileSync(join(init.overlayDir, 'shared.md'), 'utf8'), 'Keep my edit.');
  const { presets: [item] } = box.json(['preset', 'list', '--cwd', subdir]);
  assert.equal(item.globalPreset.name, 'Example');
  assert.equal(item.preset.name, 'Overlay name');
  assert.equal(item.hasOverlay, true);
  assert.deepEqual(item.defaultRoles, ['web-qa', 'browser-verifier']);
  assert.deepEqual(box.json(['preset', 'get', 'example', '--merged', '--cwd', subdir]), item.preset);
});

test('launch dry-run resolves argv and Codex flags before --; only queries hc to validate an implicit parent', t => {
  const box = sandbox(t);
  const codexDir = join(box.home, '.cache/.bun/bin');
  box.executable('codex', 'process.exit(99);', codexDir);
  mockHc(box, { terminals: [
    { address: 'tparent', state: 'live', reported: true },
    { address: 'tshell', state: 'live', reported: false, status: null },
    { address: 'remote/tparent', state: 'live', reported: true },
  ] });
  const reviewer = role('reviewer', { command: ['codex', '-c', 'model_reasoning_effort="xhigh"', '--', '--no-daemon'] });
  box.save(preset({ roles: [role('dev'), reviewer, role('optional', { default: false })], servers: [{ id: 'web', command: ['node'], cwd: 'web' }] }));
  const args = ['launch', 'example', '--dry-run', '--with-servers'];
  const isolatedPath = `${dirname(box.log)}/bin:${dirname(process.execPath)}:/usr/bin:/bin`;
  const plan = box.json(args, { env: { HC_TERMINAL_ID: 'tparent', PATH: isolatedPath } });
  assert.match(plan.runId, /^[a-z0-9]{6}$/);
  assert.equal(plan.parent, 'tparent');
  assert.deepEqual(plan.roles.map(x => x.id), ['dev', 'reviewer']);
  assert.equal(plan.roles[1].name, `${plan.runId}-reviewer`);
  assert.deepEqual(plan.roles[1].labels, launchLabels(plan.runId, 'reviewer', box.cwd, 'tparent'));
  assert.deepEqual(plan.roles[1].command, [join(codexDir, 'codex'), '--no-daemon', ...reviewer.command.slice(1)]);
  assert.match(basename(plan.roles[1].briefPath), /^reviewer-[a-f0-9]{6}\.md$/);
  assert.equal(plan.servers[0].cwd, join(box.cwd, 'web'));
  const serverLabels = launchLabels(plan.runId, 'unused', box.cwd, 'tparent');
  delete serverLabels['hc.team.role'];
  assert.deepEqual(plan.servers[0].labels, { ...serverLabels, 'hc.team.server': 'web' });
  assert.deepEqual(box.json(['preset', 'get', 'example']).roles[1].command, reviewer.command);
  const choice = box.json([...args, '--roles', 'optional', '--no-parent'], { env: { HC_TERMINAL_ID: 'tparent' } });
  assert.equal(choice.parent, null);
  assert.equal(choice.roles[0].id, 'optional');
  assert.ok(!('hc.team.parent' in choice.roles[0].labels));
  assert.equal(box.json(args, { env: { HC_TERMINAL_ID: 'tshell' } }).parent, null);
  assert.equal(box.json(args, { env: { HC_TERMINAL_ID: 'remote/tparent' } }).parent, null);
  assert.ok(readLog(box.log).every(row => row.args[0] === 'connect'));
  assert.ok(!readdirSync(box.home).includes('.local'));
  assert.equal(box.command([...args, '--roles', 'missing']).status, 1);
});

test('launch starts servers first, continues readiness after a message, never repeats a submitted brief, and preserves the snapshot', t => {
  const box = sandbox(t);
  const initial = preset({
    roles: [role('dev', { command: ['custom-agent'], owns: ['src/**'] }), role('qa'), role('broken'), role('extra', { default: false })],
    servers: [{ id: 'web', command: ['node', 'server.mjs'] }],
  });
  box.save(initial);
  box.executable('custom-agent', 'process.exit(99);');
  mockHc(box, { runningServer: true, cwd: box.cwd, failSpawn: 'broken', notStarted: ['tdev'], messageDuringWait: ['tqa'] });
  mockProcesses(box, { ps: '99 1 node server.mjs\n', listeners: 'p99\ncnode\nn*:4010\n' });
  const result = box.json(['launch', 'example', '--with-servers', '--task', 'Line one.\nLine two.', '--parent', 'tparent']);
  assert.deepEqual(result.servers, [{ id: 'web', address: 'tweb', name: `${result.runId}--web`, ready: true, urls: ['http://localhost:4010'], reason: null }]);
  const [dev, qa, broken] = result.roles;
  assert.deepEqual(result.roles.map(r => [r.id, r.address, r.sent]), [['dev', 'tdev', true], ['qa', 'tqa', true], ['broken', null, false]]);
  assert.equal(dev.started, false);
  assert.equal(dev.reason, 'submitted; did not enter working state');
  assert.equal(qa.reason, null);
  assert.match(broken.reason, /spawn_failed/);
  const brief = readFileSync(dev.briefPath, 'utf8');
  assert.match(brief, /Line one\.\nLine two\./);
  assert.match(brief, /src\/\*\*/);
  assert.match(brief, /docs\/agent-presets\/example\/shared\.md/);
  const snapshot = join(result.runDir, 'preset.json');
  const original = readFileSync(snapshot, 'utf8');
  assert.deepEqual(JSON.parse(original).roles[0].command, ['custom-agent']);
  const commands = readLog(box.log).map(row => row.args);
  const runs = commands.filter(args => args[0] === 'run');
  assert.ok(runs[0].includes('hc.team.server=web'));
  assert.ok(runs[1].includes('hc.team.parent=tparent'));
  assert.ok(commands.some(args => args[0] === 'wait' && args.includes('45')));
  assert.equal(commands.filter(args => args[0] === 'lsof').length, 2);
  const sends = commands.filter(args => args[0] === 'send');
  assert.equal(sends.filter(args => args.at(-2) === 'tdev').length, 1);
  assert.equal(sends.filter(args => args.at(-2) === 'tqa').length, 1);
  assert.equal(sends.find(args => args.at(-2) === 'tdev').at(-1), `Read ${dev.briefPath}. Task: Line one. Line two.`);
  assert.equal(commands.filter(args => args[0] === 'wait' && args.at(-1) === 'tqa').length, 2);
  assert.ok(!commands.some(args => args[0] === 'kill' || args[0] === 'rm'));
  box.run(['preset', 'save', '--json', JSON.stringify(preset()), '--update']);
  const additional = box.json(['launch', 'example', '--run', result.runId, '--roles', 'extra']);
  assert.equal(additional.runId, result.runId);
  assert.equal(additional.roles[0].sent, true);
  assert.equal(readFileSync(snapshot, 'utf8'), original);
});

test('send infers sender, warns without blocking, records events, and status/stop query exact run labels', t => {
  const box = sandbox(t);
  const runId = 'abc123';
  const snapshot = join(box.home, '.local/state/hc-team/runs', runId, 'preset.json');
  mkdirSync(dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, JSON.stringify(preset({ roles: [role('dev'), role('qa')] })));
  const terminals = [
    { address: 't1', name: `${runId}-dev`, state: 'live', status: { state: 'idle' }, labels: launchLabels(runId, 'dev', box.cwd) },
    { address: 't2', name: `${runId}-qa`, state: 'live', labels: launchLabels(runId, 'qa', box.cwd) },
    { address: 't3', name: `${runId}-old`, state: 'finished', labels: launchLabels(runId, 'old', box.cwd) },
    { address: 't4', name: 'other', state: 'live', labels: launchLabels('other1', 'qa', box.cwd) },
  ];
  mockHc(box, { terminals });
  const summary = `Ready | use this\n${'x'.repeat(125)}`;
  const message = box.run(['send', 'qa', summary, '--kind', 'review', '--artifact', 'review.md', '--json'], { env: { HC_TERMINAL_ID: 't1' } });
  assert.match(message.stderr, /dev\.talksTo does not include qa/);
  assert.equal(JSON.parse(message.stdout).address, 't2');
  const noParent = box.json(['send', 'parent', 'Finished', '--run', runId, '--from', 'dev', '--kind', 'result']);
  assert.equal(noParent.sent, false);
  assert.equal(noParent.address, null);
  const log = readLog(box.log);
  assert.deepEqual(log.filter(x => x.args[0] === 'label').map(x => x.args.slice(1)), [
    ['t1', `hc.team.last=review|qa|${summary.replace('|', '/').replace('\n', ' ').slice(0, 120)}`],
    ['t1', 'hc.team.last=result|parent|Finished'],
  ]);
  assert.deepEqual(log.filter(x => x.args[0] === 'send').map(x => x.args.slice(-2)), [['t2', `[review] ${summary} (artifact: review.md)`]]);
  const [run] = box.json(['status', runId]);
  assert.equal(run.runId, runId);
  assert.deepEqual(run.roles.map(r => r.id), ['dev', 'qa']);
  assert.equal(run.roles[0].latestEvent.summary, 'Finished');
  const [event] = run.events;
  assert.deepEqual(event, { ts: event.ts, from: 'dev', to: 'qa', kind: 'review', summary, artifact: 'review.md' });
  assert.ok(Number.isFinite(Date.parse(event.ts)));
  const statusText = box.run(['status', runId]).stdout.trim().split('\n');
  assert.equal(statusText.length, 2);
  assert.match(statusText[0], /Finished/);
  assert.deepEqual(box.json(['stop', runId]), { runId, stopped: ['t1', 't2', 't3'] });
  const requests = readLog(box.log);
  assert.ok(requests.some(x => x.request?.params?.labels?.['hc.team.run'] === runId));
  assert.ok(requests.some(x => x.request?.params?.all === true));
  for (const [verb, expected] of [['kill', ['t1', 't2']], ['rm', ['t1', 't2', 't3']]]) {
    assert.deepEqual(requests.filter(x => x.args[0] === verb).map(x => x.args[1]).sort(), expected);
  }
  mockHc(box, { terminals, failSend: 't2' });
  const blocked = box.command(['send', 'qa', 'Still there?', '--run', runId, '--from', 'dev', '--json']);
  assert.equal(blocked.status, 1);
  assert.match(JSON.parse(blocked.stdout).error.message, /blocked/);
  assert.equal(readLog(box.log).filter(x => x.args[0] === 'label').length, 2);
  assert.equal(readLog(join(dirname(snapshot), 'events.jsonl')).length, 2);
  assert.ok(log.findIndex(x => x.args[0] === 'send') < log.findIndex(x => x.args[0] === 'label'));
});

test('route table validates, reports usage and raw SHAs, guards writes, and resolves project overrides', t => {
  const box = sandbox(t);
  const path = join(box.presets, '_routes.json');
  const table = routeTable({ implement: { command: ['node'], why: 'fast' }, review: { command: ['node', 'review'] } });
  const { routesSha } = box.json(['routes', 'save', '--stdin'], { input: JSON.stringify(table) });
  assert.equal(routesSha, sha(path));
  const authored = preset({ roles: [role('dev', { route: 'implement' }), role('reviewer')] });
  box.save(authored);
  const globalFile = join(box.presets, 'example.json');
  writeFileSync(globalFile, `\n${JSON.stringify(authored)}\n`);
  assert.deepEqual(box.json(['routes']), {
    routesPath: path, reviewed: table.reviewed, routes: table.routes, routesSha,
    modelsPath: join(box.presets, '_models.md'), modelsText: '', modelsSha: null,
    usage: { implement: ['example.dev'], review: [] }, literalRoles: ['example.reviewer'],
  });
  const savedModels = box.json(['models', 'save', '--text', '# Models\n- claude-6']);
  assert.equal(savedModels.modelsPath, join(box.presets, '_models.md'));
  assert.equal(savedModels.modelsSha, sha(savedModels.modelsPath));
  assert.equal(box.json(['routes']).modelsText, '# Models\n- claude-6\n');
  assert.equal(box.command(['models', 'save', '--text', '# stale', '--expected-sha', '0'.repeat(64)]).status, 1);
  const updatedModels = box.json(['models', 'save', '--text', '# Models v2', '--expected-sha', savedModels.modelsSha]);
  assert.equal(updatedModels.modelsSha, sha(savedModels.modelsPath));
  const { overlayDir } = box.json(['init-project', 'example']);
  const overlay = { roles: [{ id: 'dev', command: ['node', 'local'] }, { id: 'reviewer', route: 'review' }] };
  writeFileSync(join(overlayDir, 'preset.json'), JSON.stringify(overlay));
  const { presets: [row] } = box.json(['preset', 'list']);
  assert.deepEqual(row.globalPreset, authored);
  assert.equal(row.globalSha, sha(globalFile));
  assert.deepEqual(row.preset.roles.map(({ command, route }) => [command, route]), [[['node', 'local'], undefined], [['node', 'review'], 'review']]);
  assert.deepEqual(box.json(['preset', 'get', 'example', '--merged']), row.preset);
  const noSource = { id: 'dev', title: 'dev', instructions: 'work' };
  for (const invalid of [noSource, { ...noSource, route: 'implement', command: ['node'] }]) {
    assert.deepEqual(validatePreset(preset({ roles: [invalid] }), table.routes), [{ path: '/roles/0', message: 'Specify exactly one of route or command' }]);
  }
  const unknown = preset({ roles: [role('dev', { route: 'missing' })] });
  for (const verb of ['validate', 'save']) {
    const result = box.command(['preset', verb, `--json=${JSON.stringify(unknown)}`]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).error.issues, [{ path: '/roles/0/route', message: 'Unknown route missing; available routes: implement, review' }]);
  }
  const invalid = box.command(['routes', 'save', '--json', JSON.stringify(routeTable({ Invalid: { command: [''] }, other: { command: [] } }))]);
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stdout).error.issues.map(x => x.path), ['/routes/Invalid', '/routes/Invalid/command/0', '/routes/other/command']);
  const badDate = box.command(['routes', 'save', '--json', JSON.stringify({ ...table, reviewed: '2026-02-31' })]);
  assert.equal(badDate.status, 1);
  assert.equal(JSON.parse(badDate.stdout).error.issues[0].path, '/reviewed');
  const stale = box.command(['routes', 'save', '--expected-sha=old', '--json', JSON.stringify(table)]);
  assert.equal(stale.status, 1);
  assert.match(JSON.parse(stale.stdout).error.message, /Conflict/);
  assert.equal(sha(path), routesSha);
  const edited = join(box.cwd, 'edited.json');
  writeFileSync(edited, JSON.stringify({ ...table, reviewed: '2026-11-22', routes: { implement: table.routes.implement } }));
  assert.notEqual(box.json(['routes', 'save', `--file=${edited}`, `--expected-sha=${routesSha}`]).routesSha, routesSha);
  const unresolved = box.json(['preset', 'list']).presets[0].preset.roles[1];
  assert.equal(unresolved.routeError, 'unknown route: review');
  assert.ok(!Object.hasOwn(unresolved, 'command'));
});

test('preset listing isolates malformed and dangling global files and a broken overlay', t => {
  const box = sandbox(t);
  box.save(preset());
  box.save(preset({ id: 'bad-overlay' }));
  const { overlayDir } = box.json(['init-project', 'bad-overlay']);
  writeFileSync(join(overlayDir, 'preset.json'), '{"roles":[{"id":"dev","command":[]}]}');
  writeFileSync(join(box.presets, 'bad-json.json'), '{');
  symlinkSync(join(box.cwd, 'missing.json'), join(box.presets, 'bad-link.json'));
  const { presets, errors } = box.json(['preset', 'list']);
  assert.deepEqual(presets.map(row => row.id), ['example']);
  assert.deepEqual(errors.map(row => [row.id, row.path]), [
    ['bad-json', join(box.presets, 'bad-json.json')], ['bad-link', join(box.presets, 'bad-link.json')],
    ['bad-overlay', join(overlayDir, 'preset.json')],
  ]);
  assert.match(errors[2].message, /\/roles\/0\/command/);
});

test('preset update rejects target changes and stale edits; new saves and seed publish without replacing', async t => {
  const box = sandbox(t);
  box.save(preset());
  box.save(preset({ id: 'other' }));
  const example = join(box.presets, 'example.json');
  const other = join(box.presets, 'other.json');
  const originalOther = readFileSync(other, 'utf8');
  const oldSha = sha(example);
  const update = (obj, expectedId, expectedSha) => box.command(['preset', 'save', '--update', '--expected-id', expectedId, '--expected-sha', expectedSha, '--json', JSON.stringify(obj)]);
  const retarget = update(preset({ id: 'other', name: 'overwrite' }), 'example', sha(other));
  assert.equal(retarget.status, 1);
  assert.match(JSON.parse(retarget.stdout).error.message, /expected preset ID example, got other/);
  assert.equal(readFileSync(other, 'utf8'), originalOther);
  writeFileSync(example, `${readFileSync(example, 'utf8')} `);
  const stale = update(preset({ name: 'stale' }), 'example', oldSha);
  assert.equal(stale.status, 1);
  assert.match(JSON.parse(stale.stdout).error.message, /Conflict/);
  assert.equal(readJson(example).name, 'Example');
  assert.equal(update(preset({ name: 'updated' }), 'example', sha(example)).status, 0);

  mkdirSync(join(box.presets, '.race.json.save-lock'));
  const saves = await Promise.all(['first', 'second'].map(name => box.commandAsync(['preset', 'save', '--json', JSON.stringify(preset({ id: 'race', name }))])));
  assert.deepEqual(saves.map(s => s.status).sort(), [0, 1]);
  assert.equal(readJson(join(box.presets, 'race.json')).name, saves[0].status === 0 ? 'first' : 'second');
  assert.ok(!readdirSync(box.presets).some(name => name.startsWith('.tmp-')));

  const from = join(box.cwd, 'seed');
  mkdirSync(from);
  writeFileSync(join(from, 'example.json'), JSON.stringify(preset({ name: 'seed' })));
  writeFileSync(join(from, '_routes.json'), JSON.stringify(routeTable()));
  writeFileSync(join(from, '_models.md'), '# seed models\n');
  assert.deepEqual(box.json(['seed', `--from=${from}`]).skipped, ['example']);
  const catalog = join(box.presets, '_routes.json');
  const models = join(box.presets, '_models.md');
  assert.equal(sha(catalog), sha(join(from, '_routes.json')));
  assert.equal(sha(models), sha(join(from, '_models.md')));
  writeFileSync(catalog, JSON.stringify(routeTable({ personal: { command: ['node'] } })));
  writeFileSync(models, '# personal notes\n');
  box.json(['seed', `--from=${from}`]);
  assert.deepEqual(Object.keys(readJson(catalog).routes), ['personal']);
  assert.equal(readFileSync(models, 'utf8'), '# personal notes\n');
  assert.equal(readJson(example).name, 'updated');
});

test('init-project refuses each escaped ancestor before touching any project or outside files', t => {
  const box = sandbox(t);
  box.save(preset());
  const outside = join(box.cwd, 'outside');
  mkdirSync(outside);
  for (const [i, ancestor] of ['docs', 'docs/agent-presets', 'docs/agent-presets/example', 'docs/agent-presets/example/roles', 'docs/agent-presets/example/tools'].entries()) {
    const root = join(box.cwd, `project-${i}`);
    const linkPath = join(root, ancestor);
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(outside, linkPath, 'dir');
    const result = box.command(['init-project', 'example', '--cwd', root, '--json']);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error.message, /escapes project root/);
    assert.deepEqual(readdirSync(outside), []);
    assert.ok(!existsSync(join(root, 'docs/agent-presets/example/shared.md')));
    assert.ok(!existsSync(join(root, 'docs/agent-presets/example/preset.json')));
  }
});

test('launch freezes routed commands and the original parent and cwd even after all terminals finish', t => {
  const box = sandbox(t);
  const table = routeTable({ implement: { command: ['node', 'initial'] }, obsolete: { command: ['node'] } });
  box.run(['routes', 'save', '--json', JSON.stringify(table)]);
  box.save(preset({ roles: [role('dev', { route: 'implement' }), role('extra', { route: 'implement', default: false }), role('broken', { route: 'obsolete' })] }));
  delete table.routes.obsolete;
  box.run(['routes', 'save', '--json', JSON.stringify(table)]);
  mockHc(box);
  const initial = box.json(['launch', 'example', '--parent', 'tparent']);
  assert.deepEqual(initial.roles.map(r => [r.sent, r.reason]), [[true, null], [false, 'unknown route: obsolete']]);
  assert.deepEqual(readJson(join(initial.runDir, 'meta.json')), {
    runId: initial.runId, presetId: 'example', projectRoot: box.cwd, parent: 'tparent',
  });
  const snapshot = readJson(join(initial.runDir, 'preset.json'));
  assert.equal(snapshot.roles[0].route, 'implement');
  assert.deepEqual(snapshot.roles[0].command, ['node', 'initial']);
  table.routes.implement.command[1] = 'updated';
  table.routes.obsolete = { command: ['node'] };
  box.run(['routes', 'save', '--json', JSON.stringify(table)]);
  const other = join(box.cwd, 'other');
  mkdirSync(other);
  const conflictingArgs = ['launch', 'example', '--run', initial.runId, '--roles', 'extra', `--cwd=${other}`, '--no-parent'];
  const dry = box.json([...conflictingArgs, '--dry-run']);
  assert.equal(dry.projectRoot, box.cwd);
  assert.equal(dry.parent, 'tparent');
  assert.equal(dry.roles[0].command.at(-1), 'initial');
  mockHc(box, { terminals: [{ address: 'elsewhere/textra', state: 'live', labels: launchLabels(initial.runId, 'extra', other) }] });
  const resumed = box.json(conflictingArgs, { env: { HC_TERMINAL_ID: 'tcaller' } });
  assert.equal(resumed.projectRoot, box.cwd);
  assert.equal(resumed.parent, 'tparent');
  assert.equal(resumed.roles[0].sent, true);
  const run = readLog(box.log).find(row => row.args.includes('hc.team.role=extra')).args;
  assert.equal(run.at(-1), 'initial');
  assert.ok(run.includes('hc.team.parent=tparent'));
  assert.deepEqual(readJson(join(initial.runDir, 'preset.json')), snapshot);
  const unresolved = box.command(['launch', 'example', '--run', initial.runId, '--roles', 'broken', '--json']);
  assert.equal(unresolved.status, 1);
  assert.equal(JSON.parse(unresolved.stdout).roles[0].reason, 'unknown route: obsolete');
});

test('concurrent role launches cannot share a brief or spawn twice, and a later launch rechecks live state', async t => {
  const box = sandbox(t);
  box.save(preset({ roles: [role('dev', { default: false })] }));
  mockHc(box, { trackRuns: true });
  const initial = box.json(['launch', 'example']);
  const args = ['launch', 'example', '--run', initial.runId, '--roles', 'dev', '--json'];
  const raced = await Promise.all(['A', 'B'].map(task => box.commandAsync([...args, `--task=${task}`])));
  assert.deepEqual(raced.map(r => r.status).sort(), [0, 1]);
  const winner = raced[0].status === 0 ? 0 : 1;
  const { roles: [roleResult] } = JSON.parse(raced[winner].stdout);
  const { roles: [denied] } = JSON.parse(raced[1 - winner].stdout);
  assert.match(denied.reason, /already (?:in progress|live)/);
  assert.deepEqual(readdirSync(join(initial.runDir, 'briefs')), [basename(roleResult.briefPath)]);
  assert.match(basename(roleResult.briefPath), /^dev-[0-9a-f]{6}\.md$/);
  assert.match(readFileSync(roleResult.briefPath, 'utf8'), new RegExp(`## Task\n${winner === 0 ? 'A' : 'B'}\n`));
  const duplicate = box.command(args);
  assert.equal(duplicate.status, 1);
  assert.match(JSON.parse(duplicate.stdout).roles[0].reason, /already live/);
  assert.equal(readLog(box.log).filter(row => row.args[0] === 'run').length, 1);
  assert.deepEqual(readdirSync(join(initial.runDir, 'locks')), []);
  mockHc(box); // The old terminal has finished.
  const replacement = JSON.parse(box.run([...args, '--task=Replacement']).stdout).roles[0];
  assert.notEqual(replacement.briefPath, roleResult.briefPath);
  assert.match(readFileSync(replacement.briefPath, 'utf8'), /## Task\nReplacement\n/);
  assert.match(readFileSync(roleResult.briefPath, 'utf8'), new RegExp(`## Task\n${winner === 0 ? 'A' : 'B'}\n`));
});

test('launch treats --help as task text, protects single executable argv and separates same-ID role/server names', t => {
  const box = sandbox(t);
  const executable = join(box.cwd, 'with spaces', 'agent');
  const shellSyntax = join(box.cwd, 'agent;path');
  box.executable('agent', '', dirname(executable));
  box.executable(basename(shellSyntax), '', box.cwd);
  box.save(preset({ roles: [role('web', { command: [executable] }), role('meta', { default: false, command: [shellSyntax] })],
    servers: [{ id: 'web', command: ['node'] }] }));
  mockHc(box, { failServer: 'web' });
  const result = box.json(['launch', 'example', '--task=--help', '--with-servers']);
  assert.equal(result.roles[0].name, `${result.runId}-web`);
  assert.equal(result.servers[0].name, `${result.runId}--web`);
  assert.match(result.servers[0].reason, /spawn_failed/);
  const run = readLog(box.log).find(row => row.args.includes('hc.team.role=web')).args;
  assert.deepEqual(run.slice(run.indexOf('--') + 1), ['/usr/bin/env', executable]);
  assert.match(readFileSync(result.roles[0].briefPath, 'utf8'), /## Task\n--help\n/);
  const other = box.json(['launch', 'example', '--roles', 'meta', '--task', '--help']);
  assert.match(readFileSync(other.roles[0].briefPath, 'utf8'), /## Task\n--help\n/);
  const meta = readLog(box.log).find(row => row.args.includes('hc.team.role=meta')).args;
  assert.deepEqual(meta.slice(meta.indexOf('--') + 1), ['/usr/bin/env', shellSyntax]);
  assert.match(box.run(['launch', '--help']).stdout, /^Usage:/);
  mockHc(box, { failSpawn: 'web' });
  const failed = box.command(['launch', 'example', '--with-servers', '--json']);
  assert.equal(failed.status, 1);
  for (const report of [...JSON.parse(failed.stdout).roles, ...JSON.parse(failed.stdout).servers]) {
    assert.equal(report.address, null);
    assert.match(report.reason, /spawn_failed/);
  }
  mockHc(box, {
    exitDuringWait: ['tweb'],
    readText: { tweb: '\n\nmise ERROR failed to parse template\nField USER_HOST is not defined in env.\n' },
  });
  const exited = box.command(['launch', 'example', '--json']);
  assert.equal(exited.status, 1);
  assert.match(JSON.parse(exited.stdout).roles[0].reason, /Terminal not ready: exited \(mise ERROR failed to parse template \| Field USER_HOST is not defined in env\.\)/);
});

test('machine config resolves per-machine executables and injects env; launch --notify-parent briefs parent on standby runs', t => {
  const box = sandbox(t);
  const customDir = join(box.cwd, 'alt-agents');
  box.executable('alt-agent', 'process.exit(0);', customDir);
  box.save(preset({ roles: [role('dev', { command: ['alt-agent', '--fast'] })] }));
  mockHc(box);
  const saved = box.json(['machine', 'save', '--json', JSON.stringify({
    schemaVersion: 1,
    executables: { 'alt-agent': join(customDir, 'alt-agent') },
    env: { USER_HOST: 'lab-box' },
  })]);
  assert.equal(saved.path, join(box.home, '.config/hc-team/machine.json'));
  const shown = box.json(['machine', 'show']);
  assert.equal(shown.exists, true);
  assert.equal(shown.executables.find(row => row.name === 'alt-agent').source, 'machine');
  const launched = box.json(['launch', 'example', '--parent', 'tparent', '--notify-parent']);
  assert.equal(launched.roles[0].sent, true);
  assert.equal(launched.parentNotified, true);
  const brief = readFileSync(launched.roles[0].briefPath, 'utf8');
  assert.match(brief, /Stand by for instructions from parent \(tparent\)/);
  assert.match(brief, /## Lifecycle\nResident teammate for run .* until the team is disbanded .* or parent \(tparent\) closes/);
  const log = readLog(box.log);
  const runArgs = log.find(row => row.args[0] === 'run').args;
  assert.ok(runArgs.includes('--parent') && runArgs.includes('tparent') && !runArgs.includes('--outlive-parent'));
  assert.deepEqual(runArgs.slice(runArgs.indexOf('--') + 1), ['/usr/bin/env', 'USER_HOST=lab-box', join(customDir, 'alt-agent'), '--fast']);
  const parentSend = log.find(row => row.args[0] === 'send' && row.args.at(-2) === 'tparent');
  assert.ok(parentSend);
  assert.match(parentSend.args.at(-1), /Active resident roles:\n- dev \(tdev\)/);
  assert.match(parentSend.args.at(-1), /Do NOT `hc kill` \/ `hc rm` them after finishing a task/);
  assert.match(parentSend.args.at(-1), /parent session closes/);
});

test('login shell probe parses sentinel PATH past stdout noise and spawnTerminal wraps command in user shell exec', t => {
  const box = sandbox(t);
  const shellDir = join(box.cwd, 'fake-shell');
  const agentDir = join(box.cwd, 'shell-only-agents');
  box.executable('shell-agent', 'process.exit(0);', agentDir);
  box.executable('zsh', `
const script = process.argv[3] || '';
if (script.includes('__HC_TEAM_PATH__')) {
  process.stdout.write('welcome banner noise\\n__HC_TEAM_PATH__' + ${JSON.stringify(agentDir)} + '__HC_TEAM_PATH__trailing noise\\n');
}
`, shellDir);
  box.save(preset({ roles: [role('dev', { command: ['shell-agent', '--ok'] })] }));
  mockHc(box);
  const env = {
    HC_TEAM_NO_LOGIN_SHELL: '',
    SHELL: join(shellDir, 'zsh'),
    PATH: `${dirname(box.log)}/bin:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const dry = box.json(['launch', 'example', '--dry-run'], { env });
  assert.deepEqual(dry.roles[0].command, [join(agentDir, 'shell-agent'), '--ok']);
  const launched = box.json(['launch', 'example'], { env });
  assert.equal(launched.roles[0].sent, true);
  const runArgs = readLog(box.log).find(row => row.args[0] === 'run').args;
  assert.deepEqual(runArgs.slice(runArgs.indexOf('--') + 1), [join(shellDir, 'zsh'), '-ilc', 'exec "$@"', 'hc-team', join(agentDir, 'shell-agent'), '--ok']);
});

test('brief injects role tools, resolved SKILL.md paths, global _tools.md, and overlay helper scripts', t => {
  const box = sandbox(t);
  const skillDir = join(box.home, '.agents/skills/my-tool');
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  writeFileSync(skillFile, '# My Tool\n');
  const globalTools = join(box.presets, '_tools.md');
  mkdirSync(box.presets, { recursive: true });
  writeFileSync(globalTools, '# Global Tools\n');
  const overlayTools = join(box.cwd, 'docs/agent-presets/example/tools');
  mkdirSync(overlayTools, { recursive: true });
  writeFileSync(join(overlayTools, 'README.md'), '# helpers\n');
  const helperScript = join(overlayTools, 'check.sh');
  writeFileSync(helperScript, '#!/bin/sh\n');
  box.save(preset({
    roles: [role('qa', {
      skills: ['my-tool', 'missing-skill'],
      tools: ['ego-browser nodejs (never Playwright)', 'hc-team servers --run <runId>'],
    })],
  }));
  mockHc(box);
  const launched = box.json(['launch', 'example', '--task', 'Check UI']);
  assert.equal(launched.roles[0].sent, true);
  const brief = readFileSync(launched.roles[0].briefPath, 'utf8');
  assert.match(brief, /## Preferred tools & scripts \(use first\)/);
  assert.match(brief, /ego-browser nodejs \(never Playwright\)/);
  assert.ok(brief.includes(`my-tool -> ${skillFile}`));
  assert.ok(brief.includes('- missing-skill'));
  assert.ok(brief.includes(`${globalTools} (global verified CLI/script playbook)`));
  assert.ok(brief.includes(`${helperScript} (project helper script)`));
});

test('scalable roles fan out into isolated git worktrees with per-role distinct-port servers and send routing', t => {
  const box = sandbox(t);
  execFileSync('git', ['init', '-q', box.cwd]);
  execFileSync('git', ['-C', box.cwd, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', box.cwd, 'config', 'user.name', 'Test']);
  writeFileSync(join(box.cwd, 'README.md'), 'init\n');
  execFileSync('git', ['-C', box.cwd, 'add', '.']);
  execFileSync('git', ['-C', box.cwd, 'commit', '-q', '-m', 'init']);
  box.save(preset({
    servers: [{ id: 'web', command: ['node', 'srv.js', '--port', '{port}'], cwd: '.' }],
    roles: [
      role('worker', { scalable: true, worktree: true, ownServer: true, talksTo: ['lead'] }),
      role('lead', { default: false, talksTo: ['worker'] }),
    ],
  }));
  mockHc(box);
  // Reject count > 1 on non-scalable role.
  assert.equal(box.command(['launch', 'example', '--roles', 'lead=2', '--dry-run', '--json']).status, 1);

  const launched = box.json(['launch', 'example', '--roles', 'worker=3', '--with-servers']);
  assert.equal(launched.roles.length, 3);
  assert.deepEqual(launched.roles.map(r => r.id), ['worker-1', 'worker-2', 'worker-3']);
  assert.equal(launched.servers.length, 3);
  assert.deepEqual(launched.servers.map(s => s.forRole), ['worker-1', 'worker-2', 'worker-3']);
  const ports = launched.servers.map(s => s.port);
  assert.equal(new Set(ports).size, 3);
  assert.ok(ports.every(port => port >= 20000 && port < 49152));
  for (let i = 0; i < 3; i++) {
    const wt = launched.roles[i].worktree;
    assert.ok(wt && readFileSync(join(wt, 'README.md'), 'utf8') === 'init\n');
    const brief = readFileSync(launched.roles[i].briefPath, 'utf8');
    assert.ok(brief.includes(`Worktree: ${wt}`));
    assert.ok(brief.includes(`PORT=${ports[i]}`));
  }
  const runCalls = readLog(box.log).filter(row => row.args[0] === 'run').map(row => row.args);
  const serverRuns = runCalls.filter(args => args.includes('--label') && args.some(a => a.startsWith('hc.team.server=')));
  assert.equal(serverRuns.length, 3);
  for (let i = 0; i < 3; i++) {
    const srvArgs = serverRuns.find(args => args.includes(`hc.team.server=web-worker-${i + 1}`));
    assert.ok(srvArgs);
    assert.ok(srvArgs.includes(`PORT=${ports[i]}`));
    assert.ok(srvArgs.includes(String(ports[i])));
  }

  // Re-launching a single dead scaled instance (--run <id> --roles worker-2) targets only worker-2
  // and reuses its live server without inventing a new port.
  const runId = launched.runId;
  mockHc(box, {
    terminals: [
      { address: 'tw1', state: 'live', labels: launchLabels(runId, 'worker-1', box.cwd) },
      { address: 'tw3', state: 'live', labels: launchLabels(runId, 'worker-3', box.cwd) },
      { address: 'ts2', state: 'live', labels: { 'hc.team.run': runId, 'hc.team.preset': 'example', 'hc.team.server': 'web-worker-2', 'hc.team.cwd': box.cwd } },
    ],
  });
  const relaunched = box.json(['launch', 'example', '--run', runId, '--roles', 'worker-2', '--with-servers']);
  assert.deepEqual(relaunched.roles.map(r => r.id), ['worker-2']);
  assert.equal(relaunched.servers[0].address, 'ts2');
  assert.equal(relaunched.servers[0].port, undefined);

  // Verify hc-team send works between scaled instances (worker-1 -> worker-2).
  mockHc(box, {
    terminals: [
      { address: 'tw1', state: 'live', labels: launchLabels(runId, 'worker-1', box.cwd) },
      { address: 'tw2', state: 'live', labels: launchLabels(runId, 'worker-2', box.cwd) },
    ],
  });
  const sent = box.json(['send', 'worker-2', 'API ready'], { env: { HC_TERMINAL_ID: 'tw1' } });
  assert.equal(sent.sent, true);
  assert.equal(sent.address, 'tw2');

  // Server relative executable resolves against server.cwd, and long server+role names stay unique <= 32 chars.
  const subDir = join(box.cwd, 'app');
  mkdirSync(subDir, { recursive: true });
  box.executable('dev', 'process.exit(0);', subDir);
  box.save(preset({
    id: 'long-srv',
    servers: [{ id: 'development-http', command: ['./dev'], cwd: 'app' }],
    roles: [role('implementer', { scalable: true, ownServer: true })],
  }));
  const longDry = box.json(['launch', 'long-srv', '--roles', 'implementer=2', '--with-servers', '--dry-run']);
  assert.equal(longDry.servers.length, 2);
  assert.ok(longDry.servers.every(s => s.reason === null && s.name.length <= 32));
  assert.equal(new Set(longDry.servers.map(s => s.name)).size, 2);
});

test('status, send, and stop exclude remote run collisions; plain-shell parent is event-only', t => {
  const box = sandbox(t);
  const runId = 'local1';
  const dir = join(box.home, '.local/state/hc-team/runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.json'), JSON.stringify(preset({ roles: [role('dev'), role('qa')] })));
  const terminals = [
    { address: 'remote/tdev', state: 'live', labels: launchLabels(runId, 'dev', box.cwd) },
    { address: 'remote/tqa', state: 'live', labels: launchLabels(runId, 'qa', box.cwd) },
    { address: 'tdev', state: 'live', labels: launchLabels(runId, 'dev', box.cwd, 'tshell') },
    { address: 'tshell', state: 'live', reported: false, status: null },
  ];
  mockHc(box, { terminals });
  const env = { HC_TERMINAL_ID: 'tdev' };
  assert.deepEqual(box.json(['status'])[0].roles.map(row => row.address), ['tdev']);
  assert.equal(box.json(['send', 'parent', 'Record only'], { env }).sent, false);
  assert.equal(box.command(['send', 'qa', 'Remote only', '--json'], { env }).status, 1);
  assert.equal(readLog(join(dir, 'events.jsonl')).length, 1);
  let log = readLog(box.log);
  assert.deepEqual(log.filter(row => row.args[0] === 'label').map(row => row.args[1]), ['tdev']);
  assert.ok(!log.some(row => row.args[0] === 'send'));
  terminals[3].reported = true;
  mockHc(box, { terminals });
  assert.equal(box.json(['send', 'parent', 'Deliver to agent'], { env }).address, 'tshell');
  log = readLog(box.log);
  assert.deepEqual(log.filter(row => row.args[0] === 'send').map(row => row.args.at(-2)), ['tshell']);
  assert.deepEqual(box.json(['stop', runId]).stopped, ['tdev']);
});

test('stop aborts before killing unlisted descendants and persists unfinished cleanup for retry', t => {
  const box = sandbox(t);
  const runId = 'parent';
  const journal = join(box.home, '.local/state/hc-team/runs', runId, 'stopping.json');
  const owner = { address: 'towner', state: 'live', labels: launchLabels(runId, 'dev', box.cwd) };
  const terminals = [owner, { address: 'tmiddle', state: 'live', parent: owner.address },
    { address: 'tchild', state: 'live', parent: 'tmiddle', labels: launchLabels('child1', 'dev', box.cwd) }];
  mockHc(box, { terminals, failRm: owner.address });
  const protectedStop = box.command(['stop', runId, '--json']);
  assert.equal(protectedStop.status, 1);
  const { message } = JSON.parse(protectedStop.stdout).error;
  for (const name of ['tmiddle', 'child1/tchild', '--force']) assert.ok(message.includes(name));
  assert.ok(readLog(box.log).every(row => row.args[0] === 'connect'));
  assert.ok(!existsSync(journal));
  const forced = box.command(['stop', runId, '--force', '--json']);
  assert.equal(forced.status, 1);
  assert.deepEqual(readJson(journal), ['towner']);
  assert.deepEqual(readLog(box.log).filter(row => row.args[0] === 'kill').map(row => row.args[1]), ['towner']);
  mockHc(box, { terminals: [{ address: owner.address, state: 'finished' }, { address: 'told', state: 'finished', labels: owner.labels }] });
  assert.deepEqual(box.json(['stop', runId]).stopped, ['towner', 'told']);
  assert.equal(readLog(box.log).filter(row => row.args[0] === 'kill').length, 1);
  assert.ok(!existsSync(journal));
});

test('connect reads a complete matching JSON-RPC frame above 8 MiB and never exposes partial frames', t => {
  const box = sandbox(t);
  box.executable('hc', `
    require('node:fs').readFileSync(0);
    console.log('{"jsonrpc":"2.0","id":22,"result":{}}');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { terminals: [], padding: 'x'.repeat(9 * 1024 * 1024) } }) + '\\n',
      () => setTimeout(() => {}, 8000));
  `);
  assert.deepEqual(box.json(['status']), []);
  for (const [size, diagnostic] of [[32, /closed before a complete response/], [65 * 1024 * 1024, /exceeds 64 MiB/]]) {
    box.executable('hc', `require('node:fs').readFileSync(0); process.stdout.write('PRIVATE_PARTIAL_RESPONSE '); process.stdout.write(Buffer.alloc(${size}, 120));`);
    const result = box.command(['status', '--json']);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).error.message, diagnostic);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_PARTIAL_RESPONSE/);
  }
});

test('real server snapshot attributes expected TCP ports and removes worker and ephemeral agent sockets', () => {
  const fixture = readJson(new URL('./fixtures/servers-snapshot.json', import.meta.url));
  const ps = parsePs(fixture.ps);
  const listeners = parseLsofListen(fixture.lsof);
  const { byTerminal, unattributed } = attributeListeners(fixture.terminals, ps, listeners);
  assert.deepEqual(byTerminal.t6m.map(x => x.port), [4431, 4432, 4433, 4434, 4435, 4436, 4437]);
  assert.deepEqual(byTerminal.t4z.map(x => x.port), [443]);
  assert.deepEqual(byTerminal.t7b.map(x => x.port), [3460, 9443]);
  const kept = [...Object.values(byTerminal).flat(), ...unattributed];
  assert.ok(kept.every(x => x.port < 49152));
  const ephemeral = listeners.filter(x => x.port >= 49152);
  for (const agent of [/claude/i, /antigravity|\bagy\b/i, /codex/i]) {
    assert.ok(ephemeral.some(x => agent.test(ps.get(x.pid)?.args ?? '')), `fixture missing ${agent} ephemeral listener`);
  }
  assert.ok(!Object.keys(byTerminal).some(key => key.includes('/')));
});

test('pure parsing tolerates process names with spaces, unknown fields, duplicate binds, and remote PID collisions', () => {
  const ps = parsePs(' 4 2 next-server (v16.3.6)\n5 4 worker name\n6 3 detached\n2 1 shell\n');
  assert.deepEqual(ps.get(4), { ppid: 2, args: 'next-server (v16.3.6)' });
  const listeners = parseLsofListen('p4\ncnext-server (v16.3.6)\nf10\nn[::1]:443\nxunknown\nn127.0.0.1:443\np5\ncworker name\nn*:5000\np6\ncother\nn*:4000\n');
  assert.deepEqual(listeners, [
    { pid: 4, port: 443, comm: 'next-server (v16.3.6)', bindHost: '::1', family: 6 },
    { pid: 4, port: 443, comm: 'next-server (v16.3.6)', bindHost: '127.0.0.1', family: 4 },
    { pid: 5, port: 5000, comm: 'worker name', bindHost: '*', family: 4 },
    { pid: 6, port: 4000, comm: 'other', bindHost: '*', family: 4 },
  ]);
  assert.deepEqual(parseLsofListen('p1\ncapp\nf4\ntIPv6\nn*:1234\nf5\ntIPv6\nn[::]:1234\nf6\ntIPv4\nn*:1234\nn*:1234\n')
    .map(x => [x.bindHost, x.family]), [['*', 6], ['::', 6], ['*', 4]]);
  const { byTerminal, unattributed } = attributeListeners([{ address: 'tlocal', pid: 2 }, { address: 'remote/t1', pid: 3 }], ps, listeners);
  assert.deepEqual(byTerminal, { tlocal: listeners.slice(0, 2) });
  assert.deepEqual(unattributed, [listeners[3]]);
  assert.deepEqual([...parseLsofCwd('p6\nfcwd\nn/folder with spaces/dev\nqignored\n')], [[6, '/folder with spaces/dev']]);
  assert.equal(dnsHost('DNS:localhost., DNS:*.example.com, IP Address:127.0.0.1, DNS:app.example.com, DNS:second.example.org'), 'app.example.com');
  assert.equal(dnsHost('DNS:LOCALHOST, DNS:*.example.com'), 'localhost');
});

test('TLS probing returns no protocol within the timeout for a listener that never handshakes', async t => {
  const server = createServer();
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  assert.equal(await probeTls(server.address().port, 40), null);
});

test('server scanner probes IPv6 binds, requires HEAD for HTTP, and only uses loopback TLS SANs', async t => {
  const box = sandbox(t);
  const methods = [];
  const http = createHttpServer((req, res) => { methods.push([req.method, req.url]); res.writeHead(405); res.end(); });
  const tcp = createServer();
  const sockets = new Set();
  tcp.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const tls = san => {
    const key = join(box.cwd, `${san}.key`), cert = join(box.cwd, `${san}.crt`), config = join(box.cwd, `${san}.conf`);
    writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=local-test\n[ext]\nsubjectAltName=DNS:${san}\n`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-out', cert, '-keyout', key], { stdio: 'ignore' });
    return createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, socket => socket.end());
  };
  const tlsPublic = tls('192.0.2.1');
  const tlsLocal = tls('127.0.0.1');
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  async function listen(server, host) {
    for (let i = 0; i < 20; i++) {
      const port = randomInt(20000, 49152);
      const error = await new Promise(resolve => {
        const onError = error => resolve(error);
        server.once('error', onError);
        server.listen({ port, host, ipv6Only: host.includes(':') }, () => { server.off('error', onError); resolve(null); });
      });
      if (!error) { t.after(() => server.close()); return port; }
      if (error.code !== 'EADDRINUSE') throw error;
    }
    assert.fail('Could not bind a non-ephemeral test port');
  }
  const [httpPort, rawPort, publicPort, localPort] = await Promise.all([
    listen(http, '::1'), listen(tcp, '127.0.0.1'), listen(tlsPublic, '::'), listen(tlsLocal, '::1'),
  ]);
  const term = { address: 'tweb', pid: 99, cwd: box.cwd, state: 'live' };
  mockHc(box, { terminals: [term] });
  mockProcesses(box, { ps: '99 1 app\n', listeners: `p99\ncapp\nf1\ntIPv6\nn[::1]:${httpPort}\nf2\ntIPv4\nn127.0.0.1:${rawPort}\nf3\ntIPv6\nn*:${publicPort}\nf4\ntIPv6\nn[::1]:${localPort}\n` });
  const result = await box.commandAsync(['servers', '--json']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const urls = Object.fromEntries(JSON.parse(result.stdout).byTerminal.tweb.map(row => [row.port, row.url]));
  assert.deepEqual(urls, {
    [httpPort]: `http://[::1]:${httpPort}`, [publicPort]: `https://localhost:${publicPort}`, [localPort]: `https://127.0.0.1:${localPort}`,
  });
  assert.deepEqual(methods, [['HEAD', '/']]);
  const override = `https://explicit.test:${rawPort}`;
  mockHc(box, { terminals: [{ ...term, labels: { 'hj.url': override } }] });
  const labeled = await box.commandAsync(['servers', '--json']);
  assert.equal(labeled.status, 0, labeled.stderr + labeled.stdout);
  assert.ok(JSON.parse(labeled.stdout).byTerminal.tweb.some(row => row.url === override));

  // Readiness may use a raw TCP listener without exposing it as a browser URL.
  box.save(preset({ servers: [{ id: 'web', command: ['node'] }], roles: [role('dev', { default: false })] }));
  mockHc(box, { runningServer: true, rawServer: true, cwd: box.cwd });
  mockProcesses(box, { ps: '99 1 node\n', listeners: `p99\ncnode\nn127.0.0.1:${rawPort}\n` });
  const launched = await box.commandAsync(['launch', 'example', '--with-servers', '--json']);
  assert.equal(launched.status, 0, launched.stderr + launched.stdout);
  assert.deepEqual(JSON.parse(launched.stdout).servers.map(({ ready, urls, reason }) => [ready, urls, reason]), [[true, [], null]]);
});

test('servers JSON uses label URLs, PID/port cache, a single detached cwd batch, and run filtering', t => {
  const box = sandbox(t);
  const runId = 'abc123';
  const sibling = `${box.cwd}-elsewhere`;
  mockHc(box, { terminals: [
    { address: 't1', state: 'live', pid: 10, cwd: box.cwd, labels: { 'hc.team.run': runId, 'hj.urls': '["https://via.test:8443/path","https://via.test:8443/path"]' } },
    { address: 't2', state: 'live', pid: 20, cwd: '/other-project', labels: { 'hj.url': 'https://other.test' } },
  ] });
  mockProcesses(box, {
    ps: '11 10 app\n21 20 app\n30 1 detached\n40 1 detached\n',
    listeners: 'p11\ncnext-server\nn*:80\nn*:8443\np21\ncproxy\nn*:443\np30\ncbun\nn*:4000\np40\ncbun\nn*:4001\n',
    cwds: `p30\nfcwd\nn${box.cwd}/deep\np40\nfcwd\nn${sibling}\n`,
  });
  const cache = join(box.home, '.local/state/hc-team/tls-cache.json');
  mkdirSync(dirname(cache), { recursive: true });
  const at = Date.now();
  writeFileSync(cache, JSON.stringify({
    'v2:11:80:4:*': { at, protocol: 'http', host: 'localhost' },
    'v2:11:8443:4:*': { at, protocol: 'http', host: 'localhost' },
    'v2:30:4000:4:*': { at, protocol: 'https', host: 'localhost' },
    'v2:40:4001:4:*': { at, protocol: 'http', host: 'localhost' },
  }));
  const result = box.json(['servers']);
  assert.deepEqual(result.byTerminal.t1.map(x => x.url), ['http://localhost', 'https://via.test:8443/path']);
  assert.deepEqual(result.byTerminal.t2.map(x => x.url), ['https://other.test']);
  assert.deepEqual(result.detached, [{ url: 'https://localhost:4000', port: 4000, protocol: 'https', host: 'localhost', pid: 30, comm: 'bun', bindHost: '*', family: 4, cwd: `${box.cwd}/deep` }]);
  assert.ok(Number.isInteger(result.updatedAt));
  assert.deepEqual(box.json(['servers', '--spaces', JSON.stringify([sibling])]).detached.map(x => x.pid), [30, 40]);
  const filtered = box.json(['servers', '--run', runId]);
  assert.deepEqual(Object.keys(filtered.byTerminal), ['t1']);
  assert.deepEqual(filtered.detached, []);
  const cwdCalls = readLog(box.log).filter(x => x.args[0] === 'lsof' && x.args[1] === '-a');
  assert.equal(cwdCalls.length, 2); // One per unfiltered call, none for --run.
  assert.equal(cwdCalls[0].args.at(-2), '30,40');
});
