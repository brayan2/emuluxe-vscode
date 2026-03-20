# Emuluxe: Mobile Simulation for VS Code

Emuluxe brings a powerful, full-featured hardware foundry directly into your editor, eliminating context switching and accelerating your mobile-first development. 

Test your web applications natively on realistic device mockups complete with precise resolution sizing and network throttling, directly within VS Code!

## Key Features
- **Interactive Device Quick-Pick**: Seamlessly simulate your code on popular devices directly inside your active environment (`Cmd+Alt+D`).
- **Instant Orientation Switching**: Toggle between portrait and landscape instantly using `Cmd+R`.
- **High-Res Screenshot Engine**: Capture high-fidelity device mockups including the site content with `Cmd+S`.
- **Developer Inspector**: Open the inspector to debug your proxied application using `Cmd+I`.
- **Plan Enforcement Engine**: Emuluxe automatically pairs your dashboard tier limits (Free, Pro, Enterprise) directly into the IDE.

## Commands & Shortcuts
| Command | Shortcut | Description |
| --- | --- | --- |
| `Emuluxe: Start Simulation` | `Cmd+Alt+E` | Launch the simulator |
| `Emuluxe: Change Device` | `Cmd+Alt+D` | Switch active device |
| `Emuluxe: Rotate Device` | `Cmd+R` | Toggle orientation |
| `Emuluxe: Take Screenshot` | `Cmd+S` | Capture device snapshot |
| `Emuluxe: Open Inspector` | `Cmd+I` | Debug webview content |
| `Emuluxe: Stop Simulation` | `Cmd+Alt+X` | Close the simulator |
| `Emuluxe: Login` | `Cmd+Alt+L` | Authenticate with Emuluxe |

## Installation
1. Install this extension from the marketplace.
2. Hit `Cmd+Shift+P` and type **`Emuluxe: Login`**. This will open your dashboard to get your CLI token.
3. Open your VS Code Settings (`Cmd+,`), search for "Emuluxe", and paste your token under the *Emuluxe: Token* field.

> Note: All Chrome browser extension features are transparently supported out of the box natively via our Inter-Process-Communication bridge!
