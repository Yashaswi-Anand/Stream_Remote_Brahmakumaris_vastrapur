import React, { useEffect, useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Empty, Modal, Toggle } from './ui.jsx';
import EditTimeDialog from './EditTimeDialog.jsx';
import { DAYS, ZOOM_STATUS, formatDateTime, formatMeetingId, formatTime, meetingIdFrom, relativeFromNow } from '../util.js';

const STEP_ICONS = { pending: '○', running: '', waiting: '…', done: '✓', failed: '✕', skipped: '–' };

export default function HomeTab({ state, act, pending }) {
  const [confirm, setConfirm] = useState(null);
  const [editTime, setEditTime] = useState(false);
  const { zoom, workflow: wf, images, schedule, settings } = state;

  const busy = wf.busy;
  const live = wf.stream.live;
  const sharing = !!wf.share.type || zoom.sharingDetected;
  const canStart = !busy && !live && zoom.installed;
  const canEnd = live || sharing || (busy && wf.action === 'start') || zoom.inMeeting;
  const youtubeWaiting = wf.action === 'start' && wf.steps.some((s) => s.id === 'youtube' && s.status === 'waiting');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Home</h1>
          <p className="muted">Start, share and stop your Zoom → YouTube stream.</p>
        </div>
      </header>

      {state.app.notice && <div className="banner banner-warning">{state.app.notice}</div>}

      <div className="grid">
        <ZoomCard zoom={zoom} settings={settings} wf={wf} act={act} busy={busy} />
        <StreamStatusCard wf={wf} zoom={zoom} />

        <Card title="Stream" className="span-2">
          <div className="toggles start-options">
            <Toggle
              label="Open Zoom and my meeting if needed"
              description={meetingIdFrom(settings.meetingLink) ? `Opens Zoom and meeting ${formatMeetingId(meetingIdFrom(settings.meetingLink))} when no meeting is open.` : 'Opens Zoom and your meeting (set the Meeting ID in Stream settings) when no meeting is open.'}
              checked={settings.openMeetingIfNeeded}
              disabled={busy}
              onChange={(v) => act('updateSettings', { openMeetingIfNeeded: v })}
            />
            <Toggle
              label="Go live on YouTube"
              description="Starts Zoom's Live on YouTube (needs a paid Zoom plan). Off: shares the image in Zoom only."
              checked={settings.goLiveOnYouTube}
              disabled={busy}
              onChange={(v) => act('updateSettings', { goLiveOnYouTube: v })}
            />
          </div>

          <div className="button-row">
            <Button variant="primary" disabled={!canStart} busy={busy && wf.action === 'start'} onClick={() => act('startStream', settings.defaultMode)}>
              {busy && wf.action === 'start' ? 'Starting…' : 'Start Stream'}
            </Button>
            <Button variant="danger" disabled={!canEnd || (busy && wf.action === 'end')} busy={busy && wf.action === 'end'} onClick={() => setConfirm('end')}>
              End Stream
            </Button>
            {busy && wf.action !== 'end' && (
              <Button variant="ghost" onClick={() => act('cancel')}>
                Cancel
              </Button>
            )}
          </div>
          {!zoom.installed && <p className="muted small">Install the Zoom desktop client to enable streaming.</p>}

          {youtubeWaiting && (
            <div className="banner banner-info">
              <div>
                <strong>Waiting for YouTube</strong>
                <span>{wf.message}</span>
              </div>
              <Button variant="primary" onClick={() => act('confirmLive')}>
                I'm live
              </Button>
            </div>
          )}

          <Steps wf={wf} />

          {wf.error && !busy && (
            <div className="banner banner-danger">
              <div>
                <strong>{wf.error.message}</strong>
                {wf.error.hint && <span>{wf.error.hint}</span>}
              </div>
              <Button variant="ghost" onClick={() => act('dismissError')}>
                Dismiss
              </Button>
            </div>
          )}
        </Card>

        <ShareCard state={state} act={act} busy={busy} sharing={sharing} />
        <ImageCard images={images} act={act} pending={pending} busy={busy} />
        <ScheduleCard schedule={schedule} settings={settings} power={state.power} act={act} pending={pending} onEdit={() => setEditTime(true)} onDelete={() => setConfirm('deleteSchedule')} />
        <SettingsCard settings={settings} act={act} />
        <ActivityCard logs={state.logs} act={act} />
      </div>

      {confirm === 'end' && (
        <ConfirmDialog
          title="End the stream?"
          danger
          confirmLabel="End Stream"
          message="This stops the YouTube live stream and sharing, ends the Zoom meeting for everyone, and closes Zoom."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act('endStream');
          }}
        />
      )}
      {confirm === 'deleteSchedule' && (
        <ConfirmDialog
          title="Delete the schedule?"
          danger
          confirmLabel="Delete"
          message="The scheduled stream and its Windows scheduled task will be removed."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act('deleteSchedule');
          }}
        />
      )}
      {editTime && <EditTimeDialog schedule={schedule} act={act} onClose={() => setEditTime(false)} />}
      {wf.pendingConfirmation && <ScheduledConfirm pending={wf.pendingConfirmation} act={act} />}
    </>
  );
}

function ZoomCard({ zoom, settings, wf, act, busy }) {
  const [tone, label] = ZOOM_STATUS[zoom.status] || ZOOM_STATUS.unknown;
  const opening = busy && wf.action === 'open_meeting';
  const meetingId = meetingIdFrom(settings.meetingLink);
  const meetingLabel = meetingId ? `Meeting ${formatMeetingId(meetingId)}` : '';
  let openText = 'Open Zoom';
  if (opening) openText = 'Opening…';
  else if (zoom.inMeeting) openText = 'Show meeting';
  else if (meetingLabel) openText = zoom.running ? 'Open meeting' : 'Open Zoom & meeting';
  return (
    <Card title="Zoom" actions={<Badge tone={tone}>{label}</Badge>}>
      <dl className="facts">
        <dt>Installed</dt>
        <dd>{zoom.installed ? 'Yes' : 'No'}</dd>
        <dt>App</dt>
        <dd>{zoom.running ? 'Running' : 'Not running'}</dd>
        <dt>Meeting</dt>
        <dd>{zoom.inMeeting ? zoom.meetingTitle || 'In a meeting' : 'No meeting open'}</dd>
        <dt>Opens</dt>
        <dd>{meetingLabel || <span className="muted">No meeting set (see Stream settings)</span>}</dd>
      </dl>
      <div className="button-row">
        {zoom.installed ? (
          <Button disabled={busy} busy={opening} onClick={() => act('openZoom')} title={meetingLabel ? `Opens Zoom and starts or joins ${meetingLabel}` : 'Opens Zoom'}>
            {openText}
          </Button>
        ) : (
          <Button onClick={() => act('locateZoom')}>Locate Zoom.exe</Button>
        )}
        <Button variant="ghost" disabled={!zoom.running || busy} onClick={() => act('zoomDiagnostics')} title="Save Zoom's control names to a file for troubleshooting">
          Diagnostics
        </Button>
      </div>
    </Card>
  );
}

function StreamStatusCard({ wf, zoom }) {
  const phase = wf.stream.phase;
  const map = {
    idle: ['neutral', 'Not streaming'],
    starting: ['info', 'Starting…'],
    live: ['live', 'Live on YouTube'],
    sharing: ['info', 'Sharing in Zoom'],
    ending: ['warning', 'Ending…'],
    error: ['danger', 'Failed'],
  };
  const [tone, label] = map[phase] || map.idle;
  const shareType = wf.share.type || (zoom.sharingDetected ? 'unknown' : null);
  return (
    <Card title="Streaming status" actions={<Badge tone={tone} pulse={phase === 'live' || phase === 'starting'}>{label}</Badge>}>
      <dl className="facts">
        <dt>YouTube</dt>
        <dd>{wf.stream.live ? (wf.stream.liveVerified ? 'Live (verified in Zoom)' : 'Live (confirmed by you)') : 'Off'}</dd>
        <dt>Since</dt>
        <dd>{wf.stream.startedAt ? formatTime(wf.stream.startedAt) : '—'}</dd>
        <dt>Sharing</dt>
        <dd>{shareType === 'image' ? 'Image' : shareType === 'screen' ? 'Screen' : shareType === 'unknown' ? 'Yes (started in Zoom)' : 'Nothing'}</dd>
        <dt>Sound</dt>
        <dd>{wf.share.type ? (wf.share.audio === true ? 'On' : wf.share.audio === false ? 'Off' : 'Not verified') : '—'}</dd>
      </dl>
      {wf.busy && wf.message && <p className="progress-msg"><span className="spinner" /> {wf.message}</p>}
    </Card>
  );
}

function Steps({ wf }) {
  if (!wf.steps.length) return null;
  const done = wf.steps.filter((s) => s.status === 'done').length;
  return (
    <div className="steps">
      <div className="progress">
        <div className="progress-bar" style={{ width: `${(done / wf.steps.length) * 100}%` }} />
      </div>
      <ol>
        {wf.steps.map((s) => (
          <li key={s.id} className={`step step-${s.status}`}>
            <span className="step-icon">{s.status === 'running' ? <span className="spinner" /> : STEP_ICONS[s.status]}</span>
            <span className="step-label">{s.label}</span>
            {s.detail && <span className="step-detail">{s.detail}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ShareCard({ state, act, busy, sharing }) {
  const { zoom, images, settings, workflow: wf } = state;
  const noMeeting = !zoom.inMeeting;
  return (
    <Card title="Share">
      <div className="share-buttons">
        <Button disabled={busy || noMeeting || !images.count} busy={busy && wf.action === 'share_image'} onClick={() => act('shareImage')}>
          Share Image
        </Button>
        <Button disabled={busy || noMeeting} busy={busy && wf.action === 'share_screen'} onClick={() => act('shareScreen')}>
          Share Screen
        </Button>
        <Button variant="ghost" disabled={busy || !sharing} busy={busy && wf.action === 'stop_share'} onClick={() => act('stopShare')}>
          Stop Share
        </Button>
      </div>
      {noMeeting && <p className="muted small">Sharing needs an open Zoom meeting.</p>}
      <div className="toggles">
        <Toggle label="Share sound with image" checked={settings.shareSound} onChange={(v) => act('updateSettings', { shareSound: v })} />
        <Toggle label="Computer audio with screen" checked={settings.shareComputerAudio} onChange={(v) => act('updateSettings', { shareComputerAudio: v })} />
      </div>
    </Card>
  );
}

function ImageCard({ images, act, pending, busy }) {
  return (
    <Card
      title="Share image"
      actions={
        <Button variant="ghost" busy={pending.chooseImageFolder} disabled={busy} onClick={() => act('chooseImageFolder')}>
          Choose Folder
        </Button>
      }
    >
      {!images.folder ? (
        <>
          <Empty title="No image yet">Choose an image, or a folder of PNG, JPG, JPEG or WebP images. The image shown in the preview is the one shared in Zoom.</Empty>
          <div className="button-row">
            <Button disabled={busy} busy={pending.chooseImage} onClick={() => act('chooseImage')}>
              Choose image…
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="path" title={images.folder}>{images.folder}</p>
          <p className="muted small">
            {images.count} image{images.count === 1 ? '' : 's'}
            {images.skipped ? ` · ${images.skipped} invalid file(s) skipped` : ''}
          </p>
          {images.error && <div className="banner banner-warning">{images.error}</div>}
          {images.previewUrl && (
            <figure className="preview">
              <img src={images.previewUrl} alt={images.selectedName} />
              <figcaption>{images.selectedName}</figcaption>
            </figure>
          )}
          <div className="button-row">
            <Button disabled={busy} busy={pending.chooseImage} onClick={() => act('chooseImage')}>
              Choose image…
            </Button>
            <Button disabled={!images.count || busy} busy={pending.pickRandomImage} onClick={() => act('pickRandomImage')}>
              {images.count > 1 ? 'Pick another random image' : 'Pick image'}
            </Button>
          </div>
          <p className="muted small">The image in the preview is the one shared in Zoom.</p>
        </>
      )}
    </Card>
  );
}

function ScheduleCard({ schedule, settings, power, act, pending, onEdit, onDelete }) {
  const info = schedule.info;
  const [wake, setWake] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [testMinutes, setTestMinutes] = useState(3);
  const wakeTest = power?.wakeTest || {};
  const runWakeCheck = async () => {
    const res = await act('wakeCheck');
    if (res?.ok) setWake(res.result);
  };
  // Refresh an open checklist when a wake test reports back.
  useEffect(() => {
    if (wake && wakeTest.result && wakeTest.result !== 'pending') runWakeCheck();
  }, [wakeTest.result, wakeTest.wokeAt]);
  const days = schedule.repeat === 'selected_days' ? DAYS.filter(([k]) => schedule.selectedDays.includes(k)).map(([, l]) => l).join(', ') : '';
  const repeat = { once: 'Once', daily: 'Every day', selected_days: days || 'Selected days' }[schedule.repeat];
  return (
    <Card title="Schedule" actions={<Button variant="ghost" onClick={onEdit}>Edit Time</Button>}>
      {!info.configured ? (
        <Empty title="No scheduled stream">Use Edit Time to start streaming automatically at a set time.</Empty>
      ) : (
        <>
          <div className="next-run">
            <span className="muted small">Next stream</span>
            {info.nextRun ? (
              <>
                <strong>{formatDateTime(info.nextRun, schedule.timeZone)}</strong>
                <span className="muted small">
                  {relativeFromNow(info.nextRun)} · {schedule.timeZone}
                </span>
              </>
            ) : (
              <strong>{schedule.enabled ? 'No upcoming run (one-time schedule finished)' : 'Schedule is off'}</strong>
            )}
          </div>
          <dl className="facts">
            <dt>Repeats</dt>
            <dd>
              {repeat} at {schedule.time}
            </dd>
            <dt>Steps</dt>
            <dd>{[settings.openMeetingIfNeeded ? 'Open meeting if needed' : 'Use open meeting', settings.goLiveOnYouTube ? 'YouTube live' : 'No YouTube', 'Share image'].join(' · ')}</dd>
            <dt>Start</dt>
            <dd>{!schedule.autoStart ? 'Open app only' : schedule.requireConfirmation ? 'Ask me first' : 'Automatically'}</dd>
            <dt>Windows task</dt>
            <dd>{info.taskError ? <span className="text-danger">Not registered</span> : info.task ? `Registered${info.task.nextRunTime && !/N\/A/i.test(info.task.nextRunTime) ? ` · next ${info.task.nextRunTime}` : ''}` : schedule.enabled && info.nextRun ? 'Not registered' : 'None'}</dd>
            {info.lastMissedOccurrence && (
              <>
                <dt>Last missed</dt>
                <dd className="text-warning">{formatDateTime(info.lastMissedOccurrence, schedule.timeZone)}</dd>
              </>
            )}
          </dl>
          <div className="button-row">
            <Toggle label="Enabled" checked={schedule.enabled} onChange={(v) => act('setScheduleEnabled', v)} />
            <Button variant="ghost" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </>
      )}
      <div className="wake-check">
        <div className="button-row">
          <Button variant="ghost" busy={pending.wakeCheck} onClick={runWakeCheck} title="Checks whether this PC can wake from sleep and start the stream unattended">
            {wake ? 'Check again' : 'Check wake readiness'}
          </Button>
        </div>
        <div className="power-on">
          <strong>Power on for the stream</strong>
          <span className="muted small">Use Hibernate instead of Shut down: the PC is fully off, and Windows powers it on for the scheduled stream if this PC's firmware supports it. Run the wake test once to prove it.</span>
          {wakeTest.result === 'pending' ? (
            <div className="button-row">
              <span className="small">Wake test waiting for {new Date(wakeTest.scheduledFor).toLocaleTimeString()}…</span>
              <Button variant="ghost" onClick={() => act('cancelWakeTest')}>
                Cancel test
              </Button>
            </div>
          ) : (
            <div className="button-row">
              <select value={testMinutes} onChange={(e) => setTestMinutes(Number(e.target.value))} aria-label="Wake test delay">
                {[2, 3, 5, 10].map((m) => (
                  <option key={m} value={m}>
                    in {m} min
                  </option>
                ))}
              </select>
              <Button onClick={() => setConfirm('test')}>Test wake (hibernate)</Button>
              <Button variant="ghost" disabled={!info.nextRun} onClick={() => setConfirm('hibernate')} title={info.nextRun ? '' : 'Save a schedule first'}>
                Hibernate until stream
              </Button>
            </div>
          )}
          {wakeTest.result && wakeTest.result !== 'pending' && (
            <span className={`small ${wakeTest.result === 'passed' ? 'text-success' : 'text-danger'}`}>
              Last wake test {wakeTest.result}
              {wakeTest.wokeAt ? ` (${new Date(wakeTest.wokeAt).toLocaleString()})` : ''}: {wakeTest.detail}
            </span>
          )}
        </div>
        {wake && (
          <ul className="checklist">
            {wake.items.map((item) => (
              <li key={item.id} className={item.ok === true ? 'ok' : item.ok === false ? 'bad' : 'info'}>
                <span className="mark" aria-hidden="true">{item.ok === true ? '✓' : item.ok === false ? '✕' : 'i'}</span>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="note">Windows can wake the PC from sleep or hibernate for a schedule, but software cannot power on a shut-down PC. See the README for BIOS/UEFI scheduled power-on.</p>
      {confirm === 'test' && (
        <ConfirmDialog
          title="Test wake from hibernate?"
          message={`The app sets a wake-up ${testMinutes} minutes from now, then hibernates this PC in 10 seconds. Save your work first. Leave the PC plugged in with the lid open and don't touch it: if it powers on by itself and the app opens, the test passed.`}
          confirmLabel="Hibernate and test"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act('wakeTest', testMinutes, true);
          }}
        />
      )}
      {confirm === 'hibernate' && (
        <ConfirmDialog
          title="Hibernate until the stream?"
          message={`The PC hibernates in 5 seconds and should power on for the stream at ${info.nextRun ? formatDateTime(info.nextRun, schedule.timeZone) : ''}. Save your work first and leave it plugged in with the lid open.`}
          confirmLabel="Hibernate"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act('hibernateUntilStream');
          }}
        />
      )}
    </Card>
  );
}

function SettingsCard({ settings, act }) {
  const [link, setLink] = useState(settings.meetingLink);
  const [email, setEmail] = useState(settings.youtubeAccountEmail);
  const [studio, setStudio] = useState(settings.youtubeStudioUrl);
  useEffect(() => setStudio(settings.youtubeStudioUrl), [settings.youtubeStudioUrl]);
  const studioOk = !studio || /^https:\/\/studio\.youtube\.com\/channel\/UC[\w-]{20,24}\/livestreaming\/?$/.test(studio.trim());
  const prof = settings.youtubeProfile;
  useEffect(() => setLink(settings.meetingLink), [settings.meetingLink]);
  useEffect(() => setEmail(settings.youtubeAccountEmail), [settings.youtubeAccountEmail]);
  const emailOk = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const id = meetingIdFrom(link);
  return (
    <Card title="Stream settings">
      <label className="field">
        <span>Zoom Meeting ID</span>
        <input type="text" inputMode="numeric" value={link} maxLength={500} placeholder="912 3456 7890" onChange={(e) => setLink(e.target.value)} onBlur={() => link !== settings.meetingLink && act('updateSettings', { meetingLink: link })} />
        {link && !id ? (
          <small className="text-danger">Enter the 9–12 digit Meeting ID, or paste the zoom.us invite link.</small>
        ) : (
          <small className="muted">
            {id ? `Meeting ${formatMeetingId(id)}. ` : ''}Find it in Zoom → Meetings → your meeting. You can also paste the invite link (it includes the passcode). Sign in to Zoom as the meeting's host so it starts as host. Stored in the local settings file.
          </small>
        )}
      </label>
      <label className="field">
        <span>YouTube account (Google email)</span>
        <input type="email" value={email} maxLength={254} placeholder="name@gmail.com" onChange={(e) => setEmail(e.target.value)} onBlur={() => emailOk && email !== settings.youtubeAccountEmail && act('updateSettings', { youtubeAccountEmail: email })} />
        {emailOk ? (
          <small className="muted">The browser profile signed in to this account is used. If Google still asks which account to use, the app clicks this one. Then: today's stream → Go live. Passwords are never entered.</small>
        ) : (
          <small className="text-danger">Enter a valid email address.</small>
        )}
      </label>
      <label className="field">
        <span>YouTube Studio live page</span>
        <input type="url" value={studio} maxLength={200} placeholder="https://studio.youtube.com/channel/UC…/livestreaming" onChange={(e) => setStudio(e.target.value)} onBlur={() => studioOk && studio.trim() !== settings.youtubeStudioUrl && act('updateSettings', { youtubeStudioUrl: studio.trim() })} />
        {!studioOk ? (
          <small className="text-danger">Paste the link from YouTube Studio → Go live, like https://studio.youtube.com/channel/UC…/livestreaming</small>
        ) : prof ? (
          <small className="muted">
            Opened in <strong>{prof.browser}</strong> profile <strong>{prof.profileName}</strong>, already signed in as {settings.youtubeAccountEmail}, so no sign-in or 2-step code is needed. Zoom's YouTube page then opens in the same profile.
          </small>
        ) : (
          <small className="text-danger">
            No Chrome or Edge profile is signed in as {settings.youtubeAccountEmail || 'this account'}. Sign in to that account once in a Chrome profile (Chrome → profile icon → Add), then it is used every time.
          </small>
        )}
      </label>
      <div className="toggles">
        <Toggle label="Click &quot;Go Live!&quot; automatically" description="On Zoom's YouTube page in your browser. Sign-in and consent stay manual." checked={settings.autoClickGoLive} onChange={(v) => act('updateSettings', { autoClickGoLive: v })} />
        <Toggle label="Launch at Windows sign-in" checked={settings.launchOnWindowsStartup} onChange={(v) => act('updateSettings', { launchOnWindowsStartup: v })} />
      </div>
      <label className="field inline">
        <span>Wait for YouTube up to</span>
        <select value={settings.liveConfirmTimeoutMinutes} onChange={(e) => act('updateSettings', { liveConfirmTimeoutMinutes: Number(e.target.value) })}>
          {[2, 3, 5, 10, 15, 30].map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
      </label>
    </Card>
  );
}

function ActivityCard({ logs, act }) {
  const items = [...logs].reverse();
  return (
    <Card
      title="Recent activity"
      className="span-2"
      actions={
        <>
          <Button variant="ghost" onClick={() => act('openLogFolder')}>
            Log folder
          </Button>
          <Button variant="ghost" disabled={!logs.length} onClick={() => act('clearLogs')}>
            Clear
          </Button>
        </>
      }
    >
      {!items.length ? (
        <Empty title="No activity yet" />
      ) : (
        <ul className="log">
          {items.map((l, i) => (
            <li key={`${l.ts}-${i}`} className={`log-${l.level}`}>
              <time>{formatTime(l.ts)}</time>
              <span className="log-source">{l.source}</span>
              <span className="log-msg">{l.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ScheduledConfirm({ pending, act }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((new Date(pending.expiresAt).getTime() - Date.now()) / 1000));
  return (
    <Modal
      title="Start the scheduled stream?"
      footer={
        <>
          <Button onClick={() => act('respondSchedule', false)}>Skip this time</Button>
          <Button variant="primary" autoFocus onClick={() => act('respondSchedule', true)}>
            Start Stream
          </Button>
        </>
      }
    >
      <p>
        It's time for your scheduled stream. It will be skipped in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} if not confirmed.
      </p>
    </Modal>
  );
}
