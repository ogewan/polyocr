/**
 * OS-specific Ollama binary detection, installation, and daemon-start.
 *
 * Three platforms supported:
 *   - Windows: `winget install Ollama.Ollama`
 *   - macOS:   `brew install ollama` (fallback to manual `.dmg` URL)
 *   - Linux:   `curl -fsSL https://ollama.com/install.sh | sh` — but only
 *              after explicit user consent, never automatic, because
 *              piping a remote shell script straight into `sh` is the
 *              canonical supply-chain anti-pattern.
 *
 * Why we don't elevate ourselves:
 *   - Windows: `winget` triggers UAC on its own when needed. We just
 *     spawn it and let Windows handle the elevation prompt.
 *   - macOS: `brew install ollama` does not need root. The `.dmg`
 *     fallback is a manual install — the user opens the installer.
 *   - Linux: the Ollama install script handles `sudo` internally where
 *     needed and asks the user.
 *
 * What this module does NOT do:
 *   - Background-service registration (Windows ollama tray, macOS launchd,
 *     systemd unit). The Windows `.exe` installer registers a startup
 *     service automatically; on macOS `brew services start ollama` is the
 *     explicit step. We surface both via `startDaemon()` but don't try to
 *     manage long-term service lifecycle — that's the OS package's job.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { ChildProcess } from 'node:child_process';

export interface BinaryInfo {
  installed: boolean;
  /** Absolute path to the `ollama` binary, when installed. */
  path?: string;
  /** First line of `ollama --version`, when reachable. */
  version?: string;
}

export type InstallMethod = 'winget' | 'brew' | 'curl-script' | 'manual' | 'none';

export interface InstallResult {
  ok: boolean;
  method: InstallMethod;
  /** Set when `ok === false`. Surfaces the underlying exit code or error. */
  error?: string;
  /** Set when `method === 'manual'` — the URL the user should open. */
  manualUrl?: string;
}

export interface StartDaemonResult {
  ok: boolean;
  pid?: number;
  /** How the daemon was started (or attempted). */
  via?: 'systemctl-user' | 'systemctl-system' | 'brew-services' | 'spawn-detached';
  error?: string;
}

interface InstallOptions {
  /** Skip confirmation prompts. Linux still requires explicit consent. */
  yes: boolean;
  log: (line: string) => void;
  prompt: (question: string) => Promise<boolean>;
  signal?: AbortSignal;
}

interface StartOptions {
  log: (line: string) => void;
}

/**
 * Detect whether `ollama` is on PATH and runnable. A binary that exists
 * on PATH but segfaults on `--version` is treated as not installed —
 * a partially-broken install is functionally identical to no install.
 */
export async function detectOllamaBinary(): Promise<BinaryInfo> {
  const path = await whichOllama();
  if (!path) return { installed: false };
  const version = await runVersion(path);
  if (!version) return { installed: false, path };
  return { installed: true, path, version };
}

async function whichOllama(): Promise<string | undefined> {
  const isWin = platform() === 'win32';
  const cmd = isWin ? 'where' : 'which';
  return await new Promise<string | undefined>((resolve) => {
    const child = spawn(cmd, ['ollama'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (code !== 0) return resolve(undefined);
      // `where` on Windows can return multiple lines (one per matched
      // PATH entry). Take the first.
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first);
    });
  });
}

async function runVersion(binPath: string): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    const child = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 3000);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(undefined);
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first);
    });
  });
}

/**
 * Install Ollama for the current OS. Each branch streams subprocess
 * output to `opts.log` so the user sees what's happening.
 *
 * The Linux branch requires explicit `y` even when `yes: true` was
 * passed at the orchestrator level — running a remote shell script as a
 * default-on action is too risky. The `confirm()` call here uses its
 * own prompt regardless of the global flag. (The orchestrator only
 * skips the *outer* "install Ollama?" confirmation when `yes` is set;
 * the inner curl-pipe-sh confirmation is non-bypassable.)
 */
export async function installOllama(opts: InstallOptions): Promise<InstallResult> {
  switch (platform()) {
    case 'win32':
      return await installWindows(opts);
    case 'darwin':
      return await installMacOS(opts);
    case 'linux':
      return await installLinux(opts);
    default:
      return {
        ok: false,
        method: 'manual',
        error: `unsupported platform: ${platform()}`,
        manualUrl: 'https://ollama.com/download'
      };
  }
}

async function installWindows(opts: InstallOptions): Promise<InstallResult> {
  // First check that winget itself is available. On Windows Server Core or
  // very old Windows 10 builds it isn't. Falling through to a manual URL
  // is better than spawning a process that immediately ENOENTs.
  const wingetOk = await new Promise<boolean>((resolve) => {
    const child = spawn('winget', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!wingetOk) {
    opts.log(`winget is not available — install Ollama manually: https://ollama.com/download/OllamaSetup.exe\n`);
    return {
      ok: false,
      method: 'manual',
      manualUrl: 'https://ollama.com/download/OllamaSetup.exe',
      error: 'winget not found'
    };
  }
  opts.log(`Running: winget install --id Ollama.Ollama (UAC will prompt if needed)\n`);
  const code = await runStreamed(
    'winget',
    [
      'install',
      '--id',
      'Ollama.Ollama',
      '--accept-source-agreements',
      '--accept-package-agreements',
      '--silent'
    ],
    opts.log,
    opts.signal
  );
  if (code !== 0) {
    return { ok: false, method: 'winget', error: `winget exited with code ${code}` };
  }
  return { ok: true, method: 'winget' };
}

async function installMacOS(opts: InstallOptions): Promise<InstallResult> {
  const brewOk = await new Promise<boolean>((resolve) => {
    const child = spawn('brew', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!brewOk) {
    opts.log(`Homebrew not found — install Ollama manually: https://ollama.com/download/Ollama-darwin.zip\n`);
    return {
      ok: false,
      method: 'manual',
      manualUrl: 'https://ollama.com/download/Ollama-darwin.zip',
      error: 'brew not found'
    };
  }
  opts.log(`Running: brew install ollama\n`);
  const code = await runStreamed('brew', ['install', 'ollama'], opts.log, opts.signal);
  if (code !== 0) {
    return { ok: false, method: 'brew', error: `brew exited with code ${code}` };
  }
  return { ok: true, method: 'brew' };
}

async function installLinux(opts: InstallOptions): Promise<InstallResult> {
  const curlOk = await new Promise<boolean>((resolve) => {
    const child = spawn('curl', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!curlOk) {
    opts.log(`curl not found — install curl first, or use the manual installer: https://ollama.com/install.sh\n`);
    return {
      ok: false,
      method: 'manual',
      manualUrl: 'https://ollama.com/install.sh',
      error: 'curl not found'
    };
  }
  // Linux install requires explicit consent regardless of --yes — see the
  // module-level docstring for the rationale.
  opts.log(
    `\nThe Linux install runs:\n` +
      `    curl -fsSL https://ollama.com/install.sh | sh\n` +
      `This pipes a remote script directly into your shell. Review it first if you're unsure:\n` +
      `    curl -fsSL https://ollama.com/install.sh | less\n`
  );
  const consent = await opts.prompt(`Run the install script now?`);
  if (!consent) {
    return { ok: false, method: 'curl-script', error: 'user declined curl|sh execution' };
  }
  const code = await runStreamed(
    'sh',
    ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
    opts.log,
    opts.signal
  );
  if (code !== 0) {
    return { ok: false, method: 'curl-script', error: `install script exited with code ${code}` };
  }
  return { ok: true, method: 'curl-script' };
}

/**
 * Start the Ollama daemon. Per-platform fallbacks:
 *   - Linux: `systemctl --user start ollama` → `systemctl start ollama` →
 *     detached `ollama serve`.
 *   - macOS: `brew services start ollama` → detached `ollama serve`.
 *   - Windows: detached `ollama serve` (the official installer registers
 *     the daemon as a startup service, so this is mainly for cases where
 *     the user installed via a portable zip).
 *
 * Detached spawn returns immediately with a pid; the caller is expected
 * to re-probe the daemon to confirm it's up.
 */
export async function startDaemon(opts: StartOptions): Promise<StartDaemonResult> {
  const plat = platform();
  if (plat === 'linux') {
    const userOk = await trySystemctl(['--user', 'start', 'ollama'], opts);
    if (userOk) return { ok: true, via: 'systemctl-user' };
    const sysOk = await trySystemctl(['start', 'ollama'], opts);
    if (sysOk) return { ok: true, via: 'systemctl-system' };
    return spawnDetached(opts);
  }
  if (plat === 'darwin') {
    const brewOk = await tryBrewServices(opts);
    if (brewOk) return { ok: true, via: 'brew-services' };
    return spawnDetached(opts);
  }
  // win32 + everything else: detached spawn.
  return spawnDetached(opts);
}

async function trySystemctl(args: string[], opts: StartOptions): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn('systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code === 0) {
        opts.log(`Started Ollama daemon via: systemctl ${args.join(' ')}\n`);
        return resolve(true);
      }
      // Quietly fall through — many Linux installs don't ship a unit file.
      if (stderr.trim()) opts.log(`systemctl ${args.join(' ')}: ${stderr.trim()}\n`);
      resolve(false);
    });
  });
}

async function tryBrewServices(opts: StartOptions): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn('brew', ['services', 'start', 'ollama'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code === 0) {
        opts.log(`Started Ollama via: brew services start ollama\n`);
        return resolve(true);
      }
      resolve(false);
    });
  });
}

function spawnDetached(opts: StartOptions): Promise<StartDaemonResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (cause) {
      return resolve({
        ok: false,
        via: 'spawn-detached',
        error: cause instanceof Error ? cause.message : String(cause)
      });
    }
    child.on('error', (err) => {
      resolve({ ok: false, via: 'spawn-detached', error: err.message });
    });
    child.unref();
    opts.log(`Spawned: ollama serve (pid ${child.pid})\n`);
    // Resolve eagerly — the orchestrator polls /api/tags to confirm the
    // daemon is up. If the spawn failed at exec time, the `error` event
    // above already resolved with `ok: false`.
    setImmediate(() => resolve({ ok: true, via: 'spawn-detached', pid: child.pid }));
  });
}

/**
 * Spawn `cmd args`, stream stdout+stderr to `log`, and resolve with the
 * exit code. SIGINT propagation: when `signal.aborted` fires we send
 * SIGTERM to the child so winget / brew / sh quit cleanly.
 */
function runStreamed(
  cmd: string,
  args: string[],
  log: (s: string) => void,
  signal?: AbortSignal
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => {
      child.kill('SIGTERM');
    };
    if (signal) signal.addEventListener('abort', onAbort);
    child.stdout.on('data', (d) => log(d.toString()));
    child.stderr.on('data', (d) => log(d.toString()));
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      log(`${cmd}: ${err.message}\n`);
      resolve(127);
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(code ?? 0);
    });
  });
}
