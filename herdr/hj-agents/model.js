function liveChildren(allTerminals) {
  const byParent = new Map();
  for (const t of allTerminals) {
    if (t.state !== "live" || !t.parent) continue;
    if (!byParent.has(t.parent)) byParent.set(t.parent, []);
    byParent.get(t.parent).push(t);
  }
  return byParent;
}

function serverRows(servers, ownerKey, ownerAddr, expandedOwners, maxVisible, lead = [], hasNext = false) {
  const limit = expandedOwners.has(ownerKey) ? servers.length : maxVisible;
  const rows = servers.slice(0, limit).map((srv) => ({ kind: "server", ownerKey, ownerAddr, srv }));
  const remaining = servers.length - rows.length;
  if (remaining > 0) rows.push({ kind: "more", ownerKey, remaining });
  return rows.map((row, i) => ({ ...row, lines: [...lead, hasNext || i < rows.length - 1 ? "├" : "└"] }));
}

export function buildAgentRows(agentAddr, allTerminals, serversByTerminal, expandedOwners, maxVisible = 3) {
  const children = liveChildren(allTerminals);
  const rows = [];
  function append(ownerAddr, lead) {
    const subs = children.get(ownerAddr) ?? [];
    rows.push(...serverRows(serversByTerminal[ownerAddr] ?? [], ownerAddr, ownerAddr, expandedOwners, maxVisible, lead, subs.length > 0));
    for (const [i, t] of subs.entries()) {
      const last = i === subs.length - 1;
      rows.push({ kind: "sub", t, lines: [...lead, last ? "└" : "├"] });
      append(t.address, [...lead, last ? "" : "│"]);
    }
  }
  append(agentAddr, []);
  return rows;
}

function directory(path) {
  if (!path) return "";
  const win = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  return (win ? path.replaceAll("\\", "/").toLowerCase() : path).replace(/\/+$/, "");
}

export function buildShellServerGroups(allTerminals, listedAgentAddrs, spacesList, serversByTerminal, detachedServers, expandedOwners, maxVisible = 3) {
  // A terminal can be rendered under an agent without appearing in agents().
  const listed = new Set(listedAgentAddrs);
  const children = liveChildren(allTerminals);
  for (const addr of listed) {
    for (const t of children.get(addr) ?? []) listed.add(t.address);
  }

  // hc-team scans only this machine. Don't match its folders to remote spaces.
  const spaces = spacesList.filter((s) => !s.machine);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const longestFirst = (a, b) => b[1].length - a[1].length || b[2] - a[2];
  const folders = spaces.filter((s) => s.folder).map((s) => [s, directory(s.folder), 0]).sort(longestFirst);
  // For detached servers, longest prefix wins; on equal paths, a space's live terminal cwd beats its stale creation folder.
  const detachedFolders = [...folders];
  for (const t of allTerminals) {
    if (t.state !== "live" || t.address.includes("/") || !t.cwd) continue;
    const space = byId.get(t.labels?.["herdr.space"]);
    if (space) detachedFolders.push([space, directory(t.cwd), 1]);
  }
  detachedFolders.sort(longestFirst);
  const spaceFor = (cwd, candidates = folders) => {
    if (!cwd) return null;
    const path = directory(cwd);
    return candidates.find(([, folder]) => path === folder || path.startsWith(`${folder}/`))?.[0] ?? null;
  };

  const groups = new Map();
  const ownersFor = (space) => {
    const key = space?.id ?? null;
    if (!groups.has(key)) groups.set(key, { space, owners: [] });
    return groups.get(key).owners;
  };
  for (const t of allTerminals) {
    const servers = serversByTerminal[t.address];
    if (t.state !== "live" || listed.has(t.address) || !servers?.length) continue;
    const space = byId.get(t.labels?.["herdr.space"]) ?? spaceFor(t.cwd);
    const name = t.name || t.program?.name || t.template || t.address;
    ownersFor(space).push({
      ownerKey: t.address,
      label: name === t.address ? name : `${name} · ${t.address}`,
      rows: serverRows(servers, t.address, t.address, expandedOwners, maxVisible),
    });
  }
  const bySpace = new Map();
  for (const srv of detachedServers) {
    const space = spaceFor(srv.cwd, detachedFolders);
    if (!space) continue;
    if (!bySpace.has(space)) bySpace.set(space, []);
    bySpace.get(space).push(srv);
  }
  for (const [space, servers] of bySpace) {
    const ownerKey = `detached-${space.id}`;
    ownersFor(space).push({
      ownerKey,
      label: "Detached",
      rows: serverRows(servers, ownerKey, null, expandedOwners, maxVisible),
    });
  }

  return [...spaces.map((s) => groups.get(s.id)), groups.get(null)].filter(Boolean);
}

// Space headers, owner labels, and each visible URL or "more" row.
export function countServerRows(shellGroups) {
  return shellGroups.reduce((count, group) =>
    count + 1 + group.owners.reduce((rows, owner) => rows + 1 + owner.rows.length, 0), 0);
}

export function openUrlCommand(platform, url) {
  if (platform === "windows") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: platform === "macos" ? "open" : "xdg-open", args: [url] };
}

export function shortUrl(url) {
  // GPUI truncates to the actual space available, not a fixed character count.
  return url.trim();
}
