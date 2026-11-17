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
  if (u.installing) status = <Badge tone="info" pulse>Downloading…</Badge>;
  else if (u.checking) status = <Badge tone="info" pulse>Checking…</Badge>;
  else if (u.error && /No release has been published/.test(u.error)) status = <Badge>No release yet</Badge>;
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

          <p className="muted small">The app checks the Stream Automation GitHub releases for a newer version automatically (at start and twice a day).</p>
          {u.error && <div className="banner banner-danger">{u.error}</div>}
          {u.installing && (
            <div className="banner banner-info">
              Downloading v{u.latestVersion}… {u.total ? `${Math.floor((u.received / u.total) * 100)}% of ${Math.round(u.total / 1048576)} MB` : `${Math.round(u.received / 1048576)} MB`}. The installer opens when the download is complete and the app closes.
            </div>
          )}
          {newer && u.releaseNotes && (
            <div className="release-notes">
              <h4>What's new in v{u.latestVersion}</h4>
              <pre>{u.releaseNotes}</pre>
            </div>
          )}

          <div className="button-row">
            {newer && u.downloadUrl && u.canInstall && (
              <Button variant="primary" busy={pending.installUpdate || u.installing} disabled={u.installing} onClick={() => setConfirm('install')}>
                Download &amp; install v{u.latestVersion}
              </Button>
            )}
            {newer && u.downloadUrl && !u.canInstall && (
              <Button variant="primary" onClick={() => act('openDownload')}>
                Download v{u.latestVersion}
              </Button>
            )}
            <Button variant={newer ? 'default' : 'primary'} disabled={u.installing} busy={pending.checkUpdates || u.checking} onClick={() => act('checkUpdates')}>
              Check for Updates
            </Button>
          </div>

          <details className="advanced">
            <summary className="muted small">Advanced: other update source</summary>
            <label className="field">
              <span>Release manifest URL (optional)</span>
              <input type="url" value={url} placeholder="Default: GitHub releases of Stream Automation" onChange={(e) => setUrl(e.target.value)} onBlur={() => url !== settings.releaseManifestUrl && act('updateSettings', { releaseManifestUrl: url.trim() })} />
              <small className="muted">
                Leave empty to use GitHub. Otherwise an HTTPS JSON with <code>version</code>, <code>releaseNotes</code> and <code>downloadUrl</code>.
              </small>
            </label>
          </details>
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
      {confirm === 'install' && (
        <ConfirmDialog
          title={`Install v${u.latestVersion}?`}
          confirmLabel="Download & install"
          message={`Downloads the installer${u.downloadSize ? ` (${Math.round(u.downloadSize / 1048576)} MB)` : ''} from GitHub. When it is ready, the app closes and the installer opens: click through it to upgrade. Your settings, meeting ID, images and schedule are kept.`}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            act('installUpdate');
          }}
        />
      )}
    </>
  );
}
