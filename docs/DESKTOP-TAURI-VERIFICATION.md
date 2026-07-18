# Tauri Desktop (macOS arm64) — Interactive Verification Checklist

The autonomous Tauri implementation (Slice 5 / G006 clusters C1–C6) is complete and
verified up to the automatable ceiling: the payload, `src-tauri` scaffold, Rust
sidecar supervisor, desktop auth bootstrap, WebView/window/lifecycle logic, the
ad-hoc-signed `.app`, and a headless installable DMG all build and pass
non-interactive checks on `ssh macbook`.

The items below require a **human at the physical Mac** (GUI interaction) and/or
**Apple credentials** (Developer ID + notarization). They gate Electron removal
(C9) and the 1.2.0 release.

## Build the artifacts (on the Mac)

```sh
ssh macbook
cd ~/workspace/gajae-app
npm ci
npm run server:payload:macos          # darwin-arm64 Node payload + externalBin (~14 min)
npm run tauri -- build                 # ad-hoc .app (+ cosmetic DMG fails headlessly — expected)
npm run desktop:dmg:macos              # functional DMG via hdiutil + sha256
```

Artifacts:
- `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Gajae App.app` (ad-hoc, arm64)
- `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Gajae-App_0.2.0_aarch64.dmg` (+`.sha256`)

## C7 — Interactive GUI smoke (human at the Mac)

Because the `.app` is ad-hoc-signed (not notarized), first launch needs a Gatekeeper
bypass: right-click the app → Open, or `xattr -dr com.apple.quarantine "<path>/Gajae App.app"`.

- [ ] **Launch**: DMG mounts, drag `Gajae App` → Applications, launch. One sidecar
      process, loopback random port, key bootstrap succeeds, `/health` verified, the
      window shows the React UI (not the recovery screen).
- [ ] **Bootstrap origin**: DevTools/network shows `/api`, `/ws`, `/shell`, EventSource
      all hitting `http://127.0.0.1:<ephemeral>` with the host-only key cookie.
- [ ] **Terminal**: open a terminal tab, type/run a command, resize — input/output/resize work.
- [ ] **Editor**: open a file, edit, save — round-trips.
- [ ] **Job (GJC web execution)**: create a job → live stream → abort → resume →
      diff → commit. RUN/DONE/INTERRUPTED badges correct; completion push notification fires.
- [ ] **Window close keeps job alive**: with a job running, close the window (red button /
      Cmd-W). Confirm the server/sidecar PID persists and the job keeps advancing. Reopen
      via Dock → the window returns and the timeline replays with no gaps/dupes.
- [ ] **Cmd-Q graceful**: with a job running, Cmd-Q. App performs graceful shutdown; on
      next launch the job shows `interrupted` and can be explicitly resumed. (If the
      shutdown fence fails, the app should stay open with an error, not fake a clean quit.)
- [ ] **Deep link**: `open gajae-app://...` routes to the running window.
- [ ] **Recovery/Retry**: simulate a sidecar failure (e.g. occupy the port) → embedded
      diagnostic + explicit Retry (no silent auto-restart).

## C8 — Electron ↔ Tauri install/upgrade/rollback drill (human at the Mac)

Use a disposable test account or APFS snapshot. Do **not** delete `~/.gajae-app`
(durable data lives outside the `.app`).

- [ ] **A. Tauri fresh install**: install + smoke (above). Window-close and Cmd-Q lifecycle verified.
- [ ] **B. Electron → Tauri upgrade**: create fixtures + a running job in the current
      Electron build, quit (job → interrupted), replace only the `.app` with Tauri, verify
      sessions/projects/jobs/worktrees/events survive and interrupted resume works, no duplicate
      server/authority.
- [ ] **C. Tauri → Electron rollback**: quit Tauri (fence), replace `.app` with the retained
      Electron build (same post-Slice-4 server payload), verify health + fixtures + resume; round-trip
      back to Tauri with no event dup/loss or schema drift.
- [ ] **D. Failure recovery**: bad/missing sidecar, occupied port, native-addon load failure,
      unexpected sidecar exit — each shows bounded diagnostics, no data mutation, and rollback to
      Electron recovers.

Record for each step: DMG sha256, app/desktop/server versions, PID/process tree, `/health`,
job state/lastSequence, DB schema version, smoke result. Keep both artifacts until rollback passes.

## Optional — Developer ID signing + notarization

The macbook currently has **no Developer ID certificate** and **no notarization
credentials** (`security find-identity -v -p codesigning` → 0 valid; `xcrun notarytool
history` → "Must provide credentials"). The current Electron build also ships unsigned
(`build.mac.notarize: false`), so ad-hoc parity matches today's bar.

To ship a Gatekeeper-clean (notarized) DMG instead, provide on the Mac:
- A **Developer ID Application** certificate in the login keychain.
- Notarization creds: either `xcrun notarytool store-credentials` profile, or
  `APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH` (App Store Connect API key).

Then set `src-tauri/tauri.conf.json` `bundle.macOS.signingIdentity` to the Developer ID
identity and export the notarization env before `npm run tauri -- build`; Tauri will
sign + notarize + staple.

## C9 — Electron removal (only after C7 + C8 pass)

Once the interactive smoke and the full rollback drill pass, remove Electron
(`electron/`, `scripts/release/prepare-desktop-app.js`, Electron scripts/config,
`electron` + `electron-builder` deps) — keeping the Windows Job Object code — then
re-run `npm run verify`, the mac cargo/DMG build, and the mac smoke, and confirm
`electron|electron-builder|ELECTRON_` is absent from non-historical source/config.
