# Technical Specification: Scroll-Velocity Pause & Idle Scheduling (Issue #23)

Status: Approved. Implements https://github.com/curdriceaurora/vrbow/issues/23 on
branch `issue-23-scroll-velocity-pause`.

Note on scope: issue #23 is self-gated — it says this work should only be
implemented if real-world telemetry (`__vdpSearchStats()`) shows `maxQueueDepth`
consistently above 6-8, or observed scroll jank, and should otherwise be
deferred/closed as over-engineering. That telemetry has not been gathered (Vrbo
currently hard-blocks automated Chrome sessions, so it can't be collected without
a human-driven browsing session). The user explicitly chose to implement this
unconditionally, skipping that gate. Recorded here for the historical record, not
as an open question.

---

## 1. Executive Summary & Goals

### Context
On Vrbo search result pages (particularly in 2-column or 3-column grid layouts), user scrolling brings multiple listing cards into the viewport concurrently. Under natural skimming speeds (~150–300 px/s), cards remain in the 150 px observation margin long enough to exceed the 400–600 ms dwell timer, causing enqueues to outpace the queue's 800–1040 ms drain rate.

### Objectives
1. **Pause Background Queue Draining During Active Scrolling:** Prevent queue backlog accumulation and CPU/network churn for cards the user is actively scrolling past.
2. **Main-Thread Idle Scheduling:** Defer the *initial kick-off* of background fetch dispatch via `requestIdleCallback` (with a mandatory fallback timeout) so the browser compositor/render loop gets first claim on idle time — not a claim that every dispatch tick is idle-deferred (see §2.2.B for why intra-drain retries stay on direct timers).
3. **Preserve High-Priority Responsiveness:** Ensure user hover interactions bypass both scroll pauses and idle delays, dispatching at the established ≤250ms global floor.
4. **Maintain Strict Invariants:** Zero disruption to the adaptive backoff ladder, asymmetric clean-window recovery, or zero-leak `dispose()` teardown semantics.

---

## 2. Architecture & Component Responsibilities

```
+-----------------------------------------------------------------------------------+
| content.js (rAF-Batched Scroll Velocity & Settle Detection)                       |
|                                                                                   |
|  [Passive Scroll Event] --> Record scrollY & requestAnimationFrame (if not queued)|
|                                      |                                            |
|                                      v                                            |
|  [rAF Callback (once/frame)] --> Compute dy / dt                                  |
|                                  +-- Velocity > 150px/s --> setScrollPaused(true)  |
|                                  +-- Reset Settle Debounce Timer (150ms)           |
|                                                                                   |
|  [scrollend / 150ms Debounce] --> Settle --------------> setScrollPaused(false)   |
+-----------------------------------------+-----------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------+
| search-fetcher.js (Entry-Only Idle Scheduler & Flow Control)                      |
|                                                                                   |
|  scheduleProcessQueue() (Kick-off from enqueue, scroll settle, visibilitychange,  |
|                          fetch-completion finally())                              |
|    +-- High Priority Pending? --> cancel idle & processQueue() (Immediate sync)   |
|    +-- Normal Priority?       --> requestIdleCallback({ timeout: 1000ms })        |
|                                                                                   |
|  processQueue() Loop                                                              |
|    +-- Next item is High Priority? --> Evaluate 250ms floor --> Dispatch          |
|    +-- Next item is Normal Priority:                                              |
|          +-- scrollPaused == true? --> break (leaves item in queue, zero mutation)|
|          +-- wait > 0?             --> scheduleTimer(processQueue, wait) (Direct) |
+-----------------------------------------------------------------------------------+
```

### Why entry-only idle scheduling (not every retry tick)
Once a drain cycle begins, request spacing is already deterministically regulated
by the 800ms (+ [0, 30%] jitter) timer. Idle-wrapping *every* pacing retry on top
of that would let an active main thread stretch each dispatch from ~800ms toward
~1800ms; across a 5-item backlog that balloons drain time from ~4s to ~9s,
directly defeating the "queue depth stays <=2-3" acceptance criterion. The
friction this feature actually targets is the *moment new work first appears*
(new cards settling into view, or scroll just stopping) — deferring that initial
kick-off via `requestIdleCallback` gives the browser compositor/render loop the
idle window to finish layout/paint before the extension initiates `fetch()`,
Apollo parsing, and badge mounting. Once a drain is already underway, its pacing
retries stay on direct timers.

---

## 3. Detailed Component Specifications

### 3.1 `content.js` — rAF-Batched Scroll Velocity & Settle Tracking

#### A. State & Constants
```js
const SCROLL_VELOCITY_THRESHOLD_PX_S = 150;
const SCROLL_SETTLE_DEBOUNCE_MS = 150;

let lastScrollY = 0;
let lastScrollTime = 0;
let scrollRafId = null;
let scrollSettleTimer = null;
let isScrollPaused = false;
```

#### B. Handlers with rAF Batching & Explicit First-Event Guard
```js
function onWindowScroll() {
  if (scrollRafId !== null) return; // Coalesce to one computation per frame

  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    const now = performance.now();
    const currentY = window.scrollY || document.documentElement.scrollTop || 0;

    // Explicit first-event guard: initialize baseline without a false-positive
    // velocity spike. performance.now() is never exactly 0 once any time has
    // elapsed since navigation start, so this sentinel is unambiguous.
    if (lastScrollTime === 0) {
      lastScrollY = currentY;
      lastScrollTime = now;
      return;
    }

    const dt = now - lastScrollTime;
    if (dt > 0) {
      const velocity = (Math.abs(currentY - lastScrollY) / dt) * 1000;
      lastScrollY = currentY;
      lastScrollTime = now;

      if (velocity >= SCROLL_VELOCITY_THRESHOLD_PX_S && !isScrollPaused) {
        isScrollPaused = true;
        if (searchQueue && typeof searchQueue.setScrollPaused === "function") {
          searchQueue.setScrollPaused(true);
        }
      }
    }

    // Reset trailing settle debounce on every frame while scroll activity continues
    if (scrollSettleTimer !== null) clearTimeout(scrollSettleTimer);
    scrollSettleTimer = setTimeout(onScrollSettled, SCROLL_SETTLE_DEBOUNCE_MS);
  });
}

function onScrollSettled() {
  if (scrollSettleTimer !== null) {
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = null;
  }
  if (isScrollPaused) {
    isScrollPaused = false;
    if (searchQueue && typeof searchQueue.setScrollPaused === "function") {
      searchQueue.setScrollPaused(false);
    }
  }
}
```

`onScrollSettled` is idempotent (guards on `isScrollPaused`), so it's safe to wire
both to the native `scrollend` event (where supported) and as the trailing-debounce
fallback without any double-fire hazard.

#### C. Lifecycle Management
- **Setup in `initSearchManager()`:**
  ```js
  window.addEventListener("scroll", onWindowScroll, { passive: true });
  if ("onscrollend" in window) {
    window.addEventListener("scrollend", onScrollSettled, { passive: true });
  }
  ```
- **Teardown in `cleanupSearchManager()`:**
  - Cancels `scrollRafId` (`cancelAnimationFrame`) and clears `scrollSettleTimer`.
  - Removes `scroll` and `scrollend` listeners from `window`.
  - Resets scroll state to initial baseline (`lastScrollY = 0`, `lastScrollTime = 0`, `isScrollPaused = false`, `scrollRafId = null`, `scrollSettleTimer = null`).

---

### 3.2 `search-fetcher.js` — Queue Flow Control & Idle Scheduling

#### A. Injected Primitives & Default Options
```js
const DEFAULT_IDLE_TIMEOUT_MS = 1000;

const idleCallbackTimeoutMs = typeof options.idleCallbackTimeoutMs === "number"
  ? options.idleCallbackTimeoutMs
  : DEFAULT_IDLE_TIMEOUT_MS;

const requestIdleCallbackFn = typeof options.requestIdleCallbackFn === "function"
  ? options.requestIdleCallbackFn
  : (typeof globalThis.requestIdleCallback === "function"
      ? globalThis.requestIdleCallback.bind(globalThis)
      : ((fn, opts) => setTimeout(() => fn({ didTimeout: true, timeRemaining: () => 0 }), opts?.timeout || 0)));

const cancelIdleCallbackFn = typeof options.cancelIdleCallbackFn === "function"
  ? options.cancelIdleCallbackFn
  : (typeof globalThis.cancelIdleCallback === "function"
      ? globalThis.cancelIdleCallback.bind(globalThis)
      : ((id) => clearTimeout(id)));
```
`options.requestIdleCallbackFn`/`options.cancelIdleCallbackFn` mirror the
existing `fetchFn`/`randomFn` injection pattern in this file, for deterministic
unit testing.

#### B. Scheduling Helper (`scheduleProcessQueue`) vs. Intra-Drain Timers
- **Entry-point triggers call `scheduleProcessQueue()`** — each of these is a
  *pre-existing* call site that currently calls `processQueue()` directly; this
  change swaps that call, it does not add new listeners:
  - `enqueue()`, after the async storage-cache check resolves and the item is pushed (existing line ~986)
  - `setScrollPaused(false)` on scroll settle (new)
  - `onVisibilityChange()` (existing handler, already wired/torn down in `dispose()` — just swaps its `processQueue()` call, line ~1027)
  - `executeFetch(...).finally()` (existing line ~761)
- **Intra-drain retry keeps its direct call** — when `computeDispatchWait()` returns
  `wait > 0` inside `processQueue()`'s loop, it continues to call
  `scheduleTimer(processQueue, applyJitter(wait))` directly, unchanged from
  today. This is deliberate (see rationale in §2).

```js
let idleHandle = null;
let scrollPaused = false;

function scheduleProcessQueue() {
  if (isDisposed) return;

  // High-priority cut-through: cancel pending idle callback and dispatch synchronously
  if (highPriorityIds.size > 0) {
    if (idleHandle !== null) {
      cancelIdleCallbackFn(idleHandle);
      idleHandle = null;
    }
    processQueue();
    return;
  }

  // Coalesce duplicate idle dispatches
  if (idleHandle !== null) return;

  idleHandle = requestIdleCallbackFn(() => {
    idleHandle = null;
    if (!isDisposed) {
      processQueue();
    }
  }, { timeout: idleCallbackTimeoutMs });
}
```

#### C. `processQueue()` Loop Gating
Inserted right after priority candidate selection, before the pacing gate:
```js
let nextIndex = queue.findIndex((item) => item.priority === "high" || highPriorityIds.has(item.propertyId));
const isHighPriority = nextIndex !== -1;
if (nextIndex === -1) nextIndex = 0;
const candidate = queue[nextIndex];

// SCROLL GATE: normal items break the loop without touching any other state
// (ladder, pausedUntil, lastNonSuccessAt are all untouched); high-priority
// items (user hover) proceed unimpeded regardless of scroll state.
if (!isHighPriority && scrollPaused) {
  break;
}
```
This gate applies inside `processQueue()` itself, so it protects intra-drain
retries too, even though those retries don't go through `scheduleProcessQueue()`.
The two mechanisms are orthogonal: scroll-pause is checked on every loop
iteration regardless of entry path; idle-scheduling only wraps the entry path.

#### D. Public Control API
```js
function setScrollPaused(paused) {
  const wasPaused = scrollPaused;
  scrollPaused = Boolean(paused);
  if (wasPaused && !scrollPaused && !isDisposed) {
    scheduleProcessQueue();
  }
}

return {
  // ... existing exports
  setScrollPaused,
  isScrollPaused: () => scrollPaused,
};
```

#### E. Teardown Invariant in `dispose()`
```js
if (idleHandle !== null) {
  cancelIdleCallbackFn(idleHandle);
  idleHandle = null;
}
```
(`onVisibilityChange`'s existing listener teardown in `dispose()` is unchanged.)

---

## 4. Invariants & Safety Guarantees

| Invariant | Guarantee & Implementation Mechanism |
| :--- | :--- |
| **Adaptive Ladder Preservation** | `setScrollPaused(true/false)` and the scroll-gate loop `break` are transport pacing. They **never** call `noteHardBlock`, `noteSoftFailure`, or `noteNonSuccess`, and **never** reset `lastNonSuccessAt`. |
| **Clean Window Preservation** | Background pauses do not interrupt active recovery windows; the 60s clean timer continues stepping down upon sustained concrete successes. |
| **High-Priority Immunity** | `highPriorityIds.size > 0` bypasses `requestIdleCallback` (cancelling any pending idle handle) to invoke `processQueue()` synchronously. Inside `processQueue()`, `isHighPriority === true` bypasses the scroll gate and dispatches at the ≤250ms floor. |
| **Drain Pacing Stability** | Once a drain is underway, sequential dispatches run on explicit 800ms (+jitter) direct timers, never compounding idle-callback latency across a backlog. |
| **In-Flight Request Safety** | `setScrollPaused(true)` does not cancel or abort requests already dispatched on the wire (`executeFetch`). |
| **Starvation Protection** | `requestIdleCallback`'s `{ timeout: 1000 }` ensures the *first* dispatch of newly-arrived work is forced within 1s even under sustained main-thread load; the `setTimeout` fallback covers environments without the API. |
| **Zero Memory/Timer Leaks** | `idleHandle` is tracked and cancelled in `dispose()`. `scrollRafId`/`scrollSettleTimer`/scroll listeners are cancelled/removed in `cleanupSearchManager()`. |

---

## 5. Verification & Test Plan

### 5.1 Unit Tests (`test/search-fetcher.test.js`)
1. **Scroll Gate Flow Control:** normal items queued + `setScrollPaused(true)` → 0 dispatches; `setScrollPaused(false)` → queue drains per 800ms pacing.
2. **High-Priority Cut-Through & Idle Cancellation:** with a normal item's idle callback pending (`idleHandle` set), enqueue a high-priority item → assert `cancelIdleCallbackFn` was called, `idleHandle` reset to `null`, and the high-priority item dispatches at the 250ms floor.
3. **Ladder Invariance Check:** record `ladderStep`, `lastNonSuccessAt`, `pausedUntil` → run a pause/resume cycle → assert exact scalar equality across all three.
4. **Deterministic Idle Scheduling & Fallback:** injected `requestIdleCallbackFn` stub confirms entry-point deferral with the correct `{ timeout }`; absence of the global executes cleanly through the `setTimeout` fallback.
5. **Teardown:** `dispose()` while an idle callback is pending cancels the handle via `cancelIdleCallbackFn`, zero lingering timers.

### 5.2 DOM & UI Harness Tests (`test/search-ui.test.js`)
1. **rAF Scroll Batching & Velocity Gating:** simulated scroll events >150px/s batched via rAF → `searchQueue.isScrollPaused() === true`. First-event initialization produces no false-positive pause.
2. **Settle Detection & Teardown:** `scrollend` (or 150ms debounce) → `isScrollPaused() === false`. `cleanupSearchManager()` removes listeners and cancels pending rAF/debounce timers, with no state leak into a subsequent search view (same pattern as the existing I7 test).

### 5.3 Pipeline Gates
- Unit suite (`node --test`): all tests pass.
- E2E Playwright suite (`e2e/`, 7 spec files / 14 top-level `test()` cases today): all pass.
- Coverage gate (`tools/check-coverage.js`) on `extract.js` and `search-fetcher.js`: lines ≥ 90%, branches ≥ 75%, funcs ≥ 85% (actual configured thresholds — not a flat 90% across all three metrics).
