// Shared CDP port resolver: --port auto (default) scans well-known ports.
export async function resolvePort(prefer = "auto") {
  if (prefer && prefer !== "auto") {
    const p = Number(prefer);
    if (await alive(p)) return p;
    throw new Error(`CDP port ${p} unreachable`);
  }
  for (const p of [9333, 9444, 9222]) {
    if (await alive(p)) return p;
  }
  throw new Error("no CDP found on 9333/9444/9222 (start Chrome with --remote-debugging-port=9333)");
}

async function alive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

// Discover backend hosts from open CDP tabs whose URL includes `match`.
export async function discoverBackends(port, match = "personal") {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const urls = [...new Set(list.filter((t) => t.type === "page" && (t.url || "").includes(match)).map((t) => t.url))];
  return [...new Set(urls.map((u) => u.replace(/\/$/, "").split("/").slice(0, 3).join("/")))];
}
