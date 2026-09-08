# Agent Note: Web todo display — host projection + two render surfaces

Status: implemented

English | [中文](2026-07-23-web-todo-display.zh.md)

## Problem

`todo_write` appends `todo/write` whole-list snapshots to the session log; the TUI renders a persistent plan panel (the automation-only ACP bridge deliberately omits todo presentation). The web client dropped the event entirely: the host mux stream already forwards every session event, but `todo/write` is not a surface type (it never folds into `ConversationSnapshot.nodes`), and no side-effect branch accumulated it — the browser had no consumption point and no display surface.

## Decision

Fold `todo/write` into a Host session projection, not a conversation node, and render it on two surfaces matching the split the TUI already draws.

### Host projection, converging through baselines and frames

`dsh-tool-todo` registers the `todos` unit with `ctx.sessionProjections`. Its Host fold treats each `todo/write` as a whole-list replacement, returns `null` on `turn/start` and on a user-aborted `turn/end`, and retains the current reference for every other event ([turn-scoped plan lifetime](2026-07-28-todo-plan-clears-on-next-turn.md), [user-stop correction](../bug-fix/2026-09-08-user-stop-clears-todo-plan.md)). Session Controller carries the finished value in the follow-opening and control-stream baselines and publishes later changes as whole-value `projection` frames. The per-Session `ProjectionValueStore` merges those inputs under its higher-sequence-wins rule and exposes an identity-stable per-key face; the browser performs no todo-specific event fold, and `ConversationSnapshot` carries no projection values. The standard kit binds that face as `useProjection`, and `TodoDock` reads `useProjection('todos')`: a list renders the strip, while `null` or an absent `undefined` value renders nothing. Keeping the standing value outside conversation nodes prevents superseded todo snapshots from appearing as current transcript content.

### TodoPanel: the durable list as a persistent strip

The panel mounts through the `conversation.input.dock` slot (a plain registrant plugin, `todoDockEntry`, using `ctx.slots.inject` with no `ConversationController` edge, `order: 0` above the queue rows), hidden while empty, collapsible to a header of title + `·`-joined per-status counts (localized, `1 completed · 2 in progress · 1 pending`, zero-count segments omitted; no in-progress content hint when collapsed). Status glyphs are the figma todo set (green check ring / blue fading ring / dashed pending ring) on a tip-surface card (`--dsw-specific-tip`, 14px radius, `width: calc(100% - 88px)` / `max-width: 776px` centered; InputBar top pad 6px is the gap to the composer card). It reads the host-computed `todos` projection via the standard-kit `useProjection` hook the dock entry receives — no store, no service, no ctx. The inner component stays props-complete and framework-free; the dock adapter is a one-line wrapper.

### TodoRow: the per-call row through the keyed toolview slot

The dedicated `todo_write` chat row is a plain registrant plugin (`todoToolview`, mounted from `apply`) that registers into the keyed `tool.call.toolview` slot through `ctx.slots.inject`, the same declaration-lifetime posture as the bash sample but a product registration. The summary derives from call args (`N/M done · first active item`, with a `+<n>` count of the other active ones in `ToolRow`'s non-shrinking `summarySuffix` slot); unparseable args fall back to the generic row summary; clicking opens the details column with the raw args. No `ToolEventView` is added for todo — presentation is client-owned, and the durable list renders from the session event, not the tool card.

## Alternatives considered

- **Fold todo writes into `nodes` as surface entries** — replayed windows would render every superseded list; the event is deliberately not a surface type.
- **Hardcoding the panel inside `ConversationRoot`** — the original landing spot before the input-dock slot existed; the dock is the architecture's home for always-on strips above the composer, and a hardcode bypasses the slot registry's disposal and ordering.
- **Details column for the panel** — the details slot is single-occupant and selection-driven, a different lifetime than an always-on strip.
- **Host-computed view (a todo `ToolEventView`)** — presentation belongs to the client; the wire already carries the whole snapshot in the event payload.

## Consequences

The durable `todo/write` event remains the source of the standing plan, while the Host projection and generic transport/store path are its only Client read path. Cold opening and reconnecting seed the same per-Session `ProjectionValueStore`, live frames advance it, and older-history prepends do not alter it; a user stop therefore hides the strip without appending a synthetic empty write or erasing the recorded tool call and event. The automation-only ACP bridge omits todo presentation, while Web keeps the projected dock and the separate per-call `todo_write` row. `packages/todo/tool-todo/tests/projection.spec.ts` pins completed, user-aborted, and other-abort lifetimes; `packages/api/session-controller/tests/projection-store.client.spec.ts` pins baseline/frame ordering; `packages/client/ui-conversation/tests/todo-panel.client.spec.tsx` pins the dock; and the Web live-interactions scenario pins disappearance after user Stop.
