# Contextra

Contextra reads your prompt's intent and auto-injects only the relevant slices of your codebase — cutting token costs and making AI outputs dramatically more precise.

## Why Contextra?

Stop pasting entire files or massive unoptimized code snippets into AI chats. Contextra analyzes what you're trying to achieve and automatically pairs your prompt with the most relevant context from your linked repository, lowering token usage and generating drastically more accurate AI responses.

## Key Features

- **Automatic Context Injection:** AI gets exactly what it needs, none of what it doesn't.
- **Secure Authentication:** Seamlessly log in via the web dashboard. Your authentication stays securely managed by the OS keychain—never stored in plaintext workspace settings.
- **Preview Before Replacing:** Ensure the assembled prompt and context are exactly what you want before it enters your AI workflow.
- **High-Performance Fallback:** If you go offline, Contextra scales back gracefully to local file context processing to keep you moving.

## Getting Started

1. Click the **Contextra** shield icon in the VS Code Activity Bar.
2. Click **Connect Account**. This will open your browser to the Contextra Dashboard.
3. Sign in and ensure your active repository is selected.
4. VS Code will automatically connect and load your session. You're ready to optimize!

## Daily Use

1. Type out your prompt in the editor and highlight it.
2. Press **Ctrl+Shift+O** (or **Cmd+Shift+O** on macOS), or click the **Optimize Prompt** button in the sidebar.
3. A preview window will show the optimized codebase context layered perfectly with your prompt.
4. Accept the changes to either replace your selection or copy it straight to your clipboard, ready for your favorite LLM chat.

## Commands

| Command | Default Shortcut | Description |
| --- | --- | --- |
| `Contextra: Optimize Prompt` | `Ctrl+Shift+O` | Build and inject context for your selected text. |
| `Contextra: Connect Account` | — | Securely log into your account. |
| `Contextra: Sign Out` | — | Remove local session securely. |
| `Contextra: Show Status` | — | Display current connection and active repository. |
| `Contextra: Select Active Repository` | — | Refresh or set the context scope to another linked project. |

## Extension Settings

You can customize your experience in VS Code Settings:

| Key | Default | Purpose |
| --- | --- | --- |
| `contextra.previewBeforeReplace` | `true` | When true, asks for your confirmation before replacing your selected text with the optimized prompt. |
| `contextra.apiBaseUrl` | `https://www.contextra.xyz/api` | The backend API used by Contextra. |
| `contextra.webUrl` | `https://www.contextra.xyz` | The web dashboard URL. |

## Build & Install

If you are building the extension from source, you can generate and install the `.vsix` file directly into VS Code by running:

```bash
npm install
npm run install-local
```

This automates the process of creating the production-ready extension package (`.vsix`) and submitting it to your local VS Code instance.

## Support & Feedback

Encountering issues or have feature requests? Please file an issue on our [GitHub repository](https://github.com/contextra/contextra-vscode/issues).

---

## License

MIT — see [LICENSE](LICENSE).


