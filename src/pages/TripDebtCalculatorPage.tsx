import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type {
  Category,
  CurrencyCode,
  Expense,
  Person,
  Settlement,
  SplitParticipant,
} from "../features/expense-divider/engine";
import {
  CURRENCIES,
  CURRENCY_CODES,
  PERCENT_TOLERANCE,
  convert,
  formatMoney,
  fromMinor,
  largestRemainder,
  newCategoryId,
  toMinor,
  validateExpense,
} from "../features/expense-divider/engine";
import { CATEGORY_ICONS, ICONS } from "../features/expense-divider/constants";
import {
  firebaseReady,
  onAccountChange,
  signInWithGoogle,
  signOutAccount,
  type AccountInfo,
} from "../features/expense-divider/firebase/config";
import {
  listTripMemberships,
  recordTripMembership,
} from "../features/expense-divider/firebase/memberships";
import { createGroup, fetchGroupInfo, joinGroup } from "../features/expense-divider/firebase/groups";
import { useExpenseGroup } from "../features/expense-divider/hooks/useExpenseGroup";
import {
  clearIdentity,
  getIdentity,
  listJoinedGroupIds,
  saveIdentity,
} from "../features/expense-divider/identity";
import "../styles/TripDebtCalculator.css";

// ============================================================================
// Local, page-owned persistence. Distinct from `identity.ts` (which the hook
// contract owns) — these two keys are UI convenience only, never touched by
// the engine/firebase/hook layer:
//   trip-debt:last-group      — which group to offer on "← 返回目前行程"
//   trip-debt:settled:{id}    — which settlement rows the viewer has ticked
//                                off locally (NOT synced to other devices)
// ============================================================================

const LAST_GROUP_KEY = "trip-debt:last-group";

/** Reserved `:groupId` value meaning "show onboard, don't resume". */
const ONBOARD_SEGMENT = "new";

function readLastGroupId(): string | null {
  try {
    return localStorage.getItem(LAST_GROUP_KEY);
  } catch {
    return null;
  }
}

function writeLastGroupId(groupId: string): void {
  try {
    localStorage.setItem(LAST_GROUP_KEY, groupId);
  } catch {
    // best-effort only
  }
}

function clearLastGroupId(): void {
  try {
    localStorage.removeItem(LAST_GROUP_KEY);
  } catch {
    // best-effort only
  }
}

/**
 * The currency this device last recorded an expense in, per group. The group's
 * `baseCurrency` is only the settlement target ("what everything converts to
 * at the end"), so it is a poor default for the amount you are typing — on a
 * Korea trip settled in TWD, nearly every entry is KRW.
 */
function lastCurrencyStorageKey(groupId: string): string {
  return `trip-debt:last-currency:${groupId}`;
}

function readLastCurrency(groupId: string): CurrencyCode | null {
  try {
    const raw = localStorage.getItem(lastCurrencyStorageKey(groupId));
    return raw && (CURRENCY_CODES as readonly string[]).includes(raw)
      ? (raw as CurrencyCode)
      : null;
  } catch {
    return null;
  }
}

function writeLastCurrency(groupId: string, code: CurrencyCode): void {
  try {
    localStorage.setItem(lastCurrencyStorageKey(groupId), code);
  } catch {
    // best-effort only
  }
}

/**
 * Legacy per-device settled ticks. Settled state now lives in Firestore so all
 * travellers see the same thing; these two are kept only to migrate what a
 * device already ticked, and are cleared once that has happened.
 */
function settledStorageKey(groupId: string): string {
  return `trip-debt:settled:${groupId}`;
}

function readSettledKeys(groupId: string): Set<string> {
  try {
    const raw = localStorage.getItem(settledStorageKey(groupId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function clearSettledKeys(groupId: string): void {
  try {
    localStorage.removeItem(settledStorageKey(groupId));
  } catch {
    // best-effort only
  }
}

function settlementKey(s: { from: string; to: string; amount: number }): string {
  return `${s.from}>${s.to}:${s.amount}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

/** Minor units -> a clean decimal string for prefilling a text input. */
function formatMajor(minor: number, code: CurrencyCode): string {
  return fromMinor(minor, code).toFixed(CURRENCIES[code].decimals);
}

/**
 * Percent splits carry two decimal places, i.e. 0.01-point granularity. All the
 * percent arithmetic runs on integer steps of that grid, so a generated split
 * sums to exactly 100 (three people -> 33.34 / 33.33 / 33.33, not 34 / 33 / 33).
 * Changing `PERCENT_DECIMALS` re-grids the input, the maths and the display
 * together — nothing below hardcodes the number of digits.
 */
const PERCENT_DECIMALS = 2;
const PERCENT_STEPS_PER_POINT = 10 ** PERCENT_DECIMALS;
const PERCENT_TOTAL_STEPS = 100 * PERCENT_STEPS_PER_POINT;

/** Integer grid steps -> display string, with no trailing zeros ("50", not "50.00"). */
function formatPercent(steps: number): string {
  return String(steps / PERCENT_STEPS_PER_POINT);
}

/** Round an already-percentage number onto the grid, for display. */
function roundPercent(pct: number): number {
  return Math.round(pct * PERCENT_STEPS_PER_POINT) / PERCENT_STEPS_PER_POINT;
}

/** Distribute 100% across `weights` as on-grid strings summing to 100. */
function percentSplitStrings(weights: number[]): string[] {
  return largestRemainder(PERCENT_TOTAL_STEPS, weights).map(formatPercent);
}

/** Digits only, at most one dot, at most `PERCENT_DECIMALS` digits after it. */
const PERCENT_INPUT_RE = new RegExp(`^(\\d*\\.?\\d{0,${PERCENT_DECIMALS}}).*$`);

type ViewName = "overview" | "activity" | "categories" | "people" | "settle";
type SplitInputMode = "pct" | "amount";

const NAV_ITEMS: { key: ViewName; label: string; icon: string }[] = [
  { key: "overview", label: "餘額", icon: "⚖️" },
  { key: "activity", label: "帳目", icon: "🧾" },
  { key: "categories", label: "分類", icon: "🏷️" },
  { key: "people", label: "成員", icon: "👥" },
  { key: "settle", label: "結算", icon: "💸" },
];

const Avatar = ({
  name,
  color,
  size,
}: {
  name: string;
  color?: string;
  size: "md" | "sm" | "xs";
}) => (
  <div className={`tdt-avatar tdt-avatar--${size}`} style={{ background: color ?? "#888888" }}>
    {initials(name)}
  </div>
);

// ============================================================================
// Top-level route component
// ============================================================================

export const TripDebtCalculatorPage = () => {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();

  if (!firebaseReady) {
    return (
      <div className="tdt-page">
        <div className="tdt-notice">
          <div className="tdt-notice-title">尚未設定</div>
          <p>行程分帳功能目前尚未設定完成，請稍後再試。</p>
        </div>
      </div>
    );
  }

  // `/new` is the escape hatch (used by "換一個行程"), not a room code: it forces
  // the onboard screen instead of resuming. Room codes are always 6 uppercase
  // alphanumerics (`generateRoomCode`), so "new" can never collide with a real
  // one.
  //
  // Every path below is router-relative. The `/trip-debt-calculator` prefix the
  // visitor sees comes from the BrowserRouter `basename` in main.tsx (this app
  // is a GitHub Pages project site served under that subpath) — writing it here
  // too would double it.
  const wantsOnboard = groupId?.toLowerCase() === ONBOARD_SEGMENT;

  if (!groupId || wantsOnboard) {
    // Returning visitor: go straight back into the trip this device already
    // belongs to, so a bookmark of the bare URL doesn't ask for the code again.
    const resumeId = wantsOnboard ? null : readLastGroupId();
    if (resumeId && getIdentity(resumeId)) {
      return <Navigate to={`/${resumeId}`} replace />;
    }
    return <OnboardScreen onNavigate={(id) => navigate(`/${id}`)} />;
  }

  return (
    <AppScreen
      key={groupId}
      groupId={groupId}
      onNavigateOnboard={() => navigate(`/${ONBOARD_SEGMENT}`)}
    />
  );
};

// ============================================================================
// Onboard: create a trip, or join one by room code
// ============================================================================

/** A trip this device has joined before. `baseCurrency` is null when offline. */
interface PastTrip {
  code: string;
  name: string;
  baseCurrency: CurrencyCode | null;
}

const OnboardScreen = ({ onNavigate }: { onNavigate: (groupId: string) => void }) => {
  const [pastTrips, setPastTrips] = useState<PastTrip[] | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => onAccountChange(setAccount), []);

  // Trips come from two places: the identity map (every group this *device*
  // joined) and the account index (groups joined on any device, once signed
  // in). Codes that no longer resolve are dropped along with their identity;
  // codes that merely failed to load are kept, since an unreachable server is
  // not evidence that a trip is gone.
  useEffect(() => {
    let alive = true;

    const resolveTrip = async (code: string): Promise<PastTrip | null> => {
      try {
        const info = await fetchGroupInfo(code);
        if (!info) {
          clearIdentity(code);
          if (readLastGroupId() === code) clearLastGroupId();
          return null;
        }
        return { code, name: info.name, baseCurrency: info.baseCurrency };
      } catch {
        return { code, name: code, baseCurrency: null };
      }
    };

    void (async () => {
      const local = listJoinedGroupIds();
      let remote: string[] = [];
      try {
        remote = await listTripMemberships();
      } catch {
        // Offline, or the account has no index yet — the local list stands.
      }
      const codes = Array.from(new Set([...local, ...remote]));
      if (!alive) return;
      if (codes.length === 0) {
        setPastTrips([]);
        return;
      }

      const resolved = await Promise.all(codes.map(resolveTrip));
      if (!alive) return;
      const last = readLastGroupId();
      const found = resolved.filter((t): t is PastTrip => t !== null);
      // Most recently used first, so "back to the trip I'm on" stays one tap.
      found.sort((a, b) => Number(b.code === last) - Number(a.code === last));
      setPastTrips(found);
    })();

    return () => {
      alive = false;
    };
  }, [account?.uid]);

  const handleSignIn = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signInWithGoogle();
      // Index the trips this device already knows under the account, so the
      // next device signed in as this account sees them too.
      await Promise.all(
        listJoinedGroupIds().map((code) => recordTripMembership(code).catch(() => undefined)),
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
        setAuthError(err instanceof Error ? err.message : "登入失敗，請再試一次。");
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signOutAccount();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "登出失敗。");
    } finally {
      setAuthBusy(false);
    }
  };

  const [obTrip, setObTrip] = useState("");
  const [obCur, setObCur] = useState<CurrencyCode>("USD");
  const [obMe, setObMe] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const handleCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const name = obMe.trim() || "我";
      const { groupId, personId } = await createGroup({
        name: obTrip.trim() || "我的行程",
        baseCurrency: obCur,
        creatorName: name,
      });
      saveIdentity(groupId, personId, name);
      writeLastGroupId(groupId);
      onNavigate(groupId);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "建立行程失敗，請再試一次。");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setJoining(true);
    setJoinError(null);
    try {
      const code = joinCode.trim().toUpperCase();
      const name = joinName.trim() || "我";
      const { personId } = await joinGroup(code, name);
      saveIdentity(code, personId, name);
      writeLastGroupId(code);
      onNavigate(code);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "加入行程失敗，請確認房間代碼。");
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="tdt-page">
      <div className="tdt-phone">
        <div className="tdt-onboard">
          <div className="tdt-account">
            {account && !account.anonymous ? (
              <>
                <span className="tdt-account-name">{account.name ?? account.email}</span>
                <button
                  type="button"
                  className="tdt-account-btn"
                  onClick={handleSignOut}
                  disabled={authBusy}
                >
                  登出
                </button>
              </>
            ) : (
              <>
                <span className="tdt-account-hint">行程只存在這台裝置</span>
                <button
                  type="button"
                  className="tdt-account-btn"
                  onClick={handleSignIn}
                  disabled={authBusy}
                >
                  {authBusy ? "登入中…" : "用 Google 登入以跨裝置"}
                </button>
              </>
            )}
          </div>
          {authError && <p className="tdt-error-text">{authError}</p>}

          {pastTrips && pastTrips.length > 0 && (
            <div className="tdt-past-trips">
              <div className="tdt-field-label tdt-mono">你的行程</div>
              <ul className="tdt-past-list">
                {pastTrips.map((trip) => (
                  <li key={trip.code}>
                    <button
                      type="button"
                      className="tdt-past-btn"
                      onClick={() => onNavigate(trip.code)}
                    >
                      <span className="tdt-past-name">{trip.name}</span>
                      <span className="tdt-past-meta tdt-mono">
                        {trip.baseCurrency ? `${trip.baseCurrency} · ` : ""}
                        {trip.code}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="tdt-onboard-main">
            <div className="tdt-hero">
              <div className="tdt-kicker tdt-mono">記帳 · 分帳 · 結算</div>
              <h1 className="tdt-hero-title">
                公平分攤
                <br />
                每一筆旅行開銷。
              </h1>
              <p className="tdt-hero-sub">
                旅途中隨手記帳、按百分比分攤,實時看清誰欠誰——回家後一鍵結清。
              </p>
            </div>

            <form className="tdt-card" onSubmit={handleCreate}>
              <label className="tdt-field">
                <span className="tdt-field-label tdt-mono">行程名稱</span>
                <input
                  className="tdt-input tdt-input--sunken"
                  value={obTrip}
                  onChange={(e) => setObTrip(e.target.value)}
                  placeholder="例如:泰國 2026"
                />
              </label>
              <label className="tdt-field">
                <span className="tdt-field-label tdt-mono">結算幣別(最後換算成)</span>
                <select
                  className="tdt-select tdt-select--sunken"
                  value={obCur}
                  onChange={(e) => setObCur(e.target.value as CurrencyCode)}
                >
                  {CURRENCY_CODES.map((code) => (
                    <option key={code} value={code}>
                      {CURRENCIES[code].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tdt-field">
                <span className="tdt-field-label tdt-mono">你的名字</span>
                <input
                  className="tdt-input tdt-input--sunken"
                  value={obMe}
                  onChange={(e) => setObMe(e.target.value)}
                  placeholder="你"
                />
              </label>
              <button type="submit" className="tdt-btn-primary" disabled={creating}>
                {creating ? "建立中…" : "開始行程 →"}
              </button>
              {createError && <p className="tdt-error-text">{createError}</p>}
            </form>

            <div className="tdt-divider">或</div>

            <form className="tdt-card" onSubmit={handleJoin}>
              <label className="tdt-field">
                <span className="tdt-field-label tdt-mono">房間代碼</span>
                <input
                  className="tdt-input tdt-input--sunken"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="例如:AB12CD"
                />
              </label>
              <label className="tdt-field">
                <span className="tdt-field-label tdt-mono">你的名字</span>
                <input
                  className="tdt-input tdt-input--sunken"
                  value={joinName}
                  onChange={(e) => setJoinName(e.target.value)}
                  placeholder="你"
                />
              </label>
              <button type="submit" className="tdt-btn-secondary" disabled={joining}>
                {joining ? "加入中…" : "加入行程 →"}
              </button>
              {joinError && <p className="tdt-error-text">{joinError}</p>}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// App shell: header + overview/activity/people/settle + FAB/nav + modals
// ============================================================================

const AppScreen = ({
  groupId,
  onNavigateOnboard,
}: {
  groupId: string;
  onNavigateOnboard: () => void;
}) => {
  const {
    group,
    baseCurrency,
    members,
    expenses,
    categories,
    balances,
    settlement,
    categoryTotals,
    rates,
    loading,
    error,
    isSettled,
    setSettled,
    updateCategories,
    addMember,
    updateMember,
    removeMember,
    addExpense,
    updateExpense,
    deleteExpense,
  } = useExpenseGroup(groupId);

  const [identity, setIdentity] = useState(() => getIdentity(groupId));
  const [view, setView] = useState<ViewName>("overview");

  // Only remember a group once Firestore confirms it exists, otherwise opening
  // one bad room code would overwrite the good "last group" and strand the
  // visitor on the not-found screen every visit. A code that turns out dead is
  // actively forgotten, along with the useless identity stored against it.
  useEffect(() => {
    if (loading) return;
    if (group) {
      writeLastGroupId(groupId);
      return;
    }
    // Only a confirmed absence forgets the group — a sign-in/network failure
    // leaves `group` null too, and dropping the identity on a flaky connection
    // would make the visitor re-join under a new person.
    if (error) return;
    if (readLastGroupId() === groupId) {
      clearLastGroupId();
    }
    clearIdentity(groupId);
  }, [groupId, loading, group, error]);

  // join prompt (fresh visitor who opened a shared link without an identity)
  const [joinName, setJoinName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // expense modal
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [dDesc, setDDesc] = useState("");
  const [dAmount, setDAmount] = useState("");
  const [dCur, setDCur] = useState<CurrencyCode>(() => readLastCurrency(groupId) ?? baseCurrency);
  const [dPayer, setDPayer] = useState("");
  const [dMode, setDMode] = useState<SplitInputMode>("pct");
  const [dPct, setDPct] = useState<Record<string, string>>({});
  const [dAmt, setDAmt] = useState<Record<string, string>>({});
  const [dIncluded, setDIncluded] = useState<Record<string, boolean>>({});
  const [dCategory, setDCategory] = useState<string | undefined>(undefined);
  const [expenseErrors, setExpenseErrors] = useState<string[]>([]);

  // Inline "new category" row inside the expense sheet, and the rename/add
  // editor on the 分類 view. Both write through `updateCategories`.
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [newCatLabel, setNewCatLabel] = useState("");
  const [newCatIcon, setNewCatIcon] = useState(CATEGORY_ICONS[0]);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  // person modal
  const [personModalOpen, setPersonModalOpen] = useState(false);
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [pName, setPName] = useState("");
  const [personError, setPersonError] = useState<string | null>(null);

  const [settleError, setSettleError] = useState<string | null>(null);
  const migratedSettled = useRef(false);

  // One-time lift of this device's old local ticks into the shared collection.
  // Ticks whose row no longer exists in the current plan are dropped: the debt
  // they described is gone, so there is nothing left to mark as paid.
  useEffect(() => {
    if (migratedSettled.current || loading || !group) return;
    const legacy = readSettledKeys(groupId);
    if (legacy.size === 0) {
      migratedSettled.current = true;
      return;
    }
    const pending = settlement.filter((row) => legacy.has(settlementKey(row)) && !isSettled(row));
    if (pending.length === 0 && settlement.length === 0) return;
    migratedSettled.current = true;
    void Promise.all(pending.map((row) => setSettled(row, true, identity?.personId ?? "legacy")))
      .then(() => clearSettledKeys(groupId))
      .catch(() => {
        // Leave the local copy in place so the next load can retry.
        migratedSettled.current = false;
      });
  }, [groupId, loading, group, settlement, isSettled, setSettled, identity]);

  // invite — the 6-char room code IS the shared secret, so the link is the invite.
  // BASE_URL is already `/trip-debt-calculator/` here (this app is served as a
  // Pages project site under that path), so the group id appends directly to it;
  // naming the path segment again would double the prefix. Built from BASE_URL +
  // origin rather than location.href so it stays correct when the app was reached
  // through the bare auto-resume path.
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const inviteUrl = new URL(
    `${import.meta.env.BASE_URL}${groupId}`,
    window.location.origin,
  ).toString();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopyInvite = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      // clipboard needs a secure context and can still be denied — show the
      // link so it can be copied by hand rather than failing silently
      setCopyFailed(true);
    }
  };

  if (loading) {
    return (
      <div className="tdt-page">
        <div className="tdt-phone">
          <div className="tdt-notice">載入中…</div>
        </div>
      </div>
    );
  }

  if (!group && error) {
    return (
      <div className="tdt-page">
        <div className="tdt-phone">
          <div className="tdt-notice">
            <div className="tdt-notice-title">連線失敗</div>
            <p>無法載入這個行程，請檢查網路後重試。</p>
            <p className="tdt-error-text">{error}</p>
            <button type="button" className="tdt-btn-primary" onClick={() => window.location.reload()}>
              重試
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="tdt-page">
        <div className="tdt-phone">
          <div className="tdt-notice">
            <div className="tdt-notice-title">找不到這個行程</div>
            <p>房間代碼可能有誤，或這個行程已經不存在了。</p>
            <button type="button" className="tdt-btn-primary" onClick={onNavigateOnboard}>
              重新輸入代碼 →
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!identity) {
    const handleJoinHere = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setJoining(true);
      setJoinError(null);
      try {
        const name = joinName.trim() || "我";
        const { personId } = await joinGroup(groupId, name);
        saveIdentity(groupId, personId, name);
        writeLastGroupId(groupId);
        setIdentity({ personId, name });
      } catch (err) {
        setJoinError(err instanceof Error ? err.message : "加入行程失敗，請再試一次。");
      } finally {
        setJoining(false);
      }
    };

    return (
      <div className="tdt-page">
        <div className="tdt-phone">
          <div className="tdt-onboard">
            <div className="tdt-onboard-main">
              <div className="tdt-hero">
                <div className="tdt-kicker tdt-mono">加入行程</div>
                <h1 className="tdt-hero-title">{group.name}</h1>
                <p className="tdt-hero-sub">輸入你的名字以加入這個行程，開始記帳。</p>
              </div>
              <form className="tdt-card" onSubmit={handleJoinHere}>
                <label className="tdt-field">
                  <span className="tdt-field-label tdt-mono">你的名字</span>
                  <input
                    className="tdt-input tdt-input--sunken"
                    value={joinName}
                    onChange={(e) => setJoinName(e.target.value)}
                    placeholder="你"
                  />
                </label>
                <button type="submit" className="tdt-btn-primary" disabled={joining}>
                  {joining ? "加入中…" : "加入行程 →"}
                </button>
                {joinError && <p className="tdt-error-text">{joinError}</p>}
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- from here on `identity`, `group` are narrowed non-null ----

  const nameOf = (id: string): string => members.find((m) => m.id === id)?.name ?? "?";

  const myBalance =
    balances.find((b) => b.personId === identity.personId) ??
    ({ personId: identity.personId, paid: 0, owed: 0, net: 0 } as const);

  const totalSpentMinor = expenses.reduce(
    (sum, e) => sum + convert(e.amount, e.currency, baseCurrency, rates),
    0,
  );

  // ---------- category handlers ----------

  const categoryOf = (id: string | undefined): Category | undefined =>
    id === undefined ? undefined : categories.find((c) => c.id === id);

  const closeNewCategoryRow = () => {
    setNewCatOpen(false);
    setNewCatLabel("");
    setNewCatIcon(CATEGORY_ICONS[0]);
    setEditingCategoryId(null);
    setCategoryError(null);
  };

  const openNewCategoryRow = () => {
    setEditingCategoryId(null);
    setNewCatLabel("");
    setNewCatIcon(CATEGORY_ICONS[0]);
    setCategoryError(null);
    setNewCatOpen(true);
  };

  const openRenameCategory = (category: Category) => {
    setEditingCategoryId(category.id);
    setNewCatLabel(category.label);
    setNewCatIcon(category.icon);
    setCategoryError(null);
    setNewCatOpen(true);
  };

  /**
   * Commits the inline editor. Adding also selects the new category in the
   * expense sheet — the only reason to add one mid-entry is to use it. Renaming
   * keeps the id, so expenses already filed under it follow the new name.
   */
  const handleSaveCategory = async () => {
    const label = newCatLabel.trim();
    if (!label) return;
    const clash = categories.some((c) => c.id !== editingCategoryId && c.label === label);
    if (clash) {
      setCategoryError(`已經有一個叫「${label}」的分類了。`);
      return;
    }

    const id = editingCategoryId ?? newCategoryId();
    const next = editingCategoryId
      ? categories.map((c) => (c.id === editingCategoryId ? { ...c, label, icon: newCatIcon } : c))
      : [...categories, { id, label, icon: newCatIcon }];

    try {
      await updateCategories(next);
      if (!editingCategoryId) setDCategory(id);
      closeNewCategoryRow();
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "儲存分類失敗，請再試一次。");
    }
  };

  /**
   * Removing a category leaves any expense filed under it pointing at an id
   * that no longer resolves, which the rollup reads as 未分類 — deliberately,
   * so deleting a bucket never silently rewrites the expenses inside it.
   */
  const handleDeleteCategory = async (id: string) => {
    setCategoryError(null);
    try {
      await updateCategories(categories.filter((c) => c.id !== id));
      if (dCategory === id) setDCategory(undefined);
      closeNewCategoryRow();
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "刪除分類失敗，請再試一次。");
    }
  };

  // Shared by the expense sheet and the 分類 view — only one of the two can be
  // open at a time, since both drive the same `newCat*` state.
  const categoryEditor = (
    <div className="tdt-cat-editor">
      <div className="tdt-cat-editor-icons">
        {CATEGORY_ICONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`圖示 ${emoji}`}
            aria-pressed={newCatIcon === emoji}
            className={`tdt-cat-icon-btn ${
              newCatIcon === emoji ? "tdt-cat-icon-btn--active" : ""
            }`}
            onClick={() => setNewCatIcon(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <div className="tdt-cat-editor-row">
        <input
          className="tdt-input"
          value={newCatLabel}
          onChange={(e) => setNewCatLabel(e.target.value)}
          placeholder="分類名稱"
          maxLength={12}
        />
        <button type="button" className="tdt-btn-ghost-sm" onClick={closeNewCategoryRow}>
          取消
        </button>
        <button
          type="button"
          className="tdt-cat-save"
          disabled={!newCatLabel.trim()}
          onClick={() => void handleSaveCategory()}
        >
          {editingCategoryId ? "儲存" : "新增"}
        </button>
      </div>
    </div>
  );

  // ---------- expense modal handlers ----------

  const openAddExpense = () => {
    const memberIds = members.map((m) => m.id);
    const pcts = percentSplitStrings(memberIds.map(() => 1));
    const included: Record<string, boolean> = {};
    const pctMap: Record<string, string> = {};
    memberIds.forEach((id, i) => {
      included[id] = true;
      pctMap[id] = pcts[i];
    });
    setEditingExpenseId(null);
    setDDesc("");
    setDAmount("");
    // Default to what is actually being spent, not the settlement currency:
    // this device's last entry, else whatever the group last recorded, else base.
    setDCur(
      readLastCurrency(groupId) ??
        expenses[expenses.length - 1]?.currency ??
        baseCurrency,
    );
    setDPayer(identity.personId);
    setDMode("pct");
    setDPct(pctMap);
    setDAmt({});
    setDIncluded(included);
    setDCategory(undefined);
    closeNewCategoryRow();
    setExpenseErrors([]);
    setExpenseModalOpen(true);
  };

  const openEditExpense = (expense: Expense) => {
    const memberIds = members.map((m) => m.id);
    const { method, participants } = expense.split;
    const byId = new Map(participants.map((p) => [p.personId, p] as const));
    const includedIds = memberIds.filter((id) => byId.has(id));

    const included: Record<string, boolean> = {};
    const pctMap: Record<string, string> = {};
    const amtMap: Record<string, string> = {};
    memberIds.forEach((id) => {
      included[id] = includedIds.includes(id);
      pctMap[id] = "0";
      amtMap[id] = "";
    });

    if (method === "exact") {
      includedIds.forEach((id) => {
        const value = byId.get(id)?.value ?? 0;
        amtMap[id] = formatMajor(value, expense.currency);
      });
      setDMode("amount");
    } else {
      const weights = includedIds.map((id) => {
        const p = byId.get(id);
        if (method === "equal") return 1;
        return p?.value ?? 0;
      });
      const pcts = percentSplitStrings(weights);
      includedIds.forEach((id, i) => {
        pctMap[id] = pcts[i];
      });
      setDMode("pct");
    }

    setEditingExpenseId(expense.id);
    setDDesc(expense.description);
    setDAmount(formatMajor(expense.amount, expense.currency));
    setDCur(expense.currency);
    setDPayer(expense.paidBy);
    setDPct(pctMap);
    setDAmt(amtMap);
    setDIncluded(included);
    setDCategory(expense.category);
    closeNewCategoryRow();
    setExpenseErrors([]);
    setExpenseModalOpen(true);
  };

  const includedMemberIds = (): string[] => members.filter((m) => dIncluded[m.id]).map((m) => m.id);

  const toggleIncluded = (id: string) => {
    const nowIncluded = !dIncluded[id];
    setDIncluded((prev) => ({ ...prev, [id]: nowIncluded }));
    if (!nowIncluded) {
      setDPct((prev) => ({ ...prev, [id]: "0" }));
      setDAmt((prev) => ({ ...prev, [id]: "" }));
    }
  };

  const setPctValue = (id: string, raw: string) => {
    // Anything finer than the percent grid is dropped as it is typed.
    const cleaned = raw.replace(/[^0-9.]/g, "").replace(PERCENT_INPUT_RE, "$1");
    setDPct((prev) => ({ ...prev, [id]: cleaned }));
  };

  const setAmtValue = (id: string, raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    setDAmt((prev) => ({ ...prev, [id]: cleaned }));
  };

  const handleEqualize = () => {
    const ids = includedMemberIds();
    if (ids.length === 0) return;
    if (dMode === "amount") {
      const totalMinor = toMinor(Number(dAmount) || 0, dCur);
      const shares = largestRemainder(totalMinor, ids.map(() => 1));
      setDAmt((prev) => {
        const next = { ...prev };
        ids.forEach((id, i) => {
          next[id] = formatMajor(shares[i], dCur);
        });
        return next;
      });
    } else {
      const pcts = percentSplitStrings(ids.map(() => 1));
      setDPct((prev) => {
        const next = { ...prev };
        ids.forEach((id, i) => {
          next[id] = pcts[i];
        });
        return next;
      });
    }
  };

  const handleSplitRemainder = () => {
    const totalMinor = toMinor(Number(dAmount) || 0, dCur);
    if (totalMinor <= 0) return;
    const ids = includedMemberIds();
    const filledIds = ids.filter((id) => Number(dAmt[id]) > 0);
    const emptyIds = ids.filter((id) => !(Number(dAmt[id]) > 0));
    if (emptyIds.length === 0) return;
    const usedMinor = filledIds.reduce((sum, id) => sum + toMinor(Number(dAmt[id]) || 0, dCur), 0);
    const remainingMinor = totalMinor - usedMinor;
    if (remainingMinor <= 0) return;
    const shares = largestRemainder(remainingMinor, emptyIds.map(() => 1));
    setDAmt((prev) => {
      const next = { ...prev };
      emptyIds.forEach((id, i) => {
        next[id] = formatMajor(shares[i], dCur);
      });
      return next;
    });
  };

  const dAmountNumber = Number(dAmount) || 0;
  const splitEntries = members
    .filter((m) => dIncluded[m.id])
    .map((m) => ({
      personId: m.id,
      value: dMode === "amount" ? Number(dAmt[m.id]) || 0 : Number(dPct[m.id]) || 0,
    }))
    .filter((entry) => entry.value > 0);
  const splitTotal = splitEntries.reduce((sum, e) => sum + e.value, 0);
  const splitValid =
    dAmountNumber > 0 &&
    splitEntries.length > 0 &&
    (dMode === "amount"
      ? Math.abs(splitTotal - dAmountNumber) < 0.01
      // Same tolerance the engine validates with, so a split the button
      // accepts can never be rejected on save.
      : Math.abs(splitTotal - 100) <= PERCENT_TOLERANCE);

  const convertHintText = (() => {
    if (dCur === baseCurrency) {
      return dAmountNumber > 0 ? "" : "請在上方輸入金額。";
    }
    if (dAmountNumber <= 0) {
      return `將換算成 ${baseCurrency} 用於結算。`;
    }
    const baseMinor = convert(toMinor(dAmountNumber, dCur), dCur, baseCurrency, rates);
    return `≈ ${formatMoney(baseMinor, baseCurrency)}(${baseCurrency})`;
  })();

  const pctTrailing = (pct: number): string => {
    if (!(dAmountNumber > 0) || pct <= 0) return "—";
    const minor = toMinor((dAmountNumber * pct) / 100, dCur);
    return formatMoney(minor, dCur);
  };

  const amtTrailing = (amt: number): string => {
    if (!(dAmountNumber > 0) || amt <= 0) return "—";
    return `${roundPercent((amt / dAmountNumber) * 100)}%`;
  };

  const handleSaveExpense = async () => {
    if (!splitValid) return;
    setExpenseErrors([]);

    const amountMinor = toMinor(dAmountNumber, dCur);
    const participants: SplitParticipant[] = splitEntries.map((e) => ({
      personId: e.personId,
      value: dMode === "amount" ? toMinor(e.value, dCur) : e.value,
    }));

    const icon = editingExpenseId
      ? expenses.find((e) => e.id === editingExpenseId)?.icon
      : ICONS[expenses.length % ICONS.length];

    // No `createdAt`: it is stamped once by addExpense, so editing an expense
    // leaves the original creation time (and therefore the ordering) intact.
    const candidate: Omit<Expense, "id" | "createdAt"> = {
      description: dDesc.trim() || "支出",
      amount: amountMinor,
      currency: dCur,
      icon,
      paidBy: dPayer,
      category: dCategory,
      split: {
        method: dMode === "amount" ? "exact" : "percent",
        participants,
      },
      createdBy: identity.personId,
    };

    const memberIds = members.map((m) => m.id);
    const existingCreatedAt = editingExpenseId
      ? expenses.find((e) => e.id === editingExpenseId)?.createdAt
      : undefined;
    const errors = validateExpense(
      { ...candidate, id: editingExpenseId ?? "draft", createdAt: existingCreatedAt ?? 0 },
      memberIds,
    );
    if (errors.length > 0) {
      setExpenseErrors(errors);
      return;
    }

    try {
      if (editingExpenseId) {
        await updateExpense(editingExpenseId, candidate);
      } else {
        await addExpense(candidate);
      }
      writeLastCurrency(groupId, dCur);
      setExpenseModalOpen(false);
    } catch (err) {
      setExpenseErrors([err instanceof Error ? err.message : "儲存失敗，請再試一次。"]);
    }
  };

  const handleDeleteExpense = async () => {
    if (!editingExpenseId) return;
    try {
      await deleteExpense(editingExpenseId);
      setExpenseModalOpen(false);
    } catch (err) {
      setExpenseErrors([err instanceof Error ? err.message : "刪除失敗，請再試一次。"]);
    }
  };

  // ---------- person modal handlers ----------

  const openAddPerson = () => {
    setEditingPersonId(null);
    setPName("");
    setPersonError(null);
    setPersonModalOpen(true);
  };

  const openEditPerson = (person: Person) => {
    setEditingPersonId(person.id);
    setPName(person.name);
    setPersonError(null);
    setPersonModalOpen(true);
  };

  const personInvolved = (id: string): boolean =>
    expenses.some((e) => e.paidBy === id || e.split.participants.some((p) => p.personId === id));

  const isSelf = editingPersonId !== null && editingPersonId === identity.personId;
  const involved = editingPersonId !== null && personInvolved(editingPersonId);
  const canRemovePerson = editingPersonId !== null && !isSelf && !involved;
  const removeBlockedMessage = isSelf
    ? "這是你本人 —— 無法把自己從行程中移除。"
    : involved
      ? "該成員已關聯到現有支出。請先重新指定付款人或刪除相關支出。"
      : null;

  const handleSavePerson = async () => {
    const name = pName.trim();
    if (!name) return;
    setPersonError(null);
    try {
      if (editingPersonId) {
        await updateMember(editingPersonId, { name });
      } else {
        await addMember(name);
      }
      setPersonModalOpen(false);
    } catch (err) {
      setPersonError(err instanceof Error ? err.message : "儲存失敗，請再試一次。");
    }
  };

  const handleRemovePerson = async () => {
    if (!editingPersonId || !canRemovePerson) return;
    try {
      await removeMember(editingPersonId);
      setPersonModalOpen(false);
    } catch (err) {
      setPersonError(err instanceof Error ? err.message : "移除失敗，請再試一次。");
    }
  };

  // ---------- settle handlers ----------

  const toggleSettled = (row: Settlement) => {
    void setSettled(row, !isSettled(row), identity.personId).catch((err: unknown) => {
      setSettleError(err instanceof Error ? err.message : "更新結算狀態失敗。");
    });
  };

  const resetSettled = () => {
    void Promise.all(
      settlement.filter(isSettled).map((row) => setSettled(row, false, identity.personId)),
    ).catch((err: unknown) => {
      setSettleError(err instanceof Error ? err.message : "重置結算狀態失敗。");
    });
  };

  return (
    <div className="tdt-page">
      <div className="tdt-phone">
        <div className="tdt-header">
          <div className="tdt-header-row">
            <div className="tdt-header-left">
              <div className="tdt-header-kicker tdt-mono">{baseCurrency} · 餘額</div>
              <div className="tdt-header-title">{group.name}</div>
            </div>
            <div className="tdt-header-right">
              <div className="tdt-header-total-label tdt-mono">總支出</div>
              <div className="tdt-header-total-value tdt-mono">
                {formatMoney(totalSpentMinor, baseCurrency)}
              </div>
            </div>
          </div>

          <div className="tdt-invite">
            <div className="tdt-invite-code">
              <span className="tdt-invite-label tdt-mono">房間代碼</span>
              <span className="tdt-invite-value tdt-mono">{groupId}</span>
            </div>
            <button type="button" className="tdt-invite-btn tdt-mono" onClick={handleCopyInvite}>
              {copied ? "已複製 ✓" : "複製邀請連結"}
            </button>
          </div>
          {copyFailed && (
            <input
              className="tdt-invite-fallback tdt-mono"
              readOnly
              value={inviteUrl}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>

        {error && <div className="tdt-error-banner">{error}</div>}

        <div className="tdt-body tdt-scroll">
          {view === "overview" && (
            <div className="tdt-overview">
              <div
                className={`tdt-mycard ${
                  myBalance.net > 0 ? "tdt-mycard--positive" : myBalance.net < 0 ? "tdt-mycard--negative" : ""
                }`}
              >
                <div className="tdt-mycard-label tdt-mono">你的帳目</div>
                <div className="tdt-mycard-amount-row">
                  <div
                    className={`tdt-mycard-amount tdt-mono ${
                      myBalance.net > 0
                        ? "tdt-mycard-amount--positive"
                        : myBalance.net < 0
                          ? "tdt-mycard-amount--negative"
                          : ""
                    }`}
                  >
                    {myBalance.net < 0 ? "−" : ""}
                    {formatMoney(Math.abs(myBalance.net), baseCurrency)}
                  </div>
                </div>
                <div className="tdt-mycard-sub">
                  {myBalance.net > 0 ? "你可收回" : myBalance.net < 0 ? "你需支付" : "已結清"}
                </div>
              </div>

              <div className="tdt-section">
                <div className="tdt-section-head">
                  <div className="tdt-section-title tdt-mono">所有人的餘額</div>
                  <div className="tdt-section-count tdt-mono">{members.length} 人</div>
                </div>
                {members.map((m) => {
                  const b = balances.find((bal) => bal.personId === m.id);
                  const net = b?.net ?? 0;
                  return (
                    <div className="tdt-row" key={m.id}>
                      <Avatar name={m.name} color={m.color} size="md" />
                      <div className="tdt-row-info">
                        <div className="tdt-row-name">{m.name}</div>
                        <div className="tdt-row-sub">
                          已付 {formatMoney(b?.paid ?? 0, baseCurrency)} · 分攤{" "}
                          {formatMoney(b?.owed ?? 0, baseCurrency)}
                        </div>
                      </div>
                      <div
                        className={`tdt-row-amount tdt-mono ${
                          net > 0 ? "tdt-row-amount--positive" : net < 0 ? "tdt-row-amount--negative" : ""
                        }`}
                      >
                        {net < 0 ? "−" : net > 0 ? "+" : ""}
                        {formatMoney(Math.abs(net), baseCurrency)}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="tdt-section">
                <div className="tdt-section-title tdt-mono">待結算</div>
                {settlement.length === 0 ? (
                  <div className="tdt-empty-gold">✓ 大家已經兩清,沒有欠款。</div>
                ) : (
                  <div className="tdt-settle-preview-list">
                    {settlement.slice(0, 3).map((s, i) => (
                      <div className="tdt-settle-preview-row" key={`${s.from}-${s.to}-${i}`}>
                        <span className="tdt-name-strong">{nameOf(s.from)}</span>
                        <span className="tdt-arrow">→</span>
                        <span className="tdt-name-strong tdt-name-strong--grow">{nameOf(s.to)}</span>
                        <span className="tdt-mono-strong tdt-mono">{formatMoney(s.amount, baseCurrency)}</span>
                      </div>
                    ))}
                    <button type="button" className="tdt-btn-outline-gold" onClick={() => setView("settle")}>
                      前往結算 →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {view === "activity" && (
            <div className="tdt-view">
              <div className="tdt-section-head">
                <div className="tdt-section-title tdt-mono">帳目 · {expenses.length} 筆支出</div>
              </div>
              {expenses.length === 0 ? (
                <div className="tdt-empty-gray">
                  還沒有任何支出。
                  <br />
                  點擊 + 新增第一筆。
                </div>
              ) : (
                <div className="tdt-activity-list">
                  {expenses.map((e) => {
                    const baseMinor = convert(e.amount, e.currency, baseCurrency, rates);
                    const cat = categoryOf(e.category);
                    return (
                      <div
                        className="tdt-row tdt-row--clickable"
                        key={e.id}
                        onClick={() => openEditExpense(e)}
                      >
                        <div className="tdt-icon-box">{e.icon ?? "💸"}</div>
                        <div className="tdt-row-info">
                          <div className="tdt-row-name">{e.description}</div>
                          <div className="tdt-row-sub">
                            {cat ? `${cat.icon} ${cat.label} · ` : ""}
                            {nameOf(e.paidBy)} 付款 · {e.split.participants.length} 人分攤
                          </div>
                        </div>
                        <div className="tdt-activity-amounts">
                          <div className="tdt-activity-amount tdt-mono">
                            {formatMoney(e.amount, e.currency)}
                          </div>
                          {e.currency !== baseCurrency && (
                            <div className="tdt-activity-amount-base tdt-mono">
                              ≈ {formatMoney(baseMinor, baseCurrency)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {view === "categories" && (
            <div className="tdt-view">
              <div className="tdt-section-head">
                <div className="tdt-section-title tdt-mono">各分類支出</div>
                <div className="tdt-section-count tdt-mono">
                  {formatMoney(totalSpentMinor, baseCurrency)}
                </div>
              </div>

              {categoryTotals.length === 0 ? (
                <div className="tdt-empty-gray">
                  還沒有任何支出。
                  <br />
                  記一筆並選個分類,這裡就會列出行程花費的去向。
                </div>
              ) : (
                <div className="tdt-cat-list">
                  {categoryTotals.map((row) => (
                    <div className="tdt-cat-row" key={row.category.id}>
                      <div className="tdt-cat-row-head">
                        <div className="tdt-icon-box">{row.category.icon}</div>
                        <div className="tdt-row-info">
                          <div className="tdt-row-name">{row.category.label}</div>
                          <div className="tdt-row-sub">{row.count} 筆支出</div>
                        </div>
                        <div className="tdt-activity-amounts">
                          <div className="tdt-activity-amount tdt-mono">
                            {formatMoney(row.total, baseCurrency)}
                          </div>
                          <div className="tdt-activity-amount-base tdt-mono">
                            {roundPercent(row.share)}%
                          </div>
                        </div>
                      </div>
                      <div className="tdt-cat-bar">
                        <div
                          className="tdt-cat-bar-fill"
                          style={{ width: `${row.share}%` }}
                          role="presentation"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="tdt-section-head">
                <div className="tdt-section-title tdt-mono">管理分類</div>
                <div className="tdt-section-count tdt-mono">{categories.length} 項</div>
              </div>
              <div className="tdt-cat-manage-list">
                {categories.map((c) => (
                  <div className="tdt-row" key={c.id}>
                    <div className="tdt-icon-box">{c.icon}</div>
                    <div className="tdt-row-info">
                      <div className="tdt-row-name">{c.label}</div>
                      <div className="tdt-row-sub">
                        {expenses.filter((e) => e.category === c.id).length} 筆支出
                      </div>
                    </div>
                    <button
                      type="button"
                      className="tdt-btn-ghost-sm"
                      onClick={() => openRenameCategory(c)}
                    >
                      編輯
                    </button>
                  </div>
                ))}
              </div>

              {newCatOpen ? (
                <div className="tdt-cat-manage-editor">
                  {categoryEditor}
                  {editingCategoryId && (
                    <button
                      type="button"
                      className="tdt-btn-danger-outline tdt-cat-delete"
                      onClick={() => void handleDeleteCategory(editingCategoryId)}
                    >
                      刪除此分類
                    </button>
                  )}
                  <div className="tdt-hint tdt-cat-hint">
                    刪除分類不會動到支出本身,原本歸在這裡的支出會變成「未分類」。
                  </div>
                </div>
              ) : (
                <button type="button" className="tdt-btn-dashed-gold" onClick={openNewCategoryRow}>
                  + 新增分類
                </button>
              )}
              {categoryError && <div className="tdt-error-banner">{categoryError}</div>}
            </div>
          )}

          {view === "people" && (
            <div className="tdt-view">
              <div className="tdt-section-title tdt-mono">行程成員 · {members.length}</div>
              <div className="tdt-people-list">
                {members.map((m) => {
                  const b = balances.find((bal) => bal.personId === m.id);
                  return (
                    <div className="tdt-row" key={m.id}>
                      <Avatar name={m.name} color={m.color} size="md" />
                      <div className="tdt-row-info">
                        <div className="tdt-row-name">
                          {m.name}
                          {m.id === identity.personId ? "（你）" : ""}
                        </div>
                        <div className="tdt-row-sub">已付 {formatMoney(b?.paid ?? 0, baseCurrency)}</div>
                      </div>
                      <button type="button" className="tdt-btn-ghost-sm" onClick={() => openEditPerson(m)}>
                        編輯
                      </button>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="tdt-btn-dashed-gold" onClick={openAddPerson}>
                + 新增成員
              </button>
              <button type="button" className="tdt-btn-outline-gray" onClick={onNavigateOnboard}>
                ＋ 建立新的行程
              </button>
            </div>
          )}

          {view === "settle" && (
            <div className="tdt-view tdt-view--settle">
              <div className="tdt-settle-head">
                <div className="tdt-section-title tdt-mono">結算</div>
              </div>

              {settleError && <div className="tdt-error-banner">{settleError}</div>}

              {settlement.length === 0 || settlement.every(isSettled) ? (
                <div className="tdt-celebrate">
                  <div className="tdt-celebrate-emoji">🎉</div>
                  <div className="tdt-celebrate-title">已全部結清!</div>
                  <div className="tdt-celebrate-sub">本次行程的所有欠款都已清償。</div>
                </div>
              ) : null}

              {settlement.length > 0 && (
                <div className="tdt-settle-list">
                  {settlement.map((s, i) => {
                    const skey = settlementKey(s);
                    const done = isSettled(s);
                    const fromMember = members.find((m) => m.id === s.from);
                    return (
                      <div
                        className={`tdt-settle-row ${done ? "tdt-settle-row--done" : ""}`}
                        key={`${skey}-${i}`}
                      >
                        <div className="tdt-settle-row-top">
                          <Avatar name={fromMember?.name ?? "?"} color={fromMember?.color} size="sm" />
                          <div className="tdt-settle-row-text">
                            <span className="tdt-name-strong">{nameOf(s.from)}</span>
                            {" 付給 "}
                            <span className="tdt-name-strong">{nameOf(s.to)}</span>
                          </div>
                          <div className="tdt-settle-row-amount tdt-mono">
                            {formatMoney(s.amount, baseCurrency)}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`tdt-settle-toggle ${!done ? "tdt-settle-toggle--active" : ""}`}
                          onClick={() => toggleSettled(s)}
                        >
                          {done ? "已結清" : "標記已結清"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {settlement.some(isSettled) && (
                <button type="button" className="tdt-settle-reset" onClick={resetSettled}>
                  重置結算狀態
                </button>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className="tdt-fab"
          aria-label="新增支出"
          onClick={openAddExpense}
        >
          +
        </button>

        <div className="tdt-nav">
          {NAV_ITEMS.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`tdt-nav-btn ${view === n.key ? "tdt-nav-btn--active" : ""}`}
              onClick={() => setView(n.key)}
            >
              <span className="tdt-nav-icon">{n.icon}</span>
              <span className="tdt-nav-label tdt-mono">{n.label}</span>
            </button>
          ))}
        </div>

        {expenseModalOpen && (
          <div className="tdt-modal-overlay-wrap">
            <button
              type="button"
              className="tdt-backdrop"
              aria-label="關閉"
              onClick={() => setExpenseModalOpen(false)}
            />
            <div className="tdt-sheet tdt-scroll">
              <div className="tdt-sheet-head">
                <div className="tdt-sheet-title">{editingExpenseId ? "編輯支出" : "新增支出"}</div>
                <button type="button" className="tdt-close-btn" onClick={() => setExpenseModalOpen(false)}>
                  ×
                </button>
              </div>
              <div className="tdt-sheet-body">
                <label className="tdt-field">
                  <span className="tdt-field-label tdt-mono">說明</span>
                  <input
                    className="tdt-input"
                    value={dDesc}
                    onChange={(e) => setDDesc(e.target.value)}
                    placeholder="例如:海鮮晚餐"
                  />
                </label>

                <div className="tdt-form-row">
                  <label className="tdt-field tdt-field--grow">
                    <span className="tdt-field-label tdt-mono">金額</span>
                    <input
                      className="tdt-input"
                      value={dAmount}
                      onChange={(e) => setDAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      inputMode="decimal"
                      placeholder="0.00"
                    />
                  </label>
                  <label className="tdt-field tdt-field--currency">
                    <span className="tdt-field-label tdt-mono">幣種</span>
                    <select
                      className="tdt-select"
                      value={dCur}
                      onChange={(e) => setDCur(e.target.value as CurrencyCode)}
                    >
                      {CURRENCY_CODES.map((code) => (
                        <option key={code} value={code}>
                          {CURRENCIES[code].short}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {convertHintText && <div className="tdt-hint">{convertHintText}</div>}

                <label className="tdt-field">
                  <span className="tdt-field-label tdt-mono">付款人</span>
                  <select className="tdt-select" value={dPayer} onChange={(e) => setDPayer(e.target.value)}>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="tdt-catpick">
                  <span className="tdt-field-label tdt-mono">分類</span>
                  <div className="tdt-cat-chips">
                    {categories.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`tdt-cat-chip ${
                          dCategory === c.id ? "tdt-cat-chip--active" : ""
                        }`}
                        // Tapping the selected chip clears it — an expense is
                        // allowed to have no category.
                        onClick={() => setDCategory(dCategory === c.id ? undefined : c.id)}
                      >
                        <span aria-hidden>{c.icon}</span>
                        {c.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="tdt-cat-chip tdt-cat-chip--add"
                      onClick={openNewCategoryRow}
                    >
                      ＋ 新增分類
                    </button>
                  </div>
                  {newCatOpen && categoryEditor}
                  {categoryError && <div className="tdt-error-text">{categoryError}</div>}
                </div>

                <div className="tdt-split">
                  <div className="tdt-split-head">
                    <span className="tdt-field-label tdt-mono">分帳方式</span>
                    <div className="tdt-chip-group">
                      {dMode === "amount" && dAmountNumber > 0 && (
                        <button type="button" className="tdt-chip-btn" onClick={handleSplitRemainder}>
                          剩下平分
                        </button>
                      )}
                      <button type="button" className="tdt-chip-btn" onClick={handleEqualize}>
                        平均分
                      </button>
                    </div>
                  </div>
                  <div className="tdt-segmented">
                    <button
                      type="button"
                      className={`tdt-segmented-btn ${dMode === "pct" ? "tdt-segmented-btn--active" : ""}`}
                      onClick={() => setDMode("pct")}
                    >
                      按百分比
                    </button>
                    <button
                      type="button"
                      className={`tdt-segmented-btn ${dMode === "amount" ? "tdt-segmented-btn--active" : ""}`}
                      onClick={() => setDMode("amount")}
                    >
                      按金額
                    </button>
                  </div>
                  <div className="tdt-split-rows">
                    {members.map((m) => {
                      const included = Boolean(dIncluded[m.id]);
                      const pct = Number(dPct[m.id]) || 0;
                      const amt = Number(dAmt[m.id]) || 0;
                      return (
                        <div
                          className={`tdt-split-row ${included ? "tdt-split-row--included" : ""}`}
                          key={m.id}
                        >
                          <button
                            type="button"
                            className={`tdt-check ${included ? "tdt-check--checked" : ""}`}
                            onClick={() => toggleIncluded(m.id)}
                          >
                            {included ? "✓" : ""}
                          </button>
                          <Avatar name={m.name} color={m.color} size="xs" />
                          <div className="tdt-split-row-name">{m.name}</div>
                          <span className="tdt-split-row-unit tdt-mono">
                            {dMode === "amount" ? CURRENCIES[dCur].symbol : "%"}
                          </span>
                          <input
                            className="tdt-split-row-input tdt-mono"
                            value={dMode === "amount" ? dAmt[m.id] ?? "" : dPct[m.id] ?? "0"}
                            onChange={(e) =>
                              dMode === "amount"
                                ? setAmtValue(m.id, e.target.value)
                                : setPctValue(m.id, e.target.value)
                            }
                            disabled={!included}
                            inputMode="decimal"
                          />
                          <span className="tdt-split-row-trailing tdt-mono">
                            {dMode === "amount" ? amtTrailing(amt) : pctTrailing(pct)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="tdt-split-total">
                    <span className="tdt-split-total-label tdt-mono">
                      {dMode === "amount" ? "合計 / 應為" : "合計"}
                    </span>
                    <span
                      className={`tdt-split-total-value tdt-mono ${
                        splitValid ? "tdt-split-total-value--valid" : ""
                      }`}
                    >
                      {dMode === "amount"
                        ? `${formatMoney(toMinor(splitTotal, dCur), dCur)} / ${formatMoney(
                            toMinor(dAmountNumber, dCur),
                            dCur,
                          )}${splitValid ? " ✓" : ""}`
                        : `${roundPercent(splitTotal)}%${splitValid ? " ✓" : ""}`}
                    </span>
                  </div>
                </div>

                {expenseErrors.length > 0 && (
                  <ul className="tdt-error-text">
                    {expenseErrors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                )}

                <div className="tdt-modal-actions">
                  {editingExpenseId && (
                    <button type="button" className="tdt-btn-danger-outline" onClick={handleDeleteExpense}>
                      刪除
                    </button>
                  )}
                  <button
                    type="button"
                    className="tdt-btn-primary"
                    disabled={!splitValid}
                    onClick={handleSaveExpense}
                  >
                    {editingExpenseId ? "儲存修改" : "新增支出"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {personModalOpen && (
          <div className="tdt-modal-overlay-wrap tdt-modal-overlay-wrap--center">
            <button
              type="button"
              className="tdt-backdrop"
              aria-label="關閉"
              onClick={() => setPersonModalOpen(false)}
            />
            <div className="tdt-person-card">
              <div className="tdt-sheet-head">
                <div className="tdt-sheet-title">{editingPersonId ? "編輯成員" : "新增成員"}</div>
                <button type="button" className="tdt-close-btn" onClick={() => setPersonModalOpen(false)}>
                  ×
                </button>
              </div>
              <label className="tdt-field">
                <span className="tdt-field-label tdt-mono">姓名</span>
                <input
                  className="tdt-input"
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                  placeholder="成員姓名"
                />
              </label>
              <div className="tdt-person-actions">
                {editingPersonId && canRemovePerson && (
                  <button type="button" className="tdt-btn-danger-outline" onClick={handleRemovePerson}>
                    移除
                  </button>
                )}
                <button
                  type="button"
                  className="tdt-btn-primary"
                  disabled={!pName.trim()}
                  onClick={handleSavePerson}
                >
                  儲存
                </button>
              </div>
              {personError && <p className="tdt-error-text">{personError}</p>}
              {removeBlockedMessage && <div className="tdt-warning-text">{removeBlockedMessage}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
