'use strict';

const { execFile, spawn } = require('child_process');

function run(file, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))));
  });
}

/** Hibernates the PC (saves the session to disk and powers off). Windows can wake it for a scheduled task. */
function hibernate() {
  const child = spawn('shutdown.exe', ['/h'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

/** Summarizes `powercfg /lastwake`, e.g. "Timer: …" when the PC was woken by a scheduled task. */
function parseLastWake(text) {
  const t = String(text);
  const count = Number((t.match(/Wake Source Count\s*-\s*(\d+)/i) || [])[1] || 0);
  if (!count) return { count: 0, summary: 'Windows recorded no wake source (normal after a power-on from hibernate on some PCs).' };
  const type = (t.match(/Type:\s*(.+)/i) || [])[1];
  const owner = (t.match(/Owner Supplied Reason:\s*(.+)/i) || [])[1] || (t.match(/Reason:\s*(.+)/i) || [])[1];
  const name = (t.match(/(?:Friendly Name|Instance Path|Description):\s*(.+)/i) || [])[1];
  const parts = [type, owner, name].map((x) => x && x.trim()).filter(Boolean);
  return { count, summary: parts.length ? parts.join(' — ') : 'Wake source recorded.' };
}

async function lastWake() {
  return parseLastWake(await run('powercfg.exe', ['/lastwake']).catch(() => ''));
}

/**
 * When the PC last returned from sleep/hibernate (System log, Power-Troubleshooter event 1) and last booted.
 * Used as proof that a wake test really powered the PC on, rather than the app just running at that time.
 */
async function lastResume() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$e = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; Id=1} -MaxEvents 1",
    "$src = if ($e) { (($e.Message -split '\r?\n') | Where-Object { $_ -match '^Wake Source' }) -join ' ' } else { '' }",
    "$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime",
    "[pscustomobject]@{ resumedAt = if ($e) { $e.TimeCreated.ToUniversalTime().ToString('o') } else { '' }; wakeSource = ($src -replace '^Wake Source:\s*', ''); bootAt = if ($boot) { $boot.ToUniversalTime().ToString('o') } else { '' } } | ConvertTo-Json -Compress",
  ].join('; ');
  try {
    return JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 30000)).trim());
  } catch {
    return { resumedAt: '', wakeSource: '', bootAt: '' };
  }
}

/** True when the Windows lock/sign-in screen is showing (LogonUI runs only then). */
async function isSessionLocked() {
  const out = await run('tasklist.exe', ['/FI', 'IMAGENAME eq LogonUI.exe', '/NH']).catch(() => '');
  return /LogonUI\.exe/i.test(out);
}

/**
 * Whether this PC's BIOS/UEFI settings can be managed from Windows (vendor WMI interfaces), which is
 * how vendor tools set a scheduled power-on. Read-only: nothing is changed.
 */
async function biosCapability() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$cs = Get-CimInstance Win32_ComputerSystem',
    "$lenovo = [bool](Get-CimClass -Namespace root\\wmi -ClassName Lenovo_BiosSetting)",
    "$dell = [bool](Get-CimClass -Namespace root\\dcim\\sysman\\biosattributes -ClassName EnumerationAttribute)",
    "$hp = [bool](Get-CimClass -Namespace root\\HP\\InstrumentedBIOS -ClassName HP_BIOSSetting)",
    "$wake = @(); if ($lenovo) { $wake = @(Get-CimInstance -Namespace root\\wmi -ClassName Lenovo_BiosSetting | Where-Object { $_.CurrentSetting -match 'Alarm|PowerOn|Power On|WakeUp|AutoOn|RTC' } | ForEach-Object { $_.CurrentSetting }) }",
    "[pscustomobject]@{ maker = $cs.Manufacturer; model = $cs.Model; family = $cs.SystemFamily; lenovo = $lenovo; dell = $dell; hp = $hp; wakeSettings = $wake } | ConvertTo-Json -Compress",
  ].join('; ');
  try {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 30000);
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

/** Plain-language advice for powering on from shut down, based on biosCapability(). */
function describeBios(cap) {
  if (!cap) return { ok: null, detail: 'Could not read the PC model. Check your BIOS/UEFI setup for a "power on at a set time" option.' };
  const pc = [cap.maker, cap.family || cap.model].filter(Boolean).join(' ');
  const setupKey = /lenovo/i.test(cap.maker) ? 'F2 (or the Novo button)' : /dell/i.test(cap.maker) ? 'F2' : /hp|hewlett/i.test(cap.maker) ? 'F10' : 'F2/Del';
  if (cap.lenovo && cap.wakeSettings && cap.wakeSettings.length) {
    return { ok: true, detail: `${pc}: the BIOS has a scheduled power-on setting (${cap.wakeSettings.join('; ')}). Set it in BIOS setup (${setupKey}) or with Lenovo's BIOS tools.` };
  }
  if (cap.lenovo || cap.dell || cap.hp) {
    return { ok: null, detail: `${pc}: BIOS settings can be managed from Windows with the maker's tools (Lenovo BIOS settings / Dell Command | Configure "Auto On" / HP BIOS Configuration Utility "BIOS Power-On"). Restart and press ${setupKey} to check for a power-on time.` };
  }
  return {
    ok: false,
    detail: `${pc}: the BIOS cannot be configured from Windows, and consumer models usually have no "power on at a set time" option. Restart and press ${setupKey} to check. Otherwise use Hibernate (below) instead of Shut down.`,
  };
}

/**
 * Everything the "Auto Power On" tab shows, read in one PowerShell call (read-only):
 * PC/BIOS identity, whether BIOS settings are manageable from Windows, last boot/resume,
 * Fast Startup, automatic sign-in and the "Windows Hello sign-in only" setting.
 */
async function systemPowerInfo() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$cs = Get-CimInstance Win32_ComputerSystem; $b = Get-CimInstance Win32_BIOS; $os = Get-CimInstance Win32_OperatingSystem; $bb = Get-CimInstance Win32_BaseBoard',
    "$lenovo = [bool](Get-CimClass -Namespace root\\wmi -ClassName Lenovo_BiosSetting)",
    "$dell = [bool](Get-CimClass -Namespace root\\dcim\\sysman\\biosattributes -ClassName EnumerationAttribute)",
    "$hp = [bool](Get-CimClass -Namespace root\\HP\\InstrumentedBIOS -ClassName HP_BIOSSetting)",
    "$wake = @(); if ($lenovo) { $wake = @(Get-CimInstance -Namespace root\\wmi -ClassName Lenovo_BiosSetting | Where-Object { $_.CurrentSetting -match 'Alarm|PowerOn|Power On|WakeUp|AutoOn|RTC' } | ForEach-Object { $_.CurrentSetting }) }",
    "$pw = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power'",
    "$wl = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'",
    "$pl = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\PasswordLess\\Device'",
    "$e = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; Id=1} -MaxEvents 1",
    '[pscustomobject]@{',
    '  maker = $cs.Manufacturer; model = $cs.Model; family = $cs.SystemFamily; pcType = $cs.PCSystemType',
    '  boardMaker = $bb.Manufacturer; boardProduct = $bb.Product; biosMaker = $b.Manufacturer',
    '  biosVersion = $b.SMBIOSBIOSVersion; biosDate = if ($b.ReleaseDate) { $b.ReleaseDate.ToString(\'yyyy-MM-dd\') } else { \'\' }',
    '  lenovo = $lenovo; dell = $dell; hp = $hp; wakeSettings = $wake',
    "  fastStartup = if ($null -ne $pw.HiberbootEnabled) { [int]$pw.HiberbootEnabled -eq 1 } else { $null }",
    "  autoSignIn = ([string]$wl.AutoAdminLogon -eq '1'); autoSignInUser = [string]$wl.DefaultUserName",
    "  helloOnly = if ($null -ne $pl.DevicePasswordLessBuildVersion) { [int]$pl.DevicePasswordLessBuildVersion -eq 2 } else { $false }",
    "  bootAt = if ($os.LastBootUpTime) { $os.LastBootUpTime.ToUniversalTime().ToString('o') } else { '' }",
    "  resumedAt = if ($e) { $e.TimeCreated.ToUniversalTime().ToString('o') } else { '' }",
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  try {
    const info = JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 40000)).trim());
    info.wakeSettings = [].concat(info.wakeSettings || []);
    return info;
  } catch (err) {
    return { error: err.message };
  }
}

/** Restarts straight into BIOS/UEFI setup (Windows asks for administrator approval). */
function restartToFirmware() {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Start-Process shutdown.exe -ArgumentList '/r','/fw','/t','15' -Verb RunAs"], 60000);
}

/** Opens one of the Windows settings pages the setup steps point to. */
function openWindowsPage(page) {
  const targets = {
    signInOptions: ['explorer.exe', ['ms-settings:signinoptions']],
    recovery: ['explorer.exe', ['ms-settings:recovery']],
    netplwiz: ['netplwiz.exe', []],
    powerButtons: ['control.exe', ['/name', 'Microsoft.PowerOptions', '/page', 'pageGlobalSettings']],
  };
  const t = targets[page];
  if (!t) throw new Error('Unknown page.');
  const child = spawn(t[0], t[1], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

/**
 * Did the last boot happen at the BIOS power-on time? `time` is "HH:MM" in this PC's local time.
 * Returns { matched, bootAt } — matched when the PC booted within 5 minutes of that time on the boot's day.
 */
function matchesPowerOnTime(bootIso, time) {
  const boot = Date.parse(bootIso);
  if (!boot || !/^\d{2}:\d{2}$/.test(time || '')) return { matched: false, bootAt: bootIso || '' };
  const d = new Date(boot);
  const [h, m] = time.split(':').map(Number);
  const expected = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  return { matched: Math.abs(boot - expected) <= 5 * 60000, bootAt: bootIso };
}

/**
 * Records an automatic power-on: when the last boot matches the BIOS power-on time the user entered,
 * it is saved once and logged. Returns whether the last boot matched.
 */
function confirmBiosPowerOn({ store, logger, info }) {
  const bios = store.get().app.biosPowerOn;
  const match = matchesPowerOnTime(info.bootAt, bios.time);
  if (match.matched && bios.lastVerifiedAt !== info.bootAt) {
    store.update((c) => {
      c.app.biosPowerOn.lastVerifiedAt = info.bootAt;
    });
    logger.success('power', `Automatic power-on confirmed: the PC started at ${new Date(info.bootAt).toLocaleTimeString()}, matching the BIOS power-on time ${bios.time}.`);
  }
  return match.matched;
}

module.exports = {
  confirmBiosPowerOn,
  hibernate,
  lastWake,
  lastResume,
  parseLastWake,
  isSessionLocked,
  biosCapability,
  describeBios,
  systemPowerInfo,
  restartToFirmware,
  openWindowsPage,
  matchesPowerOnTime,
};
