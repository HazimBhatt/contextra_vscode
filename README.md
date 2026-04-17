# Contextra

Contextra reads your prompt's intent and auto-injects only the relevant slices of your codebase — cutting token costs and making AI outputs dramatically more precise.

## Features

- **Zero-config.** Open any Git workspace — Contextra detects the repo, registers a session with the backend, and stores a token securely. No manual URL copying, no manual token setup.
- **One shortcut.** Select a prompt (or copy it to your clipboard) and press **Ctrl+Shift+O** (⌘⇧O on macOS). Contextra attaches the active file's relevant context, calls the optimizer, and replaces the selection / copies the result.
- **Offline fallback.** If the backend is unreachable, Contextra still returns a locally-assembled prompt with the file context baked in, so your flow never blocks.
- **Status at a glance.** A status-bar item shows `$(check) Contextra` when connected, `$(plug) Contextra: Offline` when not. Click it to reconnect.

## Usage

1. Open a workspace folder (Git recommended — Contextra uses the `origin` remote URL as the stable repo fingerprint).
2. On first activation, Contextra POSTs to `${apiBaseUrl}/session` with your `machineId` and repo metadata; the server returns a token and `repoId`. Token is stored in VS Code's encrypted `SecretStorage`; `repoId` in workspace state.
3. Write or copy a prompt. Either select it in the editor or keep it on your clipboard.
4. Press **Ctrl+Shift+O** (⌘⇧O). The extension sends `{ repoId, rawPrompt, fileContext }` to `${apiBaseUrl}/optimize` with a Bearer token. The optimized result replaces your selection or lands on your clipboard.

### Commands

| Command                    | Description                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `Contextra: Optimize Prompt` | Optimize the selected text (or clipboard). Default: Ctrl+Shift+O. |
| `Contextra: Connect`       | Re-run the session bootstrap against the current `apiBaseUrl`. |
| `Contextra: Sign Out`      | Clear the stored token and repo ID for this workspace.        |
| `Contextra: Show Status`   | Modal summary of current session state.                       |

## Settings

| Setting                       | Default                        | Purpose                                                   |
| ----------------------------- | ------------------------------ | --------------------------------------------------------- |
| `contextra.apiBaseUrl`        | `http://localhost:3000/api`    | Base URL for the Contextra backend.                       |
| `contextra.previewBeforeReplace` | `true`                      | Show a preview dialog before replacing the selected text. |

Token and repo ID are **not** settings — they are managed automatically per workspace.

## Backend contract

Contextra expects three HTTP endpoints rooted at `apiBaseUrl`:

- `POST /session`
  - Request: `{ machineId: string, repo: { url: string, name: string, fingerprint: string } }`
  - Response: `{ token: string, repoId: string }`
- `POST /optimize` (requires `Authorization: Bearer <token>`)
  - Request: `{ repoId: string, rawPrompt: string, fileContext: { relPath, language, startLine, endLine, snippet } | null }`
  - Response: `{ optimizedPrompt: string, tokensUsed?: number, originalTokensEstimate?: number }`
- `GET /health`
  - Response: any 2xx means "reachable".

If `POST /optimize` returns 401 or 403, the extension clears its token and re-bootstraps once before falling back.

## Development

```bash
npm install
npm run compile      # or: npm run watch
```

Press **F5** inside VS Code with this repo open to launch the Extension Development Host.

## License

MIT — see [LICENSE](LICENSE).
