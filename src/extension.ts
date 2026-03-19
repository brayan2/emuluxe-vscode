import * as vscode from 'vscode';
import axios from 'axios';

export function activate(context: vscode.ExtensionContext) {
    let currentPanel: vscode.WebviewPanel | undefined = undefined;

    let startCommand = vscode.commands.registerCommand('emuluxe.start', async () => {
        const url = await vscode.window.showInputBox({ 
            prompt: 'Enter URL to simulate', 
            placeHolder: 'http://localhost:3000' 
        }) || 'http://localhost:3000';

        const config = vscode.workspace.getConfiguration('emuluxe');
        const token = config.get<string>('token');
        const apiUrl = config.get<string>('apiUrl') || 'https://emuluxe.com';

        if (!token) {
            const action = await vscode.window.showErrorMessage(
                'Emuluxe: CLI token is missing. Please create one in your settings.',
                'Open Settings', 'Get Token'
            );
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'emuluxe.token');
            } else if (action === 'Get Token') {
                vscode.env.openExternal(vscode.Uri.parse(`${apiUrl}/platform/settings/integrations`));
            }
            return;
        }

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Starting Emuluxe Session...",
            cancellable: false
        }, async (progress) => {
            try {
                // Determine if we need to tunnel or if the URL is public
                // For simplicity in the extension, we assume the platform handles the URL resolution.
                // However, the Platform can't reach user's localhost unless it's tunneled.
                // In a real extension, we might bundle the tunnel logic or ask the user to run the CLI.
                // For this MVP, we'll assume the URL is either public or reachability is handled.
                
                const res = await axios.post(`${apiUrl}/api/cli/session`, {
                    device: 'iphone-15-pro-max',
                    url: url
                }, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const { embedUrl, sessionId } = res.data;

                if (currentPanel) {
                    currentPanel.reveal(vscode.ViewColumn.Two);
                    currentPanel.webview.html = getWebviewContent(embedUrl);
                } else {
                    currentPanel = vscode.window.createWebviewPanel(
                        'emuluxeSim',
                        'Emuluxe Simulation',
                        vscode.ViewColumn.Two,
                        { 
                            enableScripts: true, 
                            retainContextWhenHidden: true 
                        }
                    );

                    currentPanel.iconPath = vscode.Uri.parse(`${apiUrl}/favicon.ico`);
                    currentPanel.webview.html = getWebviewContent(embedUrl);
                    
                    currentPanel.onDidDispose(() => {
                        currentPanel = undefined;
                        // Optional: End session API call
                        axios.delete(`${apiUrl}/api/cli/session/${sessionId}`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        }).catch(() => {});
                    }, null, context.subscriptions);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Emuluxe Error: ${err.response?.data?.error || err.message}`);
            }
        });
    });

    let stopCommand = vscode.commands.registerCommand('emuluxe.stop', () => {
        if (currentPanel) {
            currentPanel.dispose();
        }
    });

    let loginCommand = vscode.commands.registerCommand('emuluxe.login', () => {
        const config = vscode.workspace.getConfiguration('emuluxe');
        const apiUrl = config.get<string>('apiUrl') || 'https://emuluxe.com';
        vscode.env.openExternal(vscode.Uri.parse(`${apiUrl}/platform/settings/integrations`));
    });

    context.subscriptions.push(startCommand, stopCommand, loginCommand);
}

function getWebviewContent(url: string) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Emuluxe</title>
        <style>
            body, html { margin: 0; padding: 0; height: 100vh; width: 100vw; overflow: hidden; background: #000; }
            iframe { border: none; width: 100%; height: 100%; }
            .loader { 
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                color: rgba(255,255,255,0.3); font-family: sans-serif; font-size: 10px;
                text-transform: uppercase; letter-spacing: 2px;
            }
        </style>
    </head>
    <body>
        <div class="loader">Initialising Emuluxe Shell...</div>
        <iframe src="${url}"></iframe>
    </body>
    </html>`;
}

export function deactivate() {}
