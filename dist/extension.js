"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const axios_1 = __importDefault(require("axios"));
// Removed hardcoded DEVICES
let currentPanel = undefined;
let activeSessions = [];
let currentUrl = 'http://localhost:3000';
let statusBarItem;
let cachedPlan = null;
function activate(context) {
    const checkToken = async () => {
        const config = vscode.workspace.getConfiguration('emuluxe');
        const token = config.get('token');
        const apiUrl = config.get('apiUrl') || 'https://app.emuluxe.com';
        if (!token) {
            const action = await vscode.window.showErrorMessage('Emuluxe: CLI token is missing. Please create one in your settings.', 'Open Settings', 'Get Token');
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'emuluxe.token');
            }
            else if (action === 'Get Token') {
                vscode.env.openExternal(vscode.Uri.parse(`${apiUrl}/platform/settings/integrations`));
            }
            return null;
        }
        return { token, apiUrl };
    };
    const getPlanInfo = async (auth) => {
        try {
            const res = await axios_1.default.get(`${auth.apiUrl}/api/cli/me`, {
                headers: { 'Authorization': `Bearer ${auth.token}` }
            });
            cachedPlan = res.data;
            return cachedPlan;
        }
        catch (err) {
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
                if (plan)
                    updateStatusBar(plan);
            });
        }
    });
    const updateStatusBar = (plan) => {
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
    const saveScreenshotFromDataUrl = async (dataUrl, filename) => {
        try {
            const base64 = dataUrl.replace(/^data:image\/[a-z+]+;base64,/, '');
            const bytes = Buffer.from(base64, 'base64');
            const ext = dataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png';
            const defaultName = filename || `Emuluxe_Screenshot_${Date.now()}.${ext}`;
            // Resolve a sensible default save URI.
            // Using a raw filename leads to '/filename.png' which fails on read-only FS.
            let defaultUri;
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
        }
        catch (err) {
            vscode.window.showErrorMessage(`Emuluxe: Screenshot save failed — ${err.message}`);
        }
    };
    // ── Direct Puppeteer screenshot fallback (used when embed capture fails) ─
    const captureViaApi = async (auth, url, deviceId, size) => {
        // Best-effort device dimension lookup — extend this map as needed
        const DEVICE_DIMS = {
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
            vscode.window.showWarningMessage('Emuluxe: Local URL detected — the remote screenshot service cannot reach localhost. ' +
                'Install the Emuluxe Chrome extension for full local-URL screenshot support.');
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
                const res = await axios_1.default.get(`${auth.apiUrl}/api/screenshot?${params}`, {
                    responseType: 'arraybuffer',
                    headers: { 'Authorization': `Bearer ${auth.token}` },
                    timeout: 60000,
                });
                const base64 = Buffer.from(res.data).toString('base64');
                const dataUrl = `data:image/png;base64,${base64}`;
                const filename = `Emuluxe_Screenshot_${deviceId}_${Date.now()}.png`;
                await saveScreenshotFromDataUrl(dataUrl, filename);
            }
            catch (err) {
                vscode.window.showErrorMessage(`Emuluxe: API screenshot failed — ${err.message}`);
            }
        });
    };
    const startSession = async (device, url) => {
        const auth = await checkToken();
        if (!auth)
            return;
        let simulatorUrl = url;
        if (simulatorUrl.startsWith(auth.apiUrl)) {
            try {
                const u = new URL(simulatorUrl);
                u.searchParams.set('source', 'vscode');
                simulatorUrl = u.toString();
            }
            catch (e) { }
        }
        currentUrl = simulatorUrl;
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Starting ${device.label} Simulation...`,
            cancellable: false
        }, async (progress) => {
            try {
                const res = await axios_1.default.post(`${auth.apiUrl}/api/cli/session`, {
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
                }
                else {
                    currentPanel = vscode.window.createWebviewPanel('emuluxeSim', 'Emuluxe', vscode.ViewColumn.Two, {
                        enableScripts: true,
                        retainContextWhenHidden: true
                    });
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
                                if (msg.url)
                                    currentUrl = msg.url;
                                break;
                            }
                            case 'close_device': {
                                if (msg.sessionId) {
                                    activeSessions = activeSessions.filter(s => s.sessionId !== msg.sessionId);
                                    await axios_1.default.delete(`${auth.apiUrl}/api/cli/session/${msg.sessionId}`, {
                                        headers: { 'Authorization': `Bearer ${auth.token}` }
                                    }).catch(() => { });
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
                            case 'upgrade_required': {
                                const action = await vscode.window.showInformationMessage(`Emuluxe: ${msg.feature} requires a Pro plan.`, 'Upgrade Plan');
                                if (action === 'Upgrade Plan') {
                                    vscode.env.openExternal(vscode.Uri.parse(`${auth.apiUrl}/platform/billing`));
                                }
                                break;
                            }
                        }
                    }, null, context.subscriptions);
                    currentPanel.onDidDispose(() => {
                        activeSessions.forEach(s => {
                            axios_1.default.delete(`${auth.apiUrl}/api/cli/session/${s.sessionId}`, {
                                headers: { 'Authorization': `Bearer ${auth.token}` }
                            }).catch(() => { });
                        });
                        currentPanel = undefined;
                        activeSessions = [];
                    }, null, context.subscriptions);
                }
            }
            catch (err) {
                const errorData = err.response?.data;
                const errorCode = errorData?.error;
                const errorMsg = errorData?.detail || errorData?.error || err.message;
                if (errorCode === 'SESSION_LIMIT_REACHED' || errorCode === 'CONCURRENCY_LIMIT_REACHED') {
                    const action = await vscode.window.showErrorMessage(`Emuluxe: ${errorMsg}`, 'Upgrade Plan');
                    if (action === 'Upgrade Plan') {
                        vscode.env.openExternal(vscode.Uri.parse(`${auth.apiUrl}/platform/billing`));
                    }
                }
                else {
                    vscode.window.showErrorMessage(`Emuluxe Error: ${errorMsg}`);
                }
            }
        });
    };
    const getDevices = async (auth) => {
        try {
            const res = await axios_1.default.get(`${auth.apiUrl}/api/cli/devices`, {
                headers: { 'Authorization': `Bearer ${auth.token}` }
            });
            const devicesArray = res.data?.devices || [];
            return devicesArray.map((d) => ({
                label: d.name,
                description: d.os || d.brand,
                id: d.id,
                detail: d.isLocked ? `★ Requires ${d.planRequired} Plan` : undefined,
                locked: d.isLocked,
                size: d.size
            }));
        }
        catch (err) {
            vscode.window.showErrorMessage(`Emuluxe: Failed to fetch devices. ${err.message}`);
            return [];
        }
    };
    let startCommand = vscode.commands.registerCommand('emuluxe.start', async () => {
        const auth = await checkToken();
        if (!auth)
            return;
        const devicesList = await getDevices(auth);
        if (devicesList.length === 0)
            return;
        const selectedDevice = await vscode.window.showQuickPick(devicesList, {
            placeHolder: 'Select a device to simulate',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!selectedDevice)
            return;
        if (selectedDevice.locked) {
            const action = await vscode.window.showErrorMessage(`Emuluxe: ${selectedDevice.label} requires a Pro plan.`, 'Upgrade');
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
        if (!url)
            return;
        await startSession(selectedDevice, url);
    });
    let deviceCommand = vscode.commands.registerCommand('emuluxe.device', async () => {
        const auth = await checkToken();
        if (!auth)
            return;
        const devicesList = await getDevices(auth);
        if (devicesList.length === 0)
            return;
        const selectedDevice = await vscode.window.showQuickPick(devicesList, {
            placeHolder: 'Select a new device',
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!selectedDevice)
            return;
        if (selectedDevice.locked) {
            const action = await vscode.window.showErrorMessage(`Emuluxe: ${selectedDevice.label} requires a Pro plan.`, 'Upgrade');
            if (action === 'Upgrade') {
                vscode.env.openExternal(vscode.Uri.parse(`${auth.apiUrl}/platform/billing`));
            }
            return;
        }
        if (currentPanel) {
            await startSession(selectedDevice, currentUrl);
        }
        else {
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
        const apiUrl = config.get('apiUrl') || 'https://app.emuluxe.com';
        vscode.env.openExternal(vscode.Uri.parse(`${apiUrl}/platform/settings/integrations`));
    });
    let rotateCommand = vscode.commands.registerCommand('emuluxe.rotate', () => {
        if (currentPanel)
            currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'rotate' });
    });
    let screenshotCommand = vscode.commands.registerCommand('emuluxe.screenshot', async () => {
        if (!currentPanel)
            return;
        // Send screenshot command to embed page — the panel's onDidReceiveMessage will
        // handle saving when the embed posts back EMX_SCREENSHOT_DONE.
        currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'screenshot' });
    });
    let inspectCommand = vscode.commands.registerCommand('emuluxe.inspect', () => {
        if (currentPanel)
            currentPanel.webview.postMessage({ type: 'EMX_IDE_CMD', action: 'inspect' });
    });
    context.subscriptions.push(startCommand, stopCommand, loginCommand, deviceCommand, rotateCommand, screenshotCommand, inspectCommand);
}
function getWebviewContent(sessions, apiUrl, settings = {}, userPlan = 'free') {
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
                <label for="fullPage">Full Page Screenshot ${isFree ? '<span class="pro-badge">PRO</span>' : ''}</label>
                <label class="switch">
                    <input type="checkbox" id="fullPage" ${isFree ? 'disabled' : ''}>
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
            
            frame.style.width = '100%';
            frame.style.height = '100%';

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
        async function syncBattery() {
            if (!document.getElementById('syncBattery').checked) return;
            try {
                if ('getBattery' in navigator) {
                    const battery = await navigator.getBattery();
                    const update = () => {
                        broadcast({ 
                            type: 'EMX_IDE_CMD', 
                            action: 'sync_battery', 
                            charging: battery.charging, 
                            level: battery.level 
                        });
                    };
                    battery.addEventListener('chargingchange', update);
                    battery.addEventListener('levelchange', update);
                    update();
                }
            } catch (err) {}
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
                else if (key === 'syncBattery') syncBattery();
            });
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
function deactivate() { }
//# sourceMappingURL=extension.js.map