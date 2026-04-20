import * as vscode from 'vscode';
import * as crypto from 'crypto';

const CONTEXTRA_ORIGIN = 'https://www.contextra.xyz';
const DEFAULT_API_BASE_URL = `${CONTEXTRA_ORIGIN}/api`;
const DEFAULT_WEB_URL = CONTEXTRA_ORIGIN;
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

interface RepoSummary {
    id: string;
    fullName: string;
    isActive: boolean;
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
    private connectTimer: ReturnType<typeof setTimeout> | undefined;
    private activeTicket: string | undefined;

    constructor(private readonly ctx: vscode.ExtensionContext) {}

    get state(): SessionState {
        return this._state;
    }

    get apiBaseUrl(): string {
        return DEFAULT_API_BASE_URL;
    }

    get webUrl(): string {
        return DEFAULT_WEB_URL;
    }

    async restore(): Promise<void> {
        await this.migrateLegacySettings();

        const token = await this.ctx.secrets.get(TOKEN_SECRET_KEY);
        const repoId = this.ctx.workspaceState.get<string>(REPO_STATE_KEY);
        const repoName = this.ctx.workspaceState.get<string>(REPO_NAME_STATE_KEY);

        if (!token) {
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
        this.cancelConnectTimer();
        this.setState({ status: 'connecting', message: 'Opening browser…' });

        // Ticket flow: no vscode:// protocol handler required. The extension
        // generates a one-time ticket, the web page posts the session token
        // against it, and we poll /api/vscode-auth/claim to pick it up.
        const ticket = crypto.randomBytes(24).toString('base64url');
        this.activeTicket = ticket;

        const bridgeUrl = vscode.Uri.parse(
            `${this.webUrl}/vscode-connect?ticket=${encodeURIComponent(ticket)}`
        );

        const opened = await vscode.env.openExternal(bridgeUrl);
        if (!opened) {
            this.activeTicket = undefined;
            this.setState({
                status: 'unauthenticated',
                message: 'Could not open browser.'
            });
            vscode.window.showErrorMessage(
                'Contextra: Could not open your browser. Please open it manually.'
            );
            return;
        }

        this.setState({
            status: 'connecting',
            message: 'Waiting for browser sign-in…'
        });

        void this.pollForTicket(ticket);
    }

    private async pollForTicket(ticket: string): Promise<void> {
        const DEADLINE = Date.now() + 180_000;
        const INTERVAL = 2_000;

        while (Date.now() < DEADLINE) {
            if (this.activeTicket !== ticket) {
                return; // another connect started, or user cancelled
            }

            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 6_000);
                let res: Response;
                try {
                    res = await fetch(
                        `${this.apiBaseUrl}/vscode-auth/claim?ticket=${encodeURIComponent(ticket)}`,
                        { method: 'GET', signal: controller.signal }
                    );
                } finally {
                    clearTimeout(timer);
                }

                if (res.status === 200) {
                    const data = (await res.json()) as {
                        token: string;
                        repoId?: string;
                        repoName?: string;
                    };
                    this.activeTicket = undefined;
                    await this.finishAuth(data.token, data.repoId || '', data.repoName);
                    return;
                }

                if (res.status === 410) {
                    this.activeTicket = undefined;
                    this.setState({
                        status: 'unauthenticated',
                        message: 'Sign-in ticket expired. Please retry.'
                    });
                    return;
                }
                // 204 = not ready, 400 = bad ticket; fall through to sleep+retry
            } catch {
                // network blip — keep polling
            }

            await new Promise(r => setTimeout(r, INTERVAL));
        }

        // Polling deadline reached with no result
        if (this.activeTicket === ticket && this._state.status === 'connecting') {
            this.activeTicket = undefined;
            this.setState({
                status: 'unauthenticated',
                message: 'Sign-in timed out. Please try again.'
            });
            void vscode.window.showWarningMessage(
                'Contextra: Sign-in timed out. Did you finish signing in at the browser tab?',
                'Retry'
            ).then(choice => {
                if (choice === 'Retry') {
                    void this.connect();
                }
            });
        }
    }

    cancelConnect(): void {
        this.cancelConnectTimer();
        this.activeTicket = undefined;
        if (this._state.status === 'connecting' && !this._state.token) {
            this.setState({ status: 'unauthenticated' });
        }
    }

    private cancelConnectTimer(): void {
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = undefined;
        }
    }

    async pasteCallbackUrl(): Promise<void> {
        const raw = await vscode.window.showInputBox({
            prompt: 'Paste the vscode://… URL your browser showed (or just the token).',
            placeHolder: 'vscode://contextra.contextra/auth?token=…',
            ignoreFocusOut: true,
            validateInput: (value) => {
                const v = value.trim();
                if (!v) { return 'URL or token is required.'; }
                if (!v.startsWith('vscode') && !v.startsWith('cursor') && !v.includes('.') && v.length < 20) {
                    return 'That doesn\'t look like a valid token or callback URL.';
                }
                return undefined;
            }
        });
        if (!raw) { return; }

        const trimmed = raw.trim();
        let token = '';
        let repoId = '';
        let repoName: string | undefined;

        try {
            const uri = vscode.Uri.parse(trimmed);
            const q = new URLSearchParams(uri.query);
            token = q.get('token') || '';
            repoId = q.get('repoId') || '';
            repoName = q.get('repoName') || undefined;
        } catch {
            // treat entire input as a bare token
        }

        if (!token) {
            token = trimmed;
        }

        await this.finishAuth(token, repoId, repoName);
    }

    async finishAuth(token: string, repoId: string, repoName?: string): Promise<void> {
        this.cancelConnectTimer();
        const cleanToken = token.trim();
        const cleanRepoId = repoId.trim();

        if (!cleanToken) {
            this.setState({
                status: 'unauthenticated',
                message: 'Callback missing token.'
            });
            vscode.window.showErrorMessage(
                'Contextra: Sign-in callback was incomplete. Please try again.'
            );
            return;
        }

        await this.ctx.secrets.store(TOKEN_SECRET_KEY, cleanToken);

        if (cleanRepoId) {
            await this.ctx.workspaceState.update(REPO_STATE_KEY, cleanRepoId);
            await this.ctx.workspaceState.update(REPO_NAME_STATE_KEY, repoName || cleanRepoId);
        } else {
            await this.ctx.workspaceState.update(REPO_STATE_KEY, undefined);
            await this.ctx.workspaceState.update(REPO_NAME_STATE_KEY, undefined);
        }

        this.setState({
            status: 'connecting',
            token: cleanToken,
            repoId: cleanRepoId || undefined,
            repoName
        });

        const reachable = await this.healthCheck();
        this.setState({
            status: reachable ? 'online' : 'offline',
            token: cleanToken,
            repoId: cleanRepoId || undefined,
            repoName,
            message: reachable ? undefined : `Server ${this.apiBaseUrl} unreachable`
        });

        if (cleanRepoId) {
            vscode.window.showInformationMessage(
                `Contextra: Connected (${repoName || cleanRepoId}).`
            );
        } else {
            vscode.window.showInformationMessage(
                'Contextra: Signed in. Pick a repository to enable optimization.'
            );
            void vscode.commands.executeCommand('contextra.selectRepo');
        }
    }

    async signOut(): Promise<void> {
        this.cancelConnectTimer();
        await this.ctx.secrets.delete(TOKEN_SECRET_KEY);
        await this.ctx.workspaceState.update(REPO_STATE_KEY, undefined);
        await this.ctx.workspaceState.update(REPO_NAME_STATE_KEY, undefined);
        this.setState({ status: 'unauthenticated' });
    }

    async healthCheck(): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
            const res = await fetch(`${this.apiBaseUrl}/health`, {
                method: 'GET',
                signal: controller.signal
            });
            return res.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    private promptReconnect(reason: string): void {
        vscode.window.showWarningMessage(
            `Contextra: ${reason}`,
            'Reconnect'
        ).then(action => {
            if (action === 'Reconnect') {
                void vscode.commands.executeCommand('contextra.connect');
            }
        });
    }

    async listRepos(): Promise<RepoSummary[]> {
        if (!this._state.token) {
            return [];
        }

        console.log(`[Contextra] listRepos using token prefix=${this._state.token.slice(0, 12)}… len=${this._state.token.length}`);

        try {
            const res = await fetch(`${this.apiBaseUrl}/repos`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this._state.token}`
                }
            });

            if (res.status === 401 || res.status === 403) {
                this.promptReconnect('Your session needs to be refreshed.');
                return [];
            }

            if (!res.ok) {
                console.error(`[Contextra] listRepos failed: HTTP ${res.status} ${res.statusText}`);
                vscode.window.showErrorMessage('Contextra: Could not load repositories. Please try again.');
                return [];
            }

            const data = (await res.json()) as { repos?: Array<{ _id: string; fullName?: string; name?: string; isActive?: boolean }> };
            return (data.repos || []).map(r => ({
                id: String(r._id),
                fullName: r.fullName || r.name || String(r._id),
                isActive: !!r.isActive
            }));
        } catch (err) {
            console.error('[Contextra] listRepos error:', err);
            vscode.window.showErrorMessage('Contextra: Could not reach the Contextra server.');
            return [];
        }
    }

    async setActiveRepo(repoId: string, repoName?: string): Promise<boolean> {
        if (!this._state.token) {
            return false;
        }

        try {
            const res = await fetch(`${this.apiBaseUrl}/repos/active`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this._state.token}`
                },
                body: JSON.stringify({ repoId })
            });

            if (res.status === 401 || res.status === 403) {
                this.promptReconnect('Your session needs to be refreshed.');
                return false;
            }

            if (!res.ok) {
                console.error(`[Contextra] setActiveRepo failed: HTTP ${res.status} ${res.statusText}`);
                vscode.window.showErrorMessage('Contextra: Could not set the active repository.');
                return false;
            }

            const data = (await res.json()) as { activeRepoId?: string; activeRepoName?: string };
            const newRepoId = data.activeRepoId || repoId;
            const newRepoName = data.activeRepoName || repoName;

            await this.ctx.workspaceState.update(REPO_STATE_KEY, newRepoId);
            await this.ctx.workspaceState.update(REPO_NAME_STATE_KEY, newRepoName || newRepoId);

            this.setState({
                ...this._state,
                repoId: newRepoId,
                repoName: newRepoName,
                message: undefined
            });

            return true;
        } catch (err) {
            console.error('[Contextra] setActiveRepo error:', err);
            vscode.window.showErrorMessage('Contextra: Could not reach the Contextra server.');
            return false;
        }
    }

    async optimize(rawPrompt: string, fileContext: FileContext | null): Promise<OptimizeResult | null> {
        if (!this._state.token) {
            return null;
        }

        if (!this._state.repoId) {
            vscode.window.showWarningMessage(
                'Contextra: Pick a repository first.',
                'Pick Repository'
            ).then(action => {
                if (action === 'Pick Repository') {
                    void vscode.commands.executeCommand('contextra.selectRepo');
                }
            });
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
                    activeRepoId: this._state.repoId,
                    rawPrompt,
                    fileContext
                })
            });

            if (res.status === 401 || res.status === 403) {
                this.promptReconnect('Your session needs to be refreshed.');
                this.setState({ ...this._state, status: 'offline', message: 'Session needs refresh' });
                return null;
            }

            if (!res.ok) {
                console.error(`[Contextra] optimize failed: HTTP ${res.status} ${res.statusText}`);
                this.setState({ ...this._state, status: 'offline', message: 'Optimization failed. Please try again.' });
                return null;
            }

            const data = (await res.json()) as OptimizeResult;
            if (!data?.optimizedPrompt?.trim()) {
                console.error('[Contextra] optimize returned empty response');
                this.setState({ ...this._state, status: 'offline', message: 'No response from Contextra.' });
                return null;
            }

            this.setState({ ...this._state, status: 'online', message: undefined });
            return data;
        } catch (err) {
            console.error('[Contextra] optimize error:', err);
            this.setState({ ...this._state, status: 'offline', message: 'Could not reach Contextra.' });
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

        if (s.status === 'connecting' && !s.token) {
            items.push(new ContextraTreeItem(
                'Paste Callback URL',
                'clippy',
                'If the browser didn\'t redirect',
                'contextra.pasteCallback'
            ));
            items.push(new ContextraTreeItem(
                'Cancel',
                'close',
                undefined,
                'contextra.cancelConnect'
            ));
            return items;
        }

        if (s.repoName) {
            items.push(new ContextraTreeItem(s.repoName, 'repo', 'Active · click to change', 'contextra.selectRepo'));
        } else {
            items.push(new ContextraTreeItem('Pick Repository', 'repo', 'No repo selected', 'contextra.selectRepo'));
        }

        items.push(new ContextraTreeItem('Optimize Prompt', 'rocket', '⌘⇧O', 'contextra.optimizePrompt'));

        const apiHost = this.client.apiBaseUrl.replace(/^https?:\/\//, '').replace(/\/api$/, '');
        items.push(new ContextraTreeItem(apiHost, 'globe', 'API endpoint'));

        if (s.status === 'offline') {
            items.push(new ContextraTreeItem('Retry connection', 'refresh', undefined, 'contextra.connect'));
        }
        items.push(new ContextraTreeItem('Sign Out', 'sign-out', undefined, 'contextra.signOut'));

        return items;
    }
}

function updateStatusBar(statusBar: vscode.StatusBarItem, client: ContextraClient): void {
    const s = client.state;
    switch (s.status) {
        case 'connecting':
            statusBar.text = '$(sync~spin) Contextra';
            statusBar.tooltip = 'Contextra — connecting…';
            statusBar.backgroundColor = undefined;
            break;
        case 'online':
            statusBar.text = `$(zap) Contextra${s.repoName ? ` · ${s.repoName}` : ''}`;
            statusBar.tooltip = `Contextra — connected${s.repoName ? ` to ${s.repoName}` : ''}`;
            statusBar.backgroundColor = undefined;
            break;
        case 'offline':
            statusBar.text = '$(debug-disconnect) Contextra';
            statusBar.tooltip = `Contextra — offline${s.message ? ` · ${s.message}` : ''}`;
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            break;
        case 'unauthenticated':
        default:
            statusBar.text = '$(zap) Contextra · Sign in';
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

async function runSelectRepo(client: ContextraClient): Promise<void> {
    if (client.state.status === 'unauthenticated') {
        const choice = await vscode.window.showWarningMessage(
            'Contextra: Sign in first to pick a repository.',
            'Connect Account'
        );
        if (choice === 'Connect Account') {
            void client.connect();
        }
        return;
    }

    const repos: RepoSummary[] = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Contextra: Loading repositories…',
            cancellable: false
        },
        () => client.listRepos()
    );

    if (repos.length === 0) {
        const choice = await vscode.window.showInformationMessage(
            'Contextra: No repositories connected to your account yet.',
            'Open Dashboard'
        );
        if (choice === 'Open Dashboard') {
            void vscode.env.openExternal(vscode.Uri.parse(`${client.webUrl}/dashboard`));
        }
        return;
    }

    const currentId = client.state.repoId;

    const items = repos.map(r => ({
        label: r.fullName,
        description: r.id === currentId ? '$(check) Active' : r.isActive ? 'Active on server' : undefined,
        repo: r
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: currentId ? 'Switch active repository' : 'Pick a repository to activate',
        matchOnDescription: true
    });

    if (!picked) {
        return;
    }

    if (picked.repo.id === currentId) {
        return;
    }

    const ok = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Contextra: Activating ${picked.repo.fullName}…`,
            cancellable: false
        },
        () => client.setActiveRepo(picked.repo.id, picked.repo.fullName)
    );

    if (ok) {
        vscode.window.showInformationMessage(`Contextra: Active repo set to ${picked.repo.fullName}.`);
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
        vscode.commands.registerCommand('contextra.optimizePrompt', () => runOptimize(client)),
        vscode.commands.registerCommand('contextra.selectRepo', () => runSelectRepo(client)),
        vscode.commands.registerCommand('contextra.pasteCallback', () => client.pasteCallbackUrl()),
        vscode.commands.registerCommand('contextra.cancelConnect', () => client.cancelConnect())
    );
}

export function deactivate() {}
