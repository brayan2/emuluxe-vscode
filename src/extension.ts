import * as vscode from 'vscode';
import axios from 'axios';

// Removed hardcoded DEVICES

let currentPanel: vscode.WebviewPanel | undefined = undefined;
let activeSessions: { device: any; sessionId: string; embedUrl: string }[] = [];
let currentUrl: string = 'http://localhost:3000';
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

    // ── Screenshot save helper ──────────────────────────────────────────────
    const saveScreenshotFromDataUrl = async (dataUrl: string, filename: string) => {
        try {
            const base64 = dataUrl.replace(/^data:image\/[a-z+]+;base64,/, '');
            const bytes = Buffer.from(base64, 'base64');
            const ext = dataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png';
            const defaultName = filename || `Emuluxe_Screenshot_${Date.now()}.${ext}`;

            // Resolve a sensible default save URI.
            // Using a raw filename leads to '/filename.png' which fails on read-only FS.
            let defaultUri: vscode.Uri | undefined;
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                defaultUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, defaultName);
            }

            const uri = await vscode.window.showSaveDialog({
                defaultUri,
                saveLabel: 'Save Screenshot',
                filters: { 'Images': ['png', 'jpg'] }
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, bytes);
                vscode.window.showInformationMessage(`Screenshot saved: ${uri.fsPath.split(/[\\/]/).pop()}`);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Emuluxe: Screenshot save failed — ${err.message}`);
        }
    };

    // ── Direct Puppeteer screenshot fallback (used when embed capture fails) ─
    const captureViaApi = async (auth: { token: string, apiUrl: string }, url: string, deviceId: string, size?: { w: number, h: number }) => {
        // Best-effort device dimension lookup — extend this map as needed
        const DEVICE_DIMS: Record<string, { w: number; h: number; dpr: number }> = {
            'iphone-15-pro-max': { w: 430, h: 932, dpr: 3 },
            'iphone-15-pro': { w: 393, h: 852, dpr: 3 },
            'iphone-15': { w: 390, h: 844, dpr: 3 },
            'samsung-s24-ultra': { w: 412, h: 915, dpr: 3.5 },
            'pixel-10': { w: 412, h: 915, dpr: 2.6 },
            'pixel-9': { w: 412, h: 892, dpr: 2.6 },
            'ipad-pro-13': { w: 1024, h: 1366, dpr: 2 },
        };
        const dim = size ? { w: size.w, h: size.h, dpr: 2 } : (DEVICE_DIMS[deviceId] || { w: 390, h: 844, dpr: 2 });

        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/.test(url);
        if (isLocal) {
            vscode.window.showWarningMessage(
                'Emuluxe: Local URL detected — the remote screenshot service cannot reach localhost. ' +
                'Install the Emuluxe Chrome extension for full local-URL screenshot support.'
            );
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Emuluxe: Capturing screenshot…',
            cancellable: false
        }, async () => {
            try {
                const params = new URLSearchParams({
                    url,
                    width: String(dim.w),
                    height: String(dim.h),
                    dpr: String(dim.dpr),
                    top: '0',
                    bottom: '0',
                    full: 'false',
                    format: 'png',
                    quality: '0.95',
                });
                const res = await axios.get(`${auth.apiUrl}/api/screenshot?${params}`, {
                    responseType: 'arraybuffer',
                    headers: { 'Authorization': `Bearer ${auth.token}` },
                    timeout: 60000,
                });
                const base64 = Buffer.from(res.data).toString('base64');
                const dataUrl = `data:image/png;base64,${base64}`;
                const filename = `Emuluxe_Screenshot_${deviceId}_${Date.now()}.png`;
                await saveScreenshotFromDataUrl(dataUrl, filename);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Emuluxe: API screenshot failed — ${err.message}`);
            }
        });
    };

    const startSession = async (device: any, url: string) => {
        const auth = await checkToken();
        if (!auth) return;

        currentUrl = url;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Starting ${device.label} Simulation...`,
            cancellable: false
        }, async (progress) => {
            try {
                const res = await axios.post(`${auth.apiUrl}/api/cli/session`, {
                    device: device.id,
                    url: url,
                    source: 'vscode'
                }, {
                    headers: { 'Authorization': `Bearer ${auth.token}` }
                });

                const { embedUrl, sessionId } = res.data;
                const session = { device, sessionId, embedUrl };

                // Fetch initial settings from globalState
                const initialSettings = {
                    network: context.globalState.get('emuluxe.network', 'no-throttle'),
                    geolocation: context.globalState.get('emuluxe.geolocation', 'none'),
                    safeArea: context.globalState.get('emuluxe.safeArea', false),
                    touchCursor: context.globalState.get('emuluxe.touchCursor', false),
                    fullPage: context.globalState.get('emuluxe.fullPage', false),
                    ua: context.globalState.get('emuluxe.ua', 'ios-safari'),
                };

                if (currentPanel) {
                    activeSessions.push(session);
                    currentPanel.webview.postMessage({ type: 'EMX_IDE_ADD_DEVICE', session });
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
                    activeSessions = [session];
                    currentPanel.webview.html = getWebviewContent(activeSessions, auth.apiUrl, initialSettings);

                    currentPanel.webview.onDidReceiveMessage(async (msg) => {
                        switch (msg.type) {
                            case 'screenshot_result': {
                                if (msg.dataUrl) {
                                    await saveScreenshotFromDataUrl(msg.dataUrl, msg.filename || '');
                                }
                                break;
                            }
                            case 'screenshot_fallback': {
                                const fallbackUrl = msg.url || currentUrl;
                                await captureViaApi(auth, fallbackUrl, session.device.id, session.device.size);
                                break;
                            }
                            case 'url_changed': {
                                if (msg.url) currentUrl = msg.url;
                                break;
                            }
                            case 'close_device': {
                                if (msg.sessionId) {
                                    activeSessions = activeSessions.filter(s => s.sessionId !== msg.sessionId);
                                    await axios.delete(`${auth.apiUrl}/api/cli/session/${msg.sessionId}`, {
                                        headers: { 'Authorization': `Bearer ${auth.token}` }
                                    }).catch(() => {});
                                    
                                    if (activeSessions.length === 0) {
                                        currentPanel?.dispose();
                                    }
                                }
                                break;
                            }
                            case 'add_device': {
                                await vscode.commands.executeCommand('emuluxe.start');
                                break;
                            }
                            case 'update_setting': {
                                if (msg.key) {
                                    context.globalState.update(`emuluxe.${msg.key}`, msg.value);
                                }
                                break;
                            }
                        }
                    }, null, context.subscriptions);

                    currentPanel.onDidDispose(() => {
                        activeSessions.forEach(s => {
                            axios.delete(`${auth.apiUrl}/api/cli/session/${s.sessionId}`, {
                                headers: { 'Authorization': `Bearer ${auth.token}` }
                            }).catch(() => { });
                        });
                        currentPanel = undefined;
                        activeSessions = [];
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
        size?: { w: number, h: number };
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
                locked: d.isLocked,
                size: d.size
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

        await startSession(selectedDevice, url);
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
            await startSession(selectedDevice, currentUrl);
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

    let screenshotCommand = vscode.commands.registerCommand('emuluxe.screenshot', async () => {
        if (!currentPanel) return;
        // Send screenshot command to embed page — the panel's onDidReceiveMessage will
        // handle saving when the embed posts back EMX_SCREENSHOT_DONE.
        currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'screenshot' });
    });

    let inspectCommand = vscode.commands.registerCommand('emuluxe.inspect', () => {
        if (currentPanel) currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'inspect' });
    });

    context.subscriptions.push(startCommand, stopCommand, loginCommand, deviceCommand, rotateCommand, screenshotCommand, inspectCommand);
}

function getWebviewContent(sessions: any[], apiUrl: string, settings: any = {}) {
    const sessionsJson = JSON.stringify(sessions);
    const settingsJson = JSON.stringify(settings);

    return `<!DOCTYPE html>
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
            height: 48px; background: #1a1a1a; display: flex; align-items: center;
            padding: 0 12px; gap: 8px; border-bottom: 1px solid rgba(255,255,255,0.05);
            z-index: 100; flex-shrink: 0; flex-wrap: nowrap; overflow: hidden;
        }
        .tb-group { display: flex; align-items: center; gap: 4px; border-right: 1px solid rgba(255,255,255,0.1); padding-right: 4px; }
        .tb-btn {
            background: transparent; border: none; color: #ccc;
            width: 30px; height: 30px; border-radius: 4px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; transition: all 0.2s;
        }
        .tb-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
        .tb-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        
        #url-input {
            flex: 1; min-width: 200px; max-width: 600px;
            height: 28px; background: #222; border: 1px solid rgba(255,255,255,0.1);
            border-radius: 6px; color: #fff; padding: 0 12px; font-size: 12px;
            outline: none; transition: border-color 0.2s;
        }
        #url-input:focus { border-color: #0A84FF; background: #262626; }

        /* ── Main display ── */
        main { display: flex; flex: 1; overflow: hidden; position: relative; }
        #sim-container {
            display: flex; flex-wrap: wrap; gap: 40px; justify-content: center; align-items: flex-start;
            padding: 40px; flex: 1; overflow: auto; background: #000;
        }

        .device-wrapper {
            position: relative; transition: all 0.3s cubic-bezier(0.19, 1, 0.22, 1);
        }
        .device-wrapper .close-btn {
            position: absolute; top: -15px; right: -15px; width: 30px; height: 30px;
            background: #FF3B30; color: #fff; border-radius: 50%; display: flex;
            align-items: center; justify-content: center; cursor: pointer;
            z-index: 100; opacity: 0; transform: scale(0.8); transition: all 0.2s;
            border: 2px solid #000; font-size: 18px; line-height: 1;
        }
        .device-wrapper:hover .close-btn { opacity: 1; transform: scale(1); }
        .device-wrapper iframe {
            border: none; background: #000; display: block;
            border-radius: 40px; box-shadow: 0 40px 100px rgba(0,0,0,0.8);
        }

        /* ── Progress bar ── */
        .loading-bar {
            position: absolute; top: 0; left: 0; width: 100%; height: 2px;
            pointer-events: none; z-index: 1000;
        }
        .loading-bar::after {
            content: ''; position: absolute; top: 0; left: 0; height: 100%; width: 0;
            background: linear-gradient(90deg, #0A84FF, #00C7BE);
            transition: width 0.3s ease;
        }
        .loading-bar.active::after { transition: width 0.3s ease; width: 90%; }

        /* ── Settings Panel ── */
        #settings-overlay {
            position: absolute; inset: 0; background: rgba(0,0,0,0.5);
            backdrop-filter: blur(2px); z-index: 200;
            display: none;
        }
        #settings-overlay.visible { display: block; }
        
        #settings-panel {
            position: absolute; top: 0; right: -280px; width: 280px; height: 100%;
            background: #141414; border-left: 1px solid rgba(255,255,255,0.1);
            z-index: 210; transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            padding: 20px; color: #fff;
            display: flex; flex-direction: column; gap: 20px;
        }
        #settings-panel.visible { right: 0; }
        
        .settings-header { font-size: 14px; font-weight: 600; color: #0A84FF; text-transform: uppercase; letter-spacing: 1px; }
        .settings-section { display: flex; flex-direction: column; gap: 12px; }
        .settings-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }
        .settings-row label { color: rgba(255,255,255,0.7); }
        
        select, input[type="text"] {
            background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
            border-radius: 4px; color: #fff; padding: 4px 8px; font-size: 11px; outline: none;
        }
        select:focus { border-color: #0A84FF; }
        
        /* Toggle Switch */
        .switch { position: relative; display: inline-block; width: 32px; height: 18px; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider {
            position: absolute; cursor: pointer; inset: 0; background-color: rgba(255,255,255,0.1);
            transition: .3s; border-radius: 18px;
        }
        .slider:before {
            position: absolute; content: ""; height: 14px; width: 14px; left: 2px; bottom: 2px;
            background-color: white; transition: .3s; border-radius: 50%;
        }
        input:checked + .slider { background-color: #0A84FF; }
        input:checked + .slider:before { transform: translateX(14px); }
    </style>
</head>
<body>
    <div id="toolbar">
        <div class="tb-group">
            <button class="tb-btn" id="btn-back" title="Back">
                <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <button class="tb-btn" id="btn-fwd" title="Forward">
                <svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>
            </button>
            <button class="tb-btn" id="btn-refresh" title="Refresh">
                <svg viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
        </div>
        
        <input type="text" id="url-input" placeholder="Enter site URL..." spellcheck="false">
        
        <div class="tb-group" style="border-right:none; padding:0; margin-left:auto;">
            <button class="tb-btn" id="btn-add" title="Add More Devices" style="color: #0A84FF;">
                <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
            </button>
            <button class="tb-btn" id="btn-rotate" title="Rotate (Alt+R)">
                <svg viewBox="0 0 24 24"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
            </button>
            <button class="tb-btn" id="btn-ai" title="AI Analyzer">
                <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            </button>
            <button class="tb-btn" id="btn-screenshot" title="Screenshot">
                <svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </button>
            <button class="tb-btn" id="btn-settings" title="Simulation Settings">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
        </div>
    </div>

    <!-- Loading progress bar -->
    <div class="loading-bar" id="loading-bar"></div>

    <main>
        <div id="sim-container"></div>
    </main>

    <!-- Settings Overlay & Panel -->
    <div id="settings-overlay"></div>
    <div id="settings-panel">
        <div class="settings-header">Simulation Settings</div>
        
        <div class="settings-section">
            <div class="settings-row">
                <label for="network">Network Profile</label>
                <select id="network">
                    <option value="no-throttle">No Throttle</option>
                    <option value="5g">5G (Ultra Fast)</option>
                    <option value="4g-lte">4G LTE</option>
                    <option value="3g-fast">3G (Fast)</option>
                    <option value="3g-slow">3G (Slow)</option>
                    <option value="offline">Offline</option>
                </select>
            </div>
            <div class="settings-row">
                <label for="geolocation">Location (GPS)</label>
                <select id="geolocation">
                    <option value="none">Actual Location</option>
                    <option value="san-francisco">San Francisco</option>
                    <option value="new-york">New York</option>
                    <option value="london">London</option>
                    <option value="tokyo">Tokyo</option>
                </select>
            </div>
            <div class="settings-row">
                <label for="ua">User Agent</label>
                <select id="ua">
                    <option value="ios-safari">iOS Safari</option>
                    <option value="chrome-android">Chrome Android</option>
                    <option value="edge-android">Edge Android</option>
                </select>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-header">Display Overlays</div>
            <div class="settings-row">
                <label for="safeArea">Safe Area Debug</label>
                <label class="switch">
                    <input type="checkbox" id="safeArea">
                    <span class="slider"></span>
                </label>
            </div>
            <div class="settings-row">
                <label for="touchCursor">Touch Cursor</label>
                <label class="switch">
                    <input type="checkbox" id="touchCursor">
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-header">Capture Settings</div>
            <div class="settings-row">
                <label for="fullPage">Full Page Screenshot</label>
                <label class="switch">
                    <input type="checkbox" id="fullPage">
                    <span class="slider"></span>
                </label>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const INITIAL_SETTINGS = ${settingsJson};
        const INITIAL_SESSIONS = ${sessionsJson};

        const simContainer = document.getElementById('sim-container');
        const urlInput = document.getElementById('url-input');
        const loadingBar = document.getElementById('loading-bar');
        const btnScreenshot = document.getElementById('btn-screenshot');
        const btnSettings = document.getElementById('btn-settings');
        const btnAdd = document.getElementById('btn-add');
        const settingsPanel = document.getElementById('settings-panel');
        const overlay = document.getElementById('settings-overlay');

        function addDeviceFrame(session) {
            const wrapper = document.createElement('div');
            wrapper.className = 'device-wrapper';
            wrapper.id = 'session-' + session.sessionId;

            const closeBtn = document.createElement('div');
            closeBtn.className = 'close-btn';
            closeBtn.innerHTML = '&times;';
            closeBtn.title = 'Close Simulation';
            closeBtn.onclick = () => {
                vscode.postMessage({ type: 'close_device', sessionId: session.sessionId });
                wrapper.remove();
            };

            const frame = document.createElement('iframe');
            frame.src = session.embedUrl + '&source=vscode';
            frame.allow = 'geolocation; microphone; camera; midi; encrypted-media; autoplay; clipboard-read; clipboard-write; display-capture';
            
            const { w, h } = session.device.size || { w: 375, h: 812 };
            frame.style.width = (w + 100) + 'px';
            frame.style.height = (h + 100) + 'px';

            wrapper.appendChild(closeBtn);
            wrapper.appendChild(frame);
            simContainer.appendChild(wrapper);

            frame.addEventListener('load', () => {
                loadingBar.classList.remove('active');
            });
        }

        INITIAL_SESSIONS.forEach(addDeviceFrame);

        Object.keys(INITIAL_SETTINGS).forEach(key => {
            const el = document.getElementById(key);
            if (el) {
                if (el.type === 'checkbox') el.checked = INITIAL_SETTINGS[key];
                else el.value = INITIAL_SETTINGS[key];
            }
        });

        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                let newUrl = urlInput.value.trim();
                if (!newUrl.startsWith('http')) {
                    if (newUrl.startsWith('localhost') || newUrl.startsWith('127.0.0.1')) newUrl = 'http://' + newUrl;
                    else newUrl = 'https://' + newUrl;
                }
                vscode.postMessage({ type: 'url_changed', url: newUrl });
                broadcast({ type: 'EMX_IDE_NAVIGATE', url: newUrl });
                loadingBar.classList.add('active');
            }
        });

        btnAdd.addEventListener('click', () => {
            vscode.postMessage({ type: 'add_device' });
        });

        function broadcast(msg) {
            document.querySelectorAll('iframe').forEach(f => {
                f.contentWindow && f.contentWindow.postMessage(msg, '*');
            });
        }

        document.getElementById('btn-back').addEventListener('click', () => broadcast({ type: 'EMX_IDE_CMD', action: 'back' }));
        document.getElementById('btn-fwd').addEventListener('click', () => broadcast({ type: 'EMX_IDE_CMD', action: 'forward' }));
        document.getElementById('btn-refresh').addEventListener('click', () => {
            loadingBar.classList.add('active');
            broadcast({ type: 'EMX_IDE_CMD', action: 'refresh' });
        });
        document.getElementById('btn-rotate').addEventListener('click', () => broadcast({ type: 'EMX_IDE_CMD', action: 'rotate' }));
        document.getElementById('btn-ai').addEventListener('click', () => broadcast({ type: 'EMX_IDE_CMD', action: 'trigger_ai' }));

        btnSettings.addEventListener('click', () => {
            settingsPanel.classList.toggle('visible');
            overlay.classList.toggle('visible');
        });
        overlay.addEventListener('click', () => {
            settingsPanel.classList.remove('visible');
            overlay.classList.remove('visible');
        });

        document.querySelectorAll('.settings-row select, .settings-row input').forEach(el => {
            el.addEventListener('change', () => {
                const key = el.id;
                const value = el.type === 'checkbox' ? el.checked : el.value;
                vscode.postMessage({ type: 'update_setting', key, value });
                
                if (key === 'network') broadcast({ type: 'EMX_IDE_CMD', action: 'update_network', profile: value });
                else if (key === 'geolocation') broadcast({ type: 'EMX_IDE_CMD', action: 'update_geolocation', profile: value });
                else if (key === 'ua') broadcast({ type: 'EMX_IDE_CMD', action: 'update_ua', profile: value });
                else if (key === 'safeArea') broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_safe_area', enabled: value });
                else if (key === 'touchCursor') broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_touch_cursor', enabled: value });
            });
        });

        btnScreenshot.addEventListener('click', () => {
            btnScreenshot.classList.add('capturing');
            broadcast({ type: 'EMX_IDE_CMD', action: 'screenshot', full: document.getElementById('fullPage').checked });
            setTimeout(() => btnScreenshot.classList.remove('capturing'), 30000);
        });

        window.addEventListener('message', event => {
            const data = event.data;
            if (!data || !data.type) return;

            if (data.type === 'EMX_IDE_ADD_DEVICE') addDeviceFrame(data.session);
            else if (data.type === 'EMX_SCREENSHOT_DONE') {
                btnScreenshot.classList.remove('capturing');
                vscode.postMessage({ type: 'screenshot_result', dataUrl: data.dataUrl, filename: data.filename });
            }
            else if (data.type === 'EMX_SCREENSHOT_FALLBACK') {
                btnScreenshot.classList.remove('capturing');
                vscode.postMessage({ type: 'screenshot_fallback', url: data.url || urlInput.value });
            }
            else if (data.type === 'EMULUXE_IFRAME_NAVIGATED' && data.payload?.url) {
                urlInput.value = data.payload.url;
                broadcast({ type: 'EMX_IDE_NAVIGATE', url: data.payload.url });
                vscode.postMessage({ type: 'url_changed', url: data.payload.url });
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() { }