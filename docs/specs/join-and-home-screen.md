# Join as yourself, and the Home Screen icon

Opening a trip on a browser that does not know you yet should never make a second 阿凱. And the ledger
should open from the Home Screen like an app. The two ship together because the second causes the first:
an iPhone Home Screen web app keeps its own storage, separate from Safari's and from LINE's browser
([WebKit bug 181849](https://bugs.webkit.org/show_bug.cgi?id=181849)), so everyone meets the join screen
again the first time they tap the icon.

Decided with the user on 2026-11-17, before the Tokyo trip (11/26).

## Why a second 阿凱 happens today

Each browser is its own anonymous sign-in. A member's id is the sign-in's uid (`joinGroup`), and the
join screen only offers 「你的名字」, so typing 阿凱 in a new browser writes a new member under the new
uid. A member the organiser added in advance (旅伴 → 新增旅伴) has no sign-in at all, so whoever that is
can only ever join as a duplicate.

## Decisions

| | Decision |
|---|---|
| Join screen | Everyone already in the trip as 「我是阿凱」 buttons, in trip order, then 「新來的？你的名字」. Tapping a name enters as that person at once, no confirm step. Everyone is listed, including people already in use on another phone: the same person on a second phone or a Home Screen icon is the case this fixes. |
| Claiming | Only this device's identity map changes (`trip-debt:identity`), plus the account trip index as on any join. No Firestore member is written or renamed. Anyone holding the room code could pick someone else's name, which is the trust the room code already carries. |
| Same name typed | If 新來的 is a name already in the trip (trimmed, case-insensitive), ask 「已經有阿凱了，是你嗎？」 with [是我] (enter as that 阿凱) and [不是，我是另一個人] (add a second 阿凱, as today). |
| Wrong tap | 旅伴 ends with 「不是阿凱？換人」. It forgets who you are on this device and shows the join screen again. Nothing in the trip changes. |
| Already a member | If this sign-in's uid is already a member of the trip, go straight in without the join screen. That covers a Google account on a new device, and a browser whose identity map was cleared but whose sign-in survived. |
| Home Screen icon | The design system's coin sticker on `--ground` cream, titled 旅行分帳. It also replaces the browser-tab icon, which was still the portfolio monogram. |
| Where the icon opens | On iOS, the trip it was added from: `manifest.webmanifest` has no `start_url`, so the page's own URL is used. (A Home Screen app starts with empty storage, so `./` would land on an empty trip list.) A later trip is reached with 「＋ 新行程」 → 你的行程 inside the app. Links tapped in LINE still open in LINE or Safari; iOS cannot send a link into a Home Screen app. Every other browser gets `manifest-chrome.webmanifest`, the same plus `start_url: "./"`, swapped in by `main.tsx`: Chrome will not install without one (`start-url-not-valid`), and an installed app there shares the browser's storage, so `./` resumes the last trip. |
| The tip | A card at the top of 餘額, once you are in a trip, until closed with ×. In Safari (or any non-LINE browser) on iPhone or iPad: 分享 → 加入主畫面. In LINE's browser, which cannot add to the Home Screen: a 「用 Safari 打開」 button to the same page with LINE's `openExternalBrowser=1`, which the page then strips from its address. Never inside the Home Screen app. Android and desktop get no card; Chrome offers its own install once the manifest exists. |
| Google sign-in in the app | Hidden inside the Home Screen app, with 「要用 Google 登入，請在 Safari 打開」. Popup sign-in cannot report back to an iOS Home Screen app, and redirect sign-in lands in Safari's storage instead ([firebase-js-sdk#77](https://github.com/firebase/firebase-js-sdk/issues/77)). |

## Not done

- Push notifications (need a server to send; the Blaze plan).
- Moving one person's history onto another member, e.g. merging two 阿凱 made before this change. Delete
  the spare one under 旅伴 if it has no expenses.
- Offline use. That is the next spec.
