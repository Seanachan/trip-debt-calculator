// Firestore-backed group/expense operations for live multiplayer trip-debt
// groups. Document layout:
//   groups/{groupId}                      { name, baseCurrency, categories, createdAt }
//   groups/{groupId}/members/{personId}   { name, color }
//   groups/{groupId}/expenses/{expenseId} <engine Expense minus id>

import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from "firebase/firestore";
import type { Category, CurrencyCode, Expense, Person } from "../engine";
import { DEFAULT_CATEGORIES } from "../engine";
import { PALETTE } from "../constants";
import { db, ensureAuth } from "./config";
import { recordTripMembership } from "./memberships";
import {
  expenseFromDoc,
  expenseToDoc,
  groupFromDoc,
  personFromDoc,
  personToDoc,
  type GroupInfo,
} from "./schema";

function requireDb(): Firestore {
  if (!db) {
    throw new Error("Firebase is not configured — set VITE_FIREBASE_* env vars.");
  }
  return db;
}

function groupDoc(groupId: string) {
  return doc(requireDb(), "groups", groupId);
}

function membersCol(groupId: string) {
  return collection(requireDb(), "groups", groupId, "members");
}

function memberDoc(groupId: string, personId: string) {
  return doc(requireDb(), "groups", groupId, "members", personId);
}

function expensesCol(groupId: string) {
  return collection(requireDb(), "groups", groupId, "expenses");
}

function expenseDoc(groupId: string, expenseId: string) {
  return doc(requireDb(), "groups", groupId, "expenses", expenseId);
}

const ROOM_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROOM_CODE_LENGTH = 6;

/** 6 uppercase alphanumerics, generated with the Web Crypto RNG. */
export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) {
    code += ROOM_CODE_CHARS[b % ROOM_CODE_CHARS.length];
  }
  return code;
}

async function generateUniqueRoomCode(): Promise<string> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const existing = await getDoc(groupDoc(code));
    if (!existing.exists()) {
      return code;
    }
  }
  throw new Error("Could not generate a unique room code — please try again.");
}

/** Next unused palette color, based on how many members already exist. */
async function nextMemberColor(groupId: string): Promise<string> {
  const snapshot = await getDocs(membersCol(groupId));
  return PALETTE[snapshot.size % PALETTE.length];
}

interface CreateGroupInput {
  name: string;
  baseCurrency: CurrencyCode;
  creatorName: string;
}

export async function createGroup({
  name,
  baseCurrency,
  creatorName,
}: CreateGroupInput): Promise<{ groupId: string; personId: string }> {
  const personId = await ensureAuth();
  const groupId = await generateUniqueRoomCode();

  await setDoc(groupDoc(groupId), {
    name,
    baseCurrency,
    categories: DEFAULT_CATEGORIES,
    createdAt: serverTimestamp(),
  });
  await setDoc(
    memberDoc(groupId, personId),
    personToDoc({ name: creatorName, color: PALETTE[0] }),
  );
  await rememberTrip(groupId);

  return { groupId, personId };
}

/**
 * Index the trip under the signed-in account, so another device signed into
 * the same account finds it. Never fails the surrounding create/join: the
 * local identity map is what actually gets this device back in.
 */
async function rememberTrip(groupId: string): Promise<void> {
  try {
    await recordTripMembership(groupId);
  } catch {
    // Account index is a convenience; the trip still works without it.
  }
}

export async function joinGroup(
  groupId: string,
  name: string,
): Promise<{ personId: string }> {
  const personId = await ensureAuth();

  const groupSnap = await getDoc(groupDoc(groupId));
  if (!groupSnap.exists()) {
    throw new Error("Group not found");
  }

  const color = await nextMemberColor(groupId);
  await setDoc(memberDoc(groupId, personId), personToDoc({ name, color }));
  await rememberTrip(groupId);
  return { personId };
}

/**
 * Add a person not tied to any device/auth uid — for an organizer adding
 * someone who isn't present to set up the group themselves. If that person
 * later self-joins via `joinGroup`, they get a separate id tied to their own
 * auth uid; reconciling the two is a v2 concern.
 */
/**
 * One-shot read of a group's info, for listing trips this device has joined
 * without opening a live subscription to each. `null` means the room code no
 * longer resolves — the caller treats that as "this trip is gone".
 */
export async function fetchGroupInfo(groupId: string): Promise<GroupInfo | null> {
  await ensureAuth();
  const snapshot = await getDoc(groupDoc(groupId));
  return snapshot.exists() ? groupFromDoc(snapshot.data()) : null;
}

export async function addMember(groupId: string, name: string): Promise<string> {
  const ref = doc(membersCol(groupId));
  const color = await nextMemberColor(groupId);
  await setDoc(ref, personToDoc({ name, color }));
  return ref.id;
}

export async function updateMember(
  groupId: string,
  id: string,
  patch: Partial<Omit<Person, "id">>,
): Promise<void> {
  await updateDoc(memberDoc(groupId, id), { ...patch });
}

export async function removeMember(groupId: string, id: string): Promise<void> {
  await deleteDoc(memberDoc(groupId, id));
}

/**
 * Replace the group's category list wholesale. Categories are a single array
 * field rather than a subcollection: the list is short, always read in full,
 * and reordering/renaming it as one document write keeps every device's copy
 * consistent without a second listener.
 */
export async function updateGroupCategories(
  groupId: string,
  categories: Category[],
): Promise<void> {
  await updateDoc(groupDoc(groupId), { categories });
}

/**
 * Stamps `createdAt` here rather than at the call site so an edit can never
 * rewrite it (expenses are ordered by `createdAt`). A client clock is used
 * instead of `serverTimestamp()` because `expenseFromDoc` expects a number and
 * would read a pending server timestamp as 0.
 */
export async function addExpense(
  groupId: string,
  expense: Omit<Expense, "id" | "createdAt">,
): Promise<string> {
  const ref = await addDoc(expensesCol(groupId), expenseToDoc({ ...expense, createdAt: Date.now() }));
  return ref.id;
}

/**
 * `undefined` in the patch means "clear this field" (an expense whose category
 * or icon was removed). Firestore rejects a literal `undefined` value, so those
 * keys are translated to `deleteField()` rather than silently dropped — dropping
 * them would leave the old value in place and the edit would look ignored.
 */
export async function updateExpense(
  groupId: string,
  id: string,
  patch: Partial<Omit<Expense, "id">>,
): Promise<void> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    body[key] = value === undefined ? deleteField() : value;
  }
  await updateDoc(expenseDoc(groupId, id), body);
}

export async function deleteExpense(groupId: string, id: string): Promise<void> {
  await deleteDoc(expenseDoc(groupId, id));
}

/**
 * Subscribe to a group's info + members + expenses. Calls `cb` with the
 * latest snapshot of all three whenever any changes. Returns an unsubscribe
 * that detaches all three listeners.
 *
 * Signs in first: the rules require `request.auth != null`, so attaching the
 * listeners before anonymous sign-in resolves makes all three fail with
 * `permission-denied`. That is the cold-open case — someone opening a shared
 * room link on a device that has never used the app — so it must not race.
 * Listener failures are reported through `onError` instead of being swallowed,
 * otherwise the consumer waits on a first snapshot that never arrives.
 */
export function subscribeGroup(
  groupId: string,
  cb: (data: { group: GroupInfo | null; members: Person[]; expenses: Expense[] }) => void,
  onError?: (err: Error) => void,
): () => void {
  let group: GroupInfo | null = null;
  let members: Person[] = [];
  let expenses: Expense[] = [];
  let groupLoaded = false;
  let membersLoaded = false;
  let expensesLoaded = false;
  let cancelled = false;
  const unsubs: (() => void)[] = [];

  const fail = (err: unknown) => {
    if (cancelled) return;
    onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  // Only emit once all three listeners have delivered their first snapshot,
  // so the consumer never sees a transient partial state (e.g. group loaded
  // but members still empty). After all three have loaded, every subsequent
  // change emits.
  const emit = () => {
    if (groupLoaded && membersLoaded && expensesLoaded) {
      cb({ group, members, expenses });
    }
  };

  void ensureAuth()
    .then(() => {
      if (cancelled) return;

      unsubs.push(
        onSnapshot(
          groupDoc(groupId),
          (snapshot) => {
            group = snapshot.exists() ? groupFromDoc(snapshot.data()) : null;
            groupLoaded = true;
            emit();
          },
          fail,
        ),
      );

      unsubs.push(
        onSnapshot(
          membersCol(groupId),
          (snapshot) => {
            members = snapshot.docs.map((d) => personFromDoc(d.id, d.data()));
            membersLoaded = true;
            emit();
          },
          fail,
        ),
      );

      unsubs.push(
        onSnapshot(
          expensesCol(groupId),
          (snapshot) => {
            expenses = snapshot.docs
              .map((d) => expenseFromDoc(d.id, d.data()))
              .sort((a, b) => a.createdAt - b.createdAt);
            expensesLoaded = true;
            emit();
          },
          fail,
        ),
      );
    })
    .catch(fail);

  return () => {
    cancelled = true;
    for (const unsub of unsubs) {
      unsub();
    }
  };
}
