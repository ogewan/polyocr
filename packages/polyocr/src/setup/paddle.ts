/**
 * `polyocr setup --paddle` orchestrator.
 *
 * Sibling to `setup/index.ts::runSetup` (which handles Ollama). Same
 * shape — probe → branch → remediate → re-probe → return a
 * `SetupResult`-compatible value — but the probe domain and remediation
 * graph are entirely Python/pip-shaped, not Ollama-shaped. Merging the
 * two would be a discriminator switch that paid the cognitive cost of
 * reading both halves to understand either; a sibling file reuses the
 * helpers (`runStreamed`, `confirm`, `SetupProgressEvent` shape) without
 * polluting the existing orchestrator.
 *
 * # What this does
 *
 *   1. Probe: `<python> --version` (detect Python on PATH) then
 *      `<python> -c 'import paddleocr; import fastapi; import uvicorn; import PIL'`
 *      capturing per-package import status.
 *   2. Branch on probe state:
 *        ready          → no-op
 *        python-missing → log OS-specific install instructions, return
 *                         failed (we don't auto-install Python — too many
 *                         distro/PATH/version side effects)
 *        deps-missing   → confirm unless --yes, run pip install via
 *                         `runStreamed`, re-probe
 *   3. Re-probe and return a structured result.
 *
 * # Why we don't auto-install Python
 *   CPython has too many distro/version/PATH side effects to handle
 *   cleanly. Symmetric with Ollama setup's stance of refusing to do
 *   `curl|sh` on Linux without explicit consent: refuse to do the heavy
 *   thing implicitly.
 *
 * # Why `pip install` respects `--yes` (unlike Linux curl|sh)
 *   pip from PyPI is the canonical Python install path, locally scoped,
 *   with widely understood semantics. It is NOT comparable to piping a
 *   remote shell script straight into `sh`. The outer "install paddle
 *   deps?" confirm is bypassable with `--yes`. There is no inner
 *   non-bypassable consent.
 *
 * # Why `pip install --user`
 *   Avoids root/elevation needs and PEP 668 conflicts on macOS Homebrew
 *   / Debian system Pythons. Per-user install is what desktop users
 *   want. The user can override with `PIP_USER=0` env if they have a
 *   venv active and want the install to land there instead.
 */

import { spawn } from 'node:child_process';
import { runStreamed } from './install.js';
import { confirm } from './prompt.js';

/** Default python binary name per platform — same logic as `paddleocr.ts::defaultPython`. */
function defaultPython(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Packages we require importable for PaddleOCR to actually work. */
const REQUIRED_PACKAGES = ['paddleocr', 'fastapi', 'uvicorn', 'PIL'] as const;
type RequiredPackage = typeof REQUIRED_PACKAGES[number];

/**
 * pip install package list. PIL is named `pillow` on PyPI but imports as
 * `PIL` — the probe checks the import name, the install uses the
 * package name.
 */
const PIP_PACKAGES = ['paddleocr', 'fastapi', 'uvicorn', 'pillow'] as const;

export interface PaddleSetupOptions {
  /**
   * Override the python executable. Default: `python3` on POSIX,
   * `python` on Windows. Same default as `PaddleOCRAdapter`'s
   * `defaultPython()`.
   */
  pythonPath?: string;
  /** Skip yes/no prompts. */
  yes?: boolean;
  /** Diagnose only — never run pip install. */
  checkOnly?: boolean;
  /** Where to write progress + diagnostic lines. Default `process.stderr`. */
  log?: (line: string) => void;
  /**
   * Confirmation prompt. Default uses `node:readline`. Pluggable so the
   * Electron shell can render a real dialog.
   */
  prompt?: (question: string) => Promise<boolean>;
  /** Cancel in-flight pip install. Wired to SIGINT in the CLI. */
  signal?: AbortSignal;
}

export type PaddleProbeStatus =
  | 'ready'           // python on PATH AND all required imports succeed
  | 'python-missing'  // no python(3) on PATH (or it failed --version)
  | 'deps-missing';   // python ok, at least one of paddleocr/fastapi/uvicorn/pillow doesn't import

/**
 * Structured result of a paddle environment probe. `polyocr setup
 * --paddle` consumes this; `enablePaddleOCR` users can call it directly
 * via the public `probePaddle()` export to render their own UI.
 */
export interface PaddleProbeResult {
  status: PaddleProbeStatus;
  /** Resolved python executable, when a runnable interpreter was found. */
  pythonPath?: string;
  /** First line of `python --version`, when reachable. */
  pythonVersion?: string;
  /**
   * Per-package import status. Populated when the probe reaches Python
   * (i.e. status is `ready` or `deps-missing`). Empty / undefined when
   * status is `python-missing`.
   */
  packages?: Record<RequiredPackage, boolean>;
  /** Raw error / diagnostic text (e.g. ImportError stderr). */
  error?: string;
}

export type PaddleSetupStatus =
  | 'ready'      // no-op — already configured
  | 'installed'  // pip install ran successfully
  | 'failed'     // probe / install failed
  | 'declined';  // user said no to the install confirm

/**
 * Mirrors `SetupResult`'s shape and exit-code dictionary so CLI / shell
 * code can consume both setups uniformly.
 *
 *   0 — ready (no-op or successful remediation)
 *   1 — user declined a confirmation prompt
 *   2 — misuse
 *   3 — install / probe failed for an environmental reason
 */
export interface PaddleSetupResult {
  status: PaddleSetupStatus;
  exitCode: 0 | 1 | 2 | 3;
  message: string;
  probe: PaddleProbeResult;
}

/**
 * Probe the paddle environment without side effects. Resolves either
 * `ready`, `python-missing`, or `deps-missing` — never throws. The
 * `log` callback (when supplied) receives one human-readable status
 * line; otherwise this function is silent.
 *
 * The two-step probe (version then imports) lets us distinguish "no
 * Python" from "Python but missing packages" without a single subprocess
 * conflating both. This matches the structure
 * `OllamaTranslationAdapter.probe()` uses — granular enough that the
 * orchestrator can pick the right next step.
 */
export async function probePaddle(opts: {
  pythonPath?: string;
  log?: (line: string) => void;
} = {}): Promise<PaddleProbeResult> {
  const pythonPath = opts.pythonPath ?? defaultPython();

  // Step 1: does the interpreter even run? `python --version` exits 0
  // and prints to stdout (CPython 3.4+) or stderr (CPython 3.3 and
  // earlier — we don't care, we capture both).
  const version = await runVersion(pythonPath);
  if (version === null) {
    return {
      status: 'python-missing',
      error: `${pythonPath}: not found on PATH or failed to run --version`
    };
  }

  // Step 2: probe the imports. We run a single `python -c` so a single
  // subprocess covers all four. Each import is wrapped in a try/except
  // and the missing names are printed to stdout in a parseable form.
  const packages = await probeImports(pythonPath);
  const allOk = REQUIRED_PACKAGES.every((p) => packages[p]);
  const result: PaddleProbeResult = {
    status: allOk ? 'ready' : 'deps-missing',
    pythonPath,
    pythonVersion: version,
    packages
  };
  return result;
}

/**
 * Run the probe → branch → remediate → re-probe flow. Returns a
 * `PaddleSetupResult` with the final state. Never throws — environmental
 * failures are surfaced via the structured result so callers can render
 * a UX without try/catch around every call.
 */
export async function runPaddleSetup(opts: PaddleSetupOptions = {}): Promise<PaddleSetupResult> {
  const log = opts.log ?? ((s: string) => process.stderr.write(s.endsWith('\n') ? s : s + '\n'));
  const prompt = opts.prompt ?? ((q: string) => confirm(q, false));
  const yes = opts.yes ?? false;
  const pythonPath = opts.pythonPath ?? defaultPython();

  // Step 1: probe.
  let probe = await probePaddle({ pythonPath, log });
  log(formatProbeStatus(probe));

  if (probe.status === 'ready') {
    return {
      status: 'ready',
      exitCode: 0,
      message: `Ready. ${pythonPath} has paddleocr + fastapi + uvicorn + pillow installed.`,
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
  if (probe.status === 'python-missing') {
    // We don't auto-install Python — see module docstring.
    log(pythonInstallInstructions());
    return {
      status: 'failed',
      exitCode: 3,
      message:
        `Python is required but '${pythonPath}' is not on PATH. Install Python ` +
        `(see instructions above) and re-run setup, or pass --python <path>.`,
      probe
    };
  }

  // probe.status === 'deps-missing'
  const missing = REQUIRED_PACKAGES.filter((p) => !probe.packages?.[p]);
  const consent =
    yes ||
    (await prompt(
      `Install paddleocr deps via pip (${PIP_PACKAGES.join(' ')})? Missing: ${missing.join(', ')}.`
    ));
  if (!consent) {
    return {
      status: 'declined',
      exitCode: 1,
      message: 'pip install declined.',
      probe
    };
  }

  log(`Running: ${pythonPath} -m pip install --user ${PIP_PACKAGES.join(' ')}\n`);
  // `--user` per the module docstring. PYTHONUTF8=1 forces stdout/stderr
  // to UTF-8 on Windows where pip may otherwise emit cp1252 sequences
  // that look garbled in the renderer's <pre> log view.
  const code = await runStreamed(
    pythonPath,
    ['-m', 'pip', 'install', '--user', ...PIP_PACKAGES],
    log,
    opts.signal
  );
  if (code !== 0) {
    return {
      status: 'failed',
      exitCode: 3,
      message: `pip install exited with code ${code}. See log above for the cause.`,
      probe
    };
  }

  // Step 3: re-probe to confirm the install actually fixed things.
  // `pip install` returning 0 without import success would mean a
  // partially-broken install (PYTHONPATH issue, conflicting site-packages,
  // wheel that didn't materialize). Surface those rather than declaring
  // success blindly.
  probe = await probePaddle({ pythonPath, log });
  if (probe.status !== 'ready') {
    return {
      status: 'failed',
      exitCode: 3,
      message:
        `pip install completed but post-probe is "${probe.status}" — ` +
        `at least one import still fails. Run "polyocr setup --paddle --check" for diagnostics.`,
      probe
    };
  }

  return {
    status: 'installed',
    exitCode: 0,
    message: `Installed. ${pythonPath} now has paddleocr + fastapi + uvicorn + pillow.`,
    probe
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Run `<python> --version` and return the first non-empty line, or null
 * if the binary couldn't be invoked. 3-second timeout — a Python
 * installation that hangs on `--version` is broken in a way we can't
 * recover from, so we treat it as not-installed.
 */
function runVersion(pythonPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(pythonPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 3000);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      // Python <3.4 prints --version to stderr. Capture both.
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first ?? null);
    });
  });
}

/**
 * Probe each required Python import individually. Single subprocess,
 * per-package result. The script emits one line per package in the form
 * `name=ok` or `name=missing` to stdout — robust against ImportError
 * messages mixing into stderr.
 */
async function probeImports(pythonPath: string): Promise<Record<RequiredPackage, boolean>> {
  const script = REQUIRED_PACKAGES.map(
    (pkg) =>
      `try:\n  import ${pkg}\n  print('${pkg}=ok')\nexcept Exception:\n  print('${pkg}=missing')\n`
  ).join('');
  const out = await new Promise<string>((resolve) => {
    const child = spawn(pythonPath, ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve('');
    }, 8000);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
  });
  const result = {} as Record<RequiredPackage, boolean>;
  for (const pkg of REQUIRED_PACKAGES) result[pkg] = false;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]+)=(ok|missing)$/);
    if (!m) continue;
    const name = m[1] as RequiredPackage;
    if (REQUIRED_PACKAGES.includes(name)) {
      result[name] = m[2] === 'ok';
    }
  }
  return result;
}

function formatProbeStatus(probe: PaddleProbeResult): string {
  switch (probe.status) {
    case 'ready':
      return `Paddle environment is ready (${probe.pythonVersion ?? probe.pythonPath}).\n`;
    case 'python-missing':
      return `Python is not available${probe.pythonPath ? ` (tried '${probe.pythonPath}')` : ''}.\n`;
    case 'deps-missing': {
      const missing = REQUIRED_PACKAGES.filter((p) => !probe.packages?.[p]);
      return `${probe.pythonVersion ?? probe.pythonPath} is on PATH; missing: ${missing.join(', ')}.\n`;
    }
  }
}

function probeRemediationHint(probe: PaddleProbeResult): string {
  switch (probe.status) {
    case 'ready':
      return 'ready';
    case 'python-missing':
      return 'Python not on PATH — install Python and re-run "polyocr setup --paddle"';
    case 'deps-missing': {
      const missing = REQUIRED_PACKAGES.filter((p) => !probe.packages?.[p]);
      return `Python ok but missing imports: ${missing.join(', ')} — run "polyocr setup --paddle" (without --check)`;
    }
  }
}

/**
 * OS-specific Python install instructions. Printed when probe returns
 * `python-missing`. Same shape as Ollama's manual-install fallback URLs
 * — point the user at a canonical install path and stop, rather than
 * trying to spawn winget/brew/apt for a heavyweight install we can't
 * recover from if it half-fails.
 */
function pythonInstallInstructions(): string {
  switch (process.platform) {
    case 'win32':
      return (
        '\nInstall Python first:\n' +
        '  winget install Python.Python.3.12\n' +
        '  (or download from https://www.python.org/downloads/ and tick "Add python.exe to PATH")\n\n'
      );
    case 'darwin':
      return (
        '\nInstall Python first:\n' +
        '  brew install python@3.12\n' +
        '  (or download from https://www.python.org/downloads/macos/)\n\n'
      );
    case 'linux':
      return (
        '\nInstall Python first. On Debian/Ubuntu:\n' +
        '  sudo apt install python3 python3-pip\n' +
        'On Fedora/RHEL:\n' +
        '  sudo dnf install python3 python3-pip\n' +
        'On Arch:\n' +
        '  sudo pacman -S python python-pip\n\n'
      );
    default:
      return '\nInstall Python 3 from https://www.python.org/downloads/\n\n';
  }
}
