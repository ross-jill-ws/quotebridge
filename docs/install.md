# Install

QuoteBridge for MetaTrader is one Windows installer. It installs for your Windows user only and never asks for
administrator rights.

## What you need

- Windows 10 or 11, 64-bit.
- MetaTrader 4 installed, with its MetaEditor (every normal MT4 installation has one). MetaTrader 5 terminals are
  listed but not supported yet.
- Ports **5555** (EAs) and **5580** (dashboard and REST API) free on `127.0.0.1`. Both can be changed in Settings
  later.

## Download

Download the installer from the [latest release](https://github.com/ross-jill-ws/quotebridge/releases/latest):

| File | What it is |
| --- | --- |
| `QuoteBridge-Setup-<version>-x64.exe` | The installer |
| `QuoteBridge-Setup-<version>-x64.exe.sha256` | Its SHA-256 checksum |

### Check the download

In PowerShell, in the folder you downloaded to:

```powershell
Get-FileHash .\QuoteBridge-Setup-0.2.0-x64.exe -Algorithm SHA256
Get-Content .\QuoteBridge-Setup-0.2.0-x64.exe.sha256
```

The two hashes must be the same. If they differ, delete the file and download it again.

## Run the installer

1. Double-click the installer.
2. **SmartScreen.** The installer is not code-signed yet, so Windows may show *Windows protected your PC*. Choose
   **More info**, check that the app is `QuoteBridge-Setup-…-x64.exe`, then **Run anyway**.
3. Accept the licence.
4. Choose the install folder, or keep the default `%LOCALAPPDATA%\Programs\QuoteBridge`. The folder must be one your
   user can write to and empty or new, because uninstalling removes the whole folder. A folder such as
   `Program Files`, or one that already holds other files, is refused with a message saying why.
5. Click **Install**, then **Finish**. The app starts and opens its setup screen: continue with
   [Getting started](getting-started.md).

## Where things are

| What | Where |
| --- | --- |
| The app | `%LOCALAPPDATA%\Programs\QuoteBridge` (or the folder you chose) |
| Settings, recorded data, saved history, API keys, logs | `%APPDATA%\QuoteBridge` |
| The bridge in each managed terminal | That terminal's `MQL4\Experts`, `MQL4\Include`, `MQL4\Libraries` and `templates` folders |
| The CLI's saved server and key | `~\.mt4-quote-bridge\config.json` (only if you use the CLI) |

## Update

Download the newer installer and run it: it installs over the current version and keeps your folder, settings and
data. Quit the app from the tray before you run it.

When the new version starts, it updates the bridge in every managed terminal by itself: it compiles the new EA with
each terminal's MetaEditor and leaves the old EA running if a compile fails. Charts pick up the new EA the next time
MetaTrader reloads it; [Terminals](terminals.md#setup-and-upgrades) explains how to check. While a terminal has an
unresolved trading request, its update waits.

The app does not update itself yet: watch the [releases](https://github.com/ross-jill-ws/quotebridge/releases) for a
new version.

## Uninstall

1. Optional: to take the bridge out of your terminals, open **Terminals** and click **Remove** on each one first.
   Uninstalling the app leaves the bridge files in your terminals.
2. Quit QuoteBridge from the tray.
3. Open **Windows Settings › Apps › Installed apps**, find **QuoteBridge for MetaTrader** and choose **Uninstall**.

Your data in `%APPDATA%\QuoteBridge` (settings, recordings, saved history) is kept, so reinstalling picks up where you
left off. Delete that folder yourself to remove it for good.

## If something goes wrong

| You see | Do this |
| --- | --- |
| *The EA port 5555 on 127.0.0.1 is already in use by another program.* | Another server (an older QuoteBridge or the legacy server) holds the port. Quit it, or change the port in Settings. |
| The installer refuses the folder | Choose a new or empty folder inside your user profile. |
| *No MetaTrader terminals were found* | Start each terminal once, then click **Rescan** in Terminals, or **Add folder…** for a portable one. |
| A terminal shows *Compile failed* | Click **Compile log** on its card, close MetaEditor if it is open, then **Recompile**. |
| The window stops changing views or stops updating | Press **F5** (or **Ctrl+R**) in the window. It reloads the page only; the server keeps running and the EAs stay connected. |
