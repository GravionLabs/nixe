# Releasing

`.github/workflows/release.yml` builds the bundles on every pull request and manual run (`workflow_dispatch`): unsigned,
without secrets, and nothing is published. Only a push to `main` signs and notarizes the macOS bundles (aarch64 and
x86_64) and creates and publishes the release.

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
