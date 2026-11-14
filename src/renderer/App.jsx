import React, { useCallback, useEffect, useState } from 'react';
import HomeTab from './components/HomeTab.jsx';
import UpdateTab from './components/UpdateTab.jsx';
import AutoPowerTab from './components/AutoPowerTab.jsx';
import RemoteTab from './components/RemoteTab.jsx';
import { Badge } from './components/ui.jsx';
import logoUrl from './assets/logo.png';
import { ZOOM_STATUS, isNewer } from './util.js';

const TABS = [
  ['home', 'Home'],
  ['power', 'Auto Power On'],
  ['remote', 'Remote'],
  ['update', 'Update'],
];


export default function App() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('home');
  const [toasts, setToasts] = useState([]);
  const [pending, setPending] = useState({});

  useEffect(() => {
    const off = window.zsa.onState(setState);
    window.zsa.getState().then((res) => res?.state && setState(res.state));
    return off;
  }, []);

  const toast = useCallback((tone, message, hint) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, tone, message, hint }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 9000 : 4000);
  }, []);

  /** Calls a bridge action, tracks its pending state and surfaces failures. */
  const act = useCallback(
    async (name, ...args) => {
      setPending((p) => ({ ...p, [name]: true }));
      try {
        const res = await window.zsa[name](...args);
        if (res && res.ok === false) {
          if (res.error) toast('error', res.error, res.hint);
          else if (res.errors?.length) toast('error', res.errors.join(' '));
        } else if (res?.warning) {
          toast('warning', res.warning);
        }
        return res;
      } catch (err) {
        toast('error', err.message);
        return { ok: false, error: err.message };
      } finally {
        setPending((p) => ({ ...p, [name]: false }));
      }
    },
    [toast],
  );

  if (!state) return <div className="boot">Loading…</div>;

  const [tone, label] = ZOOM_STATUS[state.zoom.status] || ZOOM_STATUS.unknown;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="logo" src={logoUrl} alt="" aria-hidden="true" />
          <div>
            <div className="brand-name">Stream Automation</div>
            <div className="brand-sub">Zoom · YouTube</div>
          </div>
        </div>
        <nav>
          {TABS.map(([id, name]) => (
            <button key={id} className={`nav-item${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              {name}
              {id === 'remote' && state.remote.watching && <span className="nav-dot" />}
              {id === 'update' && state.updates.latestVersion && isNewer(state.updates.latestVersion, state.updates.currentVersion) && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Badge tone={tone}>Zoom {label}</Badge>
          <span className="muted small">v{state.app.version}</span>
        </div>
      </aside>

      <main className="content">
        {tab === 'home' && <HomeTab state={state} act={act} pending={pending} toast={toast} />}
        {tab === 'power' && <AutoPowerTab state={state} act={act} pending={pending} />}
        {tab === 'remote' && <RemoteTab state={state} act={act} pending={pending} toast={toast} />}
        {tab === 'update' && <UpdateTab state={state} act={act} pending={pending} />}
      </main>

      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <strong>{t.message}</strong>
            {t.hint && <span>{t.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
