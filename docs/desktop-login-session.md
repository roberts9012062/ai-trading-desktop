# Desktop startup login and explicit local continuation

Version: v0.2.209. A saved JWT alone does not grant entry to the desktop UI.

## Startup boundary

`desktop_login_session_id` generates one PID/time identifier per native process.
`desktop-boot.ts` initializes the login gate before rendering. The renderer stores
the confirmed identifier and session mode in sessionStorage. A new native process
starts locked even if localStorage contains a valid user, access token and refresh
token. A renderer reload in the same process retains an explicit confirmation.
Unavailable native IPC or sessionStorage fails closed on subsequent reloads.

`DesktopSessionGate` wraps both main and administration layouts before they mount.
Deep links and the root redirect obey the same gate. `useAuthGuard` does not
automatically hydrate credentials while the gate is locked. Native tray restore
and the existing single-instance restore path emit `desktop-login-required`;
the root listener locks the UI without logging out or stopping authorized workers.

## Explicit offline session

The native login page offers `进入本机离线会话` only for a previously saved,
non-frozen account with a token. A click validates the account using `/api/auth/me`.
Transport failures, 5xx, 408 and 429 allow the known local identity to continue.
401/403, frozen users and mismatched account identity reject continuation; an
authoritative refusal is never treated as a network outage.

This choice always marks the session local-only, including when the probe succeeds.
The mode survives renderer reloads and account switching. Automatic hydration
after the server recovers preserves the restriction. Only explicit server login
clears it. A persistent banner provides a login link.

## Task boundary and retained data

Local-only or startup-locked sessions cannot create server tasks, start/run-once
or start realtime tasks, prepare a native executor, or explicitly start a native
worker. Checks run before transport. Stop actions and signed restoration of
previously authorized native execution retain their existing behavior. Existing
lease, continuity and emergency-stop policies still apply; this UI gate does not
authorize any new execution. Cached tokens, K lines, SQL records and native worker
preparations are retained when locking the UI.

## Verification

- Nine auth/account/task suites: 62 tests passed.
- Native `window_controls` test: one per-process identifier stability test passed.
- `scripts/verify-desktop-login.py` exercises the actual App with an isolated Edge
  context and synthetic account/HTTP fixtures: cached-token startup, deep-link
  rejection, wrong password, explicit login, same-run reload, restore locking,
  manual local entry, task creation rejection, server recovery and fresh launch.
  Evidence is written under ignored `.local-data/login-first/`; all eleven
  assertions passed with no page errors. No real account or trading writes run.
- Release CI includes the new auth suites and native identifier test in addition
  to existing continuity, market, signed updater and installation/upgrade checks.

The browser fixture does not replace native installation acceptance. Release CI
performs native packaging, signature verification and clean-install/upgrade checks.
