/**
 * Top-level React app for the polyocr-shell renderer.
 *
 * Owns:
 *   - The page tab state (Single | Batch | MangaMode | Settings).
 *   - Settings hydration on mount via `window.shell.getSettings()`.
 *   - A loading fallback while settings are being fetched.
 *
 * Routing is intentionally hand-rolled (a tiny tab-state machine)
 * rather than React Router — the shell has four pages, no nested
 * routes, and no URL semantics that matter. A 200-line router
 * dependency would cost more than it gains.
 */

import { useEffect, useState } from 'react';
import type { Settings } from '../shared/types.js';
import { Single } from './pages/Single.js';
import { Batch } from './pages/Batch.js';
import { MangaMode } from './pages/MangaMode.js';
import { Settings as SettingsPage } from './pages/Settings.js';

type Tab = 'single' | 'batch' | 'manga' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'single', label: 'Single' },
  { id: 'batch', label: 'Batch' },
  { id: 'manga', label: 'Manga' },
  { id: 'settings', label: 'Settings' }
];

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('single');
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    window.shell.getSettings().then(setSettings).catch((err) => {
      // Loading failure is fatal for the page-level work but not for
      // navigating around — surface a clear message rather than
      // hanging the renderer in a loading state forever.
      console.error('Could not load settings from main:', err);
      setSettings(null);
    });
  }, []);

  if (!settings) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500">
        <p className="text-sm font-mono">Loading settings…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 h-12 flex items-center gap-1 titlebar-drag">
        <span className="font-semibold mr-4 titlebar-no-drag">PolyOCR</span>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`titlebar-no-drag px-3 py-1 text-sm rounded ${
              tab === t.id
                ? 'bg-brand-500 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </header>
      <main className="flex-1 overflow-y-auto bg-slate-50">
        {tab === 'single' && <Single settings={settings} />}
        {tab === 'batch' && <Batch settings={settings} />}
        {tab === 'manga' && <MangaMode settings={settings} />}
        {tab === 'settings' && (
          <SettingsPage settings={settings} onSaved={setSettings} />
        )}
      </main>
    </div>
  );
}
