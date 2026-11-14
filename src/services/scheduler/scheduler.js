'use strict';

const { validateSchedule, nextOccurrence, latestOccurrence } = require('./scheduleMath');
const windowsTask = require('./windowsTask');

/** A scheduled run may start up to this long after its time (e.g. after the PC wakes); later counts as missed. */
const GRACE_MS = 15 * 60000;
const TICK_MS = 20000;

/**
 * Owns the stream schedule: validation, the Windows scheduled task that launches the app,
 * an in-app timer while the app is running, de-duplication and missed-run detection.
 */
class SchedulerService {
  constructor({ store, logger, getLaunchCommand, onDue }) {
    this.store = store;
    this.logger = logger;
    this.getLaunchCommand = getLaunchCommand;
    this.onDue = onDue;
    this.timer = null;
    this.taskInfo = null;
    this.taskError = '';
  }

  get schedule() {
    return this.store.get().schedule;
  }

  start() {
    this.checkMissed();
    // Re-register the Windows task if the schedule is on but the task is missing (deleted or never created).
    this.refreshTaskInfo().then((task) => {
      if (!task && this.schedule.enabled && nextOccurrence(this.schedule)) {
        this.logger.warn('scheduler', 'The Windows scheduled task was missing; registering it again.');
        this.syncTask().catch(() => {});
      }
    });
    this.timer = setInterval(() => {
      this.tick();
    }, TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  getInfo() {
    const s = this.schedule;
    const configured = !!(s.date && s.time);
    const next = s.enabled && configured ? nextOccurrence(s) : null;
    return {
      configured,
      enabled: s.enabled,
      nextRun: next ? new Date(next).toISOString() : null,
      completed: configured && s.enabled && !next,
      task: this.taskInfo,
      taskError: this.taskError,
      lastExecutedOccurrence: s.lastExecutedOccurrence,
      lastMissedOccurrence: s.lastMissedOccurrence,
    };
  }

  async refreshTaskInfo() {
    this.taskInfo = await windowsTask.queryTask().catch(() => null);
    return this.taskInfo;
  }

  async save(input) {
    const candidate = {
      enabled: !!input.enabled,
      date: String(input.date || ''),
      time: String(input.time || ''),
      timeZone: String(input.timeZone || ''),
      repeat: String(input.repeat || ''),
      selectedDays: Array.isArray(input.selectedDays) ? input.selectedDays.map(String) : [],
      streamingMode: String(input.streamingMode || ''),
      autoStart: input.autoStart !== false,
      requireConfirmation: !!input.requireConfirmation,
    };
    if (candidate.repeat !== 'selected_days') candidate.selectedDays = [];
    const errors = validateSchedule(candidate);
    if (errors.length) return { ok: false, errors };

    this.store.update((c) => {
      Object.assign(c.schedule, candidate, { savedAt: new Date().toISOString() });
    });
    const sync = await this.syncTask();
    this.logger.info('scheduler', `Schedule saved: ${describe(candidate)}${candidate.enabled ? '' : ' (disabled)'}.`);
    return { ok: true, errors: [], warning: sync.warning };
  }

  async setEnabled(enabled) {
    const s = this.schedule;
    if (enabled) {
      const errors = validateSchedule({ ...s, enabled: true });
      if (errors.length) return { ok: false, errors };
    }
    this.store.update((c) => {
      c.schedule.enabled = !!enabled;
      c.schedule.savedAt = new Date().toISOString();
    });
    const sync = await this.syncTask();
    this.logger.info('scheduler', `Schedule ${enabled ? 'enabled' : 'disabled'}.`);
    return { ok: true, errors: [], warning: sync.warning };
  }

  async remove() {
    this.store.update((c) => {
      Object.assign(c.schedule, { enabled: false, date: '', time: '', repeat: 'once', selectedDays: [], savedAt: '', lastExecutedOccurrence: '', lastMissedOccurrence: '' });
    });
    await this.syncTask();
    this.logger.info('scheduler', 'Schedule deleted.');
    return { ok: true, errors: [] };
  }

  /** Makes the Windows scheduled task match the saved schedule. */
  async syncTask() {
    const s = this.schedule;
    try {
      if (s.enabled && nextOccurrence(s)) {
        const { command, args } = this.getLaunchCommand();
        await windowsTask.registerTask(s, command, args);
        this.taskError = '';
      } else {
        await windowsTask.deleteTask();
        this.taskError = '';
      }
    } catch (err) {
      this.taskError = err.message;
      this.logger.error('scheduler', `Windows Task Scheduler update failed: ${err.message}. The schedule will only run while the app is open.`);
      await this.refreshTaskInfo();
      return { warning: 'Windows Task Scheduler could not be updated, so the schedule only runs while the app is open.' };
    }
    await this.refreshTaskInfo();
    return { warning: '' };
  }

  /** The occurrence that is due now (within the grace window and after the schedule was saved). */
  dueOccurrence(nowMs = Date.now()) {
    const s = this.schedule;
    if (!s.enabled || !s.date || !s.time) return null;
    const at = latestOccurrence(s, nowMs, GRACE_MS);
    if (!at) return null;
    if (s.savedAt && at < Date.parse(s.savedAt)) return null;
    return at;
  }

  tick() {
    const due = this.dueOccurrence();
    if (due && new Date(due).toISOString() !== this.schedule.lastExecutedOccurrence) this.fire(due, 'app timer');
  }

  /** Called when Windows launched the app (or a second instance) with the scheduled-start argument. */
  handleLaunchTrigger(source) {
    const due = this.dueOccurrence();
    if (!due) {
      const latest = latestOccurrence(this.schedule, Date.now());
      if (latest) this.markMissed(latest, `Scheduled launch arrived ${Math.round((Date.now() - latest) / 60000)} min late (allowed ${GRACE_MS / 60000} min)`);
      else this.logger.warn('scheduler', `Launched by ${source}, but no scheduled stream is due now.`);
      return false;
    }
    if (new Date(due).toISOString() === this.schedule.lastExecutedOccurrence) {
      this.logger.info('scheduler', `Duplicate scheduled launch from ${source} ignored; this run already started.`);
      return false;
    }
    this.fire(due, source);
    return true;
  }

  fire(due, source) {
    const iso = new Date(due).toISOString();
    this.store.update((c) => {
      c.schedule.lastExecutedOccurrence = iso;
    });
    this.logger.info('scheduler', `Scheduled run for ${new Date(due).toLocaleString()} triggered by ${source}.`);
    this.onDue({ occurrence: iso, schedule: { ...this.schedule } });
    // A one-time schedule has no further runs, so its Windows task can go.
    if (this.schedule.repeat === 'once') this.syncTask();
  }

  checkMissed() {
    const s = this.schedule;
    if (!s.enabled || !s.date || !s.time) return;
    const latest = latestOccurrence(s, Date.now());
    if (!latest || Date.now() - latest <= GRACE_MS) return;
    if (s.savedAt && latest < Date.parse(s.savedAt)) return;
    const iso = new Date(latest).toISOString();
    if (iso === s.lastExecutedOccurrence || iso === s.lastMissedOccurrence) return;
    this.markMissed(latest, 'The computer or app was not running at the scheduled time');
  }

  markMissed(at, reason) {
    const iso = new Date(at).toISOString();
    if (iso === this.schedule.lastMissedOccurrence) return;
    this.store.update((c) => {
      c.schedule.lastMissedOccurrence = iso;
    });
    this.logger.warn('scheduler', `Missed scheduled stream for ${new Date(at).toLocaleString()}: ${reason}.`);
  }
}

function describe(s) {
  const days = s.repeat === 'selected_days' ? ` on ${s.selectedDays.join(', ')}` : '';
  return `${s.repeat.replace('_', ' ')}${days} at ${s.time} (${s.timeZone}) from ${s.date}, mode ${s.streamingMode}`;
}

module.exports = { SchedulerService, GRACE_MS };
