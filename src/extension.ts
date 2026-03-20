import * as vscode from 'vscode';
import axios from 'axios';

// Removed hardcoded DEVICES

let currentPanel: vscode.WebviewPanel | undefined = undefined;
let currentUrl: string = 'http://localhost:3000';
let currentDevice: string = 'iphone-15-pro-max';
let statusBarItem: vscode.StatusBarItem;

interface PlanInfo {
    plan: string;
    sessionsUsedThisMonth: number;
    email: string;
}

let cachedPlan: PlanInfo | null = null;

export function activate(context: vscode.ExtensionContext) {

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

    const getPlanInfo = async (auth: { token: string, apiUrl: string }): Promise<PlanInfo | null> => {
        try {
            const res = await axios.get(`${auth.apiUrl}/api/cli/me`, {
                headers: { 'Authorization': `Bearer ${auth.token}` }
            });
            cachedPlan = res.data;
            return cachedPlan;
        } catch (err) {
            console.error('[Emuluxe] Failed to fetch plan info:', err);
            return null;
        }
    };

    // First time setup walkthrough trigger
    const isFirstRun = context.globalState.get('emuluxe.hasRunWalkthrough', false) === false;
    if (isFirstRun) {
        vscode.commands.executeCommand('walkthroughs.select', 'BrigxelSolutions.emuluxe-vscode#emuluxe.setup');
        context.globalState.update('emuluxe.hasRunWalkthrough', true);
    }

    // Proactively fetch plan info
    checkToken().then(auth => {
        if (auth) {
            getPlanInfo(auth).then(plan => {
                if (plan) updateStatusBar(plan);
            });
        }
    });

    const updateStatusBar = (plan: PlanInfo) => {
        if (!statusBarItem) {
            statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            context.subscriptions.push(statusBarItem);
        }
        statusBarItem.text = `$(account) Emuluxe: ${plan.plan.charAt(0).toUpperCase() + plan.plan.slice(1)}`;
        statusBarItem.tooltip = `Account: ${plan.email}\nSessions used: ${plan.sessionsUsedThisMonth}\nClick for billing`;
        statusBarItem.command = 'emuluxe.billing';
        statusBarItem.show();
    };

    let billingCommand = vscode.commands.registerCommand('emuluxe.billing', async () => {
        const auth = await checkToken();
        if (auth) {
            vscode.env.openExternal(vscode.Uri.parse(`${auth.apiUrl}/platform/billing`));
        }
    });

    context.subscriptions.push(billingCommand);

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
                    url: url,
                    source: 'vscode'
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
                        }).catch(() => { });
                    }, null, context.subscriptions);
                }
            } catch (err: any) {
                const errorData = err.response?.data;
                const errorCode = errorData?.error;
                const errorMsg = errorData?.detail || errorData?.error || err.message;

                if (errorCode === 'SESSION_LIMIT_REACHED' || errorCode === 'CONCURRENCY_LIMIT_REACHED') {
                    const action = await vscode.window.showErrorMessage(
                        `Emuluxe: ${errorMsg}`,
                        'Upgrade Plan'
                    );
                    if (action === 'Upgrade Plan') {
                        vscode.env.openExternal(vscode.Uri.parse(`${auth.apiUrl}/platform/billing`));
                    }
                } else {
                    vscode.window.showErrorMessage(`Emuluxe Error: ${errorMsg}`);
                }
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
            placeHolder: 'https://emuluxe.com',
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

function getWebviewContent(embedUrl: string, apiUrl: string) {
    return `<!DOCTYPE html>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; frame-src *; connect-src *; style-src * 'unsafe-inline'; font-src *;">
    <title>Emuluxe Simulation</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, html {
            height: 100vh; width: 100vw; overflow: hidden;
            background: #0d0d0d;
            display: flex; flex-direction: column;
            font-family: system-ui, -apple-system, sans-serif;
        }

        /* ── Top toolbar ── */
        #toolbar {
            display: flex; align-items: center; gap: 8px;
            padding: 6px 10px;
            background: #141414;
            border-bottom: 1px solid rgba(255,255,255,0.07);
            flex-shrink: 0;
            z-index: 100;
        }
        .tb-btn {
            background: none; border: none; cursor: pointer;
            color: rgba(255,255,255,0.5); padding: 5px; border-radius: 6px;
            display: flex; align-items: center; transition: background 0.15s, color 0.15s;
        }
        .tb-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
        .tb-btn svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

        #url-bar {
            flex: 1; display: flex; align-items: center;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px; padding: 4px 10px; gap: 6px;
        }
        #url-input {
            flex: 1; background: none; border: none; outline: none;
            color: rgba(255,255,255,0.9); font-size: 12px; font-family: inherit;
        }
        .url-lock svg { width: 11px; height: 11px; stroke: rgba(255,255,255,0.3); fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        #loading-bar {
            height: 2px; background: transparent; flex-shrink: 0;
        }
        #loading-bar.active {
            background: linear-gradient(90deg, #0A84FF, #00C2FF);
            animation: loadpulse 1.2s infinite alternate ease-in-out;
        }
        @keyframes loadpulse { 0% { opacity: 0.5; } 100% { opacity: 1; } }

        /* ── Simulation viewport ── */
        #sim-wrap {
            flex: 1; position: relative; overflow: hidden;
        }
        #sim-frame {
            position: absolute; inset: 0; width: 100%; height: 100%;
            border: none; background: #0d0d0d;
        }

        /* ── Initial loader ── */
        #loader {
            position: absolute; inset: 0; z-index: 50;
            display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px;
            background: #0d0d0d;
            animation: fadeout 0.4s 1.5s forwards;
        }
        @keyframes fadeout { to { opacity: 0; pointer-events: none; } }
        .brand-logo { width: 56px; height: 56px; }
        .brand-text {
            color: rgba(255,255,255,0.5); font-size: 10px;
            text-transform: uppercase; letter-spacing: 4px; font-weight: 700;
            animation: pulse 2s infinite ease-in-out;
        }
        @keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
    </style>
</head>
<body>
    <!-- Top browser toolbar -->
    <div id="toolbar">
        <button class="tb-btn" id="btn-back" title="Back (Alt+←)">
            <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button class="tb-btn" id="btn-fwd" title="Forward (Alt+→)">
            <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="tb-btn" id="btn-refresh" title="Refresh">
            <svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
        <div id="url-bar">
            <span class="url-lock"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
            <input id="url-input" type="text" spellcheck="false" autocomplete="off" placeholder="https://..." />
        </div>
        <button class="tb-btn" id="btn-rotate" title="Rotate (Alt+R)">
            <svg viewBox="0 0 24 24"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        </button>
        <button class="tb-btn" id="btn-screenshot" title="Screenshot">
            <svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>
    </div>

    <!-- Loading progress bar -->
    <div id="loading-bar" class="active"></div>

    <!-- Simulation frame -->
    <div id="sim-wrap">
        <iframe
            id="sim-frame"
            src="${embedUrl}"
            allow="geolocation; microphone; camera; midi; encrypted-media; clipboard-read; clipboard-write; display-capture"
            name="emx-ide-shell"
        ></iframe>

        <!-- Initial loader overlay -->
        <div id="loader">
            <svg width="100%" height="100%" viewBox="0 0 68 68" fill="none" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;transform:scale(1.3);transform-origin:center center" class="brand-logo">
                <defs>
                    <linearGradient id="emxAccent_R2mtdb" x1="0" y1="0" x2="68" y2="68" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stop-color="#0A84FF"></stop>
                        <stop offset="100%" stop-color="#00C2FF"></stop>
                    </linearGradient>
                    <filter id="emxGlow_R2mtdb" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="1.8" result="b"></feGaussianBlur>
                        <feComposite in="SourceGraphic" in2="b" operator="over"></feComposite>
                    </filter>
                </defs>
                <g class="origin-center" transform="rotate(0, 34, 34) translate(0, 0)">
                    <line x1="18" y1="34" x2="28" y2="34" stroke="url(#emxAccent_R2mtdb)" stroke-width="2.5" stroke-linecap="butt" class="transition-all duration-500 group-hover:translate-x-1"></line>
                    <line x1="50" y1="34" x2="40" y2="34" stroke="url(#emxAccent_R2mtdb)" stroke-width="2.5" stroke-linecap="butt" class="transition-all duration-500 group-hover:-translate-x-1"></line>
                    <g filter="url(#emxGlow_R2mtdb)">
                        <path d="M 23,12 L 45,12 A 5,5 0 0 1 50,17 L 50,51 A 5,5 0 0 1 45,56 L 23,56 A 5,5 0 0 1 18,51 L 18,17 A 5,5 0 0 1 23,12 Z" fill="none" stroke="url(#emxAccent_R2mtdb)" stroke-width="2.1" stroke-linejoin="round"></path>
                        <line x1="34" y1="23" x2="34" y2="52" stroke="url(#emxAccent_R2mtdb)" stroke-width="2.1" stroke-linecap="butt"></line>
                        <rect x="26.5" y="16" width="15" height="3" rx="1.5" fill="#0A84FF"></rect>
                    </g>
                </g>
            </svg>
            <div class="brand-text">Initialising Engine</div>
        </div>
    </div>

    <script>
        const frame = document.getElementById('sim-frame');
        const urlInput = document.getElementById('url-input');
        const loadingBar = document.getElementById('loading-bar');

        // Populate URL bar from the embed URL param
        try {
            const embedSrc = new URL(frame.src);
            const userUrl = embedSrc.searchParams.get('url');
            if (userUrl) urlInput.value = decodeURIComponent(userUrl);
        } catch(e) {}

        // Loading bar control
        frame.addEventListener('load', () => {
            loadingBar.classList.remove('active');
        });

        // --- URL bar navigation ---
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                let newUrl = urlInput.value.trim();
                if (!newUrl.startsWith('http')) {
                    if (newUrl.startsWith('localhost') || newUrl.startsWith('127.0.0.1')) newUrl = 'http://' + newUrl;
                    else newUrl = 'https://' + newUrl;
                }
                // Post to embed page so it re-routes through the proxy
                frame.contentWindow && frame.contentWindow.postMessage({
                    type: 'EMX_IDE_NAVIGATE',
                    url: newUrl
                }, '*');
                loadingBar.classList.add('active');
            }
        });

        // --- Toolbar buttons ---
        document.getElementById('btn-back').addEventListener('click', () => {
            frame.contentWindow && frame.contentWindow.postMessage({ type: 'EMX_IDE_CMD', action: 'back' }, '*');
        });
        document.getElementById('btn-fwd').addEventListener('click', () => {
            frame.contentWindow && frame.contentWindow.postMessage({ type: 'EMX_IDE_CMD', action: 'forward' }, '*');
        });
        document.getElementById('btn-refresh').addEventListener('click', () => {
            loadingBar.classList.add('active');
            frame.contentWindow && frame.contentWindow.postMessage({ type: 'EMX_IDE_CMD', action: 'refresh' }, '*');
        });
        document.getElementById('btn-rotate').addEventListener('click', () => {
            frame.contentWindow && frame.contentWindow.postMessage({ type: 'EMX_IDE_CMD', action: 'rotate' }, '*');
        });
        document.getElementById('btn-screenshot').addEventListener('click', () => {
            frame.contentWindow && frame.contentWindow.postMessage({ type: 'EMX_IDE_CMD', action: 'screenshot' }, '*');
        });

        // --- Relay VS Code extension messages to embed page ---
        window.addEventListener('message', event => {
            if (event.data && event.data.type && event.data.type.startsWith('EMX_IDE')) {
                frame.contentWindow && frame.contentWindow.postMessage(event.data, '*');
            }
            // Update URL bar when the sim navigates
            if (event.data && event.data.type === 'EMULUXE_IFRAME_NAVIGATED' && event.data.payload?.url) {
                try {
                    const nav = new URL(event.data.payload.url);
                    urlInput.value = nav.href;
                } catch(e) {}
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() { }
