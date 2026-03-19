import * as vscode from 'vscode';
import axios from 'axios';

// Removed hardcoded DEVICES

let currentPanel: vscode.WebviewPanel | undefined = undefined;
let currentUrl: string = 'http://localhost:3000';
let currentDevice: string = 'iphone-15-pro-max';

export function activate(context: vscode.ExtensionContext) {

    // First time setup walkthrough trigger
    const isFirstRun = context.globalState.get('emuluxe.hasRunWalkthrough', false) === false;
    if (isFirstRun) {
        vscode.commands.executeCommand('walkthroughs.select', 'emuluxe.emuluxe-vscode#emuluxe.setup');
        context.globalState.update('emuluxe.hasRunWalkthrough', true);
    }

    const checkToken = async (): Promise<{ token: string, apiUrl: string } | null> => {
        const config = vscode.workspace.getConfiguration('emuluxe');
        const token = config.get<string>('token');
        const apiUrl = config.get<string>('apiUrl') || 'https://app.emuluxe.com';

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
            return null;
        }
        return { token, apiUrl };
    };

    const startSession = async (deviceId: string, url: string) => {
        const auth = await checkToken();
        if (!auth) return;

        currentUrl = url;
        currentDevice = deviceId;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Starting ${deviceId} Simulation...`,
            cancellable: false
        }, async (progress) => {
            try {
                const res = await axios.post(`${auth.apiUrl}/api/cli/session`, {
                    device: deviceId,
                    url: url
                }, {
                    headers: { 'Authorization': `Bearer ${auth.token}` }
                });

                const { embedUrl, sessionId } = res.data;

                if (currentPanel) {
                    currentPanel.webview.html = getWebviewContent(embedUrl, auth.apiUrl);
                    currentPanel.reveal(vscode.ViewColumn.Two);
                } else {
                    currentPanel = vscode.window.createWebviewPanel(
                        'emuluxeSim',
                        'Emuluxe',
                        vscode.ViewColumn.Two,
                        { 
                            enableScripts: true, 
                            retainContextWhenHidden: true 
                        }
                    );

                    currentPanel.iconPath = vscode.Uri.parse(`${auth.apiUrl}/favicon.ico`);
                    currentPanel.webview.html = getWebviewContent(embedUrl, auth.apiUrl);
                    
                    currentPanel.onDidDispose(() => {
                        currentPanel = undefined;
                        axios.delete(`${auth.apiUrl}/api/cli/session/${sessionId}`, {
                            headers: { 'Authorization': `Bearer ${auth.token}` }
                        }).catch(() => {});
                    }, null, context.subscriptions);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Emuluxe Error: ${err.response?.data?.error || err.message}`);
            }
        });
    };

    interface EmxDevice extends vscode.QuickPickItem {
        id: string;
        locked: boolean;
    }

    const getDevices = async (auth: { token: string, apiUrl: string }): Promise<EmxDevice[]> => {
        try {
            const res = await axios.get(`${auth.apiUrl}/api/cli/devices`, {
                headers: { 'Authorization': `Bearer ${auth.token}` }
            });
            const devicesArray = res.data?.devices || [];
            
            return devicesArray.map((d: any) => ({
                label: d.name,
                description: d.os || d.brand,
                id: d.id,
                detail: d.isLocked ? `★ Requires ${d.planRequired} Plan` : undefined,
                locked: d.isLocked
            }));
        } catch (err: any) {
            vscode.window.showErrorMessage(`Emuluxe: Failed to fetch devices. ${err.message}`);
            return [];
        }
    };

    let startCommand = vscode.commands.registerCommand('emuluxe.start', async () => {
        const auth = await checkToken();
        if (!auth) return;

        const devicesList = await getDevices(auth);
        if (devicesList.length === 0) return;

        const selectedDevice = await vscode.window.showQuickPick(devicesList, {
            placeHolder: 'Select a device to simulate',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!selectedDevice) return;

        if (selectedDevice.locked) {
            const action = await vscode.window.showErrorMessage(
                `Emuluxe: ${selectedDevice.label} requires a Pro plan.`,
                'Upgrade'
            );
            if (action === 'Upgrade') {
                vscode.env.openExternal(vscode.Uri.parse(`${auth.apiUrl}/platform/billing`));
            }
            return;
        }

        const url = await vscode.window.showInputBox({ 
            prompt: 'Enter URL to simulate', 
            placeHolder: 'http://localhost:3000',
            value: currentUrl
        });
        if (!url) return;

        await startSession(selectedDevice.id, url);
    });

    let deviceCommand = vscode.commands.registerCommand('emuluxe.device', async () => {
        const auth = await checkToken();
        if (!auth) return;

        const devicesList = await getDevices(auth);
        if (devicesList.length === 0) return;

        const selectedDevice = await vscode.window.showQuickPick(devicesList, {
            placeHolder: 'Select a new device',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!selectedDevice) return;

        if (selectedDevice.locked) {
            const action = await vscode.window.showErrorMessage(
                `Emuluxe: ${selectedDevice.label} requires a Pro plan.`,
                'Upgrade'
            );
            if (action === 'Upgrade') {
                vscode.env.openExternal(vscode.Uri.parse(`${auth.apiUrl}/platform/billing`));
            }
            return;
        }
        
        if (currentPanel) {
            await startSession(selectedDevice.id, currentUrl);
        } else {
            vscode.window.showInformationMessage('No active Emuluxe simulation. Run "Emuluxe: Start Simulation" first.');
        }
    });

    let stopCommand = vscode.commands.registerCommand('emuluxe.stop', () => {
        if (currentPanel) {
            currentPanel.dispose();
        }
    });

    let loginCommand = vscode.commands.registerCommand('emuluxe.login', () => {
        const config = vscode.workspace.getConfiguration('emuluxe');
        const apiUrl = config.get<string>('apiUrl') || 'https://app.emuluxe.com';
        vscode.env.openExternal(vscode.Uri.parse(`${apiUrl}/platform/settings/integrations`));
    });

    let rotateCommand = vscode.commands.registerCommand('emuluxe.rotate', () => {
        if (currentPanel) currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'rotate' });
    });

    let screenshotCommand = vscode.commands.registerCommand('emuluxe.screenshot', () => {
        if (currentPanel) currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'screenshot' });
    });

    let inspectCommand = vscode.commands.registerCommand('emuluxe.inspect', () => {
        if (currentPanel) currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'inspect' });
    });

    context.subscriptions.push(startCommand, stopCommand, loginCommand, deviceCommand, rotateCommand, screenshotCommand, inspectCommand);
}

function getWebviewContent(url: string, apiUrl: string) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Emuluxe</title>
        <style>
            body, html { margin: 0; padding: 0; height: 100vh; width: 100vw; overflow: hidden; background: #000; display: flex; align-items: center; justify-content: center; }
            iframe { border: none; width: 100%; height: 100%; position: absolute; top: 0; left: 0; z-index: 10; }
            
            .loader-container {
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px;
                z-index: 1; animation: pulse 2s infinite ease-in-out;
            }
            .brand-logo { width: 64px; height: 64px; }
            .brand-text { 
                color: rgba(255,255,255,0.7); font-family: system-ui, -apple-system, sans-serif; font-size: 11px;
                text-transform: uppercase; letter-spacing: 4px; font-weight: 800;
            }
            @keyframes pulse { 0% { opacity: 0.6; transform: scale(0.98); } 50% { opacity: 1; transform: scale(1); } 100% { opacity: 0.6; transform: scale(0.98); } }
        </style>
    </head>
    <body>
        <div class="loader-container">
            <svg class="brand-logo" viewBox="0 0 68 68" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <linearGradient id="emxAccent" x1="0" y1="0" x2="68" y2="68" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stop-color="#0A84FF"></stop>
                        <stop offset="100%" stop-color="#00C2FF"></stop>
                    </linearGradient>
                </defs>
                <path d="M 23,12 L 45,12 A 5,5 0 0 1 50,17 L 50,51 A 5,5 0 0 1 45,56 L 23,56 A 5,5 0 0 1 18,51 L 18,17 A 5,5 0 0 1 23,12 Z" fill="none" stroke="url(#emxAccent)" stroke-width="2.5" stroke-linejoin="round"></path>
                <line x1="34" y1="23" x2="34" y2="52" stroke="url(#emxAccent)" stroke-width="2.5" stroke-linecap="butt"></line>
            </svg>
            <div class="brand-text">Initialising Engine</div>
        </div>
        <iframe id="sim-frame" src="${url}" allow="geolocation; microphone; camera; midi; encrypted-media; clipboard-read; clipboard-write; display-capture"></iframe>
        
        <script>
            // Tell the platform we are inside the IDE shell
            // This ensures the platform bypasses its proxy for locally reachable URLs (like localhost:3000)
            window.__emuluxe_installed = true;

            // Relay messages from VS Code extension to the iframe
            window.addEventListener('message', event => {
                const iframe = document.getElementById('sim-frame');
                if (iframe && iframe.contentWindow) {
                    // Forward message to the platform iframe
                    iframe.contentWindow.postMessage(event.data, '*');
                }
            });
        </script>
    </body>
    </html>`;
}

export function deactivate() {}
