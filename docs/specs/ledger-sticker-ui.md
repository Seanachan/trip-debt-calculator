# Ledger sticker UI

The calculator takes the look of the 行程表 design system, the same one
[trip-schedule](https://github.com/Seanachan/trip-schedule) already wears (its
`docs/specs/sticker-ui.md` left "the ledger" for this spec). Tokens, the two fonts and the eight
sticker icons are byte-identical copies of what that repo ships, so the two sites read as one
product.

## Decisions

| Question | Decision |
|---|---|
| Scope | Every screen of this app: onboard, join prompt, notices, the five views, the expense sheet, the person dialog. Plus two features the design asks for: expenses grouped by day, and the 依項目 split. The itinerary components (ItineraryCard, the schedule's DayTabs) stay in trip-schedule. |
| Name | Stays 旅行分帳. 行程表 is the schedule site. |
| Light / dark | Follows `prefers-color-scheme`, no toggle, same as trip-schedule. |
| Fonts | Chiron GoRound TC (晉圓體) for words, Fredoka for numbers, from Google Fonts. |
| Icons | `src/assets/icons/`, copied from trip-schedule. No emoji in the UI chrome. |
| Navigation | The five views stay. Their tabs are a sticky row of chips under the top bar, words only. The `+` FAB becomes a fixed coral 記一筆 pill: the one primary action of every view. |
| Avatars | `.ts-av`: one character on `sun`. Han names show their last character (阿凱 → 凱), other names their first letter. The device's own buddy reads 你. Stored member colours are no longer shown: buddies are told apart by name. |
| Categories | The six seeded ids get sticker icons and fills: food → bowl/strawberry, stay → bed/lilac, transit → bus/sky, fun → camera/sun, shopping → bag/palm, other and 未分類 → coin on `panel-tint`. A category a group made itself keeps the emoji it was given, on `panel-tint`: that emoji is the group's content, not chrome. The icon picker only appears for those. |
| Expense icon | New expenses no longer get a rotating emoji `icon`; an edit keeps whatever an old one had. The row shows its category's tile. |
| Money wording | Direction in words, never a bare negative: 應收 / 應付 / 已結清 pills, 「你欠 ₩34,500」, 「小明 → 阿凱」. |

## Split modes

The sheet's 怎麼分 has four modes:

| Mode | Stored as | Notes |
|---|---|---|
| 平分 | `equal` | Pick who shares. |
| 依項目 | `exact` **plus** `split.items` | See below. |
| 指定金額 | `exact` | Keeps 剩下平分. |
| 比例 | `percent` (or `equal` when left even) | `shares` from older data opens here too. |

Under the lines, one bar says what is left: 「還有 ₩3,000 沒分配」 on `money-owe-fill` until it is
zero, then 「分好了！」 on `palm`. 儲存 stays disabled until then.

### 依項目

A line has a label, an amount and the buddies who share it (everyone by default). Each line is
split evenly among its sharers; when a line does not divide evenly, the payer takes the spare
minor units if they share that line, otherwise the order of the list decides. The lines must add
up to the total.

It is stored as an `exact` split whose participant values are what the lines add up to per
person, with the lines themselves in `split.items: { label, amount, personIds }[]`. Two reasons:

- `computeOwed`, `computeBalances` and settle-up already handle `exact`; no money path changes.
- A device still on the old build reads it as an ordinary `exact` split and gets the same
  balances, instead of falling back to `equal` for a method it does not know.

`validateExpense` checks the two agree: lines add up to `amount`, every line has a positive
amount and at least one member, and every participant's value is exactly what the lines give.
An old build that edits such an expense saves it as plain `exact` (the lines are dropped, the
amounts stay right).

## Day grouping

帳目 gets the design's DayTabs: 全部 first, then one tab per local calendar day that has an
expense, in date order like the schedule's tabs. A tab reads `DAY n` (n counted from the first
day with an expense, so a day with nothing spent leaves a gap) or 今天, the date, and how many
expenses. 全部 lists every day under its own heading; a day tab lists that day alone. The day is
`createdAt` in the device's time zone; there is no separate expense date.

## Not done here

- One or more payers (the design allows several; the engine has one `paidBy`).
- The money card's progress bar: there is no estimate to measure against until the schedule
  feeds one in.
- The favicon. The design system has no logo.
