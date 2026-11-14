import React, { useEffect, useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Toggle } from './ui.jsx';
import { BIOS_GUIDES, detectGuide, powerOnTimeBefore } from '../biosGuides.mjs';
import { DEFAULT_POWER_ON_TIME, DEFAULT_STREAM_TIME, formatDateTime } from '../util.js';

const REPEAT_LABELS = { daily: 'Every day', weekdays: 'Weekdays (Mon–Fri)', selected_days: 'Selected days', once: 'One time' };

function StatusBadge({ ok, yes = 'Done', no = 'To do', unknown = 'Unknown' }) {
  if (ok === true) return <Badge tone="success">{yes}</Badge>;
  if (ok === false) return <Badge tone="warning">{no}</Badge>;
  return <Badge>{unknown}</Badge>;
}

export default function AutoPowerTab({ state, act, pending }) {
  const { schedule, settings } = state;
  const bios = state.power?.biosPowerOn || { time: '', repeat: 'daily', lastVerifiedAt: '' };
  const [data, setData] = useState(null);
  const [guideId, setGuideId] = useState('generic');
  const [time, setTime] = useState(bios.time);
  const [confirmRestart, setConfirmRestart] = useState(false);
  useEffect(() => setTime(bios.time), [bios.time]);

  const load = async () => {
    const res = await act('powerInfo');
    if (res?.ok) {
      setData(res.result);
      setGuideId((g) => (data ? g : detectGuide(res.result.info).id));
    }
  };
  useEffect(() => {
    load();
  }, []);

  const info = data?.info;
  const guide = BIOS_GUIDES.find((g) => g.id === guideId) || BIOS_GUIDES[BIOS_GUIDES.length - 1];
  const detected = info ? detectGuide(info) : null;
  const nextRun = schedule.info?.nextRun;
  // Without a saved schedule, suggest the power-on time for the default 05:50 stream.
  const suggested = nextRun ? powerOnTimeBefore(nextRun, 5) : DEFAULT_POWER_ON_TIME;
  const testTime = powerOnTimeBefore(new Date(Date.now() + 10 * 60000).toISOString(), 5);
  const manageable = info && (info.lenovo || info.dell || info.hp);
  const pc = info && !info.error ? [info.maker, info.family || info.model].filter(Boolean).join(' ') : '';
  const isLaptop = Number(info?.pcType) === 2;

  const saveTime = (value) => value !== bios.time && act('updateSettings', { biosPowerOnTime: value });

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Auto Power On</h1>
          <p className="muted">Turn the PC on by itself from Shut down at the stream time, using the BIOS power-on alarm. Set it up once.</p>
        </div>
        <Button variant="ghost" busy={pending.powerInfo} onClick={load}>
          Refresh
        </Button>
      </header>

      <div className="grid">
        <Card title="How it works" className="span-2">
          <ol className="howto">
            <li>
              When the PC is <strong>shut down</strong>, Windows and this app are not running, so no software can turn it on.
            </li>
            <li>
              The <strong>BIOS</strong> (the PC's built-in firmware) keeps a clock running on a small battery. Many PCs let you set a <strong>daily power-on time</strong> there, and the PC switches itself on at that time.
            </li>
            <li>
              After it starts, Windows <strong>signs in automatically</strong>, this app <strong>opens at sign-in</strong>, and your schedule starts the stream a few minutes later.
            </li>
          </ol>
          <div className="flow">
            <span>BIOS power-on {bios.time || suggested}</span>
            <span aria-hidden="true">→</span>
            <span>Windows auto sign-in</span>
            <span aria-hidden="true">→</span>
            <span>App opens</span>
            <span aria-hidden="true">→</span>
            <span>Stream starts {nextRun ? powerOnTimeBefore(nextRun, 0) : DEFAULT_STREAM_TIME}</span>
          </div>
        </Card>

        <Card title="This PC" actions={info ? (manageable ? <Badge tone="info">BIOS manageable from Windows</Badge> : <Badge>BIOS set up by hand</Badge>) : <Badge pulse>Reading…</Badge>}>
          {!info ? (
            <p className="muted">Reading PC details…</p>
          ) : info.error ? (
            <p className="text-danger">Could not read PC details: {info.error}</p>
          ) : (
            <>
              <dl className="facts">
                <dt>PC</dt>
                <dd>{pc}</dd>
                <dt>Type</dt>
                <dd>{isLaptop ? 'Laptop' : 'Desktop / other'}</dd>
                <dt>BIOS</dt>
                <dd>
                  {info.biosVersion} {info.biosDate && <span className="muted">({info.biosDate})</span>}
                </dd>
                {!isLaptop && info.boardMaker && (
                  <>
                    <dt>Motherboard</dt>
                    <dd>
                      {info.boardMaker} {info.boardProduct}
                    </dd>
                  </>
                )}
                <dt>Last start</dt>
                <dd>{info.bootAt ? new Date(info.bootAt).toLocaleString() : '—'}</dd>
              </dl>
              {detected && <p className="small">Detected automatically: {detected.reason}</p>}
              {info.wakeSettings?.length > 0 && <p className="small text-success">BIOS power-on setting found: {info.wakeSettings.join('; ')}</p>}
              {guideId === 'lenovo_consumer' && (
                <p className="small text-warning">IdeaPad / Yoga / Legion laptops usually have no timed power-on in BIOS. Check once with the steps; if it's missing, see "No power-on option in BIOS?" below.</p>
              )}
            </>
          )}
          <div className="button-row">
            <Button onClick={() => setConfirmRestart(true)}>Restart into BIOS</Button>
            <Button variant="ghost" onClick={() => act('openWindowsPage', 'recovery')} title="Settings → System → Recovery → Advanced startup → Restart now → Troubleshoot → Advanced options → UEFI Firmware Settings">
              Open Advanced startup
            </Button>
          </div>
          <p className="note">"Restart into BIOS" asks for administrator approval, then restarts in 15 seconds. Save your work first.</p>
        </Card>

        <Card title="1. Power-on time">
          <div className="field">
            <span>Time set in BIOS (this PC's clock)</span>
            <div className="button-row">
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} onBlur={() => saveTime(time)} aria-label="BIOS power-on time" />
              <select value={bios.repeat} onChange={(e) => act('updateSettings', { biosPowerOnRepeat: e.target.value })} aria-label="BIOS power-on repeat">
                {Object.entries(REPEAT_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              {suggested && suggested !== time && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTime(suggested);
                    saveTime(suggested);
                  }}
                >
                  Use {suggested}
                </Button>
              )}
            </div>
            <small className="muted">
              {nextRun
                ? `Your next stream starts ${formatDateTime(nextRun, schedule.timeZone)}. Set the BIOS 5 minutes earlier (${suggested}) so Windows has time to start and sign in.`
                : `No schedule saved yet, so this assumes the default stream time ${DEFAULT_STREAM_TIME} and suggests ${DEFAULT_POWER_ON_TIME}. Save the real schedule on the Home tab (Edit Time).`}
            </small>
          </div>
          {bios.lastVerifiedAt ? (
            <p className="text-success small">✓ Confirmed: this PC powered on by itself at {new Date(bios.lastVerifiedAt).toLocaleString()}.</p>
          ) : (
            <p className="muted small">Not confirmed yet. After the BIOS is set, the app confirms it automatically the next time the PC starts at that time.</p>
          )}
        </Card>

        <Card title="2. Set it in the BIOS" className="span-2" actions={
          <select value={guideId} onChange={(e) => setGuideId(e.target.value)} aria-label="PC maker">
            {BIOS_GUIDES.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {detected?.id === g.id ? ' (detected)' : ''}
              </option>
            ))}
          </select>
        }>
          <dl className="facts">
            <dt>BIOS key</dt>
            <dd>{guide.key}</dd>
            <dt>Available on</dt>
            <dd>{guide.availability}</dd>
          </dl>
          <ol className="steps-list">
            {guide.steps.map((s) => (
              <li key={s}>{s.replace('the power-on time shown on this page', bios.time || suggested ? `${bios.time || suggested}` : 'your power-on time')}</li>
            ))}
          </ol>
          <p className="small muted">The setting may also be called: {guide.names.join(', ')}. Menu names vary by model and BIOS version.</p>
          {isLaptop && <p className="small text-warning">Laptop: keep the charger connected. Many laptops only power on by alarm when on AC power.</p>}
        </Card>

        <Card title="3. Windows settings after power-on" className="span-2">
          <ul className="setup-list">
            <li>
              <div>
                <strong>Turn off Fast Startup (recommended)</strong>
                <span>With Fast Startup on, "Shut down" is a partial hibernate and some PCs ignore the BIOS alarm. Power Options → "Change settings that are currently unavailable" → untick "Turn on fast startup" → Save changes.</span>
              </div>
              <div className="setup-actions">
                <StatusBadge ok={info ? info.fastStartup === false : null} yes="Off" no="On" />
                <Button variant="ghost" onClick={() => act('openWindowsPage', 'powerButtons')}>
                  Open
                </Button>
              </div>
            </li>
            <li>
              <div>
                <strong>Allow password sign-in</strong>
                <span>Settings → Accounts → Sign-in options → turn off "For improved security, only allow Windows Hello sign-in". Needed before automatic sign-in can be turned on.</span>
              </div>
              <div className="setup-actions">
                <StatusBadge ok={info ? !info.helloOnly : null} yes="Allowed" no="Hello only" />
                <Button variant="ghost" onClick={() => act('openWindowsPage', 'signInOptions')}>
                  Open
                </Button>
              </div>
            </li>
            <li>
              <div>
                <strong>Sign in to Windows automatically</strong>
                <span>
                  Opens "User Accounts" (netplwiz): select your account, untick "Users must enter a user name and password to use this computer", click OK and enter your password. Anyone who switches the PC on gets to your desktop, so only do this on a PC kept in a safe place.
                </span>
              </div>
              <div className="setup-actions">
                <StatusBadge ok={info ? info.autoSignIn : null} yes={info?.autoSignInUser ? `On (${info.autoSignInUser})` : 'On'} no="Off" />
                <Button variant="ghost" onClick={() => act('openWindowsPage', 'netplwiz')}>
                  Open
                </Button>
              </div>
            </li>
            <li>
              <div>
                <strong>Open this app at Windows sign-in</strong>
                <span>So the app is running and can start the stream at the scheduled time.</span>
              </div>
              <div className="setup-actions">
                <Toggle label="" checked={settings.launchOnWindowsStartup} onChange={(v) => act('updateSettings', { launchOnWindowsStartup: v })} />
              </div>
            </li>
            <li>
              <div>
                <strong>Stream schedule saved</strong>
                <span>{nextRun ? `Next stream: ${formatDateTime(nextRun, schedule.timeZone)}.` : 'Set it on the Home tab → Schedule → Edit Time, with "Start the stream automatically" on.'}</span>
              </div>
              <div className="setup-actions">
                <StatusBadge ok={!!nextRun} yes="Saved" no="Not set" />
              </div>
            </li>
          </ul>
        </Card>

        <Card title="4. Test it (5 minutes)">
          <ol className="steps-list">
            <li>
              Enter <strong>{testTime}</strong> as the time in step 1 (about 5 minutes from now), then set the same time in the BIOS (step 2) and save.
            </li>
            <li>Let Windows start, then shut down normally (Start → Power → Shut down).</li>
            <li>Wait. The PC should switch on by itself at {testTime}, sign in, and open this app.</li>
            <li>
              This tab then shows <span className="text-success">✓ Confirmed</span>. Change the time back to your stream's power-on time{suggested ? ` (${suggested})` : ''} in step 1 and in the BIOS.
            </li>
          </ol>
        </Card>

        <Card title="No power-on option in BIOS?">
          <ul className="steps-list">
            <li>
              <strong>Hibernate instead of Shut down.</strong> Home tab → Schedule → "Hibernate until stream". The PC is fully off but Windows can power it on; prove it with "Test wake". You can also make the power button hibernate (Power Options → "When I press the power button: Hibernate").
            </li>
            <li>
              <strong>Smart plug + "Power On With AC Attach".</strong> If the BIOS has this option, a timer smart plug that switches the charger on at the power-on time starts the PC.
            </li>
            <li>
              <strong>Different hardware.</strong> A mini PC or desktop: almost all have "Power On By RTC".
            </li>
          </ul>
        </Card>
      </div>

      {confirmRestart && (
        <ConfirmDialog
          title="Restart into BIOS setup?"
          message="Windows asks for administrator approval, then restarts this PC in 15 seconds and opens BIOS/UEFI setup. Save your work first. Follow the steps in section 2 there."
          confirmLabel="Restart into BIOS"
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => {
            setConfirmRestart(false);
            act('restartToBios');
          }}
        />
      )}
    </>
  );
}
