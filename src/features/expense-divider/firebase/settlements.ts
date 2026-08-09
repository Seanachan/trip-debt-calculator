// Which settlement rows a group has ticked off as paid.
//
// Balances and the minimum-transaction plan are derived from expenses, never
// stored — but "Amy actually handed Sean the cash" is a fact no expense can
// imply, so it lives here:
//   groups/{groupId}/settlements/{rowId}   { settledAt, settledBy }
//
// A row's identity is (from, to, amount): edit an expense and the plan changes,
// which correctly orphans ticks that no longer describe a real debt. Orphans
// are ignored on read rather than deleted, so undoing the edit brings the tick
// back instead of silently losing it.

import { deleteDoc, doc, onSnapshot, setDoc } from "firebase/firestore";
import { collection } from "firebase/firestore";
import { db, ensureAuth } from "./config";

function settlementsCol(groupId: string) {
  if (!db) {
    throw new Error("Firebase is not configured — set VITE_FIREBASE_* env vars.");
  }
  return collection(db, "groups", groupId, "settlements");
}

/**
 * Stable document id for one settlement row. `/` is the only character
 * Firestore forbids in an id, and neither a person id nor an integer amount
 * can contain one, but the separator is spelled out rather than reusing the
 * display key so the id never depends on presentation choices.
 */
export function settlementRowId(row: { from: string; to: string; amount: number }): string {
  return `${row.from}__${row.to}__${row.amount}`;
}

export async function markSettled(
  groupId: string,
  row: { from: string; to: string; amount: number },
  settledBy: string,
): Promise<void> {
  await ensureAuth();
  await setDoc(doc(settlementsCol(groupId), settlementRowId(row)), {
    settledAt: Date.now(),
    settledBy,
  });
}

export async function unmarkSettled(
  groupId: string,
  row: { from: string; to: string; amount: number },
): Promise<void> {
  await ensureAuth();
  await deleteDoc(doc(settlementsCol(groupId), settlementRowId(row)));
}

/**
 * Live set of settled row ids. Signs in before attaching for the same reason
 * `subscribeGroup` does: the rules require an authenticated request, and a
 * cold open would otherwise fail with permission-denied.
 */
export function subscribeSettlements(
  groupId: string,
  cb: (rowIds: Set<string>) => void,
  onError?: (err: Error) => void,
): () => void {
  let cancelled = false;
  let unsub: (() => void) | null = null;

  const fail = (err: unknown) => {
    if (cancelled) return;
    onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  void ensureAuth()
    .then(() => {
      if (cancelled) return;
      unsub = onSnapshot(
        settlementsCol(groupId),
        (snapshot) => cb(new Set(snapshot.docs.map((d) => d.id))),
        fail,
      );
    })
    .catch(fail);

  return () => {
    cancelled = true;
    unsub?.();
  };
}
