# Changelog

### 1.1.2 (2026-03-21)
- **Full Feature Parity**: Added all remaining features from the Chrome extension to the VS Code panel.
    - Added **3D Hover Tilt** support for Pro/Enterprise users.
    - Added **Foldable Controls** (Fold State, Crease) for foldable devices.
    - Added **Browser Interface Toggles** (Top Bar, Bottom Bar, Full URL, Native Scrollbars).
- **Simulation Stability**: Fixed a critical regression that caused blank screens on load.
- **Improved Performance**: Hardened rendering logic and SVG generation for smoother simulation.
- **Bug Fixes**: Fixed SyntaxError in webview and resolved battery sync issues.

## [1.1.1] - 2026-03-21

### Added
- **Extension Detection**: Enabled the Emuluxe platform to natively recognize the VS Code extension for a seamless login and dashboard experience (resolves "Extension Required" error).

## [1.1.0] - 2026-03-20

### Changed
- **Packaging**: Optimized VSIX bundling logic to ensure all required dependencies are included.
- **Performance**: Improved extension activation time and resource management.

## [1.0.10] - 2026-03-20

### Fixed
- **URL Bar**: Smart protocol handling for URL bar (automatically prefixing https/http).
- **UI Styling**: Neutral background for webview to prevent white flashes.
- **Diagnostics**: Improved state reporting for remote simulation contexts.

## [1.0.9] - 2026-03-19
- **Connectivity**: Improved proxy path resolution in webview.
- **Protocol**: Smart protocol handling for URL bar.

## [1.0.8] - 2026-03-18
- **Telemetry**: Pass source=vscode and force proxy path in webview.

## [1.0.7] - 2026-03-17
- **UI**: Browser-chrome UI shell, URL bar navigation.

## [1.0.6] - 2026-03-16
- **Simulation**: IDE-specific simulation fixes and plan-based device locking.

All notable changes to the Emuluxe VS Code extension will be documented in this file.

## [1.0.0] - 2026-03-19

### Added
- **Interactive QuickPicks**: Emuluxe now lets you dynamically select which device (e.g. iPhone 15 Pro Max vs Pixel 8 Pro) seamlessly without hardcoding defaults.
- **IPC Hotkey Bridge**: Press `Cmd+R` to quickly toggle the device into landscape mode, and press `Cmd+S` to securely extract a full-resolution DOM layout natively using `html-to-image`.
- **Intelligent Gating UI**: Emuluxe seamlessly overlays accurate session limits driven heavily by the remote backend authentication tiers immediately directly into the simulator viewport.
- **Embedded Simulation Architecture**: The Webview now receives robust rendering contexts identical to those seen remotely within Chrome without injecting messy third-party dependencies natively into the editor workspace.
- **Branding Upgrade**: Complete visual identity integration. SVG pre-loaders with precise gradient meshes ensure loading looks phenomenal.
