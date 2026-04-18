# Contextra

Contextra reads your prompt's intent and auto-injects only the relevant slices of your codebase — cutting token costs and making AI outputs dramatically more precise.

## How it works

1. You sign in on the Contextra **web dashboard** and link a repository to your account there.
2. The dashboard issues you an API **token** that is already bound to your chosen repository — the VS Code extension never guesses which repo you mean.
3. The extension stores that token securely and calls the backend with it. The server answers "which repo does this token belong to?" and all subsequent optimize calls are scoped to that repo automatically.

You change the repo binding from the dashboard, not from VS Code.

## First-time setup

1. Install the extension (see **Install** below).
2. Click the **Contextra** shield icon in the left activity bar. The welcome view shows a **Connect Account** button.
3. Click **Connect Account**. Your browser opens `${contextra.webUrl}/vscode-connect?callback=vscode://contextra.contextra/auth`.
4. Sign in on the dashboard if you aren't already, and make sure a repository is marked active.
5. The bridge page reads your session cookie, calls `/api/vscode-auth` server-side, and redirects back to VS Code via the `vscode://` URI handler with `?token=…&repoId=…&repoName=…`.
6. The extension stores the token in SecretStorage and the repo in workspaceState. The sidebar switches to the connected view. No token pasting.

## Daily use

1. Select your prompt in the editor (or copy it to your clipboard).
2. Press **Ctrl+Shift+O** (⌘⇧O on macOS), or click **Optimize Prompt** in the Contextra sidebar.
3. The extension sends `{ rawPrompt, fileContext, repoId }` to `${apiBaseUrl}/optimize` with your Bearer token, previews the optimized prompt, and either replaces your selection or copies to clipboard.

If the server is unreachable, Contextra falls back to a locally-assembled prompt (file context + your text) so the flow never blocks.

## How storage works

| What              | Where stored                              | Lifecycle                                         |
| ----------------- | ----------------------------------------- | ------------------------------------------------- |
| API token         | VS Code **SecretStorage** (OS keychain)   | Cleared by `Contextra: Sign Out` or invalid-token. |
| Repo ID + name    | VS Code **workspaceState** (per-folder)   | Cleared by `Contextra: Sign Out`.                 |
| `apiBaseUrl`, `webUrl`, `previewBeforeReplace` | User/Workspace **settings.json** | You manage these in VS Code settings.             |

The token **never** lands in `settings.json` or in your Git repo. `SecretStorage` is encrypted by the OS (Windows Credential Manager / macOS Keychain / libsecret on Linux).

Legacy `contextra.authToken` and `contextra.activeRepoId` settings from earlier versions are auto-migrated into SecretStorage / workspaceState on first activation; you can then remove them from `settings.json`.

## Commands

| Command                       | Default shortcut | Description                                         |
| ----------------------------- | ---------------- | --------------------------------------------------- |
| `Contextra: Optimize Prompt`  | Ctrl+Shift+O     | Optimize the selected text (or clipboard content).  |
| `Contextra: Connect Account`  | —                | Open the login page and paste a token back.        |
| `Contextra: Sign Out`         | —                | Clear token + repo from this workspace.             |
| `Contextra: Show Status`      | —                | Modal showing current session state.                |
| `Contextra: Focus View`       | —                | Jump to the Contextra sidebar.                      |

## Settings

| Key                               | Default                       | Purpose                                                          |
| --------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `contextra.apiBaseUrl`            | `http://localhost:3000/api`   | Base URL for the API (`/me`, `/optimize`, `/health`).            |
| `contextra.webUrl`                | `http://localhost:3000`       | Web dashboard base URL (used to open `/sign-in`).                  |
| `contextra.previewBeforeReplace`  | `true`                        | Show a preview dialog before replacing the selection.            |

## Backend contract

Endpoints used by the extension:

- **`GET {webUrl}/vscode-connect?callback=vscode://...`** — browser-side bridge page. Reads the user's session cookie and redirects to the VS Code callback URI with `?token=…&repoId=…&repoName=…`.
- **`GET {webUrl}/api/vscode-auth`** — cookie-authenticated endpoint the bridge page calls. Returns `{ token, repoId, repoName }` based on the user's session + their currently-active repo.
- **`POST {apiBaseUrl}/optimize`** — `Authorization: Bearer <token>` → request `{ repoId, rawPrompt, fileContext | null }`, response `{ optimizedPrompt, tokensUsed?, originalTokensEstimate? }`.
- **`GET {apiBaseUrl}/health`** — any 2xx means reachable.

A 401/403 on `/optimize` signs the user out locally and shows a reconnect prompt.

## Install

Build and install into your regular VS Code (no Extension Development Host):

```bash
npm install
npm run install-local
```

`install-local` packages a `.vsix` and installs it via the `code` CLI. If the `code` CLI isn't on PATH, do it manually:

```bash
npm install
npm run package-vsix        # produces contextra.vsix
```

Then in VS Code: **Ctrl+Shift+P → Extensions: Install from VSIX...** → pick `contextra.vsix` → **Reload Window**.

## Development

```bash
npm install
npm run watch     # webpack watch mode
```

Press **F5** to launch an Extension Development Host for iteration. For installed-in-real-VS-Code testing, use `npm run install-local`.

## License

MIT — see [LICENSE](LICENSE).
