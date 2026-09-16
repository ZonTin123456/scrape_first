// host-gate: --map vs explicit --backend consistency (fail-closed).
// Pure function, no I/O: compares URL origins (protocol + host + port),
// never raw strings — so a trailing slash is irrelevant but a protocol or
// port change is a mismatch. Returns null when consistent (or when the gate
// does not apply: either side unknown), otherwise a human-readable reason.
// Locked/manual field-maps carry no mapMeta.host, so they never reach here.
export function mapHostMismatch(mapHost, backendOpt) {
  if (!mapHost || !backendOpt) return null;
  let a, b;
  try {
    a = new URL(String(mapHost)).origin;
  } catch {
    return `unparseable map host ${JSON.stringify(String(mapHost))}`;
  }
  try {
    b = new URL(String(backendOpt)).origin;
  } catch {
    return `unparseable --backend ${JSON.stringify(String(backendOpt))}`;
  }
  if (a === "null" || b === "null") return `uncomparable hosts (map ${JSON.stringify(String(mapHost))} vs --backend ${JSON.stringify(String(backendOpt))})`;
  if (a !== b) return `host mismatch: map host ${a} vs --backend ${b}`;
  return null;
}
