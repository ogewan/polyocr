/**
 * Settings page.
 *
 * Sections:
 *   - Engines:     Ollama URL, translation model dropdown (driven by
 *                  `getProfiles()`), vision model, PaddleOCR toggle,
 *                  custom-profile JSON path picker, "Run setup" button
 *                  for the M2 polyocr:setup IPC.
 *   - Defaults:    target language, inpaint mode, font + chroma key.
 *   - Performance: worker count, Tesseract languages.
 *   - Hotkey:      screenshot accelerator recorder.
 *   - Cache:       "Clear scan history" button.
 *
 * # Save discipline
 *   The form maintains a draft state separate from the persisted
 *   settings. "Save" diffs draft against the loaded snapshot and sends
 *   only changed fields to `window.shell.setSettings(partial)`.
 *   Re-instantiating the PolyOCR singleton in main is keyed off
 *   pipeline-relevant fields so non-pipeline changes (hotkey, defaults)
 *   don't pay for a rebuild.
 */

import { useEffect, useState } from 'react';
import type { Settings, ModelProfile } from '../../shared/types.js';
import type { SetupProgressEvent } from '../../shared/types.js';
import type { InpaintMode } from 'polyocr';

interface SettingsPageProps {
  /** Snapshot loaded by App; refresh callback so saving updates everyone. */
  settings: Settings;
  onSaved: (next: Settings) => void;
}

export function Settings({ settings, onSaved }: SettingsPageProps): JSX.Element {
  const [draft, setDraft] = useState<Settings>(settings);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    window.polyocr
      .getProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    try {
      // Diff: send only changed top-level fields. Each field is its own
      // SQLite row so non-changed fields don't get touched.
      const partial: Partial<Settings> = {};
      for (const key of Object.keys(draft) as (keyof Settings)[]) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(settings[key])) {
          (partial as Record<string, unknown>)[key] = draft[key];
        }
      }
      await window.shell.setSettings(partial);
      onSaved(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 space-y-6 text-sm">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Section title="Engines">
        <Field label="Ollama URL">
          <input
            type="text"
            value={draft.ollamaUrl}
            onChange={(e) => setDraft({ ...draft, ollamaUrl: e.target.value })}
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
          />
        </Field>

        <Field label="Translation model">
          <div className="flex gap-2">
            <select
              value={draft.translationModel}
              onChange={(e) => setDraft({ ...draft, translationModel: e.target.value })}
              className="flex-1 border border-slate-300 rounded px-2 py-1"
            >
              {profiles.length === 0 && (
                <option value={draft.translationModel}>{draft.translationModel}</option>
              )}
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({(p.approxSizeMB / 1024).toFixed(1)} GB
                  {p.strengths && p.strengths.length > 0 ? ` · ${p.strengths.join(',')}` : ''})
                </option>
              ))}
              {/* Allow a free-form value not in the dropdown: */}
              {!profiles.some((p) => p.name === draft.translationModel) && (
                <option value={draft.translationModel}>{draft.translationModel} (custom)</option>
              )}
            </select>
            <button
              onClick={() => setSetupOpen(true)}
              className="px-3 py-1 bg-brand-500 text-white rounded hover:bg-brand-600"
            >
              Run setup
            </button>
          </div>
          {profiles.find((p) => p.name === draft.translationModel)?.description && (
            <p className="text-xs text-slate-500 mt-1">
              {profiles.find((p) => p.name === draft.translationModel)?.description}
            </p>
          )}
        </Field>

        <Field label="Vision model">
          <input
            type="text"
            value={draft.visionModel}
            onChange={(e) => setDraft({ ...draft, visionModel: e.target.value })}
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
          />
        </Field>

        <Field label="PaddleOCR (CJK / dense layouts)">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.enablePaddleOCR}
              onChange={(e) => setDraft({ ...draft, enablePaddleOCR: e.target.checked })}
            />
            <span className="text-slate-600">Enable</span>
          </label>
          {/* Sub-fields collapse when paddle is disabled — keeps the page
              tidy and signals that these settings are paddle-scoped. */}
          {draft.enablePaddleOCR && (
            <div className="mt-2 pl-6 space-y-2 border-l-2 border-slate-200">
              <div className="space-y-1">
                <label className="block text-xs text-slate-600">
                  PaddleOCR language
                </label>
                <input
                  type="text"
                  value={draft.paddleocrLang}
                  onChange={(e) => setDraft({ ...draft, paddleocrLang: e.target.value })}
                  placeholder="en, ch, japan, korean, …"
                  className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
                />
                <p className="text-[11px] text-slate-500">
                  PaddleOCR's own vocabulary (different from Tesseract's). See
                  the PaddleOCR docs for the full list.
                </p>
              </div>
              <div className="space-y-1">
                <label className="block text-xs text-slate-600">Python binary</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={draft.paddleocrPythonPath ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        paddleocrPythonPath: e.target.value || null
                      })
                    }
                    placeholder="auto-discover (python3 / python on PATH)"
                    className="flex-1 border border-slate-300 rounded px-2 py-1 font-mono"
                  />
                  <button
                    onClick={async () => {
                      const picked = await window.shell.openFilePicker();
                      if (picked && picked[0]) {
                        setDraft({ ...draft, paddleocrPythonPath: picked[0] });
                      }
                    }}
                    className="px-2 py-1 border border-slate-300 rounded hover:bg-slate-50"
                  >
                    Browse…
                  </button>
                </div>
              </div>
            </div>
          )}
        </Field>

        <Field label="Custom translation profiles">
          <div className="flex gap-2">
            <input
              type="text"
              value={draft.customTranslationProfilesPath ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  customTranslationProfilesPath: e.target.value || null
                })
              }
              placeholder="Path to ModelProfile[] JSON (optional)"
              className="flex-1 border border-slate-300 rounded px-2 py-1 font-mono"
            />
            <button
              onClick={async () => {
                const picked = await window.shell.openFilePicker({ extensions: ['json'] });
                if (picked && picked[0]) {
                  setDraft({ ...draft, customTranslationProfilesPath: picked[0] });
                }
              }}
              className="px-2 py-1 border border-slate-300 rounded hover:bg-slate-50"
            >
              Browse…
            </button>
          </div>
        </Field>
      </Section>

      <Section title="Defaults">
        <Field label="Default target language (ISO 639-1)">
          <input
            type="text"
            value={draft.defaultTargetLanguage ?? ''}
            placeholder="e.g. en — leave blank to skip translation"
            onChange={(e) =>
              setDraft({ ...draft, defaultTargetLanguage: e.target.value || null })
            }
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
          />
        </Field>

        <Field label="Default inpaint mode">
          <select
            value={draft.defaultInpaintMode ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                defaultInpaintMode: (e.target.value || null) as InpaintMode | null
              })
            }
            className="border border-slate-300 rounded px-2 py-1"
          >
            <option value="">none</option>
            <option value="fill">fill</option>
            <option value="blur">blur</option>
            <option value="chroma">chroma</option>
            <option value="clone">clone (stub)</option>
          </select>
        </Field>

        <Field label="Font (inpaint fill / chroma)">
          <div className="grid grid-cols-3 gap-2">
            <input
              type="text"
              value={draft.font.family ?? ''}
              onChange={(e) => setDraft({ ...draft, font: { ...draft.font, family: e.target.value } })}
              placeholder="family"
              className="border border-slate-300 rounded px-2 py-1 font-mono"
            />
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.font.bold ?? false}
                onChange={(e) => setDraft({ ...draft, font: { ...draft.font, bold: e.target.checked } })}
              />
              bold
            </label>
            <input
              type="color"
              value={draft.font.color ?? '#000000'}
              onChange={(e) => setDraft({ ...draft, font: { ...draft.font, color: e.target.value } })}
              className="border border-slate-300 rounded h-8"
            />
          </div>
        </Field>

        <Field label="Chroma key">
          <div className="flex gap-2 items-center">
            <input
              type="color"
              value={draft.chromaKey}
              onChange={(e) => setDraft({ ...draft, chromaKey: e.target.value })}
              className="border border-slate-300 rounded h-8 w-16"
            />
            <input
              type="number"
              min={0}
              max={255}
              value={draft.chromaTolerance}
              onChange={(e) => setDraft({ ...draft, chromaTolerance: Number(e.target.value) })}
              className="w-24 border border-slate-300 rounded px-2 py-1 font-mono"
              title="Tolerance (0–255)"
            />
            <span className="text-xs text-slate-500">tolerance</span>
          </div>
        </Field>
      </Section>

      <Section title="Performance">
        <Field label="Tesseract worker count">
          <input
            type="range"
            min={1}
            max={Math.max(2, navigator.hardwareConcurrency || 4)}
            value={draft.workerCount}
            onChange={(e) => setDraft({ ...draft, workerCount: Number(e.target.value) })}
            className="w-full"
          />
          <span className="text-xs text-slate-500">
            {draft.workerCount} of {navigator.hardwareConcurrency || 4} cores
          </span>
        </Field>

        <Field label="Tesseract languages (comma-separated)">
          <input
            type="text"
            value={draft.tesseractLanguages.join(',')}
            onChange={(e) =>
              setDraft({
                ...draft,
                tesseractLanguages: e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
              })
            }
            placeholder="eng,jpn,chi_sim"
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
          />
        </Field>
      </Section>

      <Section title="Screenshot hotkey">
        <Field label="Accelerator">
          <HotkeyRecorder
            value={draft.screenshotHotkey}
            onChange={(next) => setDraft({ ...draft, screenshotHotkey: next })}
          />
        </Field>
      </Section>

      <Section title="Cache">
        <button
          onClick={async () => {
            if (confirm('Clear all scan history? This drops sessions, results, and inpainted images.')) {
              await window.shell.clearHistory();
            }
          }}
          className="px-3 py-1 border border-rose-300 text-rose-700 rounded hover:bg-rose-50"
        >
          Clear scan history
        </button>
      </Section>

      <div className="sticky bottom-0 bg-slate-50 border-t border-slate-200 -mx-4 px-4 py-3 flex justify-end gap-2">
        <button
          onClick={() => setDraft(settings)}
          disabled={!dirty}
          className="px-4 py-1.5 border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-40"
        >
          Discard
        </button>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-1.5 bg-brand-500 text-white rounded hover:bg-brand-600 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {setupOpen && (
        <SetupModal
          ollamaUrl={draft.ollamaUrl}
          model={draft.translationModel}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="bg-white border border-slate-200 rounded p-4 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-slate-600">{label}</label>
      {children}
    </div>
  );
}

/**
 * Hotkey recorder: shows the current accelerator; clicking "Record"
 * captures the next keydown and renders the Electron-style accelerator
 * string ("CommandOrControl+Shift+O").
 */
function HotkeyRecorder({
  value,
  onChange
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
        onChange(parts.join('+'));
        setRecording(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [recording, onChange]);

  return (
    <div className="flex gap-2 items-center">
      <code className="px-2 py-1 bg-slate-100 border border-slate-200 rounded font-mono">{value}</code>
      <button
        onClick={() => setRecording((r) => !r)}
        className="px-3 py-1 border border-slate-300 rounded hover:bg-slate-50"
      >
        {recording ? 'Press a key…' : 'Record'}
      </button>
    </div>
  );
}

/**
 * Modal that drives `window.polyocr.setup(...)` and renders streamed
 * progress events. Closes itself on `done` or `error` after a short
 * delay so the user can read the final message.
 */
function SetupModal({
  ollamaUrl,
  model,
  onClose
}: {
  ollamaUrl: string;
  model: string;
  onClose: () => void;
}): JSX.Element {
  const [log, setLog] = useState<string[]>([]);
  const [pull, setPull] = useState<{ status: string; percent?: number } | null>(null);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    const onProgress = (event: SetupProgressEvent) => {
      if (event.kind === 'log' && event.message) {
        setLog((prev) => [...prev, event.message!]);
      } else if (event.kind === 'pull-progress' && event.pull) {
        const next: { status: string; percent?: number } = { status: event.pull.status };
        if (event.pull.percent !== undefined) next.percent = event.pull.percent;
        setPull(next);
      }
    };
    window.polyocr
      .setup({ ollamaUrl, model, yes: true }, onProgress)
      .then((result) => {
        setLog((prev) => [...prev, `\n${result.message}`]);
      })
      .catch((err: unknown) => {
        setLog((prev) => [
          ...prev,
          `\nSetup error: ${err instanceof Error ? err.message : String(err)}`
        ]);
      })
      .finally(() => setRunning(false));
  }, [ollamaUrl, model]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-10">
      <div className="bg-white rounded shadow-lg w-[600px] max-h-[80vh] flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 flex justify-between items-center">
          <h3 className="font-semibold">polyocr setup — {model}</h3>
          <button
            onClick={onClose}
            disabled={running}
            className="text-slate-500 hover:text-slate-800 disabled:opacity-40"
          >
            ✕
          </button>
        </div>
        {pull && (
          <div className="px-4 pt-3">
            <div className="text-xs text-slate-600 mb-1">
              {pull.status}
              {pull.percent !== undefined && <> — {pull.percent.toFixed(1)}%</>}
            </div>
            <div className="h-2 bg-slate-100 rounded overflow-hidden">
              <div
                className="h-2 bg-brand-500 transition-all"
                style={{ width: `${pull.percent ?? 0}%` }}
              />
            </div>
          </div>
        )}
        <pre className="flex-1 overflow-y-auto px-4 py-3 text-xs font-mono whitespace-pre-wrap text-slate-700">
          {log.join('')}
        </pre>
        <div className="px-4 py-2 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClose}
            disabled={running}
            className="px-3 py-1 bg-slate-700 text-white rounded hover:bg-slate-800 disabled:opacity-40"
          >
            {running ? 'Running…' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
