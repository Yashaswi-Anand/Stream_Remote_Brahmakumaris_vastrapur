# Zoom Stream Automation

A Windows desktop app (Electron + React + Node.js) that automates a Zoom → YouTube live stream:
open Zoom, join your meeting, start **Live on YouTube**, share a random image (with sound) and
switch to screen sharing with computer audio. It can also start everything on a schedule.

Everything runs locally on the stream PC. Settings live in one JSON file. Version 2.0 adds an optional **remote control website** (`server/`) so the stream can be run from a phone; see [Remote control website](#remote-control-website).

---

## Download / share

| File | Use it when |
| --- | --- |
| `dist/Zoom-Stream-Automation-Setup-2.0.0.exe` | Normal install (Start-menu entry, uninstaller, per-user, no admin needed). **Recommended**, and required if you use schedules on a regular basis. |
| `dist/Zoom-Stream-Automation-Portable-2.0.0.exe` | Run without installing (e.g. from a USB stick). Schedules point at the exe's current location, so don't move it after saving a schedule. |

Copy either file to another Windows 10/11 (64-bit) PC and run it. No source code, Node.js or other runtime is needed.
The builds are not code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info → Run anyway**.

## Requirements on the PC that streams

1. **Zoom Workplace desktop client**, signed in (tested with 7.2.1).
2. **YouTube live streaming enabled in Zoom**: zoom.us → Settings → *In Meeting (Advanced)* → *Allow livestreaming of meetings* → tick **YouTube**. You must be the **host**, or co-host where your account allows it.
3. **YouTube channel enabled for live streaming** (YouTube Studio → Go Live; the first time can take up to 24 hours).
4. The first time you go live, Zoom opens your browser for Google sign-in and consent. That step is always yours: the app never stores passwords or bypasses sign-in, 2-step verification or consent screens.

---

## Using the app

### Home tab
- **Zoom card**: shows *Connected* (Zoom running), *Disconnected* (installed, not running) or *Not Installed*, plus whether a meeting window is open. **Open Zoom & meeting** opens Zoom and starts your meeting by name (or brings an open meeting to the front). **Diagnostics** saves Zoom's on-screen control names to a file (see Troubleshooting).
- **Stream**: two switches, **both on by default**, then **Start Stream**:
  - **Open Zoom and my meeting if needed**: if no meeting is open, opens Zoom and your meeting by its **Zoom Meeting ID** (Stream settings), then presses Start/Join in Zoom's video preview. Works at any time of day. Off: only uses a meeting that is already open.
  - **Go live on YouTube**: starts Zoom's *Live on YouTube* (paid Zoom plan needed). Off: the image is shared in Zoom without going live.

  Scheduled streams use the same switches.

  Each step shows its live status (✓ done, ✕ failed with the reason and what to do). Start is disabled while a stream is live or an automation is running, so duplicate starts can't happen. **Cancel** stops a running automation.
- **End Stream** (asks first): stops the YouTube live stream and sharing, closes the image window, **ends the meeting for all** and then **closes Zoom**. Zoom is only closed once the meeting has really ended, so a meeting is never left running without its host.
- **Share**: **Share Image** shares the selected image, **Share Screen** shares your screen with computer audio, **Stop Share** stops sharing.
- **Share image**: **Choose image…** picks one specific picture; **Choose Folder** picks a folder of PNG/JPG/JPEG/WebP images and **Pick another random image** picks a different one from it. **The image shown in the preview is the one shared** by Start Stream and Share Image (a random one is picked only when none is selected). Files that only look like images (wrong contents) are rejected.
- **Schedule**: shows the next run. **Edit Time** has just the **daily start time** (default **05:50 AM**) and **Schedule enabled**: the stream starts automatically every day at that time, in this PC's time zone. You can also turn the schedule off with the toggle or delete it.
- **Recent activity**: every action, success, failure and scheduled/missed run.

### Auto Power On tab
Sets up the PC to **switch itself on from Shut down** at the stream time, using the BIOS power-on alarm:
- **This PC** shows the maker, model and BIOS version, whether the BIOS can be managed from Windows, and the last start time. **Restart into BIOS** restarts straight into BIOS/UEFI setup (administrator approval required); **Open Advanced startup** is the manual route (Troubleshoot → Advanced options → UEFI Firmware Settings).
- **1. Power-on time**: enter the time you set in the BIOS. The app suggests 5 minutes before your next stream (05:45 for the default 05:50 stream) and **confirms automatically** when the PC really started at that time (shown as ✓ Confirmed and logged).
- **2. Set it in the BIOS**: step-by-step instructions **for the PC the app is installed on**. The app reads the PC maker, model, laptop/desktop type and motherboard maker from Windows and picks the matching guide: Lenovo (ThinkCentre/ThinkPad, IdeaPad/Yoga/Legion), Dell, HP, Acer, or, for desktops and self-built PCs, the ASUS, MSI, Gigabyte or ASRock motherboard guide. Unknown PCs get general steps. The detected guide is marked "(detected)" and can be changed.
- **3. Windows settings after power-on**, each with its current status and an **Open** button: Fast Startup off, password sign-in allowed, automatic sign-in (netplwiz), app opens at sign-in, stream schedule saved.
- **4. Test it**: a 5-minute test with the exact time to enter.
- **No power-on option in BIOS?** Hibernate until stream, smart plug + "Power On With AC Attach", or a mini PC/desktop.

### Remote tab
- Pairs this PC with your remote control website. On the website (signed in as the owner) open **Admin → Add a PC**, then type the website address and the 8-character code here.
- **Allow remote control** switches the connection on/off. **Unpair this PC** removes it. A notice appears while someone on the website is viewing this PC's screen.
- The PC only connects *out* to the website; nothing on the PC is opened to the internet. Its access key is stored encrypted by Windows (`remote-device.bin` in the settings folder), never in `config.json`.

### Update tab
- Shows the installed version and, once a **release manifest URL** is set, the latest version and its release notes. Without a URL, it says update checking is unavailable.
- Manifest format (served over HTTPS):
  ```json
  { "version": "1.7.0", "releaseNotes": "What changed…", "downloadUrl": "https://…/Zoom-Stream-Automation-Setup-2.0.0.exe", "publishedAt": "2026-11-01" }
  ```
- **Uninstall** opens the Windows uninstaller after you confirm. Nothing is removed until you confirm in the uninstaller. Tick *Also delete my settings…* to remove the settings folder as well. The uninstaller always removes the app's scheduled task and Windows sign-in entry; upgrades keep them. The portable build has no uninstaller: use **Remove schedule & startup entry**, then delete the exe.

---

## Remote control website

`server/` is a small Node.js website (no build step) that the client opens on a phone:

- **Sign-in** with Owner and Client roles. The owner is created once with a setup code; others get a one-time invite link and set their own password. Passwords are stored only as scrypt hashes; sessions use HttpOnly, SameSite=Strict cookies; sign-in attempts are rate limited.
- **Controls** (same rules as the app window): Start Stream, End Stream (with confirmation), Cancel, I'm live, Share Image / Screen / Stop, choose or randomize the image (with preview), daily schedule time and on/off, Open Zoom meeting, step-by-step progress and the PC's activity log.
- **Live screen**: the PC sends about one compressed frame every 1.5 s, only while someone has the view open.
- **Admin** (owner): pair and remove PCs, invite and remove people, change password, and a "who did what" log of every command.
- **Download** (signed-in people): the newest `Zoom-Stream-Automation-Setup-X.Y.Z.exe` and `…-Portable-X.Y.Z.exe` found in the downloads folder (`DOWNLOADS_DIR`, default `server/downloads`; locally `server/.env` points it at `dist/`). Only those two files are served, and each download is logged. On the live server, upload new installers to that folder (they are too large for GitHub).

Run it locally on the stream PC (for testing on the same Wi-Fi):

```
cd server
npm install
npm start
```

Open the address it prints (e.g. `http://localhost:8787`, or `http://<PC-IP>:8787` from a phone on the same Wi-Fi). Without `DB_HOST` it stores data in `server/data/db.json`; on the live server set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (MySQL), `SETUP_CODE`, `PUBLIC_URL` and `REQUIRE_HTTPS=true` as environment variables (see `server/.env.example`). The internet address must be `https://`; the desktop app accepts plain `http://` only for local-network addresses.

## How the automation works (and what stays manual)

Zoom has no public API for driving the desktop client. Zoom 7.x also draws its meeting toolbar, menus and share dialog itself, so their buttons are invisible to Windows UI Automation. The app therefore finds controls the way a person does: it reads the text on screen with **Windows' built-in text recognition (OCR)** and clicks the matching label, using Zoom's keyboard shortcuts as a fallback. A bundled PowerShell helper (`resources/zoom-uia.ps1`) does this work. Every step is checked against what Zoom actually shows; nothing is reported as done on assumption.

| Step | How | Verified by |
| --- | --- | --- |
| Launch Zoom / open meeting | Starts `Zoom.exe` and opens your **Meeting ID** (or invite link) with a `zoommtg://` link. Presses **Start/Join** in Zoom's video preview. Moves the meeting window fully on screen | Meeting window appears; the meeting name Zoom shows in the preview is logged |
| Live on YouTube | Meeting toolbar **More → Live on YouTube** | Zoom's **LIVE** badge, or *Stop Live Stream* in the More menu |
| YouTube page | In the browser: clicks your **YouTube account** in Google's account chooser if shown (set in Stream settings), then YouTube Studio **Create → Go live**, selects **today's** scheduled stream (only today's date, never another day) and clicks **Go live**. Then **Go Live!** on Zoom's page if shown. Passwords, 2-step verification and consent screens stay manual | Zoom LIVE badge. If it can't be read, press **I'm live**, and the stream is shown as *confirmed by you*, not *verified*. If no stream is scheduled for today, it stops and says so |
| Share image | Shows the image in a window titled **ZSA Stream Image**, then **Share → that window → Share sound → Share** | Zoom's sharing toolbar appears; *Share sound* tick is read from the screen |
| Disable annotation for others | Right after any share starts (Start Stream, Share Image, Share Screen): sharing toolbar **More → Disable annotation for others** | Skipped if the menu already offers *Enable annotation for others*; if the option is not found, the step shows *Not found* and the stream continues |
| Share screen | Stops any current share, then **Share → Screen → Share sound → Share** | Same as above. Sound is reported as *On* or *Not confirmed* |
| End stream | **More → Stop Live Stream**, **Stop share**, **Alt+Q → End meeting for all**, then close Zoom (normal close, force-close if it stays in the tray) | Each state re-read; meeting window gone; no Zoom process left |

**Live on YouTube needs a paid Zoom plan.** Zoom shows *Live on YouTube* only on Pro or higher plans, with *Allow livestreaming of meetings → YouTube* enabled, and only to the host. On a free (Basic) account the item is missing and Start Stream stops at that step with this explanation.

**Your mouse pointer is not moved.** Clicks and the "wake the toolbar" hover are sent straight to the Zoom or browser window as window messages. After each click the app checks that the expected result appeared (menu opened, sharing started, meeting ended, next YouTube page shown). Only if it did not, it repeats that one click as a real click and puts the pointer straight back where it was.

**Keep the screen visible during automation.** Text recognition reads the real screen: the PC must be awake and unlocked, the Zoom windows not minimized or covered, and the mouse left alone while a step runs. Zoom's interface language must be English (labels can be changed with label overrides).

Why an image window? The Zoom desktop client cannot share an image file directly, so the app displays the image full-window and shares that window, sound included.

Zoom only allows one share at a time, so the app stops the current share before starting another.

Keyboard fallbacks are used when a button can't be found: **Alt+S** (share) and **Alt+Q** (end/leave).

**Needs your hands:** Google sign-in/consent for YouTube, Zoom passcode/waiting-room prompts, and OS permission prompts. Also any Zoom dialog the app doesn't recognise, in which case it stops and tells you which step failed.

---

## Scheduling, startup and powering on

- Saving a schedule registers a **Windows Task Scheduler** task named `ZoomStreamAutomation-ScheduledStream` (your user, no admin). The task launches the app with `--scheduled-start` and has these settings:
  - *Wake the computer to run this task* is on, so it can wake the PC from **sleep/hibernate**.
  - *Run as soon as possible after a missed start* is on.
  - Only one instance runs at a time.
- If the app is already open, the running app handles the trigger, so no second copy starts. The app also runs a timer while open. Each scheduled occurrence starts **at most once**, and duplicate triggers are logged and ignored.
- A trigger up to **15 minutes late** (e.g. right after waking) still starts the stream. Later triggers, or occurrences that passed while the PC was off, are logged as **missed**.
- *Ask me before starting* shows a prompt. If nobody answers within 5 minutes, the run is skipped. With *Start the stream automatically* off, the app and Zoom only open.
- **Launch at Windows sign-in** (Stream settings) adds a standard sign-in entry.
- **Check wake readiness** (Schedule card) checks this PC: scheduled task registered, wake timers on charger/battery, current power source, whether Windows asks for sign-in after sleep, and the sleep type. Fix every ✕ before relying on an unattended early-morning stream.

### Powering the PC on for the stream

No Windows app, including this one, can power on a computer that is fully **shut down**: when it is off, no software runs. What the app can do:

1. **Hibernate until stream (recommended for laptops).** Hibernate saves your session to disk and powers the PC off, using no power like Shut down. Windows can still power it back on for the scheduled task through the firmware's wake timer. Click **Hibernate until stream** on the Schedule card instead of shutting down.
2. **Sleep.** The scheduled task wakes the PC. Uses a little battery overnight.
3. **BIOS/UEFI scheduled power-on** (*Automatic Power On*, *RTC Alarm*, *Resume by Alarm*, *Wake on RTC*): works even from Shut down, but only if your PC's BIOS has it. You set it once in BIOS setup (Lenovo/Dell: F2, HP: F10) a few minutes before the stream time. Business PCs (ThinkPad, ThinkCentre, Dell OptiPlex/Latitude, HP EliteBook) usually have it and can also be configured from Windows with the maker's tools. Consumer laptops such as **Lenovo IdeaPad** usually do not. **Check wake readiness** tells you whether this PC's BIOS can be configured from Windows.
4. **Wake-on-LAN** from another device on the network, if your network card and BIOS support it (rarely over Wi-Fi).

**Prove it on your PC with "Test wake".** The app registers a one-time wake task a few minutes ahead, hibernates the PC, and records what happens. The test passes only if Windows' own logs show the PC resumed or booted after the test started and the app ran on time. It also records whether the screen was locked, because on a locked screen the app cannot control Zoom. A test that never reports back is marked failed after 20 minutes.

For an unattended stream the PC must be **plugged in** (wake timers are often off on battery), the **lid open**, and Windows set to **not ask for sign-in after sleep** (Settings → Accounts → Sign-in options → "If you've been away…" → Never). That last one is a security trade-off for you to decide. The task then runs any start that is still within the 15-minute window.

---

## Settings file

`%APPDATA%\Zoom Stream Automation\config.json` is created on first launch:

```json
{
  "app": { "version": "1.9.0", "launchOnWindowsStartup": false, "logRetention": 300 },
  "zoom": { "executablePath": "", "meetingLink": "", "lastKnownStatus": "disconnected", "labelOverrides": {} },
  "streaming": { "defaultMode": "live", "imageFolderPath": "", "selectedImagePath": "", "shareSound": true,
                 "shareComputerAudio": true, "autoClickGoLive": true, "liveConfirmTimeoutMinutes": 5 },
  "schedule": { "enabled": false, "date": "", "time": "05:50", "timeZone": "Asia/Kolkata", "repeat": "once", "selectedDays": [],
                "streamingMode": "live", "autoStart": true, "requireConfirmation": false, "savedAt": "",
                "lastExecutedOccurrence": "", "lastMissedOccurrence": "" },
  "updates": { "latestVersion": "", "releaseManifestUrl": "", "lastCheckedAt": "", "releaseNotes": "", "downloadUrl": "" },
  "logs": []
}
```

- The file is validated on load. Unknown or invalid values fall back to defaults. A corrupted file is renamed `config.corrupt-<time>.json` and replaced with defaults, and a warning appears in the app.
- Writes are atomic (write temp file, then rename).
- Only the newest `logRetention` activity entries are kept in the JSON. A full text log is in `logs\app.log`, rotated at 1 MB with 3 files kept.
- No passwords or tokens are stored. The meeting link is stored as you enter it; if it contains `pwd=…`, that is Zoom's encoded passcode from the invite link.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| *Could not find the "More" button* / share dialog items | Keep the meeting window visible (not minimized or covered) and the PC unlocked; don't move the mouse while a step runs. Zoom must be in English, or add patterns with label overrides (below). |
| "Live on YouTube" not in More menu | Needs a paid Zoom plan (Pro+), YouTube enabled under zoom.us → Settings → In Meeting (Advanced) → *Allow livestreaming of meetings*, and you must be the host. |
| Stream stuck on *Waiting for YouTube* | Finish sign-in/consent in the browser and click **Go Live!**. If Zoom is live but the app can't see it, press **I'm live**. |
| Sound shows *Not confirmed* | The "Share sound" tick could not be read. Check it in Zoom's sharing toolbar (More → Share sound). |
| App opens to a blank window | 1.6.0 shows an error page with a **Reload** button instead, reloads automatically after a page crash and records the problem in `logsapp.log`. Send that log file if it happens again. |
| Schedule shows *Windows task: Not registered* | See the activity log for the Task Scheduler error. The schedule still runs while the app is open. |
| Nothing happened at the scheduled time | Was the PC on and signed in? See the activity log for *missed* entries and the power-on section above. |

**Label overrides.** Each key in `src/services/zoom/labels.js` can be replaced in `config.json`. Values are case-insensitive regexes, tried in order. For example, a German Zoom client:

```json
"labelOverrides": { "moreButton": ["^Mehr$"], "stopShare": ["^Freigabe beenden"] }
```

---

## Building from source

Requirements: Node.js 20+ and npm, on Windows.

```bash
npm install
```

```bash
npm start
```

That builds the UI and runs the app in development mode. To run the unit tests:

```bash
npm test
```

To build the installer and portable exe into `dist/`:

```bash
npm run dist
```

`npm run dist:installer` and `npm run dist:portable` build just one of them. To release a new version, bump `version` in `package.json`, run `npm run dist`, then publish the new exe and update your release manifest.

### Project layout

```
src/main/            Electron main process: lifecycle, IPC (validated), image window
src/preload/         contextBridge API, the only thing the UI can call
src/renderer/        React UI (Home, Update tabs)
src/services/
  config/            JSON schema, defaults, atomic store
  logging/           activity log + rotating file log
  zoom/              Zoom detection, UI-automation client, control labels
  youtube/           Zoom "Live on YouTube" workflow
  streaming/         Start/End/Share workflow orchestration
  scheduler/         schedule maths, Windows Task Scheduler, missed/duplicate handling
  images/            folder scan, image validation, random pick
  updates/           manifest check, version compare
resources/zoom-uia.ps1  Windows UI Automation helper
build/               icon, NSIS uninstall hooks
tests/               node:test unit tests
```

### Security
- The UI runs with context isolation and sandboxing, without Node integration. It can only call the named actions in `preload.js`, and every IPC call is checked for sender and validated in `src/main/ipc.js`.
- The renderer has no filesystem access. Images are served through a `zsa-img://` protocol that only returns the currently selected image inside the chosen folder.
- No credentials are stored. External links open only over HTTPS.
