# trip-debt-calculator

旅行分帳 — <https://seanachan.github.io/trip-debt-calculator/>

Split out of [`seanachan.github.io`](https://github.com/Seanachan/seanachan.github.io) so the
portfolio site and this tool build and deploy independently.

**The repo name is load-bearing.** A GitHub Pages project site is served at `/<repo>/`, so naming
it `trip-debt-calculator` keeps every public URL byte-identical to when this was a route in the
portfolio — including the `/trip-debt-calculator/<ROOM CODE>` links already shared with travel
companions. Same origin also means the `trip-debt:*` `localStorage` keys carry over, so returning
devices keep their identity instead of being asked to re-join.

Two consequences to respect when editing:

- `vite.config.ts` `base` and the `BrowserRouter basename` in `src/main.tsx` must stay in step.
- Paths inside `TripDebtCalculatorPage.tsx` are **router-relative** (`/${groupId}`, not
  `/trip-debt-calculator/${groupId}`). The basename adds the prefix; writing it twice produces
  `/trip-debt-calculator/trip-debt-calculator/…`.

## Setup

```sh
cp .env.example .env.local   # fill from Firebase console → Project settings → General
yarn install
yarn dev
```

The `VITE_FIREBASE_*` values are public client identifiers, not secrets — access control lives in
`firestore.rules` (signed-in requests only), not in hiding them. CI reads them from repository
secrets of the same names; the six must exist or the deployed build has Firebase disabled.

Nothing white-screens without them: every export in `src/features/expense-divider/firebase/config.ts`
is safe to import unconditionally, and callers check `firebaseReady` first.

`VITE_RECAPTCHA_ENTERPRISE_KEY` is optional and turns on 拍收據 (receipt scan through Firebase AI
Logic, which requires App Check). Without it the button is hidden. The one-time console setup is in
[`docs/specs/receipt-scan.md`](docs/specs/receipt-scan.md#setup-once-by-the-project-owner).

## Commands

| | |
|---|---|
| `yarn dev` | dev server |
| `yarn build` | `tsc -b && vite build` |
| `yarn lint` · `yarn test` | gates CI enforces before deploying |

## Layout

| File | Role |
|---|---|
| `src/main.tsx` | Router + basename. Routes are `/` (onboard) and `/:groupId` |
| `src/pages/TripDebtCalculatorPage.tsx` | Whole UI: onboard, app shell, expense sheet, person dialog |
| `src/components/` | Sticker pieces the page repeats (taped box, buddy chips, category bubble) and the icon map |
| `src/features/expense-divider/engine/` | Pure money math — split (incl. 依項目 lines), balances, settle, currency. Fully unit-tested |
| `src/features/expense-divider/display.ts` | Avatar character and day grouping for the ledger. Unit-tested |
| `src/features/expense-divider/firebase/` | Firestore bootstrap, groups, memberships, settlements |
| `src/features/expense-divider/receipt/` | 拍收據: what the model must return, turning it into a draft plus open questions (unit-tested), image prep, the Gemini call |
| `src/features/expense-divider/identity.ts` | Per-device identity map in `localStorage` |
| `src/styles/sticker.css` | `ts-` components from the 行程表 design system, shared look with trip-schedule |
| `src/index.css` | 行程表 tokens; light/dark follows the device |
| `src/assets/icons/` | The design system's eight sticker icons |
| `docs/specs/` | What a change decided and why — read before reworking the UI |
| `firestore.rules` · `firestore.indexes.json` · `firebase.json` | Firebase project config |

## Firebase

Same Firebase project as before the split. Authorized domains are host-level
(`seanachan.github.io`), and `firebase.json`'s `authorizedRedirectUris` is too, so moving from a
route to a project site needed **no console change**.

Sign-in *links* a Google account to the anonymous per-device identity rather than replacing it:
group membership, `createdBy` on every expense and the settled ticks are all keyed by uid, so a
fresh uid would orphan the device's whole history.
