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
    
    // ── Deep Link Handler ───────────────────────────────────────────────────
    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
            if (uri.path === '/auth') {
                const query = new URLSearchParams(uri.query);
                const token = query.get('token');
                if (token) {
                    vscode.workspace.getConfiguration('emuluxe').update('token', token, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('Emuluxe: Successfully signed in!');
                    
                    // Refresh plan and status bar
                    const apiUrl = vscode.workspace.getConfiguration('emuluxe').get<string>('apiUrl') || 'https://app.emuluxe.com';
                    getPlanInfo({ token, apiUrl }).then(plan => {
                        if (plan) updateStatusBar(plan);
                    });

                    // Reload simulator if active to reflect new auth state
                    if (currentPanel) {
                        vscode.window.showInformationMessage('Emuluxe: Reloading simulator to apply new session...');
                        // Just trigger a re-render of the webview content
                        getPlanInfo({ token, apiUrl }).then(plan => {
                             if (currentPanel) {
                                  currentPanel.webview.html = getWebviewContent(activeSessions, apiUrl, {}, plan?.plan || 'free');
                             }
                        });
                    }
                }
            }
        }
    }));

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

        let simulatorUrl = url;
        if (simulatorUrl.startsWith(auth.apiUrl)) {
            try {
                const u = new URL(simulatorUrl);
                u.searchParams.set('source', 'vscode');
                simulatorUrl = u.toString();
            } catch (e) { }
        }
        currentUrl = simulatorUrl;

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
                    safeArea: false,
                    touchCursor: false,
                    fullPage: false,
                    ua: context.globalState.get('emuluxe.ua', 'ios-safari'),
                    hoverTilt: false,
                    nativeScrollbars: context.globalState.get('emuluxe.nativeScrollbars', false),
                    showTopBar: context.globalState.get('emuluxe.showTopBar', true),
                    showBottomBar: context.globalState.get('emuluxe.showBottomBar', true),
                    showFullUrl: context.globalState.get('emuluxe.showFullUrl', false),
                    foldState: context.globalState.get('emuluxe.foldState', 'unfolded'),
                    showCrease: context.globalState.get('emuluxe.showCrease', false),
                    browserId: context.globalState.get('emuluxe.browserId', 'safari'),
                    frameColor: context.globalState.get('emuluxe.frameColor', ''),
                    rimColor: context.globalState.get('emuluxe.rimColor', ''),
                    statusBarColor: context.globalState.get('emuluxe.statusBarColor', ''),
                    statusBarStyle: context.globalState.get('emuluxe.statusBarStyle', 'light'),
                    batteryOverride: context.globalState.get('emuluxe.batteryOverride', false),
                    batteryLevel: context.globalState.get('emuluxe.batteryLevel', 80),
                    batteryCharging: context.globalState.get('emuluxe.batteryCharging', true),
                };
                
                // Immediately sync battery on start
                if (currentPanel) {
                     currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'sync_battery_now' });
                }

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
                    const planResult = await getPlanInfo(auth);
                    currentPanel.webview.html = getWebviewContent(activeSessions, auth.apiUrl, initialSettings, planResult?.plan || 'free');

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
                            case 'external_login': {
                                const config = vscode.workspace.getConfiguration('emuluxe');
                                const apiUrl = config.get<string>('apiUrl') || 'https://app.emuluxe.com';
                                vscode.env.openExternal(vscode.Uri.parse(`${apiUrl}/platform/login?source=vscode_external`));
                                break;
                            }
                            case 'upgrade_required': {
                                const action = await vscode.window.showInformationMessage(
                                    `Emuluxe: ${msg.feature} requires a Pro plan.`,
                                    'Upgrade Plan'
                                );
                                if (action === 'Upgrade Plan') {
                                    vscode.env.openExternal(vscode.Uri.parse(`${auth.apiUrl}/platform/billing`));
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
        category?: string;
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
                size: d.size,
                category: d.category
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

        if (currentPanel && activeSessions.length > 0) {
            // Decoupled device switching: update the first active session in-place
            const session = activeSessions[0];
            currentPanel.webview.postMessage({ 
                type: 'EMX_IDE_CHANGE_DEVICE', 
                sessionId: session.sessionId,
                device: selectedDevice
            });
        } else {
            // Fallback to starting a new session if none is active
            await startSession(selectedDevice, currentUrl);
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

function getWebviewContent(sessions: any[], apiUrl: string, settings: any = {}, userPlan: string = 'free') {
    const sessionsJson = JSON.stringify(sessions);
    const settingsJson = JSON.stringify(settings);
    const isFree = userPlan === 'free';

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
        header {
            display: flex; align-items: center; padding: 12px 16px;
            background: #1a1a1a; border-bottom: 1px solid rgba(255,255,255,0.1);
            gap: 12px;
        }
        #session-timer {
            margin-left: auto; font-size: 11px; font-weight: 700;
            background: rgba(255,255,255,0.05); padding: 4px 10px; border-radius: 12px;
            color: #0A84FF; border: 1px solid rgba(10,132,255,0.2);
            display: none;
        }
        .url-bar {
            display: flex; align-items: center; gap: 8px; flex: 1; flex-wrap: nowrap; overflow: hidden; justify-content: flex-end;
        }
        .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; color: #fff; flex-shrink: 0; }
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
            display: flex; flex-direction: column; align-items: center;
            padding: 0px; flex: 1; overflow: auto; background: #000;
        }

        .device-wrapper {
            position: relative; transition: all 0.3s cubic-bezier(0.19, 1, 0.22, 1);
            width: 100%; height: 100%; display: flex; items-center justify-center;
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

        /* Pro Badge */
        .pro-locked { pointer-events: none; opacity: 0.5; filter: grayscale(1); }
        .pro-badge {
            font-size: 8px; font-weight: 800; background: #0A84FF; color: #fff;
            padding: 2px 4px; border-radius: 4px; margin-left: 6px;
            vertical-align: middle; text-transform: uppercase;
            box-shadow: 0 0 10px rgba(10,132,255,0.4);
        }
        .tb-btn-locked { position: relative; }
        .tb-btn-locked::after {
            content: 'PRO'; position: absolute; top: -2px; right: -2px;
            font-size: 7px; font-weight: 900; background: #0A84FF; color: #fff;
            padding: 1px 3px; border-radius: 3px; line-height: 1;
        }
    </style>
</head>
<body>
    <header>
        <div class="logo">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="24" height="24" rx="6" fill="#0A84FF"/>
                <path d="M7 12L10 15L17 8" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Emuluxe</span>
        </div>
        <div id="session-timer">00:00</div>
        <div class="url-bar">
            <button class="tb-btn" id="btn-back" title="Back">
                <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <button class="tb-btn" id="btn-fwd" title="Forward">
                <svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>
            </button>
            <button class="tb-btn" id="btn-refresh" title="Refresh">
                <svg viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
            <input type="text" id="url-input" placeholder="Enter site URL..." spellcheck="false">
            <button class="tb-btn" id="btn-add" title="Add More Devices" style="color: #0A84FF;">
                <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
            </button>
            <button class="tb-btn" id="btn-rotate" title="Rotate (Alt+R)">
                <svg viewBox="0 0 24 24"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
            </button>
            <button class="tb-btn ${isFree ? 'tb-btn-locked' : ''}" id="btn-ai" title="${isFree ? 'AI Analyzer (Pro Plan Required)' : 'AI Analyzer'}">
                <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            </button>
            <button class="tb-btn" id="btn-screenshot" title="Take Screenshot (Snapshot View)">
                <svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </button>
            <button class="tb-btn" id="btn-settings" title="Simulation Settings">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
        </div>
    </header>

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
                <label for="network">Network Profile ${isFree ? '<span class="pro-badge">PRO</span>' : ''}</label>
                <select id="network" title="${isFree ? 'Pro Plan Required' : ''}">
                    <option value="no-throttle">No Throttle</option>
                    <option value="5g" ${isFree ? 'disabled' : ''}>5G (Ultra Fast)</option>
                    <option value="4g-lte" ${isFree ? 'disabled' : ''}>4G LTE</option>
                    <option value="3g-fast" ${isFree ? 'disabled' : ''}>3G (Fast)</option>
                    <option value="3g-slow" ${isFree ? 'disabled' : ''}>3G (Slow)</option>
                    <option value="offline" ${isFree ? 'disabled' : ''}>Offline</option>
                </select>
            </div>
            <div class="settings-row">
                <label for="geolocation">Location (GPS) ${isFree ? '<span class="pro-badge">PRO</span>' : ''}</label>
                <select id="geolocation" title="${isFree ? 'Pro Plan Required' : ''}">
                    <option value="none">Actual Location</option>
                    <option value="san-francisco" ${isFree ? 'disabled' : ''}>San Francisco</option>
                    <option value="new-york" ${isFree ? 'disabled' : ''}>New York</option>
                    <option value="london" ${isFree ? 'disabled' : ''}>London</option>
                    <option value="tokyo" ${isFree ? 'disabled' : ''}>Tokyo</option>
                </select>
            </div>
            <div class="settings-row">
                <label for="ua">User Agent ${isFree ? '<span class="pro-badge">PRO</span>' : ''}</label>
                <select id="ua" title="${isFree ? 'Pro Plan Required' : ''}">
                    <option value="ios-safari">iOS Safari</option>
                    <option value="chrome-android" ${isFree ? 'disabled' : ''}>Chrome Android</option>
                    <option value="edge-android" ${isFree ? 'disabled' : ''}>Edge Android</option>
                </select>
            </div>
            <div class="settings-row">
                <label for="browserId">Browser Engine</label>
                <select id="browserId">
                    <option value="safari">Safari</option>
                    <option value="chrome">Chrome</option>
                    <option value="firefox">Firefox</option>
                    <option value="edge">Edge</option>
                    <option value="samsung-internet">Samsung Internet</option>
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
            <div class="settings-row">
                <label for="hoverTilt">3D Hover Tilt</label>
                <label class="switch">
                    <input type="checkbox" id="hoverTilt">
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-header">Hardware Simulation</div>
            <div class="settings-row">
                <label for="batteryOverride">Manual Battery</label>
                <label class="switch">
                    <input type="checkbox" id="batteryOverride">
                    <span class="slider"></span>
                </label>
            </div>
            <div id="battery-controls" style="display: none; flex-direction: column; gap: 8px; margin-top: 4px; padding-left: 10px; border-left: 1px solid rgba(255,255,255,0.1);">
                <div class="settings-row">
                    <label>Level (<span id="batt-val">80</span>%)</label>
                    <input type="range" id="batteryLevel" min="0" max="100" style="width: 80px;">
                </div>
                <div class="settings-row">
                    <label>Charging</label>
                    <label class="switch">
                        <input type="checkbox" id="batteryCharging">
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
            <div class="settings-row">
                <label>Biometrics ${isFree ? '<span class="pro-badge">PRO</span>' : ''}</label>
                <button id="btn-biometrics-mock" style="background: #222; border: 1px solid #333; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 10px; cursor: pointer;" ${isFree ? 'disabled' : ''}>Trigger FaceID Prompt</button>
            </div>
        </div>

        <div class="settings-section" id="section-aesthetics">
            <div class="settings-header">Custom Aesthetics</div>
            <div class="settings-row">
                <label for="frameColor">Frame Color</label>
                <select id="frameColor">
                    <option value="">Default</option>
                </select>
            </div>
            <div class="settings-row">
                <label for="statusBarStyle">Status Bar Style</label>
                <select id="statusBarStyle">
                    <option value="light">Light Content</option>
                    <option value="dark">Dark Content</option>
                </select>
            </div>
        </div>

        <div id="fold-section" class="settings-section" style="display: none;">
            <div class="settings-header">Foldable Controls</div>
            <div class="settings-row">
                <label for="foldState">Fold State</label>
                <select id="foldState">
                    <option value="unfolded">Unfolded</option>
                    <option value="folded">Folded</option>
                </select>
            </div>
            <div class="settings-row">
                <label for="showCrease">Visible Crease</label>
                <label class="switch">
                    <input type="checkbox" id="showCrease">
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-header">Capture Settings</div>
            <div class="settings-row">
                <label for="fullPage">Full Page Screenshot ${isFree ? '<span class="pro-badge">PRO</span>' : ''}</label>
                <label class="switch">
                    <input type="checkbox" id="fullPage" ${isFree ? 'disabled' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-header">Browser Interface</div>
            <div class="settings-row">
                <label for="showTopBar">Show Top Bar</label>
                <label class="switch">
                    <input type="checkbox" id="showTopBar">
                    <span class="slider"></span>
                </label>
            </div>
            <div class="settings-row">
                <label for="showBottomBar">Show Bottom Bar</label>
                <label class="switch">
                    <input type="checkbox" id="showBottomBar">
                    <span class="slider"></span>
                </label>
            </div>
            <div class="settings-row">
                <label for="showFullUrl">Always Show Full URL</label>
                <label class="switch">
                    <input type="checkbox" id="showFullUrl">
                    <span class="slider"></span>
                </label>
            </div>
            <div class="settings-row">
                <label for="nativeScrollbars">Native Scrollbars</label>
                <label class="switch">
                    <input type="checkbox" id="nativeScrollbars">
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-header">Host Integration</div>
            <div class="settings-row">
                <label for="syncBattery">Sync Battery Status</label>
                <label class="switch">
                    <input type="checkbox" id="syncBattery">
                    <span class="slider"></span>
                </label>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const USER_PLAN = '${userPlan}';
        const IS_FREE = USER_PLAN === 'free';
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
        const timerEl = document.getElementById('session-timer');

        let activeSessionsMetadata = {}; // sessionId -> device metadata

        function addDeviceFrame(session) {
            const wrapper = document.createElement('div');
            wrapper.className = 'device-wrapper';
            wrapper.id = 'session-' + session.sessionId;
            
            // Store metadata for settings sync
            activeSessionsMetadata[session.sessionId] = session.device;
            updateSettingsForDevice(session.sessionId);

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
            frame.allow = 'publickey-credentials-get; publickey-credentials-create; geolocation; microphone; camera; midi; encrypted-media; autoplay; clipboard-read; clipboard-write; display-capture';
            
            frame.style.width = '100%';
            frame.style.height = '100%';

            wrapper.appendChild(closeBtn);
            wrapper.appendChild(frame);
            simContainer.appendChild(wrapper);

            frame.addEventListener('load', () => {
                loadingBar.classList.remove('active');
            });

            // Show foldable section if any active device is foldable
            if (session.device?.category === 'foldable') {
                document.getElementById('fold-section').style.display = 'flex';
            }

            // Start timer if expiresAt is provided
            if (session.expiresAt) {
                startSessionTimer(session.expiresAt);
            } else if (IS_FREE) {
                // Fallback for free users: 10 mins from now
                startSessionTimer(Date.now() + 600000);
            }
        }

        let sessionTimer;
        function startSessionTimer(expiry) {
            if (sessionTimer) clearInterval(sessionTimer);
            timerEl.style.display = 'block';
            
            function update() {
                const remaining = Math.max(0, expiry - Date.now());
                if (remaining <= 0) {
                    timerEl.textContent = "Session Expired";
                    timerEl.style.color = "#FF3B30";
                    return;
                }
                const mins = Math.floor(remaining / 60000);
                const secs = Math.floor((remaining % 60000) / 1000);
                timerEl.textContent = mins + ":" + secs.toString().padStart(2, '0');
            }
            update();
            sessionTimer = setInterval(update, 1000);
        }

        function updateSettingsForDevice(sessionId) {
            const device = activeSessionsMetadata[sessionId];
            if (!device) return;

            // 1. Update Frame Colors
            const colorSelect = document.getElementById('frameColor');
            const currentValue = colorSelect.value;
            colorSelect.innerHTML = '<option value="">Default (Auto)</option>';
            if (device.availableColors) {
                device.availableColors.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.base;
                    opt.textContent = c.name;
                    colorSelect.appendChild(opt);
                });
            }
            if (currentValue) colorSelect.value = currentValue;

            // 2. Filter Browser Engines
            const browserSelect = document.getElementById('browserId');
            const currentBrowser = browserSelect.value;
            const os = (device.os || '').toLowerCase();
            const isApple = os.includes('ios') || os.includes('ipados') || os.includes('macos');
            
            // Show/hide safari based on OS
            Array.from(browserSelect.options).forEach(opt => {
                if (opt.value === 'safari') {
                    opt.style.display = isApple ? 'block' : 'none';
                    if (!isApple && currentBrowser === 'safari') browserSelect.value = 'chrome';
                }
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
        
        // Manual Battery visibility on load
        if (INITIAL_SETTINGS.batteryOverride) {
            document.getElementById('battery-controls').style.display = 'flex';
            document.getElementById('batt-val').textContent = INITIAL_SETTINGS.batteryLevel;
        }

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
        document.getElementById('btn-rotate').addEventListener('click', () => {
            broadcast({ type: 'EMX_IDE_CMD', action: 'rotate' });
        });
        document.getElementById('btn-ai').addEventListener('click', () => {
            if (IS_FREE) return vscode.postMessage({ type: 'upgrade_required', feature: 'AI Analyzer' });
            broadcast({ type: 'EMX_IDE_CMD', action: 'trigger_ai' });
        });
        btnScreenshot.addEventListener('click', () => {
            const isFullPage = document.getElementById('fullPage').checked;
            if (isFullPage && IS_FREE) {
                return vscode.postMessage({ type: 'upgrade_required', feature: 'Full Page Screenshot' });
            }
            if (isFullPage) {
                broadcast({ type: 'EMX_IDE_CMD', action: 'full_page_screenshot' });
            } else {
                broadcast({ type: 'EMX_IDE_CMD', action: 'screenshot' });
            }
        });

        // ── Battery Sync ─────────────────────────────────────────────────────
        function syncBattery() {
            if (navigator.getBattery) {
                navigator.getBattery().then(batt => {
                    const level = Math.round(batt.level * 100);
                    broadcast({ 
                        type: 'EMX_IDE_CMD', 
                        action: 'set_battery_manual', 
                        level: level, 
                        charging: batt.charging 
                    });
                    const levelInput = document.getElementById('batteryLevel');
                    const chargingInput = document.getElementById('batteryCharging');
                    if (levelInput) levelInput.value = level;
                    if (chargingInput) chargingInput.checked = batt.charging;
                    const battVal = document.getElementById('batt-val');
                    if (battVal) battVal.textContent = level;
                });
            } else {
                broadcast({ type: 'EMX_IDE_CMD', action: 'set_battery_manual', level: 100, charging: true });
            }
        }
        
        // Periodic sync in case listeners aren't supported
        setInterval(syncBattery, 30000);

        btnSettings.addEventListener('click', () => {
            settingsPanel.classList.toggle('visible');
            overlay.classList.toggle('visible');
        });
        overlay.addEventListener('click', () => {
            settingsPanel.classList.remove('visible');
            overlay.classList.remove('visible');
        });

        // ── Settings Change Listener ──────────────────────────────────────────
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
                else if (key === 'hoverTilt') broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_tilt', enabled: value });
                else if (key === 'nativeScrollbars') broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_browser_ui', key: 'nativeScrollbars', enabled: value });
                else if (key === 'showTopBar') broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_browser_ui', key: 'showTopBar', enabled: value });
                else if (key === 'showBottomBar') broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_browser_ui', key: 'showBottomBar', enabled: value });
                else if (key === 'showFullUrl') broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_browser_ui', key: 'showFullUrl', enabled: value });
                else if (key === 'foldState') broadcast({ type: 'EMX_IDE_CMD', action: 'set_fold_state', state: value });
                else if (key === 'showCrease') broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_crease', enabled: value });
                else if (key === 'browserId') broadcast({ type: 'EMX_IDE_CMD', action: 'set_browser', browserId: value });
                else if (key === 'frameColor') {
                    const sessionId = Object.keys(activeSessionsMetadata)[0];
                    if (sessionId) {
                        const device = activeSessionsMetadata[sessionId];
                        if (device && device.availableColors) {
                            const c = device.availableColors.find((c) => c.base === value);
                            if (c) {
                                broadcast({ type: 'EMX_IDE_CMD', action: 'set_frame_color', color: c.base });
                                broadcast({ type: 'EMX_IDE_CMD', action: 'set_rim_color', color: c.rim || c.edge });
                            } else {
                                broadcast({ type: 'EMX_IDE_CMD', action: 'set_frame_color', color: '' });
                                broadcast({ type: 'EMX_IDE_CMD', action: 'set_rim_color', color: '' });
                            }
                        }
                    }
                }
                else if (key === 'rimColor') broadcast({ type: 'EMX_IDE_CMD', action: 'set_rim_color', color: value });
                else if (key === 'statusBarColor') broadcast({ type: 'EMX_IDE_CMD', action: 'set_status_bar_color', color: value });
                else if (key === 'statusBarStyle') broadcast({ type: 'EMX_IDE_CMD', action: 'set_status_bar_style', style: value });
                if (key === 'batteryOverride' || key === 'batteryLevel' || key === 'batteryCharging') {
                    const level = document.getElementById('batteryLevel').value;
                    const charging = document.getElementById('batteryCharging').checked;
                    const override = document.getElementById('batteryOverride').checked;
                    document.getElementById('batt-val').textContent = level;
                    document.getElementById('battery-controls').style.display = override ? 'flex' : 'none';
                    if (override) {
                        broadcast({ type: 'EMX_IDE_CMD', action: 'set_battery_manual', level: parseInt(level), charging });
                    } else {
                        syncBattery();
                    }
                }
                else if (key === 'syncBattery') syncBattery();
            });
        });

        document.getElementById('btn-biometrics-mock').addEventListener('click', () => {
             broadcast({ type: 'EMX_IDE_CMD', action: 'toggle_biometrics', enabled: true });
        });

        window.addEventListener('message', event => {
            const data = event.data;
            if (!data || !data.type) return;

            if (data.type === 'EMX_EXTERNAL_LOGIN') {
                vscode.postMessage({ type: 'external_login' });
            }
            else if (data.type === 'EMX_IDE_ADD_DEVICE') addDeviceFrame(data.session);
            else if (data.type === 'EMX_IDE_CHANGE_DEVICE') {
                const wrapper = document.getElementById('session-' + data.sessionId);
                if (wrapper) {
                    const iframe = wrapper.querySelector('iframe');
                    if (iframe) {
                        // Update source while preserving URL but changing device param
                        const url = new URL(iframe.src);
                        url.searchParams.set('device', data.device.id);
                        iframe.src = url.toString();
                    }
                    activeSessionsMetadata[data.sessionId] = data.device;
                    updateSettingsForDevice(data.sessionId);
                }
            }
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
            else if (data.type === 'EMX_IDE_CMD') {
                // Forward commands from VS Code host to simulation iframes
                if (data.action === 'sync_battery_now') syncBattery();
                broadcast(data);
            }
        });
    </script>
</body>
</html>`;
}

export function deactivate() { }