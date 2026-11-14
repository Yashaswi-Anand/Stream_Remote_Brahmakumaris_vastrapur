import React, { useEffect, useState } from 'react';
import { Badge, Button, Card, ConfirmDialog } from './ui.jsx';
import { formatDateTime, isNewer } from '../util.js';

export default function UpdateTab({ state, act, pending }) {
  const { updates: u, app, settings } = state;
  const [url, setUrl] = useState(settings.releaseManifestUrl);
  const [confirm, setConfirm] = useState(null);
  const [removeData, setRemoveData] = useState(false);
  useEffect(() => setUrl(settings.releaseManifestUrl), [settings.releaseManifestUrl]);

  const newer = u.latestVersion && isNewer(u.latestVersion, u.currentVersion);
  let status;
  if (!u.manifestConfigured) status = <Badge>Update source not configured</Badge>;
  else if (u.checking) status = <Badge tone="info" pulse>Checking…</Badge>;
  else if (u.error) status = <Badge tone="danger">Check failed</Badge>;
  else if (!u.latestVersion) status = <Badge>Not checked yet</Badge>;
  else if (newer) status = <Badge tone="warning">Update available</Badge>;
  else status = <Badge tone="success">Up to date</Badge>;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Update</h1>
          <p className="muted">Version information, updates and uninstall.</p>
        </div>
      </header>

      <div className="grid">
        <Card title="Version" actions={status} className="span-2">
          <div className="versions">
            <div>
              <span className="muted small">Installed</span>
              <strong>v{u.currentVersion}</strong>
              <span className="muted small">{app.portable ? 'Portable build' : app.packaged ? 'Installed build' : 'Development build'}</span>
            </div>
            <div>
              <span className="muted small">Latest</span>
              <strong>{u.latestVersion ? `v${u.latestVersion}` : '—'}</strong>
              <span className="muted small">{u.lastCheckedAt ? `Checked ${formatDateTime(u.lastCheckedAt)}` : 'Never checked'}</span>
            </div>
          </div>

          {!u.manifestConfigured && <p className="muted">Update checking is unavailable until a release manifest URL is set below. Your installed version is shown above.</p>}
          {u.error && <div className="banner banner-danger">{u.error}</div>}
          {newer && u.releaseNotes && (
            <div className="release-notes">
              <h4>What's new in v{u.latestVersion}</h4>
              <pre>{u.releaseNotes}</pre>
            </div>
          )}

          <label className="field">
            <span>Release manifest URL</span>
            <input type="url" value={url} placeholder="https://example.com/zoom-stream-automation/latest.json" onChange={(e) => setUrl(e.target.value)} onBlur={() => url !== settings.releaseManifestUrl && act('updateSettings', { releaseManifestUrl: url.trim() })} />
            <small className="muted">
              HTTPS JSON with <code>version</code>, <code>releaseNotes</code> and <code>downloadUrl</code>.
            </small>
          </label>

          <div className="button-row">
            <Button variant="primary" disabled={!u.manifestConfigured} busy={pending.checkUpdates || u.checking} onClick={() => act('checkUpdates')}>
              Check for Updates
            </Button>
            {newer && u.downloadUrl && <Button onClick={() => act('openDownload')}>Download v{u.latestVersion}</Button>}
          </div>
        </Card>

        <Card title="Uninstall" className="span-2">
          {app.uninstallerAvailable ? (
            <>
              <p>Runs the Windows uninstaller for {app.name}. The uninstaller also removes the app's scheduled task and Windows sign-in entry.</p>
              <Button variant="danger" onClick={() => setConfirm('uninstall')}>
                Uninstall
              </Button>
            </>
          ) : (
            <>
              <p>
                {app.portable
                  ? 'This is the portable version, which has no installer. Remove its schedule and sign-in entry below, then delete the .exe file.'
                  : app.packaged
                    ? 'No registered uninstaller was found next to the app. Use Windows Settings → Apps → Installed apps to remove it.'
                    : 'Development build: there is nothing to uninstall. You can still remove the schedule and sign-in entry.'}
              </p>
              <Button variant="danger" busy={pending.cleanup} onClick={() => setConfirm('cleanup')}>
                Remove schedule &amp; startup entry
              </Button>
            </>
          )}
          <p className="muted small">Settings file: {app.configPath}</p>
        </Card>
      </div>

      {confirm === 'uninstall' && (
        <ConfirmDialog
          title={`Uninstall ${app.name}?`}
          danger
          confirmLabel="Open uninstaller"
          message="The app closes and the Windows uninstaller opens. Uninstalling only happens once you confirm in the uninstaller."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act('uninstall', { removeData });
          }}
        >
          <label className="check">
            <input type="checkbox" checked={removeData} onChange={(e) => setRemoveData(e.target.checked)} />
            Also delete my settings, schedule and activity log
          </label>
        </ConfirmDialog>
      )}
      {confirm === 'cleanup' && (
        <ConfirmDialog
          title="Remove schedule and startup entry?"
          danger
          confirmLabel="Remove"
          message="Deletes the scheduled stream, its Windows scheduled task and the launch-at-sign-in entry. Other settings are kept."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act('cleanup');
          }}
        />
      )}
    </>
  );
}
