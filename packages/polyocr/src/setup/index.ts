/**
 * `polyocr setup` orchestrator.
 *
 * Composes the lower-level pieces (`probeOllama`, `detectOllamaBinary`,
 * `installOllama`, `startDaemon`, `pullModel`) into a single function the
 * CLI calls. Branches on the probe result:
 *
 *   ready          → nothing to do
 *   model-missing  → confirm → pull
 *   daemon-down    → check binary → start daemon OR install + start → pull
 *   daemon-error   → return failure with the HTTP status (operator must
 *                    intervene — we can't auto-fix a daemon that's
 *                    actively rejecting requests)
 *
 * After every side effect, re-probe to confirm the gap actually closed.
 *
 * Exit codes (returned via `SetupResult.exitCode`):
 *   0  — ready (no-op or successful remediation)
 *   1  — user declined a confirmation prompt
 *   2  — misuse (e.g. remote URL with non-check mode, no TTY without --yes)
 *   3  — install / pull failed for an environmental reason
 */

import { detectOllamaBinary, installOllama, startDaemon } from './install.js';
import type { InstallResult } from './install.js';
import { isLocalOllamaUrl, probeOllama } from './probe.js';
import { pullModel } from './pull.js';
import type { PullProgress } from './pull.js';
import { confirm } from './prompt.js';
import { listProfiles, resolveProfile } from '../translate/profiles.js';
import type { ModelProfile } from '../translate/profiles.js';
import type { OllamaProbeResult } from '../translate/ollama.js';

export interface SetupOptions {
  /** Default `http://localhost:11434`. */
  ollamaUrl?: string;
  /** Default `aya:8b`. */
  model?: string;
  /** Custom model profiles merged in front of the built-in registry. */
  customProfiles?: ModelProfile[];
  /** Skip yes/no prompts. The Linux curl|sh prompt is non-bypassable. */
  yes?: boolean;
  /** Diagnose only — never install, start, or pull. */
  checkOnly?: boolean;
  /** Where to write progress + diagnostic lines. Default `process.stderr`. */
  log?: (line: string) => void;
  /**
   * Confirmation prompt. Default uses `node:readline`. Pluggable so the
   * Electron shell can render a real dialog.
   */
  prompt?: (question: string) => Promise<boolean>;
  /** Callback invoked for each `/api/pull` progress event. */
  onPullProgress?: (event: PullProgress) => void;
  /** Cancel in-flight install / pull. Wired to SIGINT in the CLI. */
  signal?: AbortSignal;
}

export type SetupStatus =
  | 'ready'      // no-op — already configured
  | 'pulled'     // model was missing, now pulled
  | 'started'    // daemon was down, now started (and ready)
  | 'installed'  // daemon binary was missing, now installed (and ready)
  | 'failed'     // an install / pull / start step failed
  | 'declined';  // user said no to a confirmation

export interface SetupResult {
  status: SetupStatus;
  exitCode: 0 | 1 | 2 | 3;
  message: string;
  /** The probe result after any remediation steps. */
  probe: OllamaProbeResult;
}

const DEFAULT_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'aya:8b';

/**
 * Run the setup flow. See module-level docstring for the branching logic.
 */
export async function runSetup(opts: SetupOptions = {}): Promise<SetupResult> {
  const ollamaUrl = opts.ollamaUrl ?? DEFAULT_URL;
  const model = opts.model ?? DEFAULT_MODEL;
  const log = opts.log ?? ((s: string) => process.stderr.write(s.endsWith('\n') ? s : s + '\n'));
  const prompt = opts.prompt ?? ((q: string) => confirm(q, false));
  const yes = opts.yes ?? false;

  // T3: refuse to install for a remote URL. `--check` against a remote is
  // fine — that's a read-only probe — so we only short-circuit when
  // checkOnly is false.
  if (!isLocalOllamaUrl(ollamaUrl) && !opts.checkOnly) {
    const probe = await probeOllama({ ollamaUrl, model });
    return {
      status: 'failed',
      exitCode: 2,
      message: `setup is for local installations only; the configured Ollama URL points at ${ollamaUrl}. Use --check to probe a remote instance.`,
      probe
    };
  }

  // Step 1: probe.
  let probe = await probeOllama({ ollamaUrl, model });
  log(formatProbeStatus(probe));

  if (probe.status === 'ready') {
    return {
      status: 'ready',
      exitCode: 0,
      message: `ready: ${ollamaUrl} has ${model} (or a matching ${model.split(':')[0]}: tag) installed.`,
      probe
    };
  }

  if (opts.checkOnly) {
    return {
      status: 'failed',
      exitCode: 3,
      message: probeRemediationHint(probe),
      probe
    };
  }

  // Step 2: branch on what's missing.
  if (probe.status === 'daemon-error') {
    // We can't auto-fix a daemon that's responding with errors — the user
    // has to look at it. Surface the HTTP status and bail.
    return {
      status: 'failed',
      exitCode: 3,
      message: `Ollama responded ${probe.error ?? 'an error'} from ${ollamaUrl}/api/tags. Investigate the daemon (logs, port conflicts) and re-run setup.`,
      probe
    };
  }

  if (probe.status === 'daemon-down') {
    // Either the binary is installed and the daemon just isn't running,
    // or the binary needs to be installed.
    const binary = await detectOllamaBinary();
    if (binary.installed) {
      log(`Ollama binary found at ${binary.path}${binary.version ? ` (${binary.version})` : ''} but daemon isn't responding on ${ollamaUrl}. Starting it...\n`);
      const started = await startDaemon({ log });
      if (!started.ok) {
        return {
          status: 'failed',
          exitCode: 3,
          message: `Failed to start Ollama daemon: ${started.error ?? 'unknown error'}`,
          probe
        };
      }
      probe = await waitForReady({ ollamaUrl, model, log });
      if (probe.status === 'daemon-down') {
        return {
          status: 'failed',
          exitCode: 3,
          message:
            `Ollama was started but isn't responding on ${ollamaUrl}. ` +
            `It may already be running on a different port — set --ollama <url> or POLYOCR_OLLAMA_URL.`,
          probe
        };
      }
      // Fall through to model handling below if model is now missing.
    } else {
      // Need to install. Confirm unless --yes.
      const profile = resolveProfile(model, opts.customProfiles);
      const sizeHint = profile ? ` (will pull ${model}, ~${formatMB(profile.approxSizeMB)} after install)` : '';
      const consent = yes || (await prompt(`Ollama is not installed. Install it now${sizeHint}?`));
      if (!consent) {
        return {
          status: 'declined',
          exitCode: 1,
          message: `Ollama install declined.`,
          probe
        };
      }
      const install = await installOllama({ yes, log, prompt, ...(opts.signal && { signal: opts.signal }) });
      if (!install.ok) {
        return {
          status: 'failed',
          exitCode: 3,
          message: formatInstallFailure(install),
          probe
        };
      }
      // Some installers auto-start the daemon (Windows .exe), some don't
      // (macOS brew). Re-probe with a short wait first; if still down,
      // call startDaemon explicitly.
      probe = await waitForReady({ ollamaUrl, model, log, timeoutMs: 5000 });
      if (probe.status === 'daemon-down') {
        const started = await startDaemon({ log });
        if (!started.ok) {
          return {
            status: 'failed',
            exitCode: 3,
            message: `Installed but couldn't start daemon: ${started.error ?? 'unknown error'}`,
            probe
          };
        }
        probe = await waitForReady({ ollamaUrl, model, log });
      }
    }
  }

  // Step 3: at this point the daemon should be reachable. Handle the
  // model branch, regardless of whether we got here via "model-missing
  // from the start" or "daemon was down, then the model also wasn't
  // pulled".
  if (probe.status === 'model-missing') {
    const profile = resolveProfile(model, opts.customProfiles);
    const sizeHint = profile ? ` (~${formatMB(profile.approxSizeMB)})` : '';
    const consent = yes || (await prompt(`Pull "${model}"${sizeHint}?`));
    if (!consent) {
      return {
        status: 'declined',
        exitCode: 1,
        message: `Skipped pulling ${model}. Translation will be unavailable until you pull a model.`,
        probe
      };
    }
    const pull = await pullModel({
      ollamaUrl,
      model,
      log,
      ...(opts.onPullProgress && { onProgress: opts.onPullProgress }),
      ...(opts.signal && { signal: opts.signal })
    });
    if (!pull.ok) {
      return {
        status: 'failed',
        exitCode: 3,
        message: `Pull failed: ${pull.error ?? 'unknown error'}`,
        probe: await probeOllama({ ollamaUrl, model })
      };
    }
    probe = await probeOllama({ ollamaUrl, model });
  }

  // Step 4: final verification.
  if (probe.status !== 'ready') {
    return {
      status: 'failed',
      exitCode: 3,
      message: `Setup completed remediation steps but final probe is "${probe.status}".`,
      probe
    };
  }
  return {
    status: 'ready',
    exitCode: 0,
    message: `Ready. ${ollamaUrl} has ${model} installed.`,
    probe
  };
}

/**
 * Poll `/api/tags` until it reports `ready` or `model-missing` (both mean
 * the daemon is up), then return that result. Times out after `timeoutMs`
 * (default 10s).
 */
async function waitForReady(opts: {
  ollamaUrl: string;
  model: string;
  log: (s: string) => void;
  timeoutMs?: number;
}): Promise<OllamaProbeResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10000);
  let last: OllamaProbeResult = await probeOllama(opts);
  while (last.status === 'daemon-down' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    last = await probeOllama(opts);
  }
  return last;
}

function formatProbeStatus(probe: OllamaProbeResult): string {
  switch (probe.status) {
    case 'ready':
      return `Ollama at ${probe.ollamaUrl} is ready (${probe.installedModels.length} model${probe.installedModels.length === 1 ? '' : 's'} installed).\n`;
    case 'model-missing':
      return `Ollama at ${probe.ollamaUrl} is reachable but model "${probe.configuredModel}" is not pulled (have: ${probe.installedModels.join(', ') || 'none'}).\n`;
    case 'daemon-down':
      return `Ollama at ${probe.ollamaUrl} is not reachable${probe.error ? ` (${probe.error})` : ''}.\n`;
    case 'daemon-error':
      return `Ollama at ${probe.ollamaUrl} returned an error${probe.error ? `: ${probe.error}` : ''}.\n`;
  }
}

function probeRemediationHint(probe: OllamaProbeResult): string {
  switch (probe.status) {
    case 'ready':
      return 'ready';
    case 'model-missing':
      return `model "${probe.configuredModel}" not pulled — run "polyocr setup" (without --check) to pull it`;
    case 'daemon-down':
      return `Ollama daemon not reachable at ${probe.ollamaUrl} — run "polyocr setup" to install/start it`;
    case 'daemon-error':
      return `Ollama responded with an error — investigate the daemon and retry`;
  }
}

function formatInstallFailure(install: InstallResult): string {
  if (install.method === 'manual') {
    return `Automatic install isn't possible on this system. Open ${install.manualUrl ?? 'https://ollama.com/download'} to install Ollama, then re-run setup.`;
  }
  return `Install failed (${install.method}): ${install.error ?? 'unknown error'}`;
}

function formatMB(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Render the built-in + custom profile registry as a table for the
 * `polyocr setup --list-models` command. Plain text, no ANSI — works in
 * any terminal.
 */
export function formatProfileList(custom?: ModelProfile[]): string {
  const all = listProfiles(custom);
  const rows = all.map((p) => ({
    name: p.name,
    size: formatMB(p.approxSizeMB),
    langs: `${p.languages.length} langs`,
    strengths: p.strengths?.join(',') ?? '',
    description: p.description ?? ''
  }));
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    size: Math.max(4, ...rows.map((r) => r.size.length)),
    langs: Math.max(5, ...rows.map((r) => r.langs.length)),
    strengths: Math.max(9, ...rows.map((r) => r.strengths.length))
  };
  const header =
    `${'NAME'.padEnd(widths.name)}  ${'SIZE'.padEnd(widths.size)}  ${'LANGS'.padEnd(widths.langs)}  ${'STRENGTHS'.padEnd(widths.strengths)}  DESCRIPTION`;
  const lines = rows.map(
    (r) =>
      `${r.name.padEnd(widths.name)}  ${r.size.padEnd(widths.size)}  ${r.langs.padEnd(widths.langs)}  ${r.strengths.padEnd(widths.strengths)}  ${r.description}`
  );
  return [header, ...lines].join('\n') + '\n';
}

// Re-export the lower-level pieces so consumers (Electron shell, tests)
// can compose their own UX without going through `runSetup`.
export { detectOllamaBinary, installOllama, startDaemon, runStreamed } from './install.js';
export type { BinaryInfo, InstallResult, InstallMethod, StartDaemonResult } from './install.js';
export { probeOllama, isLocalOllamaUrl } from './probe.js';
export { pullModel } from './pull.js';
export type { PullProgress } from './pull.js';
export { confirm, ask } from './prompt.js';
export type { OllamaProbeResult, OllamaProbeStatus } from '../translate/ollama.js';
export type { ModelProfile, ModelStrength } from '../translate/profiles.js';
export { BUILT_IN_PROFILES, listProfiles, resolveProfile } from '../translate/profiles.js';

// Paddle setup (sibling orchestrator for PaddleOCR's Python deps).
export { runPaddleSetup, probePaddle } from './paddle.js';
export type {
  PaddleSetupOptions,
  PaddleSetupResult,
  PaddleSetupStatus,
  PaddleProbeResult,
  PaddleProbeStatus
} from './paddle.js';
