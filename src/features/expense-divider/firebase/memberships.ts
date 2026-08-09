// Which trips an account belongs to:
//   users/{uid}/trips/{groupId}   { joinedAt }
//
// The local identity map already lists the trips a *device* joined; this is the
// same list keyed by account instead, so signing in on a second device finds
// them. It is deliberately an index, not a source of truth — the membership
// that decides what you can see is still the room code plus the member row
// inside the group.

import { collection, deleteDoc, doc, getDocs, setDoc } from "firebase/firestore";
import { db, ensureAuth } from "./config";

function tripsCol(uid: string) {
  if (!db) {
    throw new Error("Firebase is not configured — set VITE_FIREBASE_* env vars.");
  }
  return collection(db, "users", uid, "trips");
}

/**
 * Record that the signed-in account is in this trip. Best-effort: a failure
 * here must not fail the join itself, since the local identity map still gets
 * the visitor back into the group on this device.
 */
export async function recordTripMembership(groupId: string): Promise<void> {
  const uid = await ensureAuth();
  await setDoc(doc(tripsCol(uid), groupId), { joinedAt: Date.now() }, { merge: true });
}

export async function forgetTripMembership(groupId: string): Promise<void> {
  const uid = await ensureAuth();
  await deleteDoc(doc(tripsCol(uid), groupId));
}

/** Room codes this account has joined, newest first. */
export async function listTripMemberships(): Promise<string[]> {
  const uid = await ensureAuth();
  const snapshot = await getDocs(tripsCol(uid));
  return snapshot.docs
    .map((d) => ({ code: d.id, joinedAt: Number(d.data().joinedAt ?? 0) }))
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .map((t) => t.code);
}
