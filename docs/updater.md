# Auto update

Nixe updates itself with [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) from the latest GitHub release.
The plugin and the restart (`tauri-plugin-process`) are desktop only.

## Use

- **Nixe → Check for Updates…** (macOS) or **Help → Check for Updates…**, the command palette, or the version button
  in the toolbar (`v<running version>`).
- A check runs **only** when you ask for it. Nixe makes no other network call to look for updates, not at startup and
  not on a timer.
- If a newer version exists, the dialog shows its release notes and **Install and restart**. The package is
  downloaded and its signature is verified against `plugins.updater.pubkey` before it is installed. Unsaved text of
  the editor is written to disk before the installer starts (Windows quits the app when the installer runs).
- An error names the failed step ("Check for updates failed", "Update failed"). After a failed install the update
  stays in the dialog, so **Retry: Install and restart** needs no new check.
- Pre-releases (`1.2.0-rc011`) are not offered to a stable install: the endpoint is `releases/latest`, which GitHub
  resolves to the newest non-pre-release, and the app also ignores a pre-release answer when it runs a stable version.

## Configuration

`src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "<public key>",
    "endpoints": ["https://github.com/GravionLabs/nixe/releases/latest/download/latest.json"]
  }
}
```

`src-tauri/capabilities/desktop.json` grants `updater:default` and `process:allow-restart` on macOS, Windows and Linux.

## Signing

Update packages are signed with a Tauri updater key pair. It is **not** the Apple certificate.

1. Generate it once: `pnpm tauri signer generate -w ~/.tauri/nixe.key` (choose a password).
2. Put the content of `nixe.key.pub` into `plugins.updater.pubkey` (the repository ships a placeholder until then).
3. Set the secrets: `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/nixe.key` and
   `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo GravionLabs/nixe`.
4. Keep the private key and its password in the password manager. Never commit them.

`createUpdaterArtifacts` is set only in `src-tauri/tauri.release.conf.json`. The release build adds it with
`--config src-tauri/tauri.release.conf.json`, so `tauri dev` and local builds need no key. Only a push to `main` gets
the two secrets, and the job fails when `TAURI_SIGNING_PRIVATE_KEY` is missing. `tauri-action` then uploads the
signed packages (`*.sig`) and `latest.json` with the installers to the release.

### Rotating the key

Installed apps trust the old public key only. After a change of `pubkey` they cannot verify a new release, so
rotate it only together with a release that every user installs by hand, or keep the old key.

## Test of the first release

Install an older build on macOS and Windows, publish a release with the updater, and update through the dialog.
