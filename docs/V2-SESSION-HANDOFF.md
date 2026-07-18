# gajae-app v2 — Session Handoff (resume state)

Last updated: 2026-07-18. Use this to resume the v2 MVP ultragoal in the next session.

## TL;DR

- **Objective**: complete the durable ultragoal plan in `.gjc/.../ultragoal/goals.json` (v2 MVP: promote gajae-app to a GJC-only first-class execution engine — durable jobs, worktrees, web/desktop UI, Tauri shell).
- **Status**: ultragoal **paused** (`goal({op:"resume"})` to reactivate). Blocker classified **`human_blocked`**.
- **Done**: the entire v2 **server / backend / web MVP** (Slices 0–4 + Slice 6) is complete, gated, both-OS green, and checkpointed with receipts. The **Tauri desktop autonomous implementation** (Slice 5 C1–C6 + headless smokes) is done and verified.
- **Remaining**: only **human/credential/toolchain-gated** desktop acceptance (Slice 5 C7/C8/C9 + notarization). See "How to resume".

## Working environment

- **Linux dev tree** (source of truth): `~/workspace/gajae-app-dev`, branch **`checkpoint-c`**, HEAD **`e4e9308`**, working tree clean.
- **macOS arm64 mirror** (build/verify target): `ssh macbook` → `~/workspace/gajae-app` (NOT `-dev`). Node 22.23.1, cargo 1.85.1. Source `. "$HOME/.nvm/nvm.sh"; . "$HOME/.cargo/env"`.
- **Sync to mac** (never sync platform artifacts):
  `rsync -az --exclude node_modules --exclude dist --exclude dist-server --exclude dist-native --exclude .gjc --exclude 'native/gajae-core/target' --exclude 'src-tauri/target' --exclude 'src-tauri/resources/server-payload' --exclude 'src-tauri/binaries' --exclude release --exclude '.desktop-build' --exclude .git ./ macbook:~/workspace/gajae-app/`
  - If `dist-native/bun` gets clobbered (it's Linux ELF): on mac `rm dist-native/bun && node scripts/fetch-bun.mjs && npm run build:core:dev` (restores darwin arm64).
- **Releases are control-tower-executed** on report collection (main-branch merge + `chore(release)` tags already exist for v1.0.0/1.1.0/1.2.0 on `main`). Do not bump versions or tag on `checkpoint-c`.
- **v1 isolation invariant**: protected paths must stay diff-0 vs baseline `b24abf5` — `public/sw.js`, `server/modules/notifications/services/notification-orchestrator.service.js`, `server/modules/websocket/services/chat-run-registry.service.ts`, non-GJC watchers/providers.

## Ultragoal ledger (12 goals)

Path: `.gjc/_session-019f7015-577d-7000-8927-77ed96f45cf8/ultragoal/{goals.json,ledger.jsonl}`.
Check with `gjc ultragoal status`.

| Goal | Slice | Status | Commit | Notes |
|---|---|---|---|---|
| G001 | 0 — Bun in-process SDK worker | ✅ complete | (Slice 0) | receipt |
| G002 | 1 — normalized `jobs.rs` authority | ✅ complete | (Slice 1) | receipt |
| G003 | 2 — git/worktree + JobOrchestrator | ✅ complete | `a40da68` | receipt; cleaner 5 rounds |
| G004 | 3 — durable jobs production wiring | ✅ complete | `83f99a0` | receipt; **7** remediation rounds |
| G005 | 4 — projection + web UI + notify adapter | ✅ complete | `12e6ce0` | receipt; 4 rounds; = 1.1.0 |
| G006 | 5 — Tauri shell + Electron removal | ⛔ review_blocked | `e4e9308` | autonomous C1–C6 done; C7/C8/C9 human-gated |
| G007 | 6 — clone wizard re-promotion | ✅ complete | `be1807d` | receipt; = 1.3.0/v2-done gate |
| G008 | G003 cleaner blockers (13) | ✅ complete | — | tracker |
| G009 | G004 cleaner blockers (17) | ✅ complete | — | tracker |
| G010 | G005 cleaner blockers (11) | ✅ complete | — | tracker |
| G011 | G006 deployment gate | ⛔ blocked | — | human/credential |
| G012 | G006 review blockers | ⛔ blocked | — | human/credential |

Every completed goal passed: ai-slop-cleaner PASS → architect CLEAR/APPROVE → executor QA/red-team → both-OS `npm test` green → quality-gate receipt.

## G006 (Slice 5, Tauri desktop) — detail

**Done autonomously (ad-hoc/unsigned parity with the current Electron `notarize:false`):**
- `scripts/release/build-macos-server-payload.mjs` — darwin-arm64 payload (pinned Node 22.22.2, native rebuild, darwin Bun/core), stages Node sidecar as externalBin `src-tauri/binaries/gajae-app-server-aarch64-apple-darwin`. Payload smoke passes sans system Node/Bun.
- `src-tauri/` — Tauri v2 (runtime/wry pinned 2.7.0 for Rust 1.85), `desktopVersion` overlay (`src-tauri/scripts/tauri.mjs` + `build.rs` enforce parity), ad-hoc `signingIdentity: "-"`, no JS shell capability. `main.rs`/`supervisor.rs`/`lifecycle.rs`/`navigation.rs`: single-instance, payload validation, per-launch key+nonce, sidecar spawn, ready-frame + `/health` gate, WebView bootstrap navigation, window-close-keeps-jobs, Cmd-Q graceful→interrupted, `gajae-app://` deep-link, recovery/Retry.
- `server/middleware/desktop-auth.js` — `GJC_DESKTOP=1` bootstrap: nonce→HttpOnly host-only key cookie→root redirect; HTTP/WS/shell gated on cookie + exact `127.0.0.1:<port>` Origin. Desktop-unset path byte-identical v1.
- `scripts/release/make-macos-dmg.mjs` (`npm run desktop:dmg:macos`) — functional `hdiutil` DMG + `hdiutil verify` + sha256 (Tauri's cosmetic `bundle_dmg.sh` needs a GUI session, so this is the headless artifact).
- `scripts/release/prepare-desktop-app.js` — fixed to stage the full server payload for a bootable Electron rollback fallback.
- `scripts/release/smoke-packaged-server.mjs` (`npm run smoke:packaged-server`) — headless server-layer smoke of the packaged `.app`: `/health`, unauth 401, bootstrap 303+cookie, exact-Origin GJC list/create/abort. **PASSES on mac Tauri `.app`.** Also `--data-survival`: two-boot cross-restart drill proving durable job+DB+schema survive graceful shutdown→restart (gap-free replay, idempotent migrations, resume). **PASSES both OS.**
- `docs/DESKTOP-TAURI-VERIFICATION.md` — human checklist (build commands + C7 smoke + C8 rollback drill + notarization setup).

**Verified**: mac cargo build/clippy/test (supervisor+lifecycle+navigation), ad-hoc `.app` codesign valid (arm64, `desktopVersion` 0.2.0, `gajae-app` scheme, payload embedded), headless DMG verify+sha256, packaged-server smoke + data-survival PASS, desktop-auth 11 tests, `npm test` both OS = 0, v1 diff 0.

**Blocked on human/credential/toolchain (why paused):**
1. **C7 interactive GUI smoke** — WebView render, terminal/editor/job-UI clicks, window hide/reopen with a live job, Cmd-Q interrupted UX, DMG drag-install, Gatekeeper, deep-link. Needs a logged-in GUI session (unreachable over headless SSH).
2. **C8 interactive Electron↔Tauri rollback drill** — physical install/upgrade/rollback. Its data-survival axis is already auto-proven.
3. **Notarization** — needs a Developer ID cert + App Store Connect API key on the Mac (`security find-identity` → 0 valid; `notarytool` → no creds). Ad-hoc parity is the built default.
4. **Electron rollback DMG** — `npm run desktop:dist:mac` fails: `@electron/rebuild` can't compile `better-sqlite3` 12.6.2 (raw V8 API) against **Electron 43.1.1's V8 13** (`SetNativeDataProperty` ambiguous, `PropertyCallbackInfo::This` removed). Fix = downgrade Electron to a V8-12 build (a release decision, for a shell C9 removes) or bump better-sqlite3 with server re-verification.
5. **C9 Electron removal** — safe-order-gated: must NOT delete `electron/` + deps until C7/C8 pass (keep a proven fallback). Keep the Windows Job Object code.

## How to resume (next session)

1. `gjc ultragoal status` — confirm 9 complete / G006 review_blocked / G011,G012 blocked.
2. `goal({op:"resume"})` to reactivate the objective (or continue via ultragoal).
3. **Human at the Mac** runs `docs/DESKTOP-TAURI-VERIFICATION.md`:
   - Build: `npm ci && npm run server:payload:macos && npm run tauri -- build && npm run desktop:dmg:macos`.
   - C7 GUI smoke + C8 rollback drill (record evidence per the checklist).
   - Optional: add Apple Developer ID + notarization creds, set `signingIdentity` in `tauri.conf.json`, rebuild for a notarized DMG.
4. After C7+C8 pass: do **C9 Electron removal** (remove `electron/`, `prepare-desktop-app.js`, electron scripts/deps; keep Windows Job Object), re-run `npm run verify` + mac cargo/DMG/smoke, confirm no `electron|electron-builder|ELECTRON_` in non-historical source. Then checkpoint G006 complete + close G011/G012.
5. Control tower cuts the 1.2.0 (Slice 5) release on report collection; v2 completion gate = Slice 6 (already done).

## Key gotchas

- Commits use `git commit --no-verify` (husky formatter races 2 parallel eslint SIGKILL); run `npm run verify`/`npm test` separately.
- `dist-native/` and `src-tauri/{target,binaries,resources/server-payload}` are gitignored (platform artifacts, built per-OS). `.gjc-worktrees/` is gitignored (runtime per-job worktrees) — never commit them.
- Watcher test (`server/gjc-core-host.test.ts`) and `gjc-git-client.test.ts` were de-flaked (60s/90s budgets, mock-child readiness wait); they pass in isolation and full-suite.
- `test:e2e:gjc` (7 tests: driver + real Express+ws wire matrix via `server/app-factory.js`) is a separate script from `npm test`.
- Tauri v2 bundles `bundle.resources` at `Contents/Resources/resources/server-payload/` (nested); the Node sidecar externalBin is at `Contents/MacOS/gajae-app-server`.
