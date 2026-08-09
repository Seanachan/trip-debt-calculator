import { useCallback, useEffect, useMemo, useState } from "react";
import type { Balance, CurrencyCode, Expense, Person, RateMap, Settlement } from "../engine";
import { computeBalances, simplifyDebts, STATIC_RATES } from "../engine";
import { fetchRates } from "../rates";
import { firebaseReady } from "../firebase/config";
import {
  addExpense as addExpenseToGroup,
  addMember as addMemberToGroup,
  deleteExpense as deleteExpenseFromGroup,
  removeMember as removeMemberFromGroup,
  subscribeGroup,
  updateExpense as updateExpenseInGroup,
  updateMember as updateMemberInGroup,
} from "../firebase/groups";
import {
  markSettled,
  settlementRowId,
  subscribeSettlements,
  unmarkSettled,
} from "../firebase/settlements";
import type { GroupInfo } from "../firebase/schema";

const DEFAULT_BASE_CURRENCY: CurrencyCode = "USD";

/** Shared empty set, so `isSettled` keeps a stable identity between renders. */
const NO_SETTLED_ROWS: ReadonlySet<string> = new Set<string>();

export interface UseExpenseGroupResult {
  group: GroupInfo | null;
  baseCurrency: CurrencyCode;
  members: Person[];
  expenses: Expense[];
  balances: Balance[];
  settlement: Settlement[];
  /** Live `code → value-in-USD` FX rates (starts at STATIC_RATES, swaps in live on fetch). */
  rates: RateMap;
  loading: boolean;
  error: string | null;
  firebaseReady: boolean;
  /** Whether this settlement row has been ticked off as actually paid. */
  isSettled: (row: Settlement) => boolean;
  setSettled: (row: Settlement, settled: boolean, settledBy: string) => Promise<void>;
  addMember: (name: string) => Promise<string>;
  updateMember: (id: string, patch: Partial<Omit<Person, "id">>) => Promise<void>;
  removeMember: (id: string) => Promise<void>;
  /** `createdAt` is stamped by the write layer, so callers must not send one. */
  addExpense: (expense: Omit<Expense, "id" | "createdAt">) => Promise<string>;
  updateExpense: (id: string, patch: Partial<Omit<Expense, "id">>) => Promise<void>;
  deleteExpense: (id: string) => Promise<void>;
}

/**
 * Live-subscribes a group's info/members/expenses from Firestore and derives
 * balances/settlement (in the group's `baseCurrency`) from the pure engine.
 * `groupId === null` renders an idle/empty state (e.g. the create/join
 * screen before a group exists).
 */
export function useExpenseGroup(groupId: string | null): UseExpenseGroupResult {
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [members, setMembers] = useState<Person[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  // Which group the current snapshot came from; `null` until the first one
  // lands. Tracking the id (rather than a boolean) makes `loading` reset by
  // itself when `groupId` changes, with no state writes during the effect.
  const [loadedGroupId, setLoadedGroupId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ groupId: string; message: string } | null>(null);
  const [rates, setRates] = useState<RateMap>(STATIC_RATES);
  const [settledSnapshot, setSettledSnapshot] = useState<{
    groupId: string;
    rowIds: Set<string>;
  } | null>(null);

  // Fetch live FX rates once on mount; keep STATIC_RATES on failure. Never
  // blocks rendering — balances just recompute when live rates land.
  useEffect(() => {
    let alive = true;
    fetchRates()
      .then((live) => {
        if (alive) setRates(live);
      })
      .catch(() => {
        /* keep static fallback */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!groupId || !firebaseReady) return;

    const unsubscribe = subscribeGroup(
      groupId,
      (data) => {
        setGroup(data.group);
        setMembers(data.members);
        setExpenses(data.expenses);
        setLoadedGroupId(groupId);
      },
      // Sign-in or a listener failed. Without this the screen would sit on the
      // spinner forever, waiting for a first snapshot that never arrives.
      (err) => setFailure({ groupId, message: err.message }),
    );

    return unsubscribe;
  }, [groupId]);

  // Settled ticks ride a separate subscription: they are the one piece of
  // settlement state that cannot be derived from expenses, and they arrive
  // independently of the group payload.
  useEffect(() => {
    if (!groupId || !firebaseReady) return;
    return subscribeSettlements(
      groupId,
      (rowIds) => setSettledSnapshot({ groupId, rowIds }),
      (err) => setFailure({ groupId, message: err.message }),
    );
  }, [groupId]);

  // Tagged with its group for the same reason `loadedGroupId` is: switching
  // group drops the previous group's ticks without a setState in the effect.
  const settledRowIds =
    settledSnapshot?.groupId === groupId ? settledSnapshot.rowIds : NO_SETTLED_ROWS;

  // Failures carry the group they belong to, for the same reason `loadedGroupId`
  // does: switching group clears them without any state write in the effect.
  const subscribeError = failure?.groupId === groupId ? failure.message : null;
  const loading =
    Boolean(groupId) && firebaseReady && loadedGroupId !== groupId && !subscribeError;
  const error =
    groupId && !firebaseReady ? "Firebase is not configured." : subscribeError;

  const baseCurrency = group?.baseCurrency ?? DEFAULT_BASE_CURRENCY;

  const balances = useMemo(
    () => computeBalances(members, expenses, baseCurrency, rates),
    [members, expenses, baseCurrency, rates],
  );
  const settlement = useMemo(() => simplifyDebts(balances), [balances]);

  const isSettled = useCallback(
    (row: Settlement) => settledRowIds.has(settlementRowId(row)),
    [settledRowIds],
  );

  const setSettled = useCallback(
    (row: Settlement, settled: boolean, settledBy: string) => {
      if (!groupId) {
        throw new Error("Cannot settle without a group.");
      }
      return settled ? markSettled(groupId, row, settledBy) : unmarkSettled(groupId, row);
    },
    [groupId],
  );

  const addExpense = useCallback(
    (expense: Omit<Expense, "id" | "createdAt">) => {
      if (!groupId) {
        throw new Error("Cannot add an expense without a group.");
      }
      return addExpenseToGroup(groupId, expense);
    },
    [groupId],
  );

  const addMember = useCallback(
    (name: string) => {
      if (!groupId) {
        throw new Error("Cannot add a member without a group.");
      }
      return addMemberToGroup(groupId, name);
    },
    [groupId],
  );

  const updateMember = useCallback(
    (id: string, patch: Partial<Omit<Person, "id">>) => {
      if (!groupId) {
        throw new Error("Cannot update a member without a group.");
      }
      return updateMemberInGroup(groupId, id, patch);
    },
    [groupId],
  );

  const removeMember = useCallback(
    (id: string) => {
      if (!groupId) {
        throw new Error("Cannot remove a member without a group.");
      }
      return removeMemberFromGroup(groupId, id);
    },
    [groupId],
  );

  const updateExpense = useCallback(
    (id: string, patch: Partial<Omit<Expense, "id">>) => {
      if (!groupId) {
        throw new Error("Cannot update an expense without a group.");
      }
      return updateExpenseInGroup(groupId, id, patch);
    },
    [groupId],
  );

  const deleteExpense = useCallback(
    (id: string) => {
      if (!groupId) {
        throw new Error("Cannot delete an expense without a group.");
      }
      return deleteExpenseFromGroup(groupId, id);
    },
    [groupId],
  );

  return {
    group,
    baseCurrency,
    members,
    expenses,
    balances,
    settlement,
    rates,
    loading,
    error,
    firebaseReady,
    isSettled,
    setSettled,
    addMember,
    updateMember,
    removeMember,
    addExpense,
    updateExpense,
    deleteExpense,
  };
}
