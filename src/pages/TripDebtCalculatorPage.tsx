import { Fragment, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type {
  Category,
  CurrencyCode,
  Expense,
  Person,
  Settlement,
  SplitItem,
  SplitParticipant,
} from "../features/expense-divider/engine";
import {
  CURRENCIES,
  CURRENCY_CODES,
  PERCENT_TOLERANCE,
  clampPercentInput,
  computeOwed,
  convert,
  formatMoney,
  fromMinor,
  isEvenPercentSplit,
  itemizedOwed,
  itemizedParticipants,
  largestRemainder,
  newCategoryId,
  percentSplitStrings,
  roundPercent,
  toMinor,
  validateExpense,
} from "../features/expense-divider/engine";
import { CATEGORY_ICONS } from "../features/expense-divider/constants";
import { avatarChar, groupByDay } from "../features/expense-divider/display";
import {
  firebaseReady,
  onAccountChange,
  receiptScanReady,
  signInWithGoogle,
  signOutAccount,
  type AccountInfo,
} from "../features/expense-divider/firebase/config";
import {
  readingToDraft,
  type ReceiptDraft,
  type ReceiptQuestion,
} from "../features/expense-divider/receipt/draft";
import { ReceiptScanError } from "../features/expense-divider/receipt/errors";
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
import { Icon } from "../components/Icon";
import { categoryLook, isBuiltInCategory, type IconName } from "../components/icons";
import {
  Avatars,
  Box,
  Buddy,
  BuddyToggle,
  CategoryMark,
  CategoryTile,
  type BuddyFace,
} from "../components/Sticker";
import "../styles/sticker.css";

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

/** Minor units -> a clean decimal string for prefilling a text input. */
function formatMajor(minor: number, code: CurrencyCode): string {
  return fromMinor(minor, code).toFixed(CURRENCIES[code].decimals);
}

/** A balance with its sign spelled out: "+NT$860", "−NT$1,240". Never a bare "-". */
function signedMoney(minor: number, code: CurrencyCode): string {
  const abs = formatMoney(Math.abs(minor), code);
  return minor > 0 ? `+${abs}` : minor < 0 ? `−${abs}` : abs;
}

function balanceKind(net: number): "owed" | "owe" | "zero" {
  return net > 0 ? "owed" : net < 0 ? "owe" : "zero";
}

const BALANCE_WORD = { owed: "應收", owe: "應付", zero: "已結清" } as const;

function clock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Strip a typed amount down to digits and one dot. */
function cleanAmount(raw: string): string {
  return raw.replace(/[^0-9.]/g, "").replace(/^(\d*\.?\d*).*$/, "$1");
}

/** As `cleanAmount`, keeping a leading minus: a 依項目 line may be a discount. */
function cleanLineAmount(raw: string): string {
  const negative = /^\s*[-−]/.test(raw);
  return (negative ? "-" : "") + cleanAmount(raw);
}

/** A scan's open question. A line question follows its line by React key, which survives edits. */
type SheetQuestion =
  | Exclude<ReceiptQuestion, { kind: "line" }>
  | (Extract<ReceiptQuestion, { kind: "line" }> & { lineKey: number });

/** Set once this device has seen what 拍收據 does with the photo. */
const RECEIPT_NOTICE_KEY = "trip-debt:receipt-notice-seen";

function receiptNoticeSeen(): boolean {
  try {
    return localStorage.getItem(RECEIPT_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

function markReceiptNoticeSeen(): void {
  try {
    localStorage.setItem(RECEIPT_NOTICE_KEY, "1");
  } catch {
    // Storage blocked: the notice just shows again next time.
  }
}

type ViewName = "overview" | "activity" | "categories" | "people" | "settle";

const VIEWS: { key: ViewName; label: string }[] = [
  { key: "overview", label: "餘額" },
  { key: "activity", label: "帳目" },
  { key: "categories", label: "分類" },
  { key: "people", label: "旅伴" },
  { key: "settle", label: "結算" },
];

/**
 * The sheet's 怎麼分. `items` and `amount` both save as "exact" (items with its
 * lines alongside); `pct` saves as "percent", or "equal" when left even.
 */
type SplitMode = "equal" | "items" | "amount" | "pct";

const SPLIT_MODES: { key: SplitMode; label: string }[] = [
  { key: "equal", label: "平分" },
  { key: "items", label: "依項目" },
  { key: "amount", label: "指定金額" },
  { key: "pct", label: "比例" },
];

/** A 依項目 line while it is being typed; `key` is only for React. */
interface DraftItem {
  key: number;
  label: string;
  amount: string;
  personIds: string[];
}

// ============================================================================
// Page frame + notices
// ============================================================================

/**
 * The brand goes to the trip list (`/new`), as 行程表's does. A bare `/` would
 * not: it resumes the last trip, so from inside a trip it goes nowhere.
 */
const Frame = ({
  meta,
  action,
  children,
}: {
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <div className="ts-page">
    <header className="ts-nav">
      <div className="ts-wrap ts-nav__inner">
        <Link to={`/${ONBOARD_SEGMENT}`} className="ts-brand" title="所有行程">
          旅行分帳
        </Link>
        {(meta || action) && (
          <div className="ts-nav__end">
            {meta && <span className="ts-nav__meta">{meta}</span>}
            {action}
          </div>
        )}
      </div>
    </header>
    <main className="ts-wrap ts-main">{children}</main>
  </div>
);

const Notice = ({
  icon = "buddy",
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) => (
  <Frame>
    <div className="ts-box ts-sticker ts-empty" role="status">
      <Icon name={icon} size={48} />
      <div className="ts-empty__title">{title}</div>
      {children}
    </div>
  </Frame>
);

// ============================================================================
// Top-level route component
// ============================================================================

export const TripDebtCalculatorPage = () => {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();

  if (!firebaseReady) {
    return (
      <Notice title="還沒設定好">
        <p className="ts-body">記帳功能還沒設定完成，晚點再來看看。</p>
      </Notice>
    );
  }

  // `/new` is the escape hatch (used by "開一趟新行程"), not a room code: it
  // forces the onboard screen instead of resuming. Room codes are always 6
  // uppercase alphanumerics (`generateRoomCode`), so "new" can never collide
  // with a real one.
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
      onNewTrip={() => navigate(`/${ONBOARD_SEGMENT}`, { state: CREATE_INTENT })}
    />
  );
};

/**
 * Router state for "開一趟新行程": the onboard screen then puts the create form
 * above the trip list and focuses it. Without it `/new` is the trip list first,
 * which is what the brand link wants.
 */
const CREATE_INTENT = { intent: "create" } as const;

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
  const location = useLocation();
  const wantsCreate =
    (location.state as { intent?: string } | null)?.intent === CREATE_INTENT.intent;
  const tripNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wantsCreate) tripNameRef.current?.focus();
  }, [wantsCreate]);

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
        setAuthError(err instanceof Error ? err.message : "登入失敗，再試一次看看。");
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
      setCreateError(err instanceof Error ? err.message : "建立行程失敗，再試一次看看。");
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
      setJoinError(err instanceof Error ? err.message : "加入失敗，確認一下房間代碼。");
    } finally {
      setJoining(false);
    }
  };

  const signedIn = account !== null && !account.anonymous;

  const pastTripsBox = pastTrips && pastTrips.length > 0 && (
    <Box label="你的行程" icon="buddy" labelId="past-trips">
      <div className="ts-stack ts-stack--tight">
        {pastTrips.map((trip) => (
          <button
            key={trip.code}
            type="button"
            className="ts-link ts-soft"
            onClick={() => onNavigate(trip.code)}
          >
            <span className="ts-link__main">
              <span className="ts-link__title">{trip.name}</span>
              <span className="ts-small">
                {trip.baseCurrency ? `${trip.baseCurrency} 結算 · ` : ""}房間{" "}
                <span className="ts-num">{trip.code}</span>
              </span>
            </span>
            <span className="ts-arrow" aria-hidden>
              →
            </span>
          </button>
        ))}
      </div>
    </Box>
  );

  return (
    <Frame meta={signedIn ? (account.name ?? account.email) : undefined}>
      <div className="ts-hero">
        <h1 className="ts-h1">一起記帳，回家一鍵結清</h1>
        <p className="ts-body">誰付了什麼、誰該給誰多少，旅伴打開同一個連結就看得到。</p>
      </div>

      <div className="ts-sections">
        <div className="ts-stack ts-stack--tight">
          <div className="ts-row ts-row--between">
            <p className="ts-help">
              {signedIn
                ? "已登入，行程會跟著帳號走。"
                : "行程只記在這台裝置上。用 Google 登入，換手機也找得到。"}
            </p>
            {signedIn ? (
              <button
                type="button"
                className="ts-btn ts-btn--text"
                onClick={handleSignOut}
                disabled={authBusy}
              >
                登出
              </button>
            ) : (
              <button
                type="button"
                className="ts-btn ts-btn--sm ts-sticker"
                onClick={handleSignIn}
                disabled={authBusy}
              >
                {authBusy ? "登入中…" : "用 Google 登入"}
              </button>
            )}
          </div>
          {authError && <p className="ts-error">{authError}</p>}
        </div>

        {!wantsCreate && pastTripsBox}

        <Box label="開一趟新行程" icon="coin" labelId="create-trip">
          <form className="ts-stack" onSubmit={handleCreate}>
            <label className="ts-field">
              <span className="ts-field__name">行程名稱</span>
              <input
                ref={tripNameRef}
                className="ts-input ts-soft"
                value={obTrip}
                onChange={(e) => setObTrip(e.target.value)}
                placeholder="例如：首爾・釜山 9 天"
              />
            </label>
            <label className="ts-field">
              <span className="ts-field__name">最後用哪個幣別結算</span>
              <select
                className="ts-select ts-soft"
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
            <label className="ts-field">
              <span className="ts-field__name">你的名字</span>
              <input
                className="ts-input ts-soft"
                value={obMe}
                onChange={(e) => setObMe(e.target.value)}
                placeholder="旅伴會看到這個名字"
              />
            </label>
            {createError && <p className="ts-error">{createError}</p>}
            <div className="ts-row ts-row--end">
              <button type="submit" className="ts-btn ts-btn--primary ts-sticker" disabled={creating}>
                {creating ? "建立中…" : "開始記帳"}
              </button>
            </div>
          </form>
        </Box>

        {wantsCreate && pastTripsBox}

        <Box label="用房間代碼加入" icon="buddy" labelId="join-trip">
          <form className="ts-stack" onSubmit={handleJoin}>
            <label className="ts-field">
              <span className="ts-field__name">房間代碼</span>
              <input
                className="ts-input ts-input--code ts-soft"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="6 碼，例如 AB12CD"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="ts-field">
              <span className="ts-field__name">你的名字</span>
              <input
                className="ts-input ts-soft"
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                placeholder="旅伴會看到這個名字"
              />
            </label>
            {joinError && <p className="ts-error">{joinError}</p>}
            <div className="ts-row ts-row--end">
              <button type="submit" className="ts-btn ts-sticker" disabled={joining}>
                {joining ? "加入中…" : "加入行程"}
              </button>
            </div>
          </form>
        </Box>
      </div>
    </Frame>
  );
};

// ============================================================================
// App shell: header + 餘額/帳目/分類/旅伴/結算 + 記一筆 + sheets
// ============================================================================

const AppScreen = ({
  groupId,
  onNavigateOnboard,
  onNewTrip,
}: {
  groupId: string;
  onNavigateOnboard: () => void;
  onNewTrip: () => void;
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
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const dayTabsRef = useRef<HTMLDivElement>(null);

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

  // expense sheet
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [dDesc, setDDesc] = useState("");
  const [dAmount, setDAmount] = useState("");
  const [dCur, setDCur] = useState<CurrencyCode>(() => readLastCurrency(groupId) ?? baseCurrency);
  const [dPayer, setDPayer] = useState("");
  const [dMode, setDMode] = useState<SplitMode>("equal");
  const [dPct, setDPct] = useState<Record<string, string>>({});
  const [dAmt, setDAmt] = useState<Record<string, string>>({});
  const [dIncluded, setDIncluded] = useState<Record<string, boolean>>({});
  const [dItems, setDItems] = useState<DraftItem[]>([]);
  const nextItemKey = useRef(0);
  const [dCategory, setDCategory] = useState<string | undefined>(undefined);
  const [expenseErrors, setExpenseErrors] = useState<string[]>([]);

  // 拍收據 inside the sheet. `sheetSession` changes every time the sheet opens,
  // so a scan that finishes after the sheet was closed or reopened is dropped
  // instead of filling a different draft.
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<SheetQuestion[]>([]);
  const [receiptNoticeOpen, setReceiptNoticeOpen] = useState(false);
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const sheetSession = useRef(0);

  // Inline "new category" row inside the expense sheet, and the rename/add
  // editor on the 分類 view. Both write through `updateCategories`.
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [newCatLabel, setNewCatLabel] = useState("");
  const [newCatIcon, setNewCatIcon] = useState(CATEGORY_ICONS[0]);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  // person dialog
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

  // Escape closes whichever sheet is open.
  useEffect(() => {
    if (!expenseModalOpen && !personModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setExpenseModalOpen(false);
      setPersonModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expenseModalOpen, personModalOpen]);

  // Day tabs run oldest → newest like the schedule's; start scrolled to the
  // newest, which is the one being added to.
  useEffect(() => {
    if (view !== "activity") return;
    const tabs = dayTabsRef.current;
    if (tabs) tabs.scrollLeft = tabs.scrollWidth;
  }, [view, expenses.length]);

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
    return <Notice title="載入中…" />;
  }

  if (!group && error) {
    return (
      <Notice title="連線失敗">
        <p className="ts-body">這趟行程載入不了，檢查一下網路再試。</p>
        <p className="ts-error">{error}</p>
        <button
          type="button"
          className="ts-btn ts-btn--primary ts-sticker"
          onClick={() => window.location.reload()}
        >
          重試
        </button>
      </Notice>
    );
  }

  if (!group) {
    return (
      <Notice title="找不到這趟行程">
        <p className="ts-body">房間代碼可能打錯了，或這趟行程已經不在了。</p>
        <button type="button" className="ts-btn ts-btn--primary ts-sticker" onClick={onNavigateOnboard}>
          重新輸入代碼
        </button>
      </Notice>
    );
  }

  const tripName = group.name || "我的行程";

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
        setJoinError(err instanceof Error ? err.message : "加入失敗，再試一次看看。");
      } finally {
        setJoining(false);
      }
    };

    return (
      <Frame>
        <div className="ts-hero">
          <h1 className="ts-h1">加入「{tripName}」</h1>
          <p className="ts-body">
            {members.length > 0
              ? `${members.map((m) => m.name).join("、")} 已經在這趟行程裡了。`
              : "填上名字就能一起記帳。"}
          </p>
        </div>
        <Box label="你是誰？" icon="buddy" labelId="join-here">
          <form className="ts-stack" onSubmit={handleJoinHere}>
            <label className="ts-field">
              <span className="ts-field__name">你的名字</span>
              <input
                className="ts-input ts-soft"
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                placeholder="旅伴會看到這個名字"
                autoFocus
              />
            </label>
            {joinError && <p className="ts-error">{joinError}</p>}
            <div className="ts-row ts-row--end">
              <button type="submit" className="ts-btn ts-btn--primary ts-sticker" disabled={joining}>
                {joining ? "加入中…" : "加入行程"}
              </button>
            </div>
          </form>
        </Box>
      </Frame>
    );
  }

  // ---- from here on `identity`, `group` are narrowed non-null ----

  const me = identity.personId;
  const nameOf = (id: string): string => members.find((m) => m.id === id)?.name ?? "?";

  /** How a buddy appears on this device: the device's own one reads 你. */
  const faceOf = (id: string): BuddyFace => {
    if (id === me) return { name: "你", char: "你" };
    const name = nameOf(id);
    return { name, char: avatarChar(name) };
  };

  const myBalance =
    balances.find((b) => b.personId === me) ??
    ({ personId: me, paid: 0, owed: 0, net: 0 } as const);

  const totalSpentMinor = expenses.reduce(
    (sum, e) => sum + convert(e.amount, e.currency, baseCurrency, rates),
    0,
  );

  const categoryOf = (id: string | undefined): Category | undefined =>
    id === undefined ? undefined : categories.find((c) => c.id === id);

  // ---------- category handlers ----------

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
      setCategoryError(err instanceof Error ? err.message : "分類沒存成功，再試一次看看。");
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
      setCategoryError(err instanceof Error ? err.message : "分類沒刪成功，再試一次看看。");
    }
  };

  // Shared by the expense sheet and the 分類 view — only one of the two can be
  // open at a time, since both drive the same `newCat*` state. A seeded
  // category's sticker icon is fixed, so only a group's own gets the picker.
  const pickingIcon = editingCategoryId === null || !isBuiltInCategory(editingCategoryId);
  const categoryEditor = (
    <div className="ts-inline-edit ts-soft">
      {pickingIcon && (
        <div className="ts-iconpick" role="group" aria-label="分類圖示">
          {CATEGORY_ICONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="ts-soft"
              aria-label={`圖示 ${emoji}`}
              aria-pressed={newCatIcon === emoji}
              onClick={() => setNewCatIcon(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      <label className="ts-field">
        <span className="ts-field__name">分類名稱</span>
        <input
          className="ts-input ts-soft"
          value={newCatLabel}
          onChange={(e) => setNewCatLabel(e.target.value)}
          placeholder="例如：門票"
          maxLength={12}
        />
      </label>
      {categoryError && <p className="ts-error">{categoryError}</p>}
      <div className="ts-actions">
        {editingCategoryId ? (
          <button
            type="button"
            className="ts-btn ts-btn--text"
            onClick={() => void handleDeleteCategory(editingCategoryId)}
          >
            刪除這個分類
          </button>
        ) : (
          <span />
        )}
        <div className="ts-row">
          <button type="button" className="ts-btn ts-btn--sm ts-sticker" onClick={closeNewCategoryRow}>
            取消
          </button>
          <button
            type="button"
            className="ts-btn ts-btn--sm ts-sticker"
            disabled={!newCatLabel.trim()}
            onClick={() => void handleSaveCategory()}
          >
            {editingCategoryId ? "儲存" : "新增"}
          </button>
        </div>
      </div>
      {editingCategoryId && (
        <p className="ts-help">刪掉分類不會動到支出，原本在這裡的會變成「未分類」。</p>
      )}
    </div>
  );

  // ---------- expense sheet: draft state ----------

  const memberIds = members.map((m) => m.id);
  const includedIds = memberIds.filter((id) => dIncluded[id]);

  const newDraftItem = (personIds: string[]): DraftItem => ({
    key: nextItemKey.current++,
    label: "",
    amount: "",
    personIds,
  });

  const evenPct = (ids: string[]): Record<string, string> => {
    const pcts = percentSplitStrings(ids.map(() => 1));
    return Object.fromEntries(ids.map((id, i) => [id, pcts[i]]));
  };

  const resetScan = () => {
    sheetSession.current += 1;
    setScanning(false);
    setScanError(null);
    setQuestions([]);
    setReceiptNoticeOpen(false);
  };

  const openAddExpense = () => {
    resetScan();
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
    setDPayer(me);
    setDMode("equal");
    setDIncluded(Object.fromEntries(memberIds.map((id) => [id, true])));
    setDPct(evenPct(memberIds));
    setDAmt({});
    setDItems([newDraftItem(memberIds)]);
    setDCategory(undefined);
    closeNewCategoryRow();
    setExpenseErrors([]);
    setExpenseModalOpen(true);
  };

  const openEditExpense = (expense: Expense) => {
    const { method, participants, items } = expense.split;
    const byId = new Map(participants.map((p) => [p.personId, p] as const));
    const inSplit = memberIds.filter((id) => byId.has(id));

    const included = Object.fromEntries(memberIds.map((id) => [id, inSplit.includes(id)]));
    let pctMap: Record<string, string> = evenPct(inSplit);
    const amtMap: Record<string, string> = {};
    let mode: SplitMode;

    if (method === "exact" && items) {
      mode = "items";
    } else if (method === "exact") {
      inSplit.forEach((id) => {
        amtMap[id] = formatMajor(byId.get(id)?.value ?? 0, expense.currency);
      });
      mode = "amount";
    } else if (method === "equal") {
      mode = "equal";
    } else {
      // percent, and "shares" from older data, both open as 比例.
      const pcts = percentSplitStrings(inSplit.map((id) => byId.get(id)?.value ?? 0));
      pctMap = Object.fromEntries(inSplit.map((id, i) => [id, pcts[i]]));
      mode = "pct";
    }

    resetScan();
    setEditingExpenseId(expense.id);
    setDDesc(expense.description);
    setDAmount(formatMajor(expense.amount, expense.currency));
    setDCur(expense.currency);
    setDPayer(expense.paidBy);
    setDMode(mode);
    setDIncluded(included);
    setDPct(pctMap);
    setDAmt(amtMap);
    setDItems(
      items
        ? items.map((item) => ({
            ...newDraftItem(memberIds.filter((id) => item.personIds.includes(id))),
            label: item.label,
            amount: formatMajor(item.amount, expense.currency),
          }))
        : [newDraftItem(memberIds)],
    );
    setDCategory(expense.category);
    closeNewCategoryRow();
    setExpenseErrors([]);
    setExpenseModalOpen(true);
  };

  const changeMode = (mode: SplitMode) => {
    // 比例 with nothing typed in yet starts from an even split, not from zeros.
    if (mode === "pct" && includedIds.every((id) => !(Number(dPct[id]) > 0))) {
      setDPct(evenPct(includedIds));
    }
    setDMode(mode);
  };

  const toggleIncluded = (id: string) => {
    const nowIncluded = !dIncluded[id];
    setDIncluded((prev) => ({ ...prev, [id]: nowIncluded }));
    if (dMode === "pct") {
      // Percentages still at the even split follow the new head count; ones
      // the person typed themselves are left alone.
      const wasEven = isEvenPercentSplit(includedIds.map((pid) => Number(dPct[pid])));
      const nextIds = memberIds.filter((pid) => (pid === id ? nowIncluded : dIncluded[pid]));
      if (wasEven) {
        setDPct(evenPct(nextIds));
        return;
      }
    }
    if (!nowIncluded) {
      setDPct((prev) => ({ ...prev, [id]: "0" }));
      setDAmt((prev) => ({ ...prev, [id]: "" }));
    }
  };

  const setPctValue = (id: string, raw: string) => {
    setDPct((prev) => ({ ...prev, [id]: clampPercentInput(raw) }));
  };

  const setAmtValue = (id: string, raw: string) => {
    setDAmt((prev) => ({ ...prev, [id]: cleanAmount(raw) }));
  };

  const handleEvenPct = () => {
    if (includedIds.length > 0) setDPct(evenPct(includedIds));
  };

  const handleSplitRemainder = () => {
    const totalMinor = toMinor(Number(dAmount) || 0, dCur);
    if (totalMinor <= 0) return;
    const filledIds = includedIds.filter((id) => Number(dAmt[id]) > 0);
    const emptyIds = includedIds.filter((id) => !(Number(dAmt[id]) > 0));
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

  const patchItem = (key: number, patch: Partial<Omit<DraftItem, "key">>) => {
    setDItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const toggleItemPerson = (key: number, id: string) => {
    setDItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const has = item.personIds.includes(id);
        // Kept in member order, so the stored line reads the same everywhere.
        const next = memberIds.filter((pid) => (pid === id ? !has : item.personIds.includes(pid)));
        return { ...item, personIds: next };
      }),
    );
  };

  // ---------- expense sheet: 拍收據 ----------

  const resolveQuestions = (match: (q: SheetQuestion) => boolean) => {
    setQuestions((prev) => (prev.some(match) ? prev.filter((q) => !match(q)) : prev));
  };

  const startScan = () => {
    if (!receiptNoticeSeen()) {
      setReceiptNoticeOpen(true);
      return;
    }
    receiptInputRef.current?.click();
  };

  // Clicking the hidden input inside this handler keeps it a user gesture, which
  // mobile browsers require before they open the camera or photo picker.
  const confirmReceiptNotice = () => {
    markReceiptNoticeSeen();
    setReceiptNoticeOpen(false);
    receiptInputRef.current?.click();
  };

  const applyReceiptDraft = (draft: ReceiptDraft) => {
    const lines = draft.lines.map((line) => ({
      ...newDraftItem(line.personIds),
      label: line.label,
      amount: line.amount,
    }));
    setDDesc(draft.description);
    setDAmount(draft.amount);
    setDCur(draft.currency);
    setDCategory(draft.category);
    setDMode(draft.mode);
    setDIncluded(Object.fromEntries(memberIds.map((id) => [id, true])));
    setDItems(lines.length > 0 ? lines : [newDraftItem(memberIds)]);
    setQuestions(
      draft.questions.map((q) => (q.kind === "line" ? { ...q, lineKey: lines[q.line].key } : q)),
    );
  };

  const handleReceiptFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // so picking the same photo again still fires
    if (!file) return;

    const session = sheetSession.current;
    setScanning(true);
    setScanError(null);
    setQuestions([]);
    try {
      const [{ prepareImage }, { readReceipt }] = await Promise.all([
        import("../features/expense-divider/receipt/image"),
        import("../features/expense-divider/receipt/scan"),
      ]);
      const reading = await readReceipt(await prepareImage(file), {
        categories: categories.map((c) => ({ id: c.id, label: c.label })),
        recentCurrencies: [dCur, ...expenses.map((x) => x.currency).reverse()].filter(
          (code, i, all) => all.indexOf(code) === i,
        ),
      });
      if (session !== sheetSession.current) return;
      const result = readingToDraft(reading, {
        categoryIds: categories.map((c) => c.id),
        memberIds,
        fallbackCurrency: dCur,
      });
      if (result.ok) {
        applyReceiptDraft(result.draft);
      } else {
        setScanError(result.reason);
      }
    } catch (err) {
      if (session !== sheetSession.current) return;
      setScanError(
        err instanceof ReceiptScanError
          ? err.message
          : navigator.onLine
            ? "讀收據失敗，先手動填吧。"
            : "沒有網路，先手動填吧。",
      );
    } finally {
      if (session === sheetSession.current) setScanning(false);
    }
  };

  /** The answers a question offers, each applied to the draft before the question closes. */
  const questionChoices = (q: SheetQuestion): { label: string; pick: () => void }[] => {
    switch (q.kind) {
      case "currency":
        return q.options.map((o) => ({ label: o.label, pick: () => setDCur(o.currency) }));
      case "total":
        return q.options.map((o) => ({ label: o.label, pick: () => setDAmount(o.amount) }));
      case "line":
        return q.options.map((o) => ({
          label: o.label,
          pick: () => patchItem(q.lineKey, { amount: o.amount }),
        }));
      case "doubt":
        return [];
    }
  };

  const questionCard = (q: SheetQuestion) => (
    <div className="ts-ask ts-soft" key={q.id} role="group" aria-label={q.prompt}>
      <p className="ts-ask__q">{q.prompt}</p>
      <div className="ts-ask__opts">
        {questionChoices(q).map((choice) => (
          <button
            key={choice.label}
            type="button"
            className="ts-chip ts-soft"
            onClick={() => {
              choice.pick();
              resolveQuestions((open) => open.id === q.id);
            }}
          >
            {choice.label}
          </button>
        ))}
        <button
          type="button"
          className="ts-btn ts-btn--text"
          onClick={() => resolveQuestions((open) => open.id === q.id)}
        >
          {q.kind === "doubt" ? "知道了" : "我自己改"}
        </button>
      </div>
    </div>
  );

  // ---------- expense sheet: what the draft adds up to ----------

  const dAmountNumber = Number(dAmount) || 0;
  const amountMinor = toMinor(dAmountNumber, dCur);
  const symbol = CURRENCIES[dCur].symbol;

  const splitEntries = members
    .filter((m) => dIncluded[m.id])
    .map((m) => ({
      personId: m.id,
      value: dMode === "amount" ? Number(dAmt[m.id]) || 0 : Number(dPct[m.id]) || 0,
    }))
    .filter((entry) => entry.value > 0);

  const pctTotal = dMode === "pct" ? splitEntries.reduce((sum, e) => sum + e.value, 0) : 0;
  const amtTotalMinor =
    dMode === "amount" ? splitEntries.reduce((sum, e) => sum + toMinor(e.value, dCur), 0) : 0;

  // A line nobody has touched is ignored; one half filled in is a problem.
  const touchedItems = dItems.filter((item) => item.label.trim() !== "" || item.amount !== "");
  const itemProblem = (() => {
    for (const item of dItems) {
      if (!touchedItems.includes(item)) continue;
      const n = dItems.indexOf(item) + 1;
      if (toMinor(Number(item.amount) || 0, dCur) === 0) return `第 ${n} 項還沒填金額。`;
      if (item.personIds.length === 0) return `第 ${n} 項還沒選誰要分。`;
    }
    return touchedItems.length === 0 ? "至少要有一項。" : null;
  })();
  const draftItems: SplitItem[] = touchedItems.map((item) => ({
    label: item.label.trim(),
    amount: toMinor(Number(item.amount) || 0, dCur),
    personIds: item.personIds,
  }));
  const itemsTotalMinor = draftItems.reduce((sum, item) => sum + item.amount, 0);

  // A discount line can push someone below zero; the engine would reject that
  // on save, so say it in words while there is still something to fix.
  const itemsIssue =
    itemProblem ??
    (() => {
      const owed = itemizedOwed(draftItems, dPayer);
      const below = memberIds.find((id) => (owed[id] ?? 0) < 0);
      return below === undefined
        ? null
        : `${faceOf(below).name}分到的變成負的，折扣要分給有點東西的人。`;
    })();

  // Questions from a scan. A line question only counts while its lines are in
  // use, and only while its line still exists.
  const openQuestions = questions.filter(
    (q) => q.kind !== "line" || (dMode === "items" && dItems.some((item) => item.key === q.lineKey)),
  );

  /** What is left to hand out, in the mode's own unit: minor units, or percentage points. */
  const remaining =
    dMode === "pct"
      ? roundPercent(100 - pctTotal)
      : dMode === "amount"
        ? amountMinor - amtTotalMinor
        : dMode === "items"
          ? amountMinor - itemsTotalMinor
          : 0;
  // Same tolerance the engine validates percentages with, so a split the
  // button accepts can never be rejected on save.
  const remainderClear = dMode === "pct" ? Math.abs(remaining) <= PERCENT_TOLERANCE : remaining === 0;

  const splitValid =
    amountMinor > 0 &&
    (dMode === "equal"
      ? includedIds.length > 0
      : dMode === "items"
        ? itemsIssue === null && remainderClear
        : splitEntries.length > 0 && remainderClear);

  const canSave = splitValid && openQuestions.length === 0;

  const convertHintText = (() => {
    if (dCur === baseCurrency || amountMinor <= 0) return "";
    const baseMinor = convert(amountMinor, dCur, baseCurrency, rates);
    return `約 ${formatMoney(baseMinor, baseCurrency)}，結算時換算成 ${baseCurrency}。`;
  })();

  /**
   * How a 比例 draft will be stored. An untouched even split becomes "equal"
   * rather than the percentages it generated: both total the same, but "equal"
   * divides the money directly instead of dividing a ratio that was rounded
   * onto the percent grid first, so the worst gap between two people drops
   * from one grid step OF THE EXPENSE to one minor unit — NT$1.00 to NT$0.01
   * on a NT$10,000 bill, and it stops scaling with the amount. Percentages keep
   * their own path because 1/3 has no exact form on any decimal grid.
   */
  const pctMethod = isEvenPercentSplit(splitEntries.map((e) => e.value)) ? "equal" : "percent";

  // Per-row 比例 preview, distributed exactly the way the engine will on save —
  // otherwise an even split previews the percent-derived NT$3,334.00 and then
  // stores NT$3,333.34.
  const pctPreview = ((): Record<string, number> => {
    if (dMode !== "pct" || !(amountMinor > 0) || splitEntries.length === 0) return {};
    const weights =
      pctMethod === "equal" ? splitEntries.map(() => 1) : splitEntries.map((e) => e.value);
    const shares = largestRemainder(amountMinor, weights);
    return Object.fromEntries(splitEntries.map((e, i) => [e.personId, shares[i]]));
  })();

  const shareHint = (id: string): string => {
    if (dMode === "pct") {
      const minor = pctPreview[id];
      return minor === undefined ? "" : formatMoney(minor, dCur);
    }
    const amt = Number(dAmt[id]) || 0;
    if (!(dAmountNumber > 0) || amt <= 0) return "";
    return `${roundPercent((amt / dAmountNumber) * 100)}%`;
  };

  const equalHint = (() => {
    if (includedIds.length === 0) return "至少選一個人。";
    if (!(amountMinor > 0)) return `${includedIds.length} 人平分。`;
    const shares = largestRemainder(amountMinor, includedIds.map(() => 1));
    const lo = Math.min(...shares);
    const hi = Math.max(...shares);
    const each =
      lo === hi ? formatMoney(lo, dCur) : `${formatMoney(lo, dCur)}～${formatMoney(hi, dCur)}`;
    return `${includedIds.length} 人平分，每人 ${each}。`;
  })();

  const itemsSummary = (() => {
    // Discount lines are negative and count too, or the summary overstates everyone's share.
    const ready = draftItems.filter((item) => item.amount !== 0 && item.personIds.length > 0);
    if (ready.length === 0) return "";
    const owed = itemizedOwed(ready, dPayer);
    return memberIds
      .filter((id) => owed[id] !== undefined)
      .map((id) => `${faceOf(id).name} ${formatMoney(owed[id], dCur)}`)
      .join(" · ");
  })();

  const remainderText = (() => {
    const abs = Math.abs(remaining);
    const amount = dMode === "pct" ? `${roundPercent(abs)}%` : formatMoney(abs, dCur);
    return remaining > 0 ? { word: "還有錢沒分配", amount } : { word: "分太多了", amount };
  })();

  const handleSaveExpense = async () => {
    if (!canSave) return;
    setExpenseErrors([]);

    let split: Expense["split"];
    if (dMode === "equal") {
      split = { method: "equal", participants: includedIds.map((personId) => ({ personId })) };
    } else if (dMode === "items") {
      split = {
        method: "exact",
        participants: itemizedParticipants(draftItems, dPayer),
        items: draftItems,
      };
    } else if (dMode === "amount") {
      split = {
        method: "exact",
        participants: splitEntries.map((e) => ({ personId: e.personId, value: toMinor(e.value, dCur) })),
      };
    } else {
      // "equal" ignores `value` entirely, and Firestore rejects an explicit
      // undefined inside the nested split object — so omit the key outright.
      const participants: SplitParticipant[] = splitEntries.map((e) =>
        pctMethod === "equal" ? { personId: e.personId } : { personId: e.personId, value: e.value },
      );
      split = { method: pctMethod, participants };
    }

    const existing = editingExpenseId ? expenses.find((e) => e.id === editingExpenseId) : undefined;

    // No `createdAt`: it is stamped once by addExpense, so editing an expense
    // leaves the original creation time (and therefore the ordering) intact.
    // `icon` is only carried over from an old expense, never assigned anew.
    const candidate: Omit<Expense, "id" | "createdAt"> = {
      description: dDesc.trim() || "支出",
      amount: amountMinor,
      currency: dCur,
      icon: existing?.icon,
      paidBy: dPayer,
      category: dCategory,
      split,
      createdBy: existing?.createdBy ?? me,
    };

    const errors = validateExpense(
      { ...candidate, id: editingExpenseId ?? "draft", createdAt: existing?.createdAt ?? 0 },
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
      setExpenseErrors([err instanceof Error ? err.message : "沒存成功，再試一次看看。"]);
    }
  };

  const handleDeleteExpense = async () => {
    if (!editingExpenseId) return;
    try {
      await deleteExpense(editingExpenseId);
      setExpenseModalOpen(false);
    } catch (err) {
      setExpenseErrors([err instanceof Error ? err.message : "沒刪成功，再試一次看看。"]);
    }
  };

  // ---------- person dialog ----------

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

  const isSelf = editingPersonId !== null && editingPersonId === me;
  const involved = editingPersonId !== null && personInvolved(editingPersonId);
  const canRemovePerson = editingPersonId !== null && !isSelf && !involved;
  const removeBlockedMessage = isSelf
    ? "這是你自己，沒辦法把自己移出行程。"
    : involved
      ? "這位旅伴已經在某些支出裡了。先改掉付款人或刪掉那幾筆，才能移除。"
      : null;

  const handleSavePerson = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
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
      setPersonError(err instanceof Error ? err.message : "沒存成功，再試一次看看。");
    }
  };

  const handleRemovePerson = async () => {
    if (!editingPersonId || !canRemovePerson) return;
    try {
      await removeMember(editingPersonId);
      setPersonModalOpen(false);
    } catch (err) {
      setPersonError(err instanceof Error ? err.message : "沒移除成功，再試一次看看。");
    }
  };

  // ---------- settle ----------

  const toggleSettled = (row: Settlement) => {
    void setSettled(row, !isSettled(row), me).catch((err: unknown) => {
      setSettleError(err instanceof Error ? err.message : "結算狀態沒更新成功。");
    });
  };

  const resetSettled = () => {
    void Promise.all(settlement.filter(isSettled).map((row) => setSettled(row, false, me))).catch(
      (err: unknown) => {
        setSettleError(err instanceof Error ? err.message : "結算狀態沒重置成功。");
      },
    );
  };

  /** 「₩100 = NT$2.38、¥100 = NT$21.60」 for every other currency this trip spent in. */
  const rateLine = (() => {
    const used = CURRENCY_CODES.filter(
      (code) => code !== baseCurrency && expenses.some((e) => e.currency === code),
    );
    if (used.length === 0) return "";
    return used
      .map((code) => {
        const unit = toMinor(CURRENCIES[code].decimals === 0 ? 100 : 1, code);
        return `${formatMoney(unit, code)} = ${formatMoney(convert(unit, code, baseCurrency, rates), baseCurrency)}`;
      })
      .join("、");
  })();

  // ---------- pieces used on more than one view ----------

  const shareBox = (message: string) => (
    <Box label="分享" icon="buddy" labelId="share-box">
      <div className="ts-stack">
        <p className="ts-body">{message}</p>
        <div className="ts-row ts-row--between">
          <div>
            <div className="ts-small">房間代碼</div>
            <div className="ts-code">{groupId}</div>
          </div>
          <button type="button" className="ts-btn ts-sticker" onClick={handleCopyInvite}>
            {copied ? "已複製！" : "分享連結"}
          </button>
        </div>
        {copyFailed && (
          <>
            <p className="ts-help">沒辦法自動複製，請手動複製下面的連結。</p>
            <input
              className="ts-input ts-input--num ts-soft"
              readOnly
              value={inviteUrl}
              aria-label="邀請連結"
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )}
      </div>
    </Box>
  );

  const transferFlow = (s: Settlement) => (
    <div className="ts-xfer__flow">
      <Buddy face={faceOf(s.from)} />
      <span className="ts-arrow" aria-label="給">
        →
      </span>
      <Buddy face={faceOf(s.to)} />
    </div>
  );

  const expenseRow = (e: Expense) => {
    const owedMap = computeOwed(e);
    const mine = owedMap[me] ?? 0;
    const category = categoryOf(e.category);

    let share: ReactNode;
    if (e.paidBy === me) {
      const others = e.amount - mine;
      share =
        others > 0 ? (
          <span className="ts-expense__share ts-amount--owed">應收 +{formatMoney(others, e.currency)}</span>
        ) : (
          <span className="ts-expense__share ts-expense__share--none">你自己的</span>
        );
    } else if (mine > 0) {
      share = (
        <span className="ts-expense__share ts-amount--owe">你欠 {formatMoney(mine, e.currency)}</span>
      );
    } else {
      share = <span className="ts-expense__share ts-expense__share--none">沒有你的份</span>;
    }

    return (
      <button
        key={e.id}
        type="button"
        className="ts-expense ts-sticker"
        onClick={() => openEditExpense(e)}
      >
        <CategoryTile category={category} labelled />
        <span className="ts-expense__title">{e.description}</span>
        <span className="ts-expense__right">
          <span className="ts-amount">{formatMoney(e.amount, e.currency)}</span>
        </span>
        <span className="ts-expense__sub">
          {/* Two halves that wrap as wholes: who paid and who shares, then when and what in base. */}
          <span className="ts-expense__part">
            {faceOf(e.paidBy).name}付
            {e.split.items ? (
              <span>· 依項目</span>
            ) : (
              <Avatars faces={e.split.participants.map((p) => faceOf(p.personId))} />
            )}
          </span>
          <span className="ts-expense__part ts-num">
            {clock(e.createdAt)}
            {e.currency !== baseCurrency &&
              ` · ≈ ${formatMoney(convert(e.amount, e.currency, baseCurrency, rates), baseCurrency)}`}
          </span>
        </span>
        <span className="ts-expense__right">{share}</span>
      </button>
    );
  };

  // ---------- views ----------

  const myKind = balanceKind(myBalance.net);
  const overview = (
    <div className="ts-sections">
      <div className="ts-stats">
        <div className="ts-stat ts-stat--wide ts-sticker">
          <div className="ts-money">
            <Icon name="coin" size={48} alt="旅費" />
            <div>
              <div className="ts-amount ts-amount--lg">{formatMoney(totalSpentMinor, baseCurrency)}</div>
              <div className="ts-stat__sub">
                已花 · {expenses.length} 筆
                {members.length > 1 &&
                  ` · 每人約 ${formatMoney(Math.round(totalSpentMinor / members.length), baseCurrency)}`}
              </div>
            </div>
          </div>
        </div>
        <div className="ts-stat ts-sticker">
          <div className={`ts-stat__num ts-amount--${myKind}`}>{signedMoney(myBalance.net, baseCurrency)}</div>
          <div className="ts-stat__sub">
            {myKind === "owed" ? "大家欠你" : myKind === "owe" ? "你欠大家" : "你已結清"}
          </div>
        </div>
        <div className="ts-stat ts-sticker">
          <div className="ts-stat__num">{members.length} 位</div>
          <div className="ts-stat__sub">{members.map((m) => faceOf(m.id).name).join(" · ")}</div>
        </div>
      </div>

      {members.length <= 1 && shareBox("現在只有你一個人。把連結傳給旅伴，大家就能一起記帳。")}

      <Box label="目前餘額" icon="coin" aside={baseCurrency} labelId="balances">
        {[...members]
          .sort((a, b) => {
            const na = balances.find((x) => x.personId === a.id)?.net ?? 0;
            const nb = balances.find((x) => x.personId === b.id)?.net ?? 0;
            return nb - na;
          })
          .map((m) => {
            const net = balances.find((b) => b.personId === m.id)?.net ?? 0;
            const kind = balanceKind(net);
            return (
              <div className="ts-bal" key={m.id}>
                <Buddy face={faceOf(m.id)} />
                <span className="ts-bal__right">
                  <span className={`ts-pill ts-pill--${kind} ts-soft`}>{BALANCE_WORD[kind]}</span>
                  <span className={`ts-amount ts-amount--${kind}`}>{signedMoney(net, baseCurrency)}</span>
                </span>
              </div>
            );
          })}
      </Box>

      <Box
        label="結算"
        icon="check"
        aside={settlement.length > 0 ? `${settlement.length} 筆轉帳` : undefined}
        labelId="settle-preview"
      >
        {settlement.length === 0 ? (
          <p className="ts-help">
            {expenses.length === 0
              ? "記了支出之後，這裡會算出誰該給誰多少。"
              : "大家都兩清了，沒有要轉的錢。"}
          </p>
        ) : (
          <div className="ts-stack">
            {settlement.slice(0, 3).map((s, i) => (
              <div
                className={`ts-xfer ts-xfer--preview ts-soft ${isSettled(s) ? "ts-xfer--done" : ""}`}
                key={`${settlementKey(s)}-${i}`}
              >
                {transferFlow(s)}
                <span className="ts-amount">{formatMoney(s.amount, baseCurrency)}</span>
              </div>
            ))}
            <div className="ts-row ts-row--end">
              <button type="button" className="ts-btn ts-sticker" onClick={() => setView("settle")}>
                看全部結算 →
              </button>
            </div>
          </div>
        )}
      </Box>
    </div>
  );

  const days = groupByDay(expenses);
  const shownDay = days.find((d) => d.key === dayFilter) ?? null;
  const dayName = (d: (typeof days)[number]) => (d.isToday ? "今天" : `DAY ${d.dayNumber}`);

  const activity =
    expenses.length === 0 ? (
      <div className="ts-box ts-sticker ts-empty">
        <Icon name="buddy" size={48} />
        <div className="ts-empty__title">還沒有支出</div>
        <p className="ts-body">按右下角的「記一筆」，來記第一筆吧。</p>
      </div>
    ) : (
      <>
        <div className="ts-tabs" role="tablist" aria-label="依日期看" ref={dayTabsRef}>
          <button
            type="button"
            role="tab"
            className="ts-tab ts-sticker"
            aria-selected={shownDay === null}
            onClick={() => setDayFilter(null)}
          >
            <span className="ts-tab__day">全部</span>
            <span className="ts-tab__date">{expenses.length}</span>
            <span className="ts-tab__count">筆</span>
          </button>
          {days.map((d) => (
            <button
              key={d.key}
              type="button"
              role="tab"
              className="ts-tab ts-sticker"
              aria-selected={shownDay?.key === d.key}
              onClick={() => setDayFilter(d.key)}
            >
              <span className="ts-tab__day">{dayName(d)}</span>
              <span className="ts-tab__date">{d.label}</span>
              <span className="ts-tab__count">{d.expenses.length} 筆</span>
            </button>
          ))}
        </div>
        <div className="ts-stack">
          {shownDay
            ? shownDay.expenses.map(expenseRow)
            : days.map((d) => (
                <Fragment key={d.key}>
                  <h2 className="ts-dayhead">
                    {dayName(d)}
                    <span className="ts-dayhead__date">{d.label}</span>
                  </h2>
                  {d.expenses.map(expenseRow)}
                </Fragment>
              ))}
        </div>
      </>
    );

  const categoriesView = (
    <div className="ts-sections">
      <Box label="錢花去哪了" icon="coin" aside={formatMoney(totalSpentMinor, baseCurrency)} labelId="cat-totals">
        {categoryTotals.length === 0 ? (
          <p className="ts-help">記一筆並選個分類，這裡就會列出錢花去哪了。</p>
        ) : (
          <div className="ts-stack ts-stack--tight">
            {categoryTotals.map((row) => (
              <div className="ts-catrow" key={row.category.id}>
                <CategoryTile category={row.category} />
                <span className="ts-catrow__name">
                  {row.category.label}
                  <span className="ts-small">
                    {" "}
                    · {row.count} 筆 · {roundPercent(row.share)}%
                  </span>
                </span>
                <span className="ts-amount">{formatMoney(row.total, baseCurrency)}</span>
                <div className="ts-bar" role="presentation">
                  <i
                    className={`ts-fill--${categoryLook(row.category).fill}`}
                    style={{ width: `${row.share}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Box>

      <Box label="管理分類" aside={`${categories.length} 個`} labelId="cat-manage">
        <div className="ts-stack">
          <div>
            {categories.map((c) => (
              <div className="ts-bal" key={c.id}>
                <span className="ts-row">
                  <CategoryTile category={c} />
                  <span className="ts-bal__info">
                    <span>{c.label}</span>
                    <span className="ts-small">{expenses.filter((e) => e.category === c.id).length} 筆</span>
                  </span>
                </span>
                <button
                  type="button"
                  className="ts-btn ts-btn--sm ts-sticker"
                  onClick={() => openRenameCategory(c)}
                >
                  編輯
                </button>
              </div>
            ))}
          </div>
          {newCatOpen ? (
            categoryEditor
          ) : (
            <div className="ts-row">
              <button type="button" className="ts-btn ts-sticker" onClick={openNewCategoryRow}>
                新增分類
              </button>
            </div>
          )}
        </div>
      </Box>
    </div>
  );

  const people = (
    <div className="ts-sections">
      {shareBox("拿到這個連結的人都能加入這趟行程。")}
      <Box label="旅伴" icon="buddy" aside={`${members.length} 位`} labelId="people">
        <div className="ts-stack">
          <div>
            {members.map((m) => {
              const b = balances.find((bal) => bal.personId === m.id);
              return (
                <div className="ts-bal" key={m.id}>
                  <span className="ts-bal__info">
                    <span className="ts-row ts-row--tight">
                      <Buddy face={{ name: m.name, char: avatarChar(m.name) }} />
                      {m.id === me && <span className="ts-badge">你</span>}
                    </span>
                    <span className="ts-small">
                      已付 {formatMoney(b?.paid ?? 0, baseCurrency)} · 分攤{" "}
                      {formatMoney(b?.owed ?? 0, baseCurrency)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="ts-btn ts-btn--sm ts-sticker"
                    onClick={() => openEditPerson(m)}
                  >
                    編輯
                  </button>
                </div>
              );
            })}
          </div>
          <div className="ts-row">
            <button type="button" className="ts-btn ts-sticker" onClick={openAddPerson}>
              新增旅伴
            </button>
          </div>
        </div>
      </Box>
      <div className="ts-row ts-row--end">
        <button type="button" className="ts-btn ts-btn--text" onClick={onNewTrip}>
          開一趟新行程
        </button>
      </div>
    </div>
  );

  const allSettled = settlement.every(isSettled);
  const settle = (
    <div className="ts-sections">
      {settleError && (
        <div className="ts-notice" role="alert">
          {settleError}
        </div>
      )}
      {allSettled && (
        <div className="ts-box ts-sticker ts-empty">
          <Icon name="check" size={48} />
          <div className="ts-empty__title">
            {expenses.length === 0 ? "還沒有要結的帳" : "全部結清囉！"}
          </div>
          <p className="ts-body">
            {expenses.length === 0
              ? "記了支出之後，這裡會列出最少要轉幾筆錢。"
              : "這趟行程的錢都算清楚了。"}
          </p>
        </div>
      )}
      {settlement.length > 0 && (
        <Box label={`結算 · 只要 ${settlement.length} 筆轉帳`} icon="coin" labelId="settle">
          <div className="ts-stack">
            {settlement.map((s, i) => {
              const done = isSettled(s);
              const amount = formatMoney(s.amount, baseCurrency);
              return (
                <div className={`ts-xfer ts-soft ${done ? "ts-xfer--done" : ""}`} key={`${settlementKey(s)}-${i}`}>
                  <button
                    type="button"
                    className="ts-tick ts-soft"
                    role="checkbox"
                    aria-checked={done}
                    aria-label={`${faceOf(s.from).name}給${faceOf(s.to).name} ${amount}，已付`}
                    onClick={() => toggleSettled(s)}
                  >
                    {done && <Icon name="check" />}
                  </button>
                  {transferFlow(s)}
                  <span className="ts-amount">{amount}</span>
                </div>
              );
            })}
            <p className="ts-help">付完就打勾，所有旅伴都會看到。</p>
            {rateLine && <p className="ts-help">匯率：{rateLine}</p>}
            {settlement.some(isSettled) && (
              <div>
                <button type="button" className="ts-btn ts-btn--text" onClick={resetSettled}>
                  全部改回未付
                </button>
              </div>
            )}
          </div>
        </Box>
      )}
    </div>
  );

  const views: Record<ViewName, ReactNode> = {
    overview,
    activity,
    categories: categoriesView,
    people,
    settle,
  };

  // ---------- expense sheet: the 怎麼分 body for each mode ----------

  const splitBody =
    dMode === "equal" ? (
      <div className="ts-stack ts-stack--tight">
        <div className="ts-row ts-row--tight" role="group" aria-label="誰要分">
          {members.map((m) => (
            <BuddyToggle
              key={m.id}
              face={faceOf(m.id)}
              pressed={Boolean(dIncluded[m.id])}
              onClick={() => toggleIncluded(m.id)}
            />
          ))}
        </div>
        <p className="ts-help">{equalHint}</p>
      </div>
    ) : dMode === "items" ? (
      <div className="ts-lines">
        {dItems.map((item, i) => (
          <Fragment key={item.key}>
            <div className="ts-line ts-soft">
              <input
                className="ts-input ts-soft"
                value={item.label}
                onChange={(e) => patchItem(item.key, { label: e.target.value })}
                placeholder={i === 0 ? "例如：韓牛套餐" : `第 ${i + 1} 項`}
                aria-label={`第 ${i + 1} 項是什麼`}
              />
              <span className="ts-share__input">
                <span className="ts-share__unit">{symbol}</span>
                <input
                  className="ts-input ts-input--num ts-soft"
                  value={item.amount}
                  onChange={(e) => {
                    patchItem(item.key, { amount: cleanLineAmount(e.target.value) });
                    resolveQuestions((q) => q.kind === "line" && q.lineKey === item.key);
                  }}
                  inputMode="decimal"
                  placeholder="0"
                  aria-label={`第 ${i + 1} 項金額`}
                />
              </span>
              <button
                type="button"
                className="ts-line__remove ts-soft"
                aria-label={`刪掉第 ${i + 1} 項`}
                disabled={dItems.length === 1}
                onClick={() => {
                  setDItems((prev) => prev.filter((x) => x.key !== item.key));
                  resolveQuestions((q) => q.kind === "line" && q.lineKey === item.key);
                }}
              >
                ×
              </button>
              <div className="ts-line__who" role="group" aria-label={`第 ${i + 1} 項誰要分`}>
                {members.map((m) => (
                  <BuddyToggle
                    key={m.id}
                    face={faceOf(m.id)}
                    pressed={item.personIds.includes(m.id)}
                    onClick={() => toggleItemPerson(item.key, m.id)}
                  />
                ))}
              </div>
            </div>
            {openQuestions
              .filter((q) => q.kind === "line" && q.lineKey === item.key)
              .map(questionCard)}
          </Fragment>
        ))}
        <div className="ts-row">
          <button
            type="button"
            className="ts-btn ts-btn--sm ts-sticker"
            onClick={() => setDItems((prev) => [...prev, newDraftItem(memberIds)])}
          >
            加一項
          </button>
        </div>
        {itemsSummary && <p className="ts-help">算下來：{itemsSummary}</p>}
      </div>
    ) : (
      <div className="ts-lines">
        {members.map((m) => {
          const included = Boolean(dIncluded[m.id]);
          const face = faceOf(m.id);
          return (
            <div className="ts-share" key={m.id}>
              <span>
                <BuddyToggle face={face} pressed={included} onClick={() => toggleIncluded(m.id)} />
              </span>
              <span className="ts-share__input">
                <span className="ts-share__unit">{dMode === "amount" ? symbol : "%"}</span>
                <input
                  className="ts-input ts-input--num ts-soft"
                  value={dMode === "amount" ? (dAmt[m.id] ?? "") : (dPct[m.id] ?? "0")}
                  onChange={(e) =>
                    dMode === "amount" ? setAmtValue(m.id, e.target.value) : setPctValue(m.id, e.target.value)
                  }
                  disabled={!included}
                  inputMode="decimal"
                  aria-label={`${face.name}的${dMode === "amount" ? "金額" : "比例"}`}
                />
              </span>
              {included && <span className="ts-share__hint">{shareHint(m.id)}</span>}
            </div>
          );
        })}
        <div className="ts-row">
          {dMode === "pct" ? (
            <button type="button" className="ts-btn ts-btn--sm ts-sticker" onClick={handleEvenPct}>
              先平均分
            </button>
          ) : (
            amountMinor > 0 && (
              <button type="button" className="ts-btn ts-btn--sm ts-sticker" onClick={handleSplitRemainder}>
                剩下平分
              </button>
            )
          )}
        </div>
      </div>
    );

  const currentView = VIEWS.find((v) => v.key === view) ?? VIEWS[0];

  return (
    <Frame
      meta={
        <>
          房間 <span className="ts-nav__code">{groupId}</span>
        </>
      }
      action={
        <button type="button" className="ts-btn ts-btn--sm ts-sticker" onClick={onNewTrip}>
          ＋ 新行程
        </button>
      }
    >
      <div className="ts-hero">
        <h1 className="ts-h1">{tripName}</h1>
        <p className="ts-small">
          {baseCurrency} 結算 · {members.length} 位旅伴
        </p>
      </div>

      <nav className="ts-viewbar" aria-label="分頁">
        <div className="ts-chips" role="tablist">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              id={`view-tab-${v.key}`}
              type="button"
              role="tab"
              className="ts-chip ts-chip--plain ts-soft"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </nav>

      {error && (
        <div className="ts-notice" role="alert">
          {error}
        </div>
      )}

      <div role="tabpanel" aria-labelledby={`view-tab-${currentView.key}`}>
        {views[view]}
      </div>

      <button type="button" className="ts-btn ts-btn--primary ts-sticker ts-fab" onClick={openAddExpense}>
        <Icon name="coin" size={24} />
        記一筆
      </button>

      {expenseModalOpen && (
        <div className="ts-overlay">
          <button
            type="button"
            className="ts-backdrop"
            aria-label="關閉"
            tabIndex={-1}
            onClick={() => setExpenseModalOpen(false)}
          />
          <div className="ts-sheet ts-box ts-sticker" role="dialog" aria-modal="true" aria-labelledby="expense-title">
            <h2 className="ts-label" id="expense-title">
              <span className="ts-tape" aria-hidden />
              <Icon name="coin" />
              {editingExpenseId ? "編輯這筆" : "記一筆"}
            </h2>
            <button
              type="button"
              className="ts-close ts-soft"
              aria-label="關閉"
              onClick={() => setExpenseModalOpen(false)}
            >
              ×
            </button>

            <div className="ts-stack">
              {receiptScanReady && !editingExpenseId && (
                <div className="ts-scan">
                  <button
                    type="button"
                    className="ts-btn ts-sticker"
                    onClick={startScan}
                    disabled={scanning}
                  >
                    <Icon name="camera" />
                    {scanning ? "讀收據中…" : "拍收據"}
                  </button>
                  <p className="ts-help">
                    {scanning ? "要幾秒鐘。" : "拍照或從相簿選，金額和明細會幫你填好。"}
                  </p>
                  <input
                    ref={receiptInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => void handleReceiptFile(e)}
                  />
                </div>
              )}
              {scanError && (
                <p className="ts-error" role="alert">
                  {scanError}
                </p>
              )}
              {openQuestions.filter((q) => q.kind === "doubt").map(questionCard)}

              <div className="ts-field">
                <label className="ts-field__name" htmlFor="expense-amount">
                  金額
                </label>
                <div className="ts-amountrow">
                  <input
                    id="expense-amount"
                    className="ts-input ts-input--big ts-soft"
                    value={dAmount}
                    onChange={(e) => {
                      setDAmount(cleanAmount(e.target.value));
                      resolveQuestions((q) => q.kind === "total");
                    }}
                    inputMode="decimal"
                    placeholder="0"
                    autoFocus={!editingExpenseId}
                  />
                  <select
                    className="ts-select ts-soft"
                    aria-label="幣別"
                    value={dCur}
                    onChange={(e) => {
                      setDCur(e.target.value as CurrencyCode);
                      resolveQuestions((q) => q.kind === "currency");
                    }}
                  >
                    {CURRENCY_CODES.map((code) => (
                      <option key={code} value={code}>
                        {CURRENCIES[code].short}
                      </option>
                    ))}
                  </select>
                </div>
                {convertHintText && <p className="ts-help">{convertHintText}</p>}
                {openQuestions
                  .filter((q) => q.kind === "currency" || q.kind === "total")
                  .map(questionCard)}
              </div>

              <label className="ts-field">
                <span className="ts-field__name">買了什麼</span>
                <input
                  className="ts-input ts-soft"
                  value={dDesc}
                  onChange={(e) => setDDesc(e.target.value)}
                  placeholder="例如：海雲台烤貝晚餐"
                />
              </label>

              <div className="ts-field">
                <span className="ts-field__name" id="expense-category">
                  分類
                </span>
                <div className="ts-chips ts-chips--wrap" role="group" aria-labelledby="expense-category">
                  {categories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="ts-chip ts-soft"
                      aria-pressed={dCategory === c.id}
                      // Tapping the selected chip clears it — an expense is
                      // allowed to have no category.
                      onClick={() => setDCategory(dCategory === c.id ? undefined : c.id)}
                    >
                      <CategoryMark category={c} />
                      {c.label}
                    </button>
                  ))}
                  {!newCatOpen && (
                    <button type="button" className="ts-chip ts-chip--plain ts-soft" onClick={openNewCategoryRow}>
                      ＋ 新增分類
                    </button>
                  )}
                </div>
                {newCatOpen && categoryEditor}
              </div>

              <div className="ts-field">
                <span className="ts-field__name" id="expense-payer">
                  誰付的
                </span>
                <div className="ts-row ts-row--tight" role="group" aria-labelledby="expense-payer">
                  {members.map((m) => (
                    <BuddyToggle
                      key={m.id}
                      face={faceOf(m.id)}
                      pressed={dPayer === m.id}
                      onClick={() => setDPayer(m.id)}
                    />
                  ))}
                </div>
              </div>

              <div className="ts-field">
                <span className="ts-field__name" id="expense-mode">
                  怎麼分
                </span>
                <div className="ts-seg" role="group" aria-labelledby="expense-mode">
                  {SPLIT_MODES.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      className="ts-soft"
                      aria-pressed={dMode === m.key}
                      onClick={() => changeMode(m.key)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {splitBody}

              {dMode !== "equal" &&
                (amountMinor > 0 ? (
                  remainderClear ? (
                    <div className="ts-left ts-left--ok ts-soft" role="status">
                      <span className="ts-row ts-row--tight">
                        <Icon name="check" />
                        分好了！
                      </span>
                    </div>
                  ) : (
                    <div className="ts-left ts-soft" role="status">
                      <span>{remainderText.word}</span>
                      <span className="ts-amount">{remainderText.amount}</span>
                    </div>
                  )
                ) : (
                  <p className="ts-help">先填上金額，再來分。</p>
                ))}
              {dMode === "items" && amountMinor > 0 && itemsIssue && touchedItems.length > 0 && (
                <p className="ts-help">{itemsIssue}</p>
              )}

              {expenseErrors.length > 0 && (
                <ul className="ts-error">
                  {expenseErrors.map((err) => (
                    <li key={err}>{err}</li>
                  ))}
                </ul>
              )}

              {openQuestions.length > 0 && (
                <p className="ts-help" role="status">
                  還有 {openQuestions.length} 個問題要回答，答完才能存。
                </p>
              )}

              <div className="ts-actions">
                {editingExpenseId ? (
                  <button type="button" className="ts-btn ts-btn--text" onClick={handleDeleteExpense}>
                    刪除這筆
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="ts-btn ts-btn--primary ts-sticker"
                  disabled={!canSave}
                  onClick={handleSaveExpense}
                >
                  儲存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {expenseModalOpen && receiptNoticeOpen && (
        <div className="ts-overlay ts-overlay--center">
          <button
            type="button"
            className="ts-backdrop"
            aria-label="關閉"
            tabIndex={-1}
            onClick={() => setReceiptNoticeOpen(false)}
          />
          <div
            className="ts-dialog ts-box ts-sticker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-notice-title"
          >
            <h2 className="ts-label" id="receipt-notice-title">
              <span className="ts-tape" aria-hidden />
              <Icon name="camera" />
              拍收據之前
            </h2>
            <button
              type="button"
              className="ts-close ts-soft"
              aria-label="關閉"
              onClick={() => setReceiptNoticeOpen(false)}
            >
              ×
            </button>
            <div className="ts-stack">
              <p className="ts-body">
                照片會送到 Google 的 Gemini 辨識。用的是免費版，Google 可能拿照片和辨識結果改進他們的產品，也可能有人工看過。
              </p>
              <p className="ts-body">
                照片辨識完就丟掉，不會存進帳目。收據上如果有卡號末四碼這類資料，介意的話就手動記。
              </p>
              <div className="ts-actions">
                <button
                  type="button"
                  className="ts-btn ts-btn--text"
                  onClick={() => setReceiptNoticeOpen(false)}
                >
                  先不要
                </button>
                <button
                  type="button"
                  className="ts-btn ts-btn--primary ts-sticker"
                  onClick={confirmReceiptNotice}
                >
                  知道了，拍照
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {personModalOpen && (
        <div className="ts-overlay ts-overlay--center">
          <button
            type="button"
            className="ts-backdrop"
            aria-label="關閉"
            tabIndex={-1}
            onClick={() => setPersonModalOpen(false)}
          />
          <form
            className="ts-dialog ts-box ts-sticker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="person-title"
            onSubmit={handleSavePerson}
          >
            <h2 className="ts-label" id="person-title">
              <span className="ts-tape" aria-hidden />
              <Icon name="buddy" />
              {editingPersonId ? "編輯旅伴" : "新增旅伴"}
            </h2>
            <button
              type="button"
              className="ts-close ts-soft"
              aria-label="關閉"
              onClick={() => setPersonModalOpen(false)}
            >
              ×
            </button>
            <div className="ts-stack">
              <label className="ts-field">
                <span className="ts-field__name">名字</span>
                <input
                  className="ts-input ts-soft"
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                  placeholder="例如：阿凱"
                  autoFocus
                />
              </label>
              {removeBlockedMessage && <p className="ts-help">{removeBlockedMessage}</p>}
              {personError && <p className="ts-error">{personError}</p>}
              <div className="ts-actions">
                {editingPersonId && canRemovePerson ? (
                  <button type="button" className="ts-btn ts-btn--text" onClick={handleRemovePerson}>
                    移除
                  </button>
                ) : (
                  <span />
                )}
                <button type="submit" className="ts-btn ts-btn--primary ts-sticker" disabled={!pName.trim()}>
                  儲存
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </Frame>
  );
};
