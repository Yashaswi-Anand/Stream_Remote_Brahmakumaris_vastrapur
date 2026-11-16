# Test Report: Zoom Stream Automation 2.1.0

Test machine: Windows 11 Home 10.0.26300 (64-bit), time zone India Standard Time, Zoom Workplace **7.2.1.48556** (per-user install), Node 22.20, Electron 45. Date: 27 Oct 2026.

Legend: ✅ verified on this machine · ⚠️ implemented, needs a live Zoom meeting/YouTube account to verify · ℹ️ by design / platform limit

## Remote control website on Firebase (2.1.0, 16 Nov 2026, Firebase emulators on this PC)

Automated: desktop `npm test` 29/29 pass. `npm run test:firebase` 2/2 pass against the Auth + Realtime Database emulators:
- **Security rules test:**
  - owner claim needs the setup code, and the code can never be read;
  - invites are single-use and tied to the invited email;
  - clients can't promote themselves, read people, invites or the log, or create pairing codes;
  - pairing codes are single-use and expire;
  - only the paired PC writes its status;
  - commands are checked (allowed actions and values, the sender's own email, server time);
  - removing a person or PC revokes access at once.
- **Desktop connector test:** the real `RemoteClient` pairs, publishes state and preview, runs commands (including the PC's own error message), streams frames only while watched, goes offline/online with the switch, and notices removal.

Manual, in the browser pane and a separate test copy of the desktop app (own settings folder, `npm run web:local`):
- ✅ Owner created with the setup code; Admin → Add a PC → the test copy paired.
  - `config.json` holds only the address and ids.
  - The Firebase key is in the Windows-encrypted `remote-device.bin`.
- ✅ Website showed "PC online", Zoom "Not running" and the PC's activity. "Choose image" came back with the PC's real error ("That image is no longer in the image folder.").
- ✅ Live screen: 960×540 frames of about 32 KB every 2 s; the desktop showed the viewing notice. Closing the view stopped it and removed the frame.
- ✅ Invite link → client set a password → controls (no Admin); a client's command worked; the `/admin` address shows Home for a client.
- ✅ Download page with no GitHub release yet: shows "No release has been published yet".
- ✅ Owner removed the PC → the desktop Remote tab shows "This PC was removed on the website. Pair it again."
- ✅ Phone layout (375 px) checked.
- ⚠️ Not yet tested:
  - on a real Firebase project (the hosting security headers / CSP only apply there);
  - from a real phone;
  - Start/End Stream on a live meeting from the website.

## Remote control website (2.0.0, 6 Nov 2026, local Node.js server, replaced in 2.1.0)

Automated: desktop `npm test` 29/29 pass (incl. 5 new remote tests that run the real connector against the real server); `server/` `npm test` 4/4 pass.

- ✅ Owner created with the setup code; wrong code refused; setup closed once an account exists.
- ✅ Invite link → client sets password → works once; clients cannot manage people or PCs; 5 wrong passwords block sign-in.
- ✅ Writes without the app header or from another site are refused; a cross-site page cannot open the live socket.
- ✅ Pairing code works once; desktop test copy paired from the website; config.json holds only address/ids, the key is in Windows-encrypted `remote-device.bin`; tokens/passwords are stored only as hashes on the server.
- ✅ Website showed the PC online, Zoom status, schedule and the PC's activity; "Random image" came back with the PC's real error ("No images available.").
- ✅ Live screen: 1280×720 frames arrived; the desktop Remote tab showed the viewing notice; frames stop when the view closes.
- ✅ Removing the PC on the website disconnects it and its key stops working; turning "Allow remote control" off shows it offline.
- ✅ Phone layout (375 px) checked.
- ⚠️ Not yet tested from a real phone, over the internet (Hostinger, https, MySQL), or with Start/End Stream on a live meeting from the website.

## Automated tests (`npm test`): 24/24 pass (1.9.0)

Schedule maths (time zones incl. DST, once/daily/selected days, start dates), validation (past/invalid/missing), Task Scheduler XML, config recovery from corrupted/invalid JSON, atomic save + reload, Zoom link parsing, label-override validation, image filtering by extension **and** file signature, version comparison, update-manifest validation, meeting-name button matching, wake-readiness parsing (powercfg / registry), last-wake parsing, BIOS advice, wake-test state.

## Application

| Area | Result | Notes |
| --- | --- | --- |
| App launches, Home + Update tabs | ✅ | Screens checked via a test harness that drives the real main process |
| Zoom installed/running detection | ✅ | Found `%APPDATA%\Zoom\bin\Zoom.exe`, reported *Connected*, "No meeting open" |
| Image folder, random pick, preview | ✅ | 3 valid images listed, a fake `.png` (text content) and a `.txt` skipped, preview served via `zsa-img://` |
| Missing folder / empty folder | ✅ | Clear error messages (unit-tested) |
| Corrupted config.json | ✅ | Backed up as `config.corrupt-*.json`, defaults restored, warning shown |
| Settings persist across restarts | ✅ | Image folder and schedule survived several restarts |
| Schedule validation | ✅ | Past date rejected ("The scheduled time is in the past.") |
| Windows task registration | ✅ | `ZoomStreamAutomation-ScheduledStream` created, correct next run time, wake-to-run, start-when-available, single instance |
| **Task Scheduler launches the app at the scheduled time** | ✅ | Saved for 13:06 IST, Windows launched the app at 13:06:00, log: *"Scheduled run … triggered by Windows Task Scheduler"* |
| Duplicate trigger | ✅ | Re-running the task 4 minutes later: *"Duplicate scheduled launch … ignored"* |
| One-time task cleanup | ✅ | Task removed after the one-time run fired |
| Launch when not due | ✅ | Logged *"no scheduled stream is due now"*, nothing started |
| Missed schedule (PC off past the 15-min window) | ✅ unit + code path | Logged as *missed* on next start |
| Update tab without manifest URL | ✅ | Shows installed version and "update checking is unavailable" |
| Update check against a manifest | ✅ unit | HTTPS-only, invalid JSON/version/HTTP errors reported |
| Installer + portable build | ✅ | `dist/Zoom-Stream-Automation-Setup-1.0.0.exe`, `dist/Zoom-Stream-Automation-Portable-1.0.0.exe` |
| Install/uninstall on a clean PC | ⚠️ | Not run here (would modify this PC). NSIS uninstaller removes the scheduled task + sign-in entry, and the settings folder only if chosen |

A bug was found and fixed during testing: the scheduled-start check was attached after the first Zoom poll and could miss the page-load event, so a scheduled launch might not start. It now runs at startup.

## Zoom / YouTube automation (live tests, 27 Oct 2026, meeting "Yash's Zoom Meeting")

Zoom 7.2.1 does not expose its meeting toolbar, menus or share dialog to Windows UI Automation, so 1.2.0 reads them with Windows' built-in text recognition (OCR) and uses Zoom shortcuts as fallback.

| Step | Result | Notes |
| --- | --- | --- |
| Start meeting by name (Zoom home list) | ✅ | Name found by OCR, **Start** under it pressed (~4 s) |
| Zoom video preview | ✅ | **Start** pressed automatically; preview title confirmed the meeting name |
| Meeting window under taskbar | ✅ fixed | Window moved fully on screen before reading the toolbar |
| Toolbar labels (Audio … Share, Host tools, More, End) | ✅ | Read reliably; toolbar woken by moving the mouse in the same step |
| Share Screen + Share sound | ✅ | Dialog opened, *Screen* selected, *Share sound* tick confirmed from screen pixels, sharing toolbar detected |
| Share Image (window "ZSA Stream Image") + sound | ✅ | Through the real app: Forest.png shared with sound, then stopped |
| Stop share | ✅ | "Stop share" on the sharing toolbar; Zoom confirmed |
| End Stream → End meeting for all | ✅ | Meeting ended; window gone (tested twice) |
| Start Stream with no meeting open | ✅ up to YouTube | Opened Zoom meeting by name, pressed preview Start, then stopped at Live on YouTube (below) |
| More → Live on YouTube | ⚠️ not available on this account | More menu opened and read; the item is missing because this Zoom account is on the free plan (shows "Upgrade"). Zoom shows it only on Pro+ with live streaming enabled. The app reports this and closes the menu. The click path, LIVE-badge check and Stop Live Stream are implemented but untested |
| Start Stream, YouTube switch off (28 Oct) | ⚠️ partly | Found a bug: Zoom had started minimized and the app gave up after 45 s. Fixed: the app now restores a minimized/tray Zoom window and waits up to 90 s (verified: minimized window restored in 2 s). The rerun then stopped correctly at "Yash's Zoom Meeting": today's slot (12:00–12:30 AM) was over, so Zoom showed no Start button. 1.5.1 explains this and uses the meeting link/ID when set |
| Start Stream by Meeting ID, YouTube off (28 Oct, run 1) | ✅ start / ❌ end | Opened meeting 912 3456 7890 ("Yash's Zoom Meeting"), shared Forest.png with sound. End Stream failed: text was read from a window behind Zoom's see-through sharing toolbar. Fixed in 1.6.0: End uses Alt+Q and clicks only inside Zoom's leave dialog (verified by hand: Alt+Q → "End meeting for all" ended the meeting); Stop share reads only the toolbar strip, checks the result and falls back to Alt+S |
| Start Stream by Meeting ID (run 2) | ❌ | Start pressed in the video preview but the meeting did not open; Cancel did not stop the wait. Fixed in 1.6.0: Cancel stops it; the preview is brought to the front before pressing and re-pressed only after 8 s. Not re-tested live |
| Save schedule crash ("settings is not defined") | ✅ fixed | Schedule card now receives the settings; Save schedule tested: daily 05:50, task registered, no error page |
| Edit Time | ✅ | Only daily start time + Schedule enabled |
| Blank window report | ⚠️ not reproduced | Installed 1.5.1 started and drew the full UI with fresh and with copied settings. 1.6.0 adds an error page with Reload, auto-reload after a page crash, a show-window safety timer, and logs UI errors to logsapp.log |
| Disable annotation for others | ⚠️ not tested live | Added after every share (sharing toolbar → More). Live check was blocked: Zoom on this PC is now signed in to a different account (meeting list "Daily Murli 2026, Host: Brahmakumaris Vastrapur"), so meeting 912 3456 7890 did not open. Labels are Zoom's standard wording; the step never stops the stream and reports Not found if the wording differs |
| End Stream closes Zoom | ✅ | Close Zoom step: Zoom fully closed in ~7 s, no process left. Runs only after the meeting ended (otherwise it reports that Zoom was left open) |
| Share Image: ERR_FAILED loading imageWindow.html (portable) | ✅ fixed | Cause: the portable exe always unpacked to the same Temp folder, so starting another copy replaced the running copy's app.asar. Fixed: each portable launch now unpacks to its own folder, and the image page is built in memory (no file). Tested: image window shows the picture, title "ZSA Stream Image", reusable |
| Share the previewed image only | ✅ | Start Stream and Share Image use the selected (previewed) image: 10 of 10 runs used Ocean.jpg; random only when none selected. New Choose image… button (file picker, image contents checked) |
| YouTube Studio steps (account → Create → Go live → today's stream → Go live) | ⚠️ not tested live | Needs your YouTube account and a paid Zoom plan. Date matching unit-tested: 8 forms of today match; yesterday, tomorrow, 22 Nov, last year and "Today's views" do not. Each step logs the browser text it saw if it gets stuck |
| Share Image ERR_FAILED (portable, again in 1.8.0) | ✅ fixed | Real cause: the portable launcher runs `RMDir /r` on its fixed Temp folder at every start, so starting the exe again wiped the running copy's files; new windows then failed. 1.8.1 creates the image window hidden at start-up and only swaps the picture, and runs the automation helper from a copy in the settings folder. Reproduced with two launches of the portable exe: image window still opened |
| Cursor-free clicks | ✅ partly | Window-message click on Zoom's home "Meetings" tab switched the view and the pointer stayed at the same position. Meeting toolbar / share dialog / YouTube Studio not tested live; each falls back to a real click (pointer restored) only if the expected result did not appear |
| Automation helper start-up hang | ✅ fixed | Since a recent Windows update, creating a script block in a PowerShell started with -EncodedCommand hangs; 1.8.1 was affected on this PC. 1.9.0 starts the helper with -Command (verified: answers in under 1 s) |
| Google sign-in / consent | ℹ️ manual | Never automated, by design |
| Wake-readiness check | ✅ | On this laptop: wake timers on (charger) / off (battery), sign-in required after 15 min (blocks automation), Modern Standby |

**Requirements for the OCR steps:** PC awake and unlocked, Zoom windows visible and not minimized, Zoom in English, mouse left alone while a step runs.

## Power-on (1.3.0)

| Check | Result | Notes |
| --- | --- | --- |
| BIOS manageable from Windows | ✅ detected: **No** | Lenovo IdeaPad Slim 3 15IAH8 (83ER), BIOS LTCN44WW: no `Lenovo_BiosSetting` WMI class, so no app can set a BIOS power-on time on this PC |
| Hibernate available | ✅ | `powercfg /a` lists Hibernate |
| Wake-test task | ✅ | One-time task with "Wake the computer to run this task" registered, fired the app with `--wake-test`, removed afterwards |
| Wake-test verdict | ✅ honest | With the laptop awake the whole time, the test is **not** counted as passed: it requires Windows' resume/boot record after the test started |
| Real hibernate → power-on | ⚠️ not run here | Needs you to run **Test wake** (it hibernates the laptop). Not run during development so as not to power off your PC |

## Auto Power On tab (1.4.0)

| Check | Result | Notes |
| --- | --- | --- |
| PC / BIOS detection | ✅ | LENOVO IdeaPad Slim 3 15IAH8, laptop, BIOS LTCN44WW (2026-04-01), not manageable from Windows → IdeaPad guide selected |
| Windows status rows | ✅ | Fast Startup: On, sign-in: Windows Hello only, automatic sign-in: Off, launch at sign-in: Off, schedule: Not set (all match this PC) |
| Guide detection on other PCs | ✅ unit | 15 cases: IdeaPad, ThinkPad, ThinkCentre, Dell Latitude, HP EliteBook/ProDesk, Acer, self-built MSI/ASUS/Gigabyte/ASRock (maker "To Be Filled By O.E.M." → motherboard used), ASUS VivoBook, Surface, unreadable data |
| Default stream time | ✅ | Edit Time opens at 05:50 on the next upcoming day (tomorrow when 05:50 has passed); Auto Power On defaults to power-on 05:45 → stream 05:50 |
| Power-on time setting | ✅ | 05:40 / Weekdays saved; invalid time (25:99) rejected |
| Power-on confirmation logic | ✅ unit | Boot within 5 min of the set time counts as confirmed |
| Restart into BIOS / Open buttons | ⚠️ not clicked | Would restart this PC or open Windows dialogs; the commands are `shutdown /r /fw /t 15` (elevated), `ms-settings:` pages, `netplwiz`, Power Options |
| Real BIOS power-on | ⚠️ needs your PC | This IdeaPad most likely has no BIOS power-on option; check with F2/Novo using the tab's steps |

## Platform limits

- Software cannot power on a fully shut-down PC. Use sleep plus wake timers, BIOS/UEFI RTC wake, or Wake-on-LAN (see README).
- Zoom needs a signed-in desktop session; scheduled runs start after Windows sign-in.
- The builds are unsigned, so SmartScreen shows a warning on first run.
