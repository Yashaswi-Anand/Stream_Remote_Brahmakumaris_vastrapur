'use strict';

const path = require('path');
const { AutomationError, toZoomUri } = require('../zoom/zoomService');
const { listImages, pickRandom } = require('../images/imageService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "91234567890" → "912 3456 7890" (Zoom's own grouping). */
function formatMeetingId(id) {
  const d = String(id || '');
  if (d.length === 11) return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  if (d.length === 9) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return d;
}

const IMAGE_WINDOW_PATTERN = ['^ZSA Stream Image'];

const MODE_LABELS = {
  live: 'Live Streaming',
  zoom_and_youtube: 'Start Zoom and YouTube Streaming',
};

function initialState() {
  return {
    busy: false,
    action: null,
    mode: null,
    steps: [],
    message: '',
    error: null,
    waitingForUser: false,
    stream: { phase: 'idle', live: false, liveVerified: false, liveMethod: '', startedAt: null },
    share: { type: null, audio: null, verified: false },
    pendingConfirmation: null,
  };
}

/**
 * Runs the Start Stream / End Stream / Share workflows step by step and publishes progress.
 * Every step is verified against Zoom's actual UI state; nothing is reported as done on assumption.
 */
class StreamWorkflow {
  constructor({ store, logger, zoom, youtube, imageWindow, onChange }) {
    this.store = store;
    this.logger = logger;
    this.zoom = zoom;
    this.youtube = youtube;
    this.imageWindow = imageWindow;
    this.onChange = onChange;
    this.state = initialState();
    this.cancelled = false;
    this.liveConfirmedByUser = false;
    this.confirmTimer = null;
  }

  emit() {
    this.onChange(this.state);
  }

  patch(p) {
    Object.assign(this.state, p);
    this.emit();
  }

  begin(action, stepDefs, mode = null) {
    this.cancelled = false;
    this.state.busy = true;
    this.state.action = action;
    this.state.mode = mode;
    this.state.error = null;
    this.state.waitingForUser = false;
    this.state.message = '';
    this.state.steps = stepDefs.map(([id, label]) => ({ id, label, status: 'pending', detail: '' }));
    this.emit();
  }

  setStep(id, status, detail = '') {
    const step = this.state.steps.find((s) => s.id === id);
    if (step) Object.assign(step, { status, detail });
    if (status === 'running' || status === 'waiting') this.state.message = detail || step?.label || '';
    this.emit();
  }

  async runStep(id, fn) {
    if (this.cancelled) throw new AutomationError('Cancelled by user.');
    this.setStep(id, 'running');
    const detail = await fn();
    this.setStep(id, 'done', typeof detail === 'string' ? detail : '');
    return detail;
  }

  fail(err) {
    const running = this.state.steps.find((s) => s.status === 'running' || s.status === 'waiting');
    if (running) Object.assign(running, { status: 'failed', detail: err.message });
    for (const s of this.state.steps) if (s.status === 'pending') s.status = 'skipped';
    this.state.error = { message: err.message, hint: err.hint || '' };
    this.state.message = '';
    this.state.waitingForUser = false;
    this.logger.error('workflow', `${err.message}${err.hint ? ` — ${err.hint}` : ''}`);
  }

  finish() {
    this.state.busy = false;
    this.state.action = null;
    this.state.waitingForUser = false;
    this.emit();
  }

  get settings() {
    return this.store.get().streaming;
  }

  // ---- Start Stream ------------------------------------------------------------------------

  async startStream(mode, source = 'user') {
    if (this.state.busy) throw new Error('Another automation is already running.');
    if (this.state.stream.live) throw new Error('A stream is already live. End it before starting another.');
    if (!MODE_LABELS[mode]) throw new Error('Unknown streaming mode.');

    // The Start Stream checklist decides the steps (all ticked by default); unticked steps are skipped.
    const openIfNeeded = this.settings.openMeetingIfNeeded !== false;
    const goLive = this.settings.goLiveOnYouTube !== false;
    const shareImage = this.settings.shareImageOnStart !== false;
    const annotation = shareImage && this.settings.disableAnnotationOnStart !== false;
    const music = this.settings.playMusicOnStart !== false;
    this.begin(
      'start',
      [
        ['zoom', openIfNeeded ? 'Open Zoom if needed' : 'Check Zoom is running'],
        ['meeting', openIfNeeded ? 'Use the open meeting or start the configured one' : 'Find the open meeting'],
        ['youtube', 'Go live on YouTube'],
        ['image', 'Use the image shown in the preview'],
        ['share', 'Share the image in Zoom (with sound)'],
        ['annotation', 'Disable annotation for others'],
        ['music', 'Play music'],
      ],
      mode,
    );
    const skip = (id, why = 'Turned off in the Start Stream checklist.') => this.setStep(id, 'skipped', why);
    this.liveConfirmedByUser = false;
    this.state.stream = { phase: 'starting', live: false, liveVerified: false, liveMethod: '', startedAt: null };
    this.logger.info(
      'workflow',
      `Start Stream requested by ${source} (open meeting: ${openIfNeeded ? 'on' : 'off'}, YouTube live: ${goLive ? 'on' : 'off'}, share image: ${shareImage ? 'on' : 'off'}, annotation: ${annotation ? 'on' : 'off'}, music: ${music ? 'on' : 'off'}).`,
    );

    try {
      await this.runStep('zoom', () => this.ensureZoomRunning(openIfNeeded));

      let meetingNote = '';
      const meeting = await this.runStep('meeting', async () => {
        const status = await this.zoom.getStatus();
        if (status.inMeeting) return this.zoom.requireMeeting();
        if (!openIfNeeded) {
          throw new AutomationError('No open Zoom meeting was found.', 'Start or join your meeting in Zoom first, or turn on "Open Zoom and my meeting if needed".');
        }
        const opened = await this.openConfiguredMeeting('meeting');
        meetingNote = opened.note;
        return opened.window;
      });
      this.setStep('meeting', 'done', meetingNote || meeting.title || 'Meeting window found.');

      if (!goLive) {
        skip('youtube');
        this.logger.info('youtube', 'YouTube live stream skipped (turned off in Start Stream).');
      }
      if (goLive) await this.runStep('youtube', async () => {
        const res = await this.youtube.start(meeting, {
          autoClickGoLive: this.settings.autoClickGoLive,
          accountEmail: this.settings.youtubeAccountEmail,
          studioUrl: this.settings.youtubeStudioUrl,
          timeoutMinutes: this.settings.liveConfirmTimeoutMinutes,
          onWaiting: (msg) => {
            this.state.waitingForUser = true;
            this.setStep('youtube', 'waiting', msg);
          },
          isCancelled: () => this.cancelled,
          isManuallyConfirmed: () => this.liveConfirmedByUser,
        });
        this.state.waitingForUser = false;
        this.state.stream = { phase: 'live', live: true, liveVerified: res.verified, liveMethod: res.method, startedAt: new Date().toISOString() };
        if (res.verified) {
          this.logger.success('youtube', 'Zoom reports the YouTube live stream is active.');
          return 'Live on YouTube (verified in Zoom).';
        }
        this.logger.warn('youtube', 'Live stream confirmed by the user; Zoom\'s live indicator could not be read.');
        return 'Live on YouTube (confirmed by you, not verified).';
      });

      if (shareImage) {
        const image = await this.runStep('image', async () => this.previewedImage());
        this.setStep('image', 'done', path.basename(image));
        await this.runStep('share', async () => this.shareImageInMeeting(meeting, image));
      } else {
        skip('image');
        skip('share');
      }
      if (annotation) await this.disableAnnotationStep(meeting);
      else skip('annotation', shareImage ? undefined : 'Nothing is shared, so there is nothing to protect.');

      // Music never stops the stream: a problem is shown on the step and logged.
      if (music && this.musicControl) {
        this.setStep('music', 'running');
        try {
          const res = await this.musicControl.play();
          this.setStep('music', 'done', res && res.title ? `Playing "${res.title}".` : 'Playing.');
        } catch (err) {
          this.setStep('music', 'skipped', err.message);
          this.logger.warn('music', `Music not started: ${err.message}`);
        }
      } else skip('music');

      if (!goLive) this.state.stream = { phase: 'sharing', live: false, liveVerified: false, liveMethod: '', startedAt: new Date().toISOString() };
      this.state.message = goLive ? 'Streaming.' : 'Sharing in Zoom.';
      this.logger.success('workflow', 'Start Stream completed.');
    } catch (err) {
      this.fail(err);
      if (!this.state.stream.live) this.state.stream.phase = 'error';
    } finally {
      this.finish();
    }
  }

  async ensureZoomRunning(mayLaunch) {
    const status = await this.zoom.getStatus();
    if (!status.installed) throw new AutomationError('Zoom is not installed.', 'Install the Zoom desktop client, then try again.');
    if (status.running) return 'Zoom is running.';
    if (!mayLaunch) throw new AutomationError('Zoom is not running.', 'Open Zoom and start your meeting, or use "Start Zoom and YouTube Streaming".');
    this.zoom.launch();
    if (!(await this.zoom.waitUntilRunning())) throw new AutomationError('Zoom did not open within 90 seconds.', 'Open Zoom manually and sign in, then try again.');
    return 'Zoom opened.';
  }

  /**
   * Opens the configured meeting by its Meeting ID (or invite link) and waits for its window.
   * Zoom starts it as host when you are signed in as the meeting's host.
   * Returns { window, note }.
   */
  async openConfiguredMeeting(stepId) {
    const { meetingLink } = this.store.get().zoom;
    const uri = toZoomUri(meetingLink);
    if (!uri) {
      throw new AutomationError(
        meetingLink ? 'The Meeting ID in Stream settings is not valid.' : 'No Meeting ID is set.',
        'Enter your Zoom Meeting ID (9–12 digits, e.g. 912 3456 7890) or paste the invite link in Stream settings.',
      );
    }
    const meetingId = (uri.match(/confno=(\d+)/) || [])[1] || '';
    this.setStep(stepId, 'running', `Opening meeting ${formatMeetingId(meetingId)} in Zoom…`);
    this.zoom.launch(uri);
    const how = `Opened meeting ${formatMeetingId(meetingId)}`;
    this.logger.info('zoom', `${how}.`);

    this.setStep(stepId, 'waiting', 'Opening the meeting… answer any Zoom prompt (video preview, passcode, audio) if shown.');
    this.state.waitingForUser = true;
    this.emit();
    let previewTitle = '';
    let previewPresses = 0;
    let lastPress = 0;
    const found = await this.zoom.waitForMeeting(
      120000,
      async (preview) => {
        previewTitle = preview.title;
        // Zoom's video preview waits for Start/Join: press it, again only if it is still there 8 s later (3 tries).
        if (Date.now() - lastPress < 8000) return;
        if (previewPresses < 3) {
          previewPresses++;
          lastPress = Date.now();
          // First press is cursor-free; if the preview is still there 8 s later, the next press is a real click.
          if (await this.zoom.pressPreviewStart(preview, previewPresses > 1)) {
            this.setStep(stepId, 'waiting', `Pressed Start in Zoom's video preview for "${preview.title}"…`);
            return;
          }
        }
        this.setStep(stepId, 'waiting', `Zoom shows the video preview for "${preview.title}". Press Start/Join in that window.`);
      },
      () => this.cancelled,
    );
    this.state.waitingForUser = false;
    if (!found) throw new AutomationError('The Zoom meeting did not open within 2 minutes.', 'Finish any Zoom prompt (video preview, passcode, waiting room) and check you are signed in to Zoom.');
    await sleep(2000);
    await this.zoom.showMeeting(found).catch(() => {});

    // Zoom's meeting window is titled "Zoom Meeting"; the video preview shows the meeting's name.
    const note = `${how}${previewTitle ? ` ("${previewTitle}")` : ''}; meeting open`;
    this.logger.success('zoom', `${note}.`);
    return { window: found, note: `${note}.` };
  }

  /** "Open Zoom" button: opens Zoom and the configured meeting, or brings the open meeting forward. */
  async openMeeting(source = 'user') {
    if (this.state.busy) throw new Error('Another automation is already running.');
    this.begin('open_meeting', [
      ['zoom', 'Open Zoom'],
      ['meeting', 'Open the meeting'],
    ]);
    this.logger.info('workflow', `Open Zoom and meeting requested by ${source}.`);
    try {
      await this.runStep('zoom', () => this.ensureZoomRunning(true));
      await this.runStep('meeting', async () => {
        const status = await this.zoom.getStatus();
        if (status.inMeeting) {
          await this.zoom.showMeeting(await this.zoom.requireMeeting());
          return 'A meeting is already open; brought it to the front.';
        }
        return (await this.openConfiguredMeeting('meeting')).note;
      });
    } catch (err) {
      this.fail(err);
    } finally {
      this.finish();
    }
  }

  /** "I'm live" button: the user confirms the browser step finished when Zoom's indicator can't be read. */
  confirmLive() {
    if (this.state.action !== 'start') return false;
    this.liveConfirmedByUser = true;
    return true;
  }

  cancel() {
    if (!this.state.busy) return false;
    this.cancelled = true;
    this.logger.warn('workflow', 'Cancel requested.');
    return true;
  }

  chooseRandomImage() {
    const folder = this.settings.imageFolderPath;
    const { images, error } = listImages(folder);
    if (!images.length) throw new AutomationError(error, 'Choose a folder that contains PNG, JPG, JPEG or WebP images.');
    const chosen = pickRandom(images, this.settings.selectedImagePath);
    this.store.update((c) => {
      c.streaming.selectedImagePath = chosen;
    });
    this.logger.info('images', `Selected image: ${path.basename(chosen)}`);
    return chosen;
  }

  /** Sharing toolbar → More → "Disable annotation for others". A problem here never stops the stream. */
  async disableAnnotationStep(meeting) {
    this.setStep('annotation', 'running');
    const res = await this.zoom.disableAnnotationForOthers(meeting).catch((err) => {
      this.logger.warn('zoom', `Could not disable annotation: ${err.message}`);
      return 'not_found';
    });
    if (res === 'disabled') {
      this.logger.success('zoom', 'Annotation disabled for others (sharing toolbar → More).');
      this.setStep('annotation', 'done', 'Disabled for others.');
    } else if (res === 'already') {
      this.setStep('annotation', 'done', 'Already disabled for others.');
    } else {
      this.logger.warn('zoom', 'Annotation for others is NOT disabled: the option was not found. Turn it off in Zoom: sharing toolbar → More → Disable annotation for others.');
      this.setStep('annotation', 'skipped', 'Not found — in Zoom: sharing toolbar → More → Disable annotation for others.');
    }
  }

  /** The image shown in the preview; a random one only when none is selected (or it was removed). */
  previewedImage() {
    const current = this.settings.selectedImagePath;
    const { images } = listImages(this.settings.imageFolderPath);
    return images.includes(current) ? current : this.chooseRandomImage();
  }

  async shareImageInMeeting(meeting, imagePath) {
    if (await this.zoom.isSharing()) await this.zoom.stopSharing(meeting);
    // Zoom cannot share an image file directly, so the image is shown in a dedicated window that is shared instead.
    await this.imageWindow.show(imagePath);
    await sleep(800);
    const res = await this.zoom.shareSource(meeting, IMAGE_WINDOW_PATTERN, { shareSound: this.settings.shareSound, sourceLabel: 'ZSA Stream Image window' });
    this.state.share = { type: 'image', audio: res.audio, verified: true };
    this.logger.success('zoom', `Sharing image ${path.basename(imagePath)}${soundNote(res.audio, this.settings.shareSound)}.`);
    return `Sharing ${path.basename(imagePath)}${soundNote(res.audio, this.settings.shareSound)}`;
  }

  // ---- Share buttons -----------------------------------------------------------------------

  async shareImage() {
    if (this.state.busy) throw new Error('Another automation is already running.');
    this.begin('share_image', [
      ['meeting', 'Find the active meeting'],
      ['image', 'Use the selected image'],
      ['share', 'Share the image in Zoom'],
      ['annotation', 'Disable annotation for others'],
    ]);
    try {
      const meeting = await this.runStep('meeting', () => this.zoom.requireMeeting());
      this.setStep('meeting', 'done', meeting.title);
      const image = await this.runStep('image', async () => this.previewedImage());
      this.setStep('image', 'done', path.basename(image));
      await this.runStep('share', () => this.shareImageInMeeting(meeting, image));
      await this.disableAnnotationStep(meeting);
    } catch (err) {
      this.fail(err);
    } finally {
      this.finish();
    }
  }

  async shareScreen() {
    if (this.state.busy) throw new Error('Another automation is already running.');
    const wantAudio = this.settings.shareComputerAudio;
    this.begin('share_screen', [
      ['meeting', 'Find the active meeting'],
      ['stop', 'Stop the current share'],
      ['share', 'Share the screen'],
      ['audio', 'Enable computer audio'],
      ['annotation', 'Disable annotation for others'],
    ]);
    try {
      const meeting = await this.runStep('meeting', () => this.zoom.requireMeeting());
      this.setStep('meeting', 'done', meeting.title);
      await this.runStep('stop', async () => {
        const stopped = await this.zoom.stopSharing(meeting);
        this.imageWindow.close();
        return stopped ? 'Previous share stopped.' : 'Nothing was being shared.';
      });
      const res = await this.runStep('share', () => this.zoom.shareSource(meeting, this.zoom.labels.screenTile, { shareSound: wantAudio, sourceLabel: 'Screen' }));
      this.setStep('share', 'done', 'Screen sharing started.');
      this.state.share = { type: 'screen', audio: res.audio, verified: true };

      await this.runStep('audio', async () => {
        if (!wantAudio) return 'Computer audio is turned off in settings.';
        if (res.audio === true) return '"Share sound" ticked in the share dialog (checked on screen).';
        this.logger.warn('zoom', '"Share sound" could not be confirmed; check it in Zoom\'s sharing toolbar (More → Share sound).');
        return 'Not confirmed — check "Share sound" in Zoom\'s sharing toolbar (More).';
      });
      await this.disableAnnotationStep(meeting);
      this.logger.success('zoom', `Screen sharing started${soundNote(this.state.share.audio, wantAudio)}.`);
    } catch (err) {
      this.fail(err);
    } finally {
      this.finish();
    }
  }

  async stopShare() {
    if (this.state.busy) throw new Error('Another automation is already running.');
    this.begin('stop_share', [['stop', 'Stop sharing']]);
    try {
      await this.runStep('stop', async () => {
        const meeting = await this.zoom.requireMeeting().catch(() => null);
        const stopped = await this.zoom.stopSharing(meeting);
        this.imageWindow.close();
        this.state.share = { type: null, audio: null, verified: false };
        this.logger.info('zoom', stopped ? 'Sharing stopped.' : 'Nothing was being shared.');
        return stopped ? 'Sharing stopped.' : 'Nothing was being shared.';
      });
    } catch (err) {
      this.fail(err);
    } finally {
      this.finish();
    }
  }

  // ---- End Stream --------------------------------------------------------------------------

  async endStream() {
    if (this.state.busy && this.state.action === 'start') {
      this.cancel();
      for (let i = 0; i < 40 && this.state.busy; i++) await sleep(250);
    }
    if (this.state.busy) throw new Error('Another automation is already running.');
    this.begin('end', [
      ['live', 'Stop YouTube live stream'],
      ['music', 'Stop music'],
      ['share', 'Stop sharing'],
      ['meeting', 'End the meeting for all'],
      ['zoom', 'Close Zoom'],
    ]);
    this.state.stream.phase = 'ending';
    this.logger.info('workflow', 'End Stream requested.');
    const problems = [];
    const meeting = await this.zoom.requireMeeting().catch(() => null);

    const step = async (id, fn) => {
      this.setStep(id, 'running');
      try {
        this.setStep(id, 'done', await fn());
      } catch (err) {
        problems.push(err);
        this.setStep(id, 'failed', err.message);
        this.logger.error('workflow', `${err.message}${err.hint ? ` — ${err.hint}` : ''}`);
      }
    };

    await step('live', async () => {
      if (!meeting) return 'No meeting is open.';
      const res = await this.youtube.stop(meeting);
      if (!res.wasLive) return 'Zoom did not report an active live stream.';
      if (!res.stopped) throw new AutomationError('Zoom still reports the stream as live.', 'Stop it from Zoom (More → Stop Live Stream) or YouTube Studio.');
      this.logger.success('youtube', 'YouTube live stream stopped.');
      return 'Live stream stopped.';
    });
    await step('music', async () => (this.musicControl && this.musicControl.stop() ? 'Music stopped.' : 'No music was playing.'));
    await step('share', async () => {
      try {
        const stopped = meeting ? await this.zoom.stopSharing(meeting) : false;
        return stopped ? 'Sharing stopped.' : 'Nothing was being shared.';
      } finally {
        this.imageWindow.close();
      }
    });
    let meetingClosed = !meeting;
    await step('meeting', async () => {
      if (!meeting) return 'No meeting is open.';
      const ended = await this.zoom.endMeeting(meeting, true);
      if (!ended) throw new AutomationError('The meeting window is still open.', 'End the meeting in Zoom (End → End meeting for all).');
      meetingClosed = true;
      this.logger.success('zoom', 'Meeting ended for all.');
      return 'Meeting ended for all.';
    });
    await step('zoom', async () => {
      // Closing Zoom while the meeting still runs would leave it running without its host, so only close after it ended.
      if (!meetingClosed) throw new AutomationError('Zoom was left open because the meeting is still running.', 'End the meeting in Zoom, then close Zoom.');
      const closed = await this.zoom.quitZoom();
      if (!closed) throw new AutomationError('Zoom is still running.', 'Close Zoom from its icon in the taskbar tray (right-click → Exit).');
      this.logger.success('zoom', 'Zoom closed.');
      return 'Zoom closed.';
    });

    this.state.share = { type: null, audio: null, verified: false };
    this.state.stream = { phase: 'idle', live: false, liveVerified: false, liveMethod: '', startedAt: null };
    if (problems.length) {
      this.state.error = { message: `End Stream finished with ${problems.length} problem(s): ${problems.map((p) => p.message).join(' ')}`, hint: problems[0].hint || '' };
    } else {
      this.logger.success('workflow', 'End Stream completed.');
    }
    this.state.message = '';
    this.finish();
  }

  // ---- Scheduled runs ----------------------------------------------------------------------

  /** Called by the scheduler. Starts immediately or waits for the user's confirmation. */
  handleScheduledRun({ occurrence, schedule }) {
    if (!schedule.autoStart) {
      this.logger.info('scheduler', 'Scheduled launch: auto-start is off, so only Zoom and the meeting are opened.');
      if (!this.state.busy) this.openMeeting('schedule').catch((err) => this.logger.warn('zoom', `Could not open the meeting: ${err.message}`));
      return;
    }
    if (this.state.busy || this.state.stream.live) {
      this.logger.warn('scheduler', 'Scheduled stream skipped: a stream or automation is already running.');
      return;
    }
    if (schedule.requireConfirmation) {
      const expiresAt = Date.now() + 5 * 60000;
      this.state.pendingConfirmation = { occurrence, mode: schedule.streamingMode, expiresAt: new Date(expiresAt).toISOString() };
      this.emit();
      clearTimeout(this.confirmTimer);
      this.confirmTimer = setTimeout(() => {
        if (this.state.pendingConfirmation?.occurrence === occurrence) {
          this.state.pendingConfirmation = null;
          this.logger.warn('scheduler', 'Scheduled stream not started: no confirmation within 5 minutes.');
          this.emit();
        }
      }, expiresAt - Date.now());
      this.logger.info('scheduler', 'Waiting for confirmation to start the scheduled stream.');
      return;
    }
    this.startStream(schedule.streamingMode, 'schedule');
  }

  respondConfirmation(accept) {
    const pending = this.state.pendingConfirmation;
    if (!pending) return false;
    clearTimeout(this.confirmTimer);
    this.state.pendingConfirmation = null;
    this.emit();
    if (accept) this.startStream(pending.mode, 'schedule (confirmed)');
    else this.logger.info('scheduler', 'Scheduled stream declined by the user.');
    return true;
  }
}

function soundNote(audio, wanted) {
  if (!wanted) return '';
  if (audio === true) return ' with sound';
  if (audio === false) return ' (sound could not be enabled)';
  return ' (sound option not verified)';
}

module.exports = { StreamWorkflow, MODE_LABELS };
