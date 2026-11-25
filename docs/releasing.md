# Releasing

`.github/workflows/release.yml` builds the bundles on every pull request and manual run (`workflow_dispatch`): unsigned,
without secrets, and nothing is published. Only a push to `main` signs and notarizes the macOS bundles (aarch64 and
x86_64) and creates and publishes the release.

After all builds, the `checksums` job downloads the draft release assets, writes `SHA256SUMS` over the binaries (not
`*.sig`, `latest.json`) with `scripts/release-checksums.sh`, checks it and uploads it. `publish-release` waits for it.
There is no build provenance attestation: the repository is private.

The release build also signs the update packages and uploads `latest.json` for the in-app updater; see
[updater.md](updater.md).

## Browser extension

The `extension` job of `release.yml` builds `extension/` with the version of the app and zips one package per browser:
`nixe-extension-chromium-<version>.zip` and `nixe-extension-firefox-<version>.zip` (`manifest.json` at the root of the
archive). A push to `main` attaches them to the release before `SHA256SUMS` is written; other runs only build them.
The manifest holds the numeric version only (`1.2.0` for `1.2.0-rc.1`); Chromium shows the full one as
`version_name`. The pull request checks (`ci.yml`) build and test the extension too.

The store upload is manual; no store credentials are in CI:

1. Download both zips from the published release.
2. Chrome Web Store: in the [developer dashboard](https://chrome.google.com/webstore/devconsole), upload the Chromium
   zip as a new package of the item and submit it for review.
3. Firefox: on [addons.mozilla.org](https://addons.mozilla.org/developers/), upload the Firefox zip as a new version of
   the add-on. The background script is bundled, so attach the source code (the release tag) when asked.
4. After the first upload, enter the extension IDs of the stores in `src-tauri/src/native_host.rs`
   ([links.md](links.md#browser-extension-host)).

## macOS signing and notarization

Only the `build` job of a push to `main` gets the Apple secrets. Tauri signs with the hardened runtime, notarizes
through the App Store Connect API and staples the ticket; a verify step then runs `codesign --verify --deep --strict`,
`stapler validate` and `spctl -a -vv`. If one of the six secrets is missing, the release build fails and nothing is
published. Nixe has no sidecars (`externalBin`) and needs no entitlements.

| Secret                       | Content                                             |
| ---------------------------- | --------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Developer ID Application certificate (.p12), base64 |
| `APPLE_CERTIFICATE_PASSWORD` | password of the .p12                                |
| `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: <Team> (<TEAMID>)`  |
| `APPLE_API_ISSUER`           | App Store Connect issuer ID                         |
| `APPLE_API_KEY`              | App Store Connect API key ID                        |
| `APPLE_API_KEY_CONTENT`      | content of the `AuthKey_<ID>.p8` file               |

The certificate and the API key are the team-wide ones shared with poimen (GravionLabs/poimen#791); no per-app
certificate or provisioning profile is created.

### Rotating

1. Create the new Developer ID Application certificate or API key (developer.apple.com, App Store Connect), once for
   the team.
2. Update the six secrets in every GravionLabs repository that signs (`gh secret set <NAME> --repo GravionLabs/<repo>`,
   values from the password manager, never from the shell history).
3. Revoke the old certificate or key after a release from `main` with the new values has passed the verify step.
