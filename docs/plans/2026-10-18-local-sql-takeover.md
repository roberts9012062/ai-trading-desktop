# Local SQL takeover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the Windows crypto desktop operational when the business server is unavailable, with embedded SQL storage, native API VALUE COLLECTION access and an explicit server synchronization control.

**Architecture:** Embed SQLite in Tauri. Scope records by server/user and exchange caches by account/environment. Encrypt Secrets with DPAPI and sign private REST/WS natively. Local settings and records persist independently; synchronization uses revisions, tombstones, conflict detection and acknowledgements. Exchange commands are never a replay queue. The user confirmed automatic AI/quant execution takeover with duplicate prevention. Every trading task must first be authenticated and registered by the business server; cached login and local SQL rows cannot authorize task creation or execution.

**Tech Stack:** Rust/Tauri, bundled SQLite/rusqlite, DPAPI, reqwest/ring, TypeScript/React, existing local research engines.

## Decisions and tradeoffs

- SQLite instead of a separate MySQL/PostgreSQL installation: no port/service, transactional schema migrations, WAL and bound parameters. IndexedDB remains a research cache, not the requested SQL business store.
- Native credential signing instead of business RPC. Import existing credentials with the sealed handoff or save locally; the renderer only reads masked metadata.
- Explicit record sync instead of failed-request replay. Preserve concurrent edits as conflicts; acknowledgements only clear the uploaded revision; retain deletion tombstones. Never upload/replay exchange commands.
- Backend outages do not revoke an established session. Explicit authentication rejection still requires login. Cloud-only pages degrade without blocking local core functions.
- Current exchange data still requires the API center online. The target is business-server outage, not total network disconnection.

## Task 1: SQLite records and secure vault

Files: `src-tauri/Cargo.toml`, `src-tauri/src/local_store.rs`, `src-tauri/src/lib.rs`.

1. Add and run failing native tests for persistence/reopen, namespace isolation, SQL binding, atomic remote merge, tombstones, conflicts and revision-aware acknowledgements.
2. Implement a lazy native state opening `desktop-state.sqlite3` under app data, versioned schema, secure blob storage and command intents; do not expose arbitrary SQL.
3. Run `cargo test --manifest-path src-tauri/Cargo.toml --lib local_store` and verify tests pass.

## Task 2: Independent exchange access

Files: new `src-tauri/src/local_exchange.rs`, `src/lib/local-desktop.ts`; existing `market_data.rs`, `okx_analytics.rs`, `lib.rs`, `desktop-exchange.ts`, `snippet-private-ws.ts`, `live-api.ts`.

1. Test contract quantities/steps, normalized account/position/order/fill data, immutable client order IDs, ambiguous writes and exact signing bytes before implementation.
2. Implement DPAPI credential CRUD, preserving blank secrets and account/demo isolation.
3. Implement center-only native private requests, bounded complete history pagination, SQL records and WS proofs. Reuse the shared HTTP slot and rights checks.
4. Route native reads before business RPC and use local credentials for PnL. Persist write intent before sending; reconcile unknown outcomes without automatic replay.

## Task 3: Local API and session continuity

Files: native/local desktop routing modules, `desktop-boot.ts`, `hooks/auth.ts`, config/watchlist/favorite entry points.

1. Test known-session outage, explicit 401, user/server switch isolation and local CRUD.
2. Implement local-first SQL configuration/record routes and native business fetch integration.
3. Restore established sessions after transport/5xx outages; show local operation and server availability.

## Task 4: Synchronization

Files: new sync modules/UI and necessary business backend sync endpoints.

1. Test merge/conflict/delete, idempotent retry, interrupted sync, concurrent edit during upload, account changes and absence of command replay.
2. Implement authenticated scoped bounded sync with persistent revisions/cursors and secure credential import.
3. Add “同步服务器”, last sync time, pending/conflict/error state and conflict resolution. Data upload must not start server execution.

## Task 5: Runtime ownership

Enforce exclusive ownership at the gateway and server runner before enabling automatic takeover. A network partition must not permit duplicate orders. Reuse matching local strategy engines; explicitly port scheduling, risk controls and persistence. Do not label remote tasks as locally running without a real executor. Task creation requires a successful authenticated server response and a server-issued registration; never queue creation offline.

### Executor lifecycle and shutdown

- Closing the window hides it in the tray while native execution and ownership renewal continue. Tray status reports actual local task count. Never hide if the tray could not initialize.
- Explicit exit first stops scheduling new commands and drains/reconciles in-flight requests. Release ownership only after the executor is quiescent. Unknown command outcomes block handoff until verified. Forced termination relies on lease expiry and the same gateway reconciliation, not graceful cleanup.
- The server may resume an approved running task only after the prior lease expires/releases, no unknown writes remain, and positions/orders are reconciled. A restored server cannot steal an active desktop lease. Sync does not start tasks or override ownership.
- Executor availability follows the package policy below; never retain a misleading running state when no authorized executor can run. Previously submitted exchange orders/protective orders remain at the exchange. Locally computed trailing stops, AI decisions and other software-only protection do not run after exit/power loss.
- On restart, read durable registration/intents and reconcile gateway ownership, exchange state and task revision before scheduling. A SQL status of running is not sufficient to execute.
- Submit required exchange-native protective stops and verify acknowledgement after entry. A protection failure must be visible and invoke the task's configured risk response. Do not silently claim all protection survives local shutdown.
- The user confirmed continuous execution while both business server and desktop are off: deploy an independent always-on standby executor on the API VALUE COLLECTION host, available only through the explicit standby package entitlement. All three executors use the same gateway fencing. The market gateway itself is not a strategy executor; deploy and supervise this worker separately. It needs independent task/config/checkpoint storage and verified account/model credentials, and must not call the unavailable business server to evaluate strategies.

## Task 6: Verify and release

Block only the business server while leaving the center accessible. Verify cold restart, account/positions/history/fills/PnL, private WS renewal, local edits, restored sync and execution ownership when enabled. Run meaningful native/frontend tests, full typecheck/test/build and UI checks. Increment by 0.0.1, push/tag, build signed installer and verify update artifacts. Do not claim complete independence while required backend paths remain.

### Confirmed package entitlement and manual restart policy (2026-10-19)

- `standby_executor` is a separate package/grant Boolean, default false. Public market, private REST and private WS permissions never imply standby service. Admin package saves propagate the choice to current valid grants without rotating keys or changing expiry. Expiry and revocation are checked during standby acquire, renew and every new write.
- Paid standby may continue server-approved tasks when both primary executors stop. All participants still share the same account lease, durable command barrier and checkpoints. A package entitlement alone does not mean the standby worker is installed, enrolled or running.
- Without standby coverage, the last primary executor exiting or all primary leases/presences expiring latches the entire exchange account into `manual_flatten_required` and stops all registered tasks. Heartbeats are evaluated BEFORE refreshing presence, so reopening cannot hide the outage. Another still-live primary may take over normally.
- Persist the stop latch in the center SQL database. Restart, synchronization, local running-state edits, newer server registration or buying/upgrading a package cannot clear it. Separate demo/live accounts by verified OKX UID.
- While latched, allow only manual exchange-native position close and order/algo cancellation, after unresolved command outcomes are reconciled; reject every strategy order and ordinary new manual order.
- Clearing requires fresh unfiltered full-account position, ordinary-order and all supported algo-type reads observed by the gateway, with no unresolved commands. Filtered empty results, malformed data and reads started before a command settled cannot prove flat. A generation barrier handles same-millisecond races.
- Confirming flat clears only the account latch. Tasks remain stopped, and require an explicit manual restart with a NEW server-signed revision and `manual_start=true` attestation. Never resume old task certificates, SQL state or queued commands automatically.
- Latest verification covers SQL package enable/disable, expiry/revocation, persistent no-coverage lock, live-primary failover, protected manual close and replay rejection. Standalone executor enrollment, packaging and production activation remain pending; do not describe this development state as deployed continuous execution.

### Development checkpoint (2026-10-19)

- Private backend now has authenticated enrollment, atomic task-signing outbox,
  recipient-encrypted preparation, scoped runtime restoration and an independent
  account process with an actual standard quant-engine test. Only the server can
  supply the initial center baseline; cached desktop state cannot authorize it.
- A business supervisor manages per-account child processes, refreshes changed
  credential/model vaults and publishes durable stops after account revocation.
  Both production feature flags remain disabled. No standby daemon is deployed.
- OS locks prevent two processes importing the same SQLite vault. Parent EOF or
  explicit exit stops new command preparation immediately, drains active steps
  and releases the account lease after checkpoint confirmation. A late AI model
  response cannot place a new order after shutdown starts.
- Native account/position/order/bill/fee reads and private WS proofs now enter
  the live API after an explicit server-bound credential import. The exchange
  page has its own account-sync button. An older server without the binding
  protocol cannot activate the local copy. The encrypted payload must identify
  the exact vault owner; credentials and permission commit atomically.
- Business financial requests carry the native credential/environment binding,
  including through the desktop RPC. The actual server adapter checks it on
  fresh and cached paths before exchange access. Server credential edits clear
  the local copy; import/switch cancels stale reads, clears old UI account data,
  resets PnL and reconnects private WS. Native financial writes remain blocked.
- History follows all advertised pages, deduplicates immutable order IDs and
  paints completed pages early. Pending orders use separate ordinary/eight-algo
  stages, returning the shared HTTP slot after each page. Repeated/bad cursors
  and later-page failures stay visible. Account changes cannot mix histories.
  Exchange history remains subject to exchange retention; importing older
  business-server history and attributing local positions to tasks remain work.
- Available close quantities are preserved. Native positions are explicitly
  exchange aggregates, not guessed manual/AI ownership. A cold instrument read
  warms all valid USDT specs in one cache transaction; orders/fills also cache
  in batches, removing per-symbol requests and per-row disk commits.
- Positive gateway order reads now settle unknown ordinary/algo creation and
  cancellation, including complete batches. Empty/old/wrong/partial reads cannot
  prove a submission failed. Reconciled commands cannot be replayed, and an
  interrupted strategy step still pauses for explicit manual review/start.
  Remaining ambiguous amendment/leverage/anonymous-close proof paths stay blocked.
- Worker candle and current-price readers have a real transport test without
  Redis or business HTTP. Stale ticks stop evaluation; cross-exchange fallback
  cannot bypass API VALUE COLLECTION inside an execution context.
- Watchlist and notification settings now use native SQLite in a separate
  server/user/trading-mode namespace. The authenticated server sync endpoint
  applies bounded compare-and-swap updates and commits before acknowledging.
  Stable contract identifiers converge independent additions; tombstones,
  conflicts and captured revisions preserve interrupted/concurrent edits.
  Financial commands, tasks and credentials cannot enter this record endpoint.
- The personal data panel now has a working synchronization button with pending
  count, last synchronization, readable local/server comparisons and explicit
  conflict choices. Notification changes take effect without restarting.
  Browser checks cover conflict choice, retry after acknowledgement and an
  unavailable business server; local edits survive. Other configuration types,
  credential enrollment and execution preparations remain separate pending work.
- Verified: center 229 non-integration tests and mypy (123 files) at the prior
  checkpoint; desktop Rust 40 passed/2 ignored; frontend 1232 passed/6 skipped,
  TypeScript typecheck and production build passed. Current backend selection
  has 96 passing executor/sync/visibility/notification/hosting tests, including
  real child-process isolation, shutdown, market transport and settlement.
  Earlier quota/permission/OKX lifecycle checks had 76 passing tests. Two legacy
  futures master-rollover fixture failures remain outside this crypto change.
- The new account binding, sealed credential export, desktop relay, live
  permission, sync and visibility selection has 44 passing backend tests. Native
  UI transport tests block business HTTP while reading account/positions/history;
  financial requests retain their server path and account binding. Browser
  checks cover account import, center account read and failed import preserving
  the previous copy. All browser/native HTTP responses in those tests are
  synthetic; no exchange orders, credential changes or production grants run.
- After the native read wiring and account-binding changes, all 55 private
  executor tests pass again. Production build passes; the release workflow now
  also checks native SQL, account transport, server-only task creation and the
  deferred-feature guards. No tag, installer release or production activation
  has been performed for this development batch.
- Running the entire frontend suite together with backend/process/browser
  checks saturated resources and exposed two existing timing-sensitive tests.
  They pass in isolation, and the full suite passes with four frontend workers.
- Hunter dispatch and takeover are deferred by the user. The current source
  hides it from every role, including admins, removes public API/discovery entry
  points and excludes it from new enrollment. UI/API/scanner guards prevent
  cached groups or accidental remounts from reopening it. Legacy position exit
  and protection handling remains. Browser and authenticated API checks pass;
  these changes have not been published/deployed yet.
- The searchable manual no longer describes the deferred feature. Obsolete
  screenshots containing its entry are omitted in both readers and archived
  outside the private website's public assets. Public showcase queries exclude
  its running/paused tasks in both modes. Authenticated detail and showcase
  regression tests, all-role UI guards and manual browser checks pass.
- Still required: dedicated shortline dispatcher, remaining exchange
  proof paths, Tauri worker packaging/lifecycle, remaining scoped configuration
  synchronization, paid standby enrollment/deployment and end-to-end outage UI
  validation. Desktop remains 0.2.205; publish 0.2.206 only after completion.

### 2026-10-19: native manual cancellation and closing

Implementation continued below: route manual order creation through the same
native account/lease/intent boundary. Validate native position mode, decimal
contract sizing and price ticks; use fresh center ticker data for margin sizing.
Leverage adjustment is a separate durable command and must be acknowledged
before order creation. No retries for uncertain leverage/order outcomes.
Normalize only submission acknowledgement, never manufacture a fill. Attached
TP/SL instructions remain part of the immutable order payload. Test invalid
sizes, hedge/net close directions, leverage failure, attachment evidence and
absence of business HTTP before moving on to worker packaging.

- Added the center's exclusive `manual` lease. It works for a verified account
  without enrolling an automatic task, cannot run tasks or write checkpoints,
  cannot steal another executor's active lease, and does not count as a primary
  heartbeat that could keep unattended tasks running. Once fenced, a manual
  account no longer accepts an unclaimed legacy write.
- Wired ordinary/algo cancellation and exchange-native full closing to the
  native UI transport. Closing reads actual margin/position modes, maps net
  long/short correctly, uses a unique client ID and never silently cancels
  protective orders. Creating orders and changing leverage still use the server
  path; native opening and worker-owned manual action dispatch remain pending.
- SQLite schema v2 stores the exact unsigned command and its owner/epoch
  atomically before sending. Neither signing credentials nor API keys are in
  that journal. Unknown results block further writes, survive restart and are
  resolved from the center's ledger and positive exchange evidence. An absent
  center entry alone cannot clear a command: a newer exclusive epoch must first
  fence all delayed requests from its old owner.
- Malformed success receipts remain unknown at both ends. A uniquely identified
  close can now settle from a fresh matching market/reduce-only exchange order;
  anonymous closes and unrelated older orders cannot. Confirming flat state
  checks all positions, regular orders and eight algo kinds; it never restarts
  tasks. The exchange panel exposes an explicit confirmation button.
- Algo cancellation is shown only for a transport that explicitly advertises
  it. Bulk cancellation stops on its first failed/uncertain command. Switching
  users prevents later old-account cancellations and stale close confirmations.
- The full frontend suite passed 1235 tests with 6 skipped before the final
  cancellation UI guards; the final affected selection adds four cases and
  passes all 29 tests. Native checks pass 46 tests with 2 skipped. Center final
  non-integration regression passes 234 tests; its fencing selection passes
  all 26 cases and mypy passes 123 files.
  Typecheck and production build pass. Browser checks use synthetic native/API
  responses for flat success, outstanding orders and ordinary/algo actions.
- No real order, cancellation or close was sent, and no production service,
  package or key was changed. Execution flags remain disabled. No release or
  version bump has been performed; automatic takeover/standby deployment is
  still unfinished.

### 2026-10-19: native manual opening and submission receipts

- The live order entry now routes to native signing/center fencing for a
  server-bound preparation. It supports limit/market entry, explicit base
  quantity or margin/leverage sizing, attached market TP/SL, and partial
  reduce-only closing. Price ticks, contract currency/value, fractional lot
  size, minimum/maximum order size, available positions and hedge/net direction
  are validated before a write. Portfolio-margin cross entry is explicitly
  unsupported. A stale market reference is rechecked after queueing and again
  after the durable SQL commit; no simulated price or business fallback is used.
- A different leverage is its own durable intent. Only the required isolated
  hedge leg is changed, and a matching exchange ACK is required before the
  order is sent. An uncertain leverage response retains the center barrier;
  a matching later configuration snapshot cannot settle it. Ambiguous leverage
  proof and generic amendments remain unfinished rather than being guessed.
- The renderer persists one scoped client request ID before submission. An
  error or reload retains it; a retry returns the original receipt or verified
  exchange order rather than creating another order. Different parameters are
  blocked while the old request is unresolved. Verified rejection/not-sent
  outcomes permit a new explicit submission.
- Exchange settings now includes `核对上次下单`. Its native path only queries
  the original ledger/order and may fence an old missing request; it never sends
  a financial command. Only a verified accepted, reconciled, rejected or fenced
  not-sent result clears the pending renderer ID. Empty, malformed, wrong-ID
  receipts and unknown outcomes remain blocked. Original instrument specs are
  retained with the SQL command for quantity normalization after restart.
- Every native send retains the originating login and account guard throughout
  preparation and HTTP-slot queueing. Credential/login changes cannot redirect
  a prepared old action into a newly selected account. A native overlapping
  manual action is rejected, rather than waiting in a hidden financial queue.
- Validation: frontend full suite 1246 passed/6 skipped; native 53 passed/2
  ignored; center 237 non-integration passed/32 integration deselected, mypy
  passed for 123 files. Typecheck/build passed. Browser fixture verified unknown
  results retain the ID, changed quantity cannot send, and the explicit receipt
  check makes no additional order call. All financial responses were synthetic;
  no real order, leverage change or credential/grant mutation was performed.
- Still unfinished: dispatching manual actions through an already-running
  account worker, private runtime packaging/Tauri lifecycle, shortline dispatch,
  paid standby enrollment/service deployment and full outage/shutdown acceptance.
  Production execution flags remain disabled; version remains 0.2.205 and no
  GitHub tag/build/deployment was triggered for this incomplete migration.

### 2026-10-19: native automatic-worker preparation and lifecycle

- Added authenticated native registration/bundle synchronization. X25519,
  HKDF, AES-GCM and bounded zlib decoding recover the server-signed document in
  Rust. Current center authority keys, exact signed bytes, server subject,
  center Key and server-bound OKX environment/credential must match before a
  scoped DPAPI commit. No preparation, model key or exchange secret reaches
  renderer state. Failed synchronization keeps the prior preparation.
- Native launch accepts a fixed compiled resource executable only. Full file
  hashes, exact manifest inventory, path/type checks and source/bytecode/env
  rejection precede launch. A required Windows Job Object is installed before
  giving the child any task/key. Fixed stdin protocol, bounded status output and
  an OS-only environment replace renderer-controlled paths or secret arguments.
- Fixed the existing Windows Job Object ABI and OpenProcess rights. Both its
  actual layout and termination of a real harmless child are verified. Trading
  children now use this mechanism as a mandatory startup condition.
- Added native account generations, synchronous credential/Key invalidation,
  login/mode lifecycle subscriptions and persisted opt-in. Manual stop survives
  a renderer reload. Cached preparations may only restore previously enabled
  workers; they never call enrollment or task creation. The child independently
  verifies current center authorization and restores its committed SQLite state.
- Tray hiding preserves the worker. Accepted application exit stops new work,
  waits for a matching checkpoint/stop receipt and reaps the child; a 45-second
  deadline terminates an unresponsive process as unconfirmed. The updater drains
  before invoking its installer and fences starts after a successful install.
  A missing/wrong receipt, nonzero exit or stale running signal cannot be shown
  as a clean stop or current ownership. Lifecycle SQL survives a parent crash.
- Data configuration now shows preparation, installation and actual worker
  states separately, with explicit sync/start/stop controls. A missing binary
  disables activation. Browser fixtures verify offline sync failure, existing
  native startup, stop/reload, missing-artifact gating and logout boundaries.
  These are synthetic account responses, never live trading acceptance.
- Private build and public compiled-artifact assembly scripts now reject
  undeclared/altered files and private source. The first build reached MSVC;
  localized clcache diagnostic decoding failed under concurrent compilation.
  Its failing module succeeds alone; a serial diagnostic rebuild is ongoing.
  Source changed during that diagnostic build, so it is not eligible for release.
  A fresh current-source build, compiled self-test, resource bundle mapping and
  signed release assembly must still pass. Keep production flags off.
- Verified checkpoint: frontend full suite 1252 passed/6 skipped; native full
  suite 62 passed/2 ignored before the final account-generation and recipient
  envelope cases; all 8 affected native execution cases then passed before the
  final recipient crypto test. Private executor selection 69 passed before the
  final status/fingerprint additions; those affected selections pass separately.
  TypeScript typecheck and production build pass. Final totals will be refreshed
  after the packaging repairs. No version bump, tag, installer or deployment.
- Remaining activation work includes the dedicated shortline dispatcher,
  manual actions under an already-running worker, paid standby enrollment and
  deployment, remaining configuration sync and full three-end outage acceptance.
  Hunter remains deferred and hidden for every role.

### 2026-10-20: account-switch races and build shutdown boundary

- Context replacement now captures its generation and signals the retiring
  worker under the same native context lock. A delayed old context or stop
  command cannot borrow a newer account's generation or signal its process.
  Status rechecks account binding after waiting for the operation lock and
  only reports a worker with the exact matching generation.
- Removed the release script's forced `taskkill /F`. Packaging now reads the
  process inventory and stops if the trading desktop is still running or the
  inspection fails. The operator must use the normal exit path so checkpoint
  and exchange receipts can finish before files are rebuilt.
- Verified: 4 account-generation native cases, 8 renderer lifecycle cases and
  6 artifact/build-boundary Node cases pass. Typecheck and the latest production
  frontend build pass. Earlier full suites: frontend 1253 passed/6 skipped,
  native 65 passed/2 ignored, private executor selection 73 passed. These full
  counts precede the additional generation/build tests; they are not claims
  about a freshly rerun combined suite.
- The serial diagnostic C/link build completed. A fresh build using the
  current private source is running with one compiler job and the existing
  cache. It must pass source fingerprint validation, compiled self-test,
  private-module report verification and exact native file inventory before
  assembly. A real compiled-executable native smoke test is prepared; it uses
  only self-test and an invalid bootstrap, with no task/account authorization
  or financial requests. Production activation and version release remain off.

### 2026-10-20: committed task projection and hydration continuity

- AI trading now includes a native read-only SQL task snapshot. Its database
  location is DPAPI sealed to the server/user and current credential/Key
  binding. The reader requires the exact database version and completed
  bootstrap/replication owner, uses a consistent read-only transaction, and
  projects only own live non-Hunter task IDs/names/symbols/status/timestamps.
  Model credentials, prompts and arbitrary SQL never reach the renderer.
- Record status is explicitly separate from current execution ownership.
  Pending checkpoints, the last acknowledged sequence and the 500-task bound
  remain visible. A missing database is not created by reading. Failed reads
  and account changes clear the visible projection rather than retaining a
  previous user's task names. The projection cannot start or edit a task.
- Boot auth hydration no longer retires a native worker during webview reload.
  Explicit logout and virtual-mode changes still retire it. Native context
  requests serialize; superseded queued accounts are discarded. A snapshot
  reader mounting before the boot listener cannot suppress opted-in restore.
- Native generation checks read scope and generation under the same context
  mutex, and binding checks revalidate after local credential I/O. Credential
  and center-Key commits invalidate both before and after persistence so an
  intervening handshake cannot retain old credentials. Editing a local secret
  or passphrase clears server binding; a label-only change preserves it.
- The build-delivery scripts now validate a fixed same-repository asset and
  both ZIP/manifest digests. Real Windows ZIP cases cover traversal, links,
  device names and case collisions. No private-repository token is needed.
  Final artifact pin/resource mapping awaits the current compiled self-test.
- Verified: full frontend 1257 passed/6 skipped before the final two hydration
  cases; all 13 affected lifecycle cases pass. Native full 71 passed/3 ignored
  before the final binding case; all 25 affected exchange cases and 16 execution
  cases pass separately. Node artifact/build tests: 10 passed. Typecheck and
  latest production frontend build pass. Browser fixtures verify business
  outage snapshot reads, pending checkpoints, refresh/logout clearing, and
  auth hydration plus reload without a native stop. Screenshot inspected.
- Full offline task detail/history integration, business-server runtime
  projection, manual dispatch under an active worker, shortline and paid
  standby deployment remain activation work. Hunter remains hidden/deferred.

### 2026-10-20: compiler compatibility and private CI delivery

- Latest desktop checks: frontend 1259 passed/6 skipped, native 72 passed/3
  ignored, Node delivery/build checks 10 passed; typecheck and production build
  pass. Browser snapshot and hydration/reload checks pass with synthetic data.
  The ignored compiled-distribution check still requires a validated artifact.
- The complete Nuitka 4.2 binary linked, but its self-test failed during the
  FastAPI deferred-annotation import. A private diagnostic build located the
  failure; it is explicitly marked ineligible for distribution. No manifest,
  installer, draft asset or client version was published from that binary.
- Pinned Nuitka 4.3.1, verified its official source digest, and compiled the
  failing model separately. The compiled model now imports and constructs
  successfully. The build rejects a compiler version differing from its pin.
- Private backend commit `4fcebfc` is pushed on `codex/desktop-local-executor`.
  Its clean Windows CI passes dependency installation and executor checks and
  is compiling the full native worker. The local private selections pass 76
  executor/distribution tests and 62 sync/binding/deferred-feature tests.
- The private builder now emits a flat native ZIP and the exact six-field
  descriptor consumed by the public desktop's pinned-asset reader. The private
  workflow retains verified delivery separately from private failure logs.
  The public workflow still needs the successful artifact pin/resource mapping
  before it can build an installer containing the worker. Production flags stay
  off, and the desktop version is still 0.2.205.
