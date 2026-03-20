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
let currentUrl = 'http://localhost:3000';
let currentDevice = 'iphone-15-pro-max';
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
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultName),
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
    const captureViaApi = async (auth, url, deviceId) => {
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
        const dim = DEVICE_DIMS[deviceId] || { w: 390, h: 844, dpr: 2 };
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
    const startSession = async (deviceId, url) => {
        const auth = await checkToken();
        if (!auth)
            return;
        currentUrl = url;
        currentDevice = deviceId;
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Starting ${deviceId} Simulation...`,
            cancellable: false
        }, async (progress) => {
            try {
                const res = await axios_1.default.post(`${auth.apiUrl}/api/cli/session`, {
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
                }
                else {
                    currentPanel = vscode.window.createWebviewPanel('emuluxeSim', 'Emuluxe', vscode.ViewColumn.Two, {
                        enableScripts: true,
                        retainContextWhenHidden: true
                    });
                    currentPanel.iconPath = vscode.Uri.parse(`${auth.apiUrl}/favicon.ico`);
                    currentPanel.webview.html = getWebviewContent(embedUrl, auth.apiUrl);
                    // ── Handle messages from the webview (screenshot relay etc.) ──
                    currentPanel.webview.onDidReceiveMessage(async (msg) => {
                        switch (msg.type) {
                            // Full composite screenshot relayed from the embed page
                            case 'screenshot_result': {
                                if (msg.dataUrl) {
                                    await saveScreenshotFromDataUrl(msg.dataUrl, msg.filename || '');
                                }
                                break;
                            }
                            // Embed page signals it cannot reach the URL (e.g. localhost) and asks
                            // the extension to attempt a direct Puppeteer capture instead.
                            case 'screenshot_fallback': {
                                const fallbackUrl = msg.url || currentUrl;
                                await captureViaApi(auth, fallbackUrl, currentDevice);
                                break;
                            }
                            // Embed page URL changed (e.g. user navigated inside the sim)
                            case 'url_changed': {
                                if (msg.url)
                                    currentUrl = msg.url;
                                break;
                            }
                        }
                    }, null, context.subscriptions);
                    currentPanel.onDidDispose(() => {
                        currentPanel = undefined;
                        axios_1.default.delete(`${auth.apiUrl}/api/cli/session/${sessionId}`, {
                            headers: { 'Authorization': `Bearer ${auth.token}` }
                        }).catch(() => { });
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
                locked: d.isLocked
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
        await startSession(selectedDevice.id, url);
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
            await startSession(selectedDevice.id, currentUrl);
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
function getWebviewContent(embedUrl, apiUrl) {
    const iframeUrl = embedUrl + (embedUrl.includes('?') ? '&' : '?') + 'source=vscode';
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

        /* Screenshot button active state */
        #btn-screenshot.capturing { color: #0A84FF; animation: camPulse 0.8s infinite alternate; }
        @keyframes camPulse { from { opacity: 0.6; } to { opacity: 1; } }

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
            src="${iframeUrl}"
            allow="geolocation; microphone; camera; midi; encrypted-media; autoplay; clipboard-read; clipboard-write; display-capture"
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
        console.log('[Emuluxe Webview] Script Initialized. Version: 1.1.2');
        // ── VS Code API bridge (must be acquired exactly once per webview) ──
        const vscode = acquireVsCodeApi();

        const frame = document.getElementById('sim-frame');
        const urlInput = document.getElementById('url-input');
        const loadingBar = document.getElementById('loading-bar');
        const btnScreenshot = document.getElementById('btn-screenshot');

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
                // Track current URL in extension host
                vscode.postMessage({ type: 'url_changed', url: newUrl });
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

        // ── Screenshot button ────────────────────────────────────────────────
        // We forward to the embed page AND show a "capturing" state.
        // The embed page will respond with EMX_SCREENSHOT_DONE which we relay
        // back to the extension host for file saving.
        btnScreenshot.addEventListener('click', () => {
            btnScreenshot.classList.add('capturing');
            frame.contentWindow && frame.contentWindow.postMessage({ type: 'EMX_IDE_CMD', action: 'screenshot' }, '*');
            // Fallback: clear capturing state after 30s in case embed never responds
            setTimeout(() => btnScreenshot.classList.remove('capturing'), 30000);
        });

        console.log('[Emuluxe Webview] Message listener bound.');
        window.addEventListener('message', event => {
            const data = event.data;
            console.log('[Emuluxe Webview] Message event received from:', event.origin, 'Type:', data?.type);
            if (!data || !data.type) return;

            // ── Screenshot result from embed page → relay to extension host ──
            // The embed page posts EMX_SCREENSHOT_DONE with the composited dataUrl.
            if (data.type === 'EMX_SCREENSHOT_DONE') {
                console.log('[Emuluxe Webview] Detected EMX_SCREENSHOT_DONE. Length:', data.dataUrl?.length || 0);
                btnScreenshot.classList.remove('capturing');
                vscode.postMessage({
                    type: 'screenshot_result',
                    dataUrl: data.dataUrl,
                    filename: data.filename || ('Emuluxe_Screenshot_' + Date.now() + '.png')
                });
                return;
            }

            // ── Embed page cannot capture the site (e.g. localhost) ──
            // Ask the extension host to attempt a direct API screenshot instead.
            if (data.type === 'EMX_SCREENSHOT_FALLBACK') {
                btnScreenshot.classList.remove('capturing');
                vscode.postMessage({
                    type: 'screenshot_fallback',
                    url: data.url || urlInput.value
                });
                return;
            }

            // ── Relay extension → embed for other IDE commands ──
            if (data.type && data.type.startsWith('EMX_IDE')) {
                frame.contentWindow && frame.contentWindow.postMessage(data, '*');
            }

            // ── Update URL bar when the sim navigates ──
            if (data.type === 'EMULUXE_IFRAME_NAVIGATED' && data.payload?.url) {
                try {
                    const nav = new URL(data.payload.url);
                    urlInput.value = nav.href;
                    vscode.postMessage({ type: 'url_changed', url: nav.href });
                } catch(e) {}
            }
        });
    </script>
</body>
</html>`;
}
function deactivate() { }
//# sourceMappingURL=extension.js.map