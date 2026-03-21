# VS Code Extension Feature Proposal

Our research into the Emuluxe Chrome extension, Platform Simulation Page, and Pricing/Billing tiers has revealed several high-value features that would bring the VS Code extension to parity and provide a premium, "Pro" developer experience.

## 🚀 Priority 1: Advanced Simulation Controls
*   **Full Device Registry**: Unlock the 90+ hardware profiles (**Pro/Enterprise**). Free tier is limited to 6 curated devices (iPhone 15/Pro Max, Pixel 8, S24, iPad Pro 11, Foldable).
*   **Network Throttling**: Simulate connections (**Free: Basic/Offline, Pro/Enterprise: Advanced 5G/4G + Custom Latency/Upload/Download Overrides**).
*   **Geolocation Spoofing**: One-click GPS simulation to test location-aware apps (**Pro/Enterprise**).
*   **Biometric Testing**: Trigger simulated WebAuthn/Passkey prompts (**Pro/Enterprise**).

## 📸 Priority 2: High-Fidelity Capture Suite
*   **Full-Page Canvas Stitching**: Capture the entire scrollable height of the page (**Pro/Enterprise**).
*   **Enhanced Screenshots**: Captures available to all. **Free Tier includes diagonal watermarks**; Pro/Enterprise are watermark-free.
*   **Viewport-Only Export**: Capture just the site content without the device frame (**All Plans**).
*   **HQ Video Recording**: Enable 4K session recording (**Pro/Enterprise**).

## 🛠️ Priority 3: Developer Workflow & UI
*   **Multi-Device View**: View machines in a grid or split-view (**Free: 1 device, Pro: up to 3, Enterprise: 10+**).
*   **Cloud Sync & Named Sessions**: Open saved sessions from the platform directly in VS Code (**Pro/Enterprise**).
*   **Safe Area Debugging**: Toggle-able overlay to visualize `env(safe-area-inset-*)` regions (**All Plans**).
*   **Touch Cursor**: Toggle a specialized touch pointer for mobile simulation accuracy (**All Plans**).

## ✨ Premium Aesthetics & Advanced Testing
*   **3D Hover Tilt**: Interactive 3D tilt effect on the device frame (**All Plans**).
*   **Device Metadata**: Display DPR, Viewport resolution in the Status Bar (**All Plans**).
*   **Interactive Battery Simulation**: Test Battery Status API hooks (**Free/Pro/Enterprise**).
*   **AI Page Insights**: Integrated "Scan for Issues" button (**Pro: 3 points, Enterprise: Deep Analysis/Copilot**).
*   **Custom User-Agents**: Fully customizable UA strings (**Pro/Enterprise**).

---

> [!TIP]
> **Priority Suggestion**: We recommend starting with **Network Throttling** and **Full-Page Screenshots**, as these are the most requested features for developers debugging responsive web apps in IDEs.
