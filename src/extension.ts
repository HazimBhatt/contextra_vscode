import * as vscode from 'vscode';

const DEFAULT_API_BASE_URL = 'http://localhost:3000/api';
const DEFAULT_WEB_URL = 'http://localhost:3000';
const MAX_CONTEXT_LINES = 200;
const TOKEN_SECRET_KEY = 'contextra.token';
const REPO_STATE_KEY = 'contextra.repoId';
const REPO_NAME_STATE_KEY = 'contextra.repoName';

type SessionStatus = 'connecting' | 'online' | 'offline' | 'unauthenticated';

interface FileContext {
    relPath: string;
    language: string;
    startLine: number;
    endLine: number;
    snippet: string;
}

interface SessionState {
    status: SessionStatus;
    token?: string;
    repoId?: string;
    repoName?: string;
    message?: string;
}

interface OptimizeResult {
    optimizedPrompt: string;
    tokensUsed?: number;
    originalTokensEstimate?: number;
}

function extractFileContext(editor: vscode.TextEditor): FileContext | null {
    const doc = editor.document;
    if (doc.lineCount === 0) {
        return null;
    }

    const lastLineIdx = doc.lineCount - 1;
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    const language = doc.languageId;

    let range: vscode.Range;
    if (editor.visibleRanges.length > 0) {
        range = editor.visibleRanges.reduce((acc, r) => acc.union(r));
    } else {
        const cursor = editor.selection.active.line;
        const start = Math.max(0, cursor - Math.floor(MAX_CONTEXT_LINES / 2));
        const end = Math.min(lastLineIdx, start + MAX_CONTEXT_LINES - 1);
        range = new vscode.Range(start, 0, end, 0);
    }

    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(
        lastLineIdx,
        Math.max(startLine, range.end.line),
        startLine + MAX_CONTEXT_LINES - 1
    );
    const snippet = doc.getText(
        new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)
    );

    return {
        relPath,
        language,
        startLine: startLine + 1,
        endLine: endLine + 1,
        snippet
    };
}

function buildLocalPrompt(rawPrompt: string, context: FileContext | null): string {
    if (!context) {
        return `## Task\n${rawPrompt.trim()}\n`;
    }
    return (
        `## Context\n` +
        `File: ${context.relPath} (${context.language}, lines ${context.startLine}-${context.endLine})\n\n` +
        '```' + context.language + '\n' +
        context.snippet + '\n' +
        '```\n\n' +
        `## Task\n${rawPrompt.trim()}\n`
    );
}

class ContextraClient {
    private _state: SessionState = { status: 'unauthenticated' };
    private readonly _onDidChange = new vscode.EventEmitter<SessionState>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly ctx: vscode.ExtensionContext) {}

    get state(): SessionState {
        return this._state;
    }

    get apiBaseUrl(): string {
        const cfg = vscode.workspace.getConfiguration('contextra');
        const base = (cfg.get<string>('apiBaseUrl') || '').trim();
        if (base) {
            return base.replace(/\/+$/, '');
        }
        const legacy = (cfg.get<string>('apiUrl') || '').trim();
        if (legacy) {
            return legacy.replace(/\/+optimize\/?$/, '').replace(/\/+$/, '');
        }
        return DEFAULT_API_BASE_URL;
    }

    get webUrl(): string {
        const cfg = vscode.workspace.getConfiguration('contextra');
        const web = (cfg.get<string>('webUrl') || '').trim();
        if (web) {
            return web.replace(/\/+$/, '');
        }
        const derived = this.apiBaseUrl.replace(/\/+api\/?$/, '');
        return derived || DEFAULT_WEB_URL;
    }

    async restore(): Promise<void> {
        await this.migrateLegacySettings();

        const token = await this.ctx.secrets.get(TOKEN_SECRET_KEY);
        const repoId = this.ctx.workspaceState.get<string>(REPO_STATE_KEY);
        const repoName = this.ctx.workspaceState.get<string>(REPO_NAME_STATE_KEY);

        if (!token || !repoId) {
            this.setState({ status: 'unauthenticated' });
            return;
        }

        this.setState({ status: 'connecting', token, repoId, repoName });
        const reachable = await this.healthCheck();
        this.setState({
            status: reachable ? 'online' : 'offline',
            token,
            repoId,
            repoName,
            message: reachable ? undefined : `Server ${this.apiBaseUrl} unreachable`
        });
    }

    private async migrateLegacySettings(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('contextra');
        const legacyToken = (cfg.get<string>('authToken') || '').trim();
        const legacyRepoId = (cfg.get<string>('activeRepoId') || '').trim();

        if (legacyToken && !(await this.ctx.secrets.get(TOKEN_SECRET_KEY))) {
            await this.ctx.secrets.store(TOKEN_SECRET_KEY, legacyToken);
        }

        if (legacyRepoId && !this.ctx.workspaceState.get<string>(REPO_STATE_KEY)) {
            await this.ctx.workspaceState.update(REPO_STATE_KEY, legacyRepoId);
            if (!this.ctx.workspaceState.get<string>(REPO_NAME_STATE_KEY)) {
                const folderName =
                    vscode.workspace.workspaceFolders?.[0]?.name || legacyRepoId;
                await this.ctx.workspaceState.update(REPO_NAME_STATE_KEY, folderName);
            }
        }
    }

    async connect(): Promise<void> {
        this.setState({ status: 'connecting' });

        const publisher = this.ctx.extension.packageJSON.publisher || 'contextra';
        const name = this.ctx.extension.packageJSON.name || 'contextra';
        const callbackUri = await vscode.env.asExternalUri(
            vscode.Uri.parse(`${vscode.env.uriScheme}://${publisher}.${name}/auth`)
        );

        const bridgeUrl = vscode.Uri.parse(
            `${this.webUrl}/vscode-connect?callback=${encodeURIComponent(callbackUri.toString(true))}`
        );

        const opened = await vscode.env.openExternal(bridgeUrl);
        if (!opened) {
            this.setState({
                status: 'unauthenticated',
                message: 'Could not open browser.'
            });
            vscode.window.showErrorMessage(
                'Contextra: Could not open your browser. Please open it manually.'
            );
            return;
        }

        vscode.window.showInformationMessage(
            'Contextra: Finish signing in your browser — VS Code will pick up the session automatically.'
        );
    }

    async finishAuth(token: string, repoId: string, repoName?: string): Promise<void> {
        const cleanToken = token.trim();
        const cleanRepoId = repoId.trim();

        if (!cleanToken || !cleanRepoId) {
            this.setState({
                status: 'unauthenticated',
                message: 'Callback missing token or repoId.'
            });
            vscode.window.showErrorMessage(
                'Contextra: Sign-in callback was incomplete. Please try again.'
            );
            return;
        }

        await this.ctx.secrets.store(TOKEN_SECRET_KEY, cleanToken);
        await this.ctx.workspaceState.update(REPO_STATE_KEY, cleanRepoId);
        await this.ctx.workspaceState.update(REPO_NAME_STATE_KEY, repoName || cleanRepoId);

        this.setState({
            status: 'connecting',
            token: cleanToken,
            repoId: cleanRepoId,
            repoName
        });

        const reachable = await this.healthCheck();
        this.setState({
            status: reachable ? 'online' : 'offline',
            token: cleanToken,
            repoId: cleanRepoId,
            repoName,
            message: reachable ? undefined : `Server ${this.apiBaseUrl} unreachable`
        });

        vscode.window.showInformationMessage(
            `Contextra: Connected (${repoName || cleanRepoId}).`
        );
    }

    async signOut(): Promise<void> {
        await this.ctx.secrets.delete(TOKEN_SECRET_KEY);
        await this.ctx.workspaceState.update(REPO_STATE_KEY, undefined);
        await this.ctx.workspaceState.update(REPO_NAME_STATE_KEY, undefined);
        this.setState({ status: 'unauthenticated' });
    }

    async healthCheck(): Promise<boolean> {
        try {
            const res = await fetch(`${this.apiBaseUrl}/health`, { method: 'GET' });
            return res.ok;
        } catch {
            return false;
        }
    }

    async optimize(rawPrompt: string, fileContext: FileContext | null): Promise<OptimizeResult | null> {
        if (!this._state.token || !this._state.repoId) {
            return null;
        }

        try {
            const res = await fetch(`${this.apiBaseUrl}/optimize`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this._state.token}`
                },
                body: JSON.stringify({
                    repoId: this._state.repoId,
                    rawPrompt,
                    fileContext
                })
            });

            if (res.status === 401 || res.status === 403) {
                await this.signOut();
                vscode.window.showWarningMessage('Contextra: Token invalid — please reconnect.');
                return null;
            }

            if (!res.ok) {
                throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }

            const data = (await res.json()) as OptimizeResult;
            if (!data?.optimizedPrompt?.trim()) {
                throw new Error('API returned an empty response.');
            }

            this.setState({ ...this._state, status: 'online', message: undefined });
            return data;
        } catch (err: any) {
            this.setState({ ...this._state, status: 'offline', message: err?.message || String(err) });
            return null;
        }
    }

    private setState(next: SessionState): void {
        this._state = next;
        this._onDidChange.fire(next);
    }
}

class ContextraTreeItem extends vscode.TreeItem {
    constructor(label: string, iconId: string, description?: string, commandId?: string, commandTitle?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(iconId);
        if (description) {
            this.description = description;
        }
        if (commandId) {
            this.command = { command: commandId, title: commandTitle || label };
        }
    }
}

class ContextraViewProvider implements vscode.TreeDataProvider<ContextraTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly client: ContextraClient) {
        client.onDidChange(() => {
            this._onDidChangeTreeData.fire();
            void vscode.commands.executeCommand(
                'setContext',
                'contextra.isAuthenticated',
                client.state.status !== 'unauthenticated'
            );
        });
    }

    getTreeItem(item: ContextraTreeItem): vscode.TreeItem {
        return item;
    }

    getChildren(): ContextraTreeItem[] {
        const s = this.client.state;
        if (s.status === 'unauthenticated') {
            return [];
        }

        const items: ContextraTreeItem[] = [];

        const statusIcon =
            s.status === 'online' ? 'pass-filled' :
            s.status === 'offline' ? 'warning' :
            'sync~spin';
        const statusLabel =
            s.status === 'online' ? 'Connected' :
            s.status === 'offline' ? 'Offline' :
            'Connecting…';
        items.push(new ContextraTreeItem(statusLabel, statusIcon, s.message));

        if (s.repoName) {
            items.push(new ContextraTreeItem(`Repo: ${s.repoName}`, 'repo', s.repoId?.slice(0, 12)));
        }

        items.push(new ContextraTreeItem('API', 'globe', this.client.apiBaseUrl));

        items.push(new ContextraTreeItem('Optimize Prompt', 'rocket', 'Ctrl+Shift+O', 'contextra.optimizePrompt'));
        items.push(new ContextraTreeItem('Reconnect', 'refresh', undefined, 'contextra.connect'));
        items.push(new ContextraTreeItem('Sign Out', 'sign-out', undefined, 'contextra.signOut'));

        return items;
    }
}

function updateStatusBar(statusBar: vscode.StatusBarItem, client: ContextraClient): void {
    const s = client.state;
    switch (s.status) {
        case 'connecting':
            statusBar.text = '$(sync~spin) Contextra';
            statusBar.tooltip = 'Contextra: connecting…';
            statusBar.backgroundColor = undefined;
            break;
        case 'online':
            statusBar.text = '$(check) Contextra';
            statusBar.tooltip = `Contextra: connected${s.repoName ? ` (${s.repoName})` : ''}`;
            statusBar.backgroundColor = undefined;
            break;
        case 'offline':
            statusBar.text = '$(plug) Contextra: Offline';
            statusBar.tooltip = `Contextra: offline${s.message ? ` — ${s.message}` : ''}`;
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            break;
        case 'unauthenticated':
        default:
            statusBar.text = '$(sign-in) Contextra: Connect';
            statusBar.tooltip = 'Click to connect your Contextra account';
            statusBar.backgroundColor = undefined;
    }
}

async function runOptimize(client: ContextraClient): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    let rawPrompt = '';
    let replaceSelection = false;

    if (editor && !editor.selection.isEmpty) {
        rawPrompt = editor.document.getText(editor.selection);
        replaceSelection = true;
    } else {
        rawPrompt = await vscode.env.clipboard.readText();
    }

    if (!rawPrompt.trim()) {
        vscode.window.showWarningMessage('Contextra: No text selected and clipboard is empty.');
        return;
    }

    const fileContext = editor ? extractFileContext(editor) : null;

    let optimizedPrompt = '';
    let source: 'api' | 'local' = 'local';
    let tokensInfo = '';

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Contextra: Optimizing prompt…',
            cancellable: false
        },
        async () => {
            if (client.state.status === 'unauthenticated') {
                optimizedPrompt = buildLocalPrompt(rawPrompt, fileContext);
                source = 'local';
                vscode.window.showWarningMessage(
                    'Contextra: Not connected — using local fallback. Click "Connect Account" in the Contextra sidebar.'
                );
                return;
            }

            const result = await client.optimize(rawPrompt, fileContext);
            if (result) {
                optimizedPrompt = result.optimizedPrompt;
                source = 'api';
                if (
                    result.tokensUsed !== undefined &&
                    result.tokensUsed !== null &&
                    result.originalTokensEstimate !== undefined &&
                    result.originalTokensEstimate !== null
                ) {
                    tokensInfo = `\n\nTokens Used: ${result.tokensUsed} (Original Estimate: ${result.originalTokensEstimate})`;
                }
            } else {
                optimizedPrompt = buildLocalPrompt(rawPrompt, fileContext);
                source = 'local';
                vscode.window.showWarningMessage(
                    'Contextra: API unavailable — using local fallback prompt.'
                );
            }
        }
    );

    const config = vscode.workspace.getConfiguration('contextra');
    const previewBeforeReplace = config.get<boolean>('previewBeforeReplace', true);
    const primaryAction = replaceSelection ? 'Replace' : 'Copy';

    if (previewBeforeReplace) {
        const action = await vscode.window.showInformationMessage(
            `Apply optimized prompt (${source})?`,
            { modal: true, detail: optimizedPrompt + tokensInfo },
            primaryAction
        );
        if (action !== primaryAction) {
            vscode.window.showInformationMessage('Contextra: Optimization cancelled.');
            return;
        }
    }

    if (replaceSelection && editor) {
        await editor.edit(editBuilder => editBuilder.replace(editor.selection, optimizedPrompt));
        await vscode.env.clipboard.writeText(optimizedPrompt);
        vscode.window.showInformationMessage(
            `Contextra: Prompt replaced and copied to clipboard (${source}).`
        );
        return;
    }

    await vscode.env.clipboard.writeText(optimizedPrompt);
    if (editor) {
        const action = await vscode.window.showInformationMessage(
            `Contextra: Optimized prompt copied (${source}). Insert at cursor?`,
            'Insert'
        );
        if (action === 'Insert') {
            await editor.edit(editBuilder =>
                editBuilder.insert(editor.selection.active, optimizedPrompt)
            );
        }
    } else {
        vscode.window.showInformationMessage(
            `Contextra: Optimized prompt copied to clipboard (${source}).`
        );
    }
}

export function activate(context: vscode.ExtensionContext) {
    const client = new ContextraClient(context);

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'contextra.focusView';
    statusBar.show();
    context.subscriptions.push(statusBar);

    client.onDidChange(() => updateStatusBar(statusBar, client));
    updateStatusBar(statusBar, client);

    const viewProvider = new ContextraViewProvider(client);
    const treeView = vscode.window.createTreeView('contextra.view', { treeDataProvider: viewProvider });
    context.subscriptions.push(treeView);

    void client.restore();

    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri: vscode.Uri) {
                if (uri.path !== '/auth') {
                    return;
                }
                const query = new URLSearchParams(uri.query);
                const token = query.get('token') || '';
                const repoId = query.get('repoId') || '';
                const repoName = query.get('repoName') || undefined;
                void client.finishAuth(token, repoId, repoName);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('contextra.connect', () => client.connect()),
        vscode.commands.registerCommand('contextra.signOut', async () => {
            await client.signOut();
            vscode.window.showInformationMessage('Contextra: Signed out.');
        }),
        vscode.commands.registerCommand('contextra.showStatus', () => {
            const s = client.state;
            const lines = [
                `Status: ${s.status}`,
                `Repo: ${s.repoName || '—'}`,
                `Repo ID: ${s.repoId || '—'}`,
                `Token: ${s.token ? 'stored (secret)' : '—'}`,
                `API base: ${client.apiBaseUrl}`,
                `Web URL: ${client.webUrl}`,
                s.message ? `Message: ${s.message}` : ''
            ].filter(Boolean);
            vscode.window.showInformationMessage('Contextra status', {
                modal: true,
                detail: lines.join('\n')
            });
        }),
        vscode.commands.registerCommand('contextra.focusView', () => {
            void vscode.commands.executeCommand('workbench.view.extension.contextra');
        }),
        vscode.commands.registerCommand('contextra.optimizePrompt', () => runOptimize(client))
    );
}

export function deactivate() {}
