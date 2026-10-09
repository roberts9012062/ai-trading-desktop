# Desktop OKX daily earnings (v0.2.160)

The dashboard earnings analysis and today's realized earnings share a local
60-second cache and one in-flight query. In Snippet mode the native Tauri process
authenticates and signs read-only OKX calls, sends them directly to the fixed REST
Snippet host, and returns raw bill/fill rows. TypeScript aggregates Beijing days,
fees (including rebates), funding, gross earnings and cumulative earnings using
the existing display contract. No per-page signing or aggregation runs on the
product server on the healthy path.

The server authenticates the product session and delivers only that user's OKX
credential envelope. Native ephemeral X25519, HKDF-SHA256 and AES-256-GCM protect
delivery; TLS is mandatory and redirects are disabled. Credentials stay in native
memory for at most five minutes, never renderer state, localStorage, disk or logs.
Logout, credential changes and routing changes clear local state. Product
authentication and server task credentials remain on the server. The native
command accepts only three read-only analytics paths on the fixed proxy host.

Query recent bills plus archived bills to cover the requested 1–90 days, deduplicate
by bill ID, retain USDT SWAP trade/funding records, and use fills only when bills
contain no trade records (OKX demo behavior). Pagination must reach an end; stalled
cursors, limits and deadlines raise an error instead of publishing partial sums.
Ordinary network/proxy/auth failures use the existing server fallback; an
incomplete history remains an error. Server mode goes directly to the server.
Older versions and the website continue using existing endpoints.
Native requests reuse a connection pool and retry transient read-only network,
body-stream, rate-limit and gateway failures twice, signing each attempt afresh.
The first complete history is retained in session memory. Later refreshes merge a
one-hour recent overlap by bill ID and keep archived earnings, avoiding a full
90-day download every minute. A failed refresh never commits a partial snapshot.
Initial recent/archive queries use separate non-overlapping time windows and at
most two concurrent requests. Initial history is bounded to 500 pages/five minutes.
The UI shows record-count progress while first syncing a long history. A native
API-key/demo fingerprint prevents cached records from crossing an exchange
account change, including changes made from a different device.

## Verification evidence (2026-10-10, Asia/Shanghai)

- Deployed backend revision `65c00c273ad569563d8353aa7f30f59796d0ad97`, Docker healthy.
- Real authenticated native reads through `okx-rest-test.kins.eu.org`: recent
  bills, archive bills and fills all succeeded; current admin key is OKX demo.
- Full local aggregation smoke: 37 reads, 3,509 valid records, 19 days; 145.94s
  including a subsequent incremental refresh. Warm refresh needed one read.
- No trading writes or order actions in verification. Account amounts, raw rows,
  JWTs and credentials are excluded from test reports.
- Desktop suite: 952 passed, two expected skips (GPU and opt-in live smoke).
  Typecheck and production build passed. Twelve focused local analytics tests
  passed after the final progress UI change; native signing/envelope tests passed.
  Backend credential/analytics/transport/routing suite: 52 passed.

Verification: encrypted-envelope tamper/wrong-key/ownership/auth tests, native
interoperability and signing vectors, pagination/deduplication/Beijing boundaries/
rebates/funding/demo tests, mode/fallback/session/cache tests, TypeScript check,
production build, native Rust checks, signed GitHub release and Docker health.
