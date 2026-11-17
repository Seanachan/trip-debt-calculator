// Who is this visitor? Pure helpers for the join screen, so the rules that
// decide between "you are 阿凱 again" and "a second 阿凱" are tested without
// Firestore or a browser. See docs/specs/join-and-home-screen.md.

import type { Person } from "./engine";

/** How a typed name is compared: trimmed, width- and case-folded (「Ａｎｎ」 is 「ann」). */
function foldName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

/**
 * The member a newcomer's typed name already belongs to, if any, so the join
 * screen can ask 「已經有阿凱了，是你嗎？」 instead of quietly adding a second one.
 */
export function memberNamed(members: Person[], typed: string): Person | undefined {
  const wanted = foldName(typed);
  if (wanted === "") return undefined;
  return members.find((m) => foldName(m.name) === wanted);
}

/**
 * The member this sign-in already is. A member's id is the uid of the sign-in
 * that joined, so a Google account on a new device, or a browser whose identity
 * map was cleared, is recognised without the join screen.
 */
export function memberForUid(members: Person[], uid: string | null): Person | undefined {
  if (!uid) return undefined;
  return members.find((m) => m.id === uid);
}
