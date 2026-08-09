// Local device identity: which personId/name this browser used for each
// group it has created or joined. Lets a returning visitor land back on
// "their" identity without re-joining. Best-effort — guarded against a
// missing/broken localStorage (private browsing, SSR-less environments,
// quota errors, corrupt JSON) so it never throws into the caller.

const STORAGE_KEY = "trip-debt:identity";

interface StoredIdentity {
  personId: string;
  name: string;
}

type IdentityMap = Record<string, StoredIdentity>;

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function readMap(): IdentityMap {
  if (!hasLocalStorage()) {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as IdentityMap;
    }
    return {};
  } catch {
    return {};
  }
}

function writeMap(map: IdentityMap): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage full/unavailable — identity just won't persist this time.
  }
}

export function getIdentity(groupId: string): StoredIdentity | null {
  return readMap()[groupId] ?? null;
}

/**
 * Every group this device has created or joined. This map is the only record
 * of past trips that exists client-side — `trip-debt:last-group` remembers one
 * code and overwrites it, while Firestore has no per-user index.
 */
export function listJoinedGroupIds(): string[] {
  return Object.keys(readMap());
}

export function saveIdentity(groupId: string, personId: string, name: string): void {
  const map = readMap();
  map[groupId] = { personId, name };
  writeMap(map);
}

export function clearIdentity(groupId: string): void {
  const map = readMap();
  delete map[groupId];
  writeMap(map);
}
