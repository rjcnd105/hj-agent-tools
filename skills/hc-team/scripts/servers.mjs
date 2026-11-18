import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const TTL = 10 * 60 * 1000;

export function parsePs(text) {
  const processes = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/);
    if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] ?? '' });
  }
  return processes;
}

export function parseLsofListen(text) {
  const listeners = new Map();
  let pid, comm, addressFamily;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') {
      pid = Number(line.slice(1));
      comm = '';
      addressFamily = undefined;
    } else if (line[0] === 'c') {
      comm = line.slice(1);
    } else if (line[0] === 'f') {
      addressFamily = undefined;
    } else if (line === 'tIPv4' || line === 'tIPv6') {
      addressFamily = Number(line.at(-1));
    } else if (line[0] === 'n' && Number.isSafeInteger(pid) && pid > 0) {
      const match = line.match(/^n(.+):(\d+)$/);
      if (!match) continue;
      const bindHost = match[1].replace(/^\[(.*)\]$/, '$1');
      const port = Number(match[2]);
      const family = isIP(bindHost) || addressFamily || 4;
      if (port > 0 && port <= 65535 && (bindHost === '*' || isIP(bindHost))) {
        listeners.set(`${pid}:${port}:${family}:${bindHost}`, { pid, port, comm, bindHost, family });
      }
    }
  }
  return [...listeners.values()];
}

export function attributeListeners(terminals, psMap, listeners) {
  const local = new Map(terminals
    .filter(t => !t.address.includes('/') && t.pid > 0)
    .map(t => [t.pid, t.address]));
  const grouped = new Map();
  const unattributed = [];
  for (const listener of listeners) {
    if (listener.port >= 49152) continue;
    const ancestors = [];
    const seen = new Set();
    let pid = listener.pid;
    while (pid > 0 && !seen.has(pid) && !local.has(pid)) {
      seen.add(pid);
      if (pid !== listener.pid) ancestors.push(pid);
      pid = psMap.get(pid)?.ppid;
    }
    const address = local.get(pid);
    if (address === undefined) {
      unattributed.push(listener);
    } else {
      if (!grouped.has(address)) grouped.set(address, []);
      grouped.get(address).push({ listener, ancestors });
    }
  }
  const byTerminal = Object.fromEntries([...grouped].map(([address, rows]) => {
    const pids = new Set(rows.map(row => row.listener.pid));
    return [address, rows.filter(row => !row.ancestors.some(pid => pids.has(pid)))
      .map(row => row.listener).sort((a, b) => a.port - b.port)];
  }));
  return { byTerminal, unattributed };
}

export function dnsHost(subjectAltName = '') {
  for (const entry of subjectAltName.split(/,\s*/)) {
    const host = entry.trim().match(/^DNS:([a-z\d_.-]+)$/i)?.[1];
    if (host && host.toLowerCase().replace(/\.$/, '') !== 'localhost') return host;
  }
  return 'localhost';
}

export function probeTls(port, timeoutMs = 300, host = '127.0.0.1') {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    const fallback = () => finish(null);
    const deadline = setTimeout(fallback, timeoutMs);
    function finish(result) {
      clearTimeout(deadline);
      socket.destroy();
      resolve(result);
    }
    socket.once('secureConnect', () => finish({
      protocol: 'https',
      host: dnsHost(socket.getPeerCertificate()?.subjectaltname),
    }));
    socket.once('error', fallback);
    socket.once('close', fallback);
  });
}

function probeHttp(host, port) {
  return new Promise(resolve => {
    const req = request({ host, port, path: '/', method: 'HEAD', agent: false }, () => finish(true));
    const timer = setTimeout(() => finish(false), 250);
    function finish(result) {
      clearTimeout(timer);
      req.destroy();
      resolve(result);
    }
    req.once('error', () => finish(false));
    req.end();
  });
}

function loopbackDns(host) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 300);
    lookup(host, { all: true }).then(addresses => {
      // A mixed answer is unsafe: a browser could pick any of the addresses.
      resolve(addresses.length > 0 && addresses.every(({ address, family }) =>
        family === 4 ? address.startsWith('127.') : address === '::1'));
    }, () => resolve(false)).finally(() => clearTimeout(timer));
  });
}

function probeAddress({ bindHost, family }) {
  if (['*', '0.0.0.0', '::'].includes(bindHost)) return family === 6 ? '::1' : '127.0.0.1';
  return bindHost;
}

function labelUrls(labels = {}) {
  let urls = [];
  if (labels['hj.urls']) {
    try {
      const parsed = JSON.parse(labels['hj.urls']);
      if (Array.isArray(parsed)) urls = parsed;
    } catch {
      urls = labels['hj.urls'].split(/[,\s]+/);
    }
  }
  return [labels['hj.url'], ...urls].flatMap(url => {
    if (typeof url !== 'string') return [];
    try {
      const parsed = new URL(url);
      const protocol = parsed.protocol.slice(0, -1);
      if (protocol !== 'http' && protocol !== 'https') return [];
      return [{ url, protocol, host: parsed.hostname, port: Number(parsed.port || (protocol === 'https' ? 443 : 80)) }];
    } catch {
      return [];
    }
  });
}

async function lsof(args) {
  try {
    return (await exec('lsof', args, { maxBuffer: 8 * 1024 * 1024, timeout: 2500 })).stdout;
  } catch (error) {
    // lsof exits 1 when no files match, and can also report partial results.
    if (error.code === 1 && (!error.stderr.trim() || error.stdout)) return error.stdout;
    throw error;
  }
}

export function parseLsofCwd(text) {
  const cwd = new Map();
  let pid;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    if (line[0] === 'n' && pid > 0) cwd.set(pid, line.slice(1));
  }
  return cwd;
}

function inFolder(cwd, folder) {
  const path = relative(folder, cwd);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function writeCache(path, entries) {
  const temp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, JSON.stringify(entries), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function scanServers(terminals, {
  runId, spaces = [], raw = false,
  cachePath = join(homedir(), '.local/state/hc-team/tls-cache.json'),
} = {}) {
  const local = terminals.filter(t => !t.address.includes('/') && t.state === 'live');
  const [ps, sockets] = await Promise.all([
    exec('ps', ['-axo', 'pid=,ppid=,args='], { maxBuffer: 32 * 1024 * 1024, timeout: 2500 }),
    lsof(['+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcfnt']),
  ]);
  const { byTerminal, unattributed } = attributeListeners(local, parsePs(ps.stdout), parseLsofListen(sockets));
  const selected = local.filter(t => !runId || t.labels?.['hc.team.run'] === runId);
  const folders = [...new Set([...spaces, ...local.map(t => t.cwd)].filter(path => typeof path === 'string' && isAbsolute(path)))];
  const pids = [...new Set(unattributed.map(({ pid }) => pid))];
  const now = Date.now();
  const cache = new Map();
  let changed = false;
  const [cwds, rawCache] = await Promise.all([
    !runId && pids.length && folders.length
      ? lsof(['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']).then(parseLsofCwd)
      : new Map(),
    readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null),
  ]);
  for (const [key, value] of Object.entries(rawCache ?? {})) {
    if (key.startsWith('v2:') && value?.at > now - TTL && ['http', 'https'].includes(value.protocol) && typeof value.host === 'string') {
      cache.set(key, value);
    } else {
      changed = true;
    }
  }
  const dns = new Map();
  async function withUrl(listener) {
    const { pid, port } = listener;
    const address = probeAddress(listener);
    const key = `v2:${pid}:${port}:${listener.family}:${listener.bindHost}`;
    let value = cache.get(key);
    if (!value) {
      value = await probeTls(port, 300, address);
      if (value) {
        const { host } = value;
        if (host !== 'localhost') {
          if (!dns.has(host)) dns.set(host, loopbackDns(host));
          if (!await dns.get(host)) value.host = 'localhost';
        }
      } else if (await probeHttp(address, port)) {
        value = { protocol: 'http', host: address === '127.0.0.1' ? 'localhost' : address };
      } else {
        return null;
      }
      cache.set(key, { ...value, at: Date.now() });
      changed = true;
    }
    const { protocol, host } = value;
    const defaultPort = protocol === 'https' ? 443 : 80;
    const domain = isIP(host) === 6 ? `[${host}]` : host;
    return { url: `${protocol}://${domain}${port === defaultPort ? '' : `:${port}`}`, ...listener, protocol, host };
  }
  const owners = await Promise.all(selected.filter(t => byTerminal[t.address]?.length).map(async t => {
    const labels = labelUrls(t.labels);
    const rows = await Promise.all(byTerminal[t.address].map(async listener => {
      const matches = labels.filter(label => label.port === listener.port);
      return matches.length ? matches.map(label => ({ ...listener, ...label })) : [await withUrl(listener)];
    }));
    return [t.address, [...new Map(rows.flat().filter(Boolean).map(row => [row.url, row])).values()]];
  }));
  const detached = (await Promise.all(unattributed.flatMap(listener => {
    const cwd = cwds.get(listener.pid);
    return cwd && folders.some(folder => inFolder(cwd, folder))
      ? [withUrl(listener).then(row => row && { ...row, cwd })] : [];
  }))).filter(Boolean);
  detached.sort((a, b) => a.port - b.port || a.pid - b.pid);
  if (changed) await writeCache(cachePath, Object.fromEntries(cache)).catch(() => {});
  return {
    byTerminal: Object.fromEntries(owners.filter(([, rows]) => rows.length)), detached, updatedAt: Date.now(),
    ...(raw ? { listenersByTerminal: Object.fromEntries(selected.flatMap(t =>
      byTerminal[t.address] ? [[t.address, byTerminal[t.address]]] : [])) } : {}),
  };
}
