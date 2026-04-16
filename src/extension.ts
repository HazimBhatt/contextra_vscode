import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "contextra" is now active!');

    const optimizeDisposable = vscode.commands.registerCommand('contextra.optimizePrompt', async () => {
        const editor = vscode.window.activeTextEditor;
        
        let textToOptimize = '';
        let isFromClipboard = false;

        if (editor && !editor.selection.isEmpty) {
            // Get selected text
            textToOptimize = editor.document.getText(editor.selection);
        } else {
            // Fallback to clipboard if no text is selected
            textToOptimize = await vscode.env.clipboard.readText();
            isFromClipboard = true;

            if (!textToOptimize.trim()) {
                vscode.window.showWarningMessage('Contextra: No text selected and clipboard is empty.');
                return;
            }
        }

        // Run optimization with a progress indicator
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Contextra: Optimizing Prompt...",
            cancellable: false
        }, async (progress) => {
            try {
                // Get configurations
                const config = vscode.workspace.getConfiguration('contextra');
                const apiUrl = config.get<string>('apiUrl', 'http://localhost:3000/api/optimize');
                const activeRepoId = config.get<string>('activeRepoId', '');
                const authToken = config.get<string>('authToken', '');
                const previewBeforeReplace = config.get<boolean>('previewBeforeReplace', true);

                if (!activeRepoId) {
                    throw new Error('Please configure "contextra.activeRepoId" in VS Code settings.');
                }

                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                };
                
                if (authToken) {
                    headers['Authorization'] = `Bearer ${authToken}`;
                }

                // Make API request (built-in fetch is available in modern Node.js/VS Code environments)
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ 
                        activeRepoId, 
                        rawPrompt: textToOptimize 
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const errorMsg = (errorData as any)?.error || `Status: ${response.status} ${response.statusText}`;
                    throw new Error(`API failed: ${errorMsg}`);
                }

                const data = await response.json() as { 
                    optimizedPrompt?: string, 
                    tokensUsed?: number, 
                    originalTokensEstimate?: number 
                };
                
                if (!data || !data.optimizedPrompt || !data.optimizedPrompt.trim()) {
                    throw new Error('API returned an empty or invalid response.');
                }

                const optimizedText = data.optimizedPrompt;
                const stats = data.tokensUsed != null && data.originalTokensEstimate != null 
                    ? `\n\nTokens Used: ${data.tokensUsed} (Original Estimate: ${data.originalTokensEstimate})`
                    : '';

                // Optional preview step
                if (previewBeforeReplace) {
                    const action = await vscode.window.showInformationMessage(
                        'Replace with optimized prompt?',
                        { modal: true, detail: optimizedText + stats },
                        'Replace'
                    );

                    if (action !== 'Replace') {
                        vscode.window.showInformationMessage('Contextra: Optimization cancelled.');
                        return;
                    }
                }

                // Apply changes
                if (!isFromClipboard && editor) {
                    // Replace the currently selected text
                    await editor.edit(editBuilder => {
                        editBuilder.replace(editor.selection, optimizedText);
                    });
                    vscode.window.showInformationMessage('Contextra: Prompt replaced successfully!');
                } else {
                    // If text was from clipboard or no active editor, put it back to clipboard
                    await vscode.env.clipboard.writeText(optimizedText);
                    if (editor) {
                        // Optionally, if they are in an editor but had no selection, we can insert it at cursor
                        const action = await vscode.window.showInformationMessage(
                            'Optimized text copied to clipboard. Insert at cursor?',
                            'Insert'
                        );
                        if (action === 'Insert') {
                            await editor.edit(editBuilder => {
                                editBuilder.insert(editor.selection.active, optimizedText);
                            });
                        }
                    } else {
                        vscode.window.showInformationMessage('Contextra: Optimized prompt copied to clipboard!');
                    }
                }

            } catch (error: any) {
                console.error('Contextra Optimization Error:', error);
                vscode.window.showErrorMessage(`Contextra: Failed to optimize prompt. ${error.message || ''}`);
            }
        });
    });

    context.subscriptions.push(optimizeDisposable);
}

export function deactivate() {}

