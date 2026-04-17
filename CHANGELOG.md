# Changelog

All notable changes to the "contextra" extension are documented in this file.

## [0.1.0] — 2026-04-17

### Added
- Zero-config bootstrap: detects the workspace's Git remote, registers a session with the backend, and stores the token in VS Code's `SecretStorage`.
- Status-bar item with three states (`connecting`, `online`, `offline`) that doubles as a reconnect button.
- Automatic file-context extraction (path, language, visible range capped at 200 lines) attached to every optimize request.
- Local fallback prompt when the backend is unreachable.
- Commands: `Contextra: Connect`, `Contextra: Sign Out`, `Contextra: Show Status`.

### Changed
- `contextra.apiUrl` → `contextra.apiBaseUrl` (one URL, endpoints are derived).
- Removed `contextra.activeRepoId` and `contextra.authToken` from settings — both are now managed automatically per workspace.
