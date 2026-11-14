'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { zonedToUtc, nextOccurrence, DAY_KEYS } = require('./scheduleMath');

const TASK_NAME = 'ZoomStreamAutomation-ScheduledStream';
const SCHEDULED_ARG = '--scheduled-start';
const WAKE_TEST_TASK = 'ZoomStreamAutomation-WakeTest';
const WAKE_TEST_ARG = '--wake-test';
const XML_DAYS = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('schtasks.exe', args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/** Formats an instant as a machine-local "YYYY-MM-DDTHH:MM:SS" (Task Scheduler local boundary). */
function localBoundary(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

/**
 * Builds the Task Scheduler XML. Times are converted from the schedule's time zone to this
 * machine's local time, including the weekdays of a selected-days schedule.
 */
function buildTaskXml(schedule, command, args, nowMs = Date.now(), description = 'Launches Zoom Stream Automation to start the scheduled Zoom/YouTube stream.') {
  const first = schedule.repeat === 'once' ? zonedToUtc(schedule.date, schedule.time, schedule.timeZone) : nextOccurrence(schedule, nowMs);
  if (!first) throw new Error('The schedule has no upcoming run.');
  const boundary = localBoundary(first);

  let trigger;
  if (schedule.repeat === 'once') {
    trigger = `<TimeTrigger><StartBoundary>${boundary}</StartBoundary><Enabled>true</Enabled></TimeTrigger>`;
  } else if (schedule.repeat === 'daily') {
    trigger = `<CalendarTrigger><StartBoundary>${boundary}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`;
  } else {
    // Map each selected weekday (in the schedule's zone) to the weekday it falls on locally.
    const localDays = new Set();
    for (const day of schedule.selectedDays) {
      const ref = nextOccurrence({ ...schedule, repeat: 'selected_days', selectedDays: [day] }, nowMs);
      if (ref) localDays.add(DAY_KEYS[new Date(ref).getDay()]);
    }
    const days = DAY_KEYS.filter((d) => localDays.has(d)).map((d) => `<${XML_DAYS[d]} />`).join('');
    trigger = `<CalendarTrigger><StartBoundary>${boundary}</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek>${days}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>`;
  }

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Zoom Stream Automation</Author>
    <Description>${xmlEscape(description)}</Description>
  </RegistrationInfo>
  <Triggers>${trigger}</Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

async function registerTask(schedule, command, args, name = TASK_NAME, description = undefined) {
  const xml = buildTaskXml(schedule, command, args, Date.now(), description);
  const file = path.join(os.tmpdir(), `zsa-task-${process.pid}-${Date.now()}.xml`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  try {
    await run(['/Create', '/TN', name, '/XML', file, '/F']);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function deleteTask(name = TASK_NAME) {
  try {
    await run(['/Delete', '/TN', name, '/F']);
    return true;
  } catch (err) {
    if (/cannot find|does not exist|not exist/i.test(err.message)) return false;
    throw err;
  }
}

/** Returns Task Scheduler's own view of the task, or null when it is not registered. */
async function queryTask() {
  let out;
  try {
    out = await run(['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/V']);
  } catch {
    return null;
  }
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const parse = (line) => (line.match(/("([^"]|"")*")/g) || []).map((c) => c.slice(1, -1).replace(/""/g, '"'));
  const head = parse(lines[0]);
  const row = parse(lines[1]);
  const get = (name) => row[head.findIndex((h) => h.toLowerCase() === name)] || '';
  return { nextRunTime: get('next run time'), lastRunTime: get('last run time'), lastResult: get('last result'), status: get('status') };
}

/**
 * Registers a one-time task that wakes the PC (from sleep or hibernate, if the firmware allows)
 * and launches the app with --wake-test at `atMs`. Times are whole minutes in this machine's zone.
 */
async function registerWakeTest(atMs, command, args) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  const schedule = {
    repeat: 'once',
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    selectedDays: [],
  };
  await registerTask(schedule, command, args, WAKE_TEST_TASK, 'Zoom Stream Automation wake test: checks that this PC can wake itself at a set time.');
}

module.exports = { TASK_NAME, SCHEDULED_ARG, WAKE_TEST_TASK, WAKE_TEST_ARG, buildTaskXml, registerTask, registerWakeTest, deleteTask, queryTask };
