import React, { useEffect, useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Toggle } from './ui.jsx';
import { formatDateTime } from '../util.js';

const CONNECTION = {
  connected: ['success', 'Connected'],
  connecting: ['info', 'Connecting…'],
  error: ['danger', 'Not connected'],
  off: ['neutral', 'Off'],
  unpaired: ['neutral', 'Not paired'],
};

/** Links this PC to the remote control website so the stream can be run from a phone. */
export default function RemoteTab({ state, act, pending, toast }) {
  const r = state.remote;
  const [url, setUrl] = useState(r.serverUrl || '');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (r.serverUrl) setUrl(r.serverUrl);
  }, [r.serverUrl]);

  const [tone, label] = CONNECTION[r.connection] || CONNECTION.off;

  const pair = async () => {
    const res = await act('remotePair', url.trim(), code.trim());
    if (res?.ok) {
      setCode('');
      toast('success', `Paired as "${res.result.deviceName}".`);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Remote</h1>
          <p className="muted">Control this PC's stream from a phone, through your website.</p>
        </div>
      </header>

      <div className="grid">
        <Card title="Connection" actions={<Badge tone={tone} pulse={r.connection === 'connecting'}>{label}</Badge>} className="span-2">
          {r.paired ? (
            <>
              <div className="versions">
                <div>
                  <span className="muted small">Website</span>
                  <strong>{r.serverUrl}</strong>
                </div>
                <div>
                  <span className="muted small">This PC is called</span>
                  <strong>{r.deviceName}</strong>
                  {r.connectedAt && r.connection === 'connected' && <span className="muted small">Connected {formatDateTime(r.connectedAt)}</span>}
                </div>
              </div>
              {r.error && <div className="banner banner-danger">{r.error}</div>}
              {r.watching && <div className="banner banner-warning">Someone on the website is viewing this PC's screen right now.</div>}
              <Toggle
                checked={r.enabled}
                onChange={(v) => act('remoteSetEnabled', v)}
                label="Allow remote control"
                description="When off, the website shows this PC as offline and cannot start, end or view anything."
              />
              <div className="actions-row">
                <Button variant="danger" onClick={() => setConfirm(true)}>
                  Unpair this PC
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">
                On the website, sign in as the owner, open <strong>Admin → Add a PC</strong> and type the code shown there below.
              </p>
              <label className="field">
                <span>Website address</span>
                <input type="url" value={url} placeholder="https://your-project.web.app" onChange={(e) => setUrl(e.target.value)} />
                <small className="muted">The address of your Stream Remote website (Firebase Hosting). For a local test: http://localhost:5555.</small>
              </label>
              <label className="field">
                <span>Pairing code</span>
                <input value={code} placeholder="ABCD-1234" maxLength={12} onChange={(e) => setCode(e.target.value.toUpperCase())} />
              </label>
              {r.error && <div className="banner banner-danger">{r.error}</div>}
              <div className="actions-row">
                <Button variant="primary" busy={pending.remotePair} disabled={!url.trim() || code.replace(/[^A-Z0-9]/gi, '').length !== 8} onClick={pair}>
                  Pair this PC
                </Button>
              </div>
            </>
          )}
        </Card>

        <Card title="Keep this PC online" className="span-2">
          <p className="muted">The website can only reach this PC while the app is running. These keep it running without the window open.</p>
          <Toggle
            checked={state.settings.runInBackground}
            onChange={(v) => act('updateSettings', { runInBackground: v })}
            label="Keep running in the background when the window is closed"
            description="Closing the window hides it to the system tray (bottom-right, near the clock). Right-click the tray icon to open the app or quit."
          />
          <Toggle
            checked={state.settings.launchOnWindowsStartup}
            onChange={(v) => act('updateSettings', { launchOnWindowsStartup: v })}
            label="Start in the background when Windows signs in"
            description="After a restart the app starts by itself in the tray, without opening its window. Turned on automatically when this PC is paired."
          />
          {r.paired && (!state.settings.runInBackground || !state.settings.launchOnWindowsStartup) && (
            <div className="banner banner-warning">With a switch off, the website shows this PC offline {!state.settings.launchOnWindowsStartup ? 'after a restart until you open the app' : 'whenever the window is closed'}.</div>
          )}
          <p className="muted small">The PC must also be switched on and signed in to Windows. For unattended restarts, set up automatic sign-in in the Auto Power On tab.</p>
        </Card>

        <Card title="How it works" className="span-2">
          <ul className="plain-list">
            <li>This PC connects out to your website's Firebase database; nothing on this PC is opened to the internet.</li>
            <li>The phone's buttons run the same steps as this window (Start Stream, Share, End Stream, schedule).</li>
            <li>The PC screen is sent only while someone has "Show live screen" open, and you see a notice here when it is.</li>
            <li>This PC signs in to Firebase with its own key, stored encrypted by Windows (not in the settings file). Remove the PC on the website, or unpair here, to revoke it.</li>
            <li>The PC must be on and signed in, with this app running (it can run in the background in the tray). Zoom automation also needs the screen unlocked.</li>
          </ul>
        </Card>
      </div>

      {confirm && (
        <ConfirmDialog
          title="Unpair this PC?"
          message="This PC is removed from the website and can no longer be controlled from it. To use it again, pair it with a new code."
          confirmLabel="Unpair"
          danger
          onConfirm={() => {
            setConfirm(false);
            act('remoteUnpair');
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}
