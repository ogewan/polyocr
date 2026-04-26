/**
 * Stream a model pull from Ollama's `/api/pull` endpoint.
 *
 * Ollama returns NDJSON — one JSON object per line — describing pull
 * progress. We stream the response, parse line-by-line (carrying any
 * partial trailing line forward across chunk boundaries), and render a
 * single overwriting stderr line via `\r` so the user sees a progress
 * indicator that updates in place.
 *
 * Why NDJSON parsing has to be line-buffered:
 *   The fetch reader yields arbitrary byte chunks. A naive
 *   `chunk.split('\n').forEach(JSON.parse)` will lose the trailing
 *   partial line at every chunk boundary that doesn't fall on `\n`. We
 *   keep a `buffer` string between iterations and only `JSON.parse`
 *   completed lines.
 *
 * Why we render on `\r` instead of clearing the line:
 *   ANSI clear-line escapes (`\x1b[2K`) work on most terminals but break
 *   on Windows cmd.exe in ConPTY-less contexts. `\r` + spaces (when the
 *   new line is shorter than the old) covers both. We emit a final `\n`
 *   on status-change so successive states don't overwrite each other.
 *
 * Resumability:
 *   Ollama keeps partial blobs on disk between attempts. A network drop
 *   or Ctrl-C mid-pull is recoverable — re-running `polyocr setup` picks
 *   up from where it stopped. Surfacing this in the cancellation message
 *   sets the right expectation.
 */

/**
 * One progress event from `/api/pull`. Fields are populated incrementally
 * — early events have just `status`, byte-counted events add `total` /
 * `completed` / `digest`. We compute `percent` for convenience.
 */
export interface PullProgress {
  /** e.g. `"pulling manifest"`, `"downloading"`, `"verifying sha256"`, `"writing manifest"`, `"success"`. */
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  /** Derived: `completed / total * 100`, rounded to one decimal. Undefined when `total` is missing. */
  percent?: number;
}

interface PullModelOptions {
  ollamaUrl: string;
  model: string;
  /**
   * Where to render the human-readable progress line. Default
   * `process.stderr.write`. Pluggable so the Electron shell can route
   * progress into a UI.
   */
  log?: (line: string) => void;
  /**
   * Per-event callback. Use this when you need structured progress data
   * (for a Renderer-side progress bar, telemetry, etc.).
   */
  onProgress?: (event: PullProgress) => void;
  /**
   * Cancel the in-flight pull. Wired to SIGINT in the CLI. Ollama's
   * partial blobs are kept on disk, so a cancelled pull resumes on retry.
   */
  signal?: AbortSignal;
}

interface PullResult {
  ok: boolean;
  /** Final status reported by Ollama (`"success"` on success). */
  finalStatus?: string;
  /** Set when `ok === false`. */
  error?: string;
}

/**
 * Pull a model. Resolves only after the pull completes successfully
 * (status === `"success"`), the network drops, or the caller aborts.
 *
 * Errors that come back from the Ollama registry (e.g. typos in model
 * names — `{"error":"pull model manifest: file does not exist"}`) are
 * surfaced verbatim in `result.error`.
 */
export async function pullModel(opts: PullModelOptions): Promise<PullResult> {
  const log = opts.log ?? ((s: string) => process.stderr.write(s));
  const tag = `[ollama pull ${opts.model}]`;

  let res: Response;
  try {
    res = await fetch(`${opts.ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: opts.model, stream: true }),
      signal: opts.signal
    });
  } catch (cause) {
    // Network unreachable, daemon refused, or aborted before the request
    // headers were sent.
    const msg = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `failed to reach ${opts.ollamaUrl}/api/pull: ${msg}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `${tag} ${res.status} ${res.statusText}${body ? ': ' + body : ''}` };
  }
  if (!res.body) {
    return { ok: false, error: `${tag} response has no body stream` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastStatus: string | null = null;
  let finalStatus = '';
  let lastRenderedLine = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // NDJSON line-buffer: split on `\n`, keep the trailing partial line
      // (if any) in `buffer` for the next iteration. Skip empty lines —
      // some Ollama versions emit a trailing newline.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: PullProgress;
        try {
          event = parseEvent(line);
        } catch {
          // Malformed line — log and skip rather than fail the pull.
          log(`\n${tag} warning: skipping unparseable progress line\n`);
          continue;
        }
        opts.onProgress?.(event);
        if (event.status !== lastStatus) {
          // Status transition: terminate the previous overwriting line.
          if (lastStatus !== null) log('\n');
          lastStatus = event.status;
          finalStatus = event.status;
        }
        const rendered = renderLine(tag, event);
        if (rendered !== lastRenderedLine) {
          // Pad the new line with spaces if it's shorter than the previous
          // one so leftover chars from the longer line are erased.
          const pad =
            rendered.length < lastRenderedLine.length
              ? ' '.repeat(lastRenderedLine.length - rendered.length)
              : '';
          log(`\r${rendered}${pad}`);
          lastRenderedLine = rendered;
        }
      }
    }
    // Flush any trailing partial line — usually empty after a successful
    // stream, but a malformed last line shouldn't crash us.
    if (buffer.trim()) {
      try {
        const event = parseEvent(buffer);
        opts.onProgress?.(event);
        finalStatus = event.status;
      } catch {
        /* ignore */
      }
    }
    log('\n');
  } catch (cause) {
    // Either the network dropped mid-stream or the caller aborted. In
    // both cases Ollama keeps the partial blobs, so we tell the user a
    // retry will resume.
    if ((cause as { name?: string })?.name === 'AbortError') {
      log(`\n${tag} cancelled (resume by re-running setup)\n`);
      return { ok: false, error: 'pull cancelled' };
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: `network error during pull (resume by re-running setup): ${msg}`
    };
  }

  if (finalStatus !== 'success') {
    return { ok: false, finalStatus, error: `pull ended in status "${finalStatus}"` };
  }
  return { ok: true, finalStatus };
}

function parseEvent(line: string): PullProgress {
  const obj = JSON.parse(line) as {
    status?: string;
    digest?: string;
    total?: number;
    completed?: number;
    error?: string;
  };
  if (obj.error) {
    // Registry-side error (e.g. unknown model name). We treat this as a
    // status transition so the renderer line shows the failure message
    // before pullModel returns.
    return { status: `error: ${obj.error}` };
  }
  const status = obj.status ?? 'unknown';
  const total = obj.total;
  const completed = obj.completed;
  const percent =
    typeof total === 'number' && total > 0 && typeof completed === 'number'
      ? Math.round((completed / total) * 1000) / 10
      : undefined;
  const out: PullProgress = { status };
  if (obj.digest) out.digest = obj.digest;
  if (typeof total === 'number') out.total = total;
  if (typeof completed === 'number') out.completed = completed;
  if (percent !== undefined) out.percent = percent;
  return out;
}

function renderLine(tag: string, event: PullProgress): string {
  if (event.percent !== undefined && event.total !== undefined && event.completed !== undefined) {
    return `${tag} ${event.status} ${event.percent.toFixed(1)}% (${formatBytes(event.completed)}/${formatBytes(event.total)})`;
  }
  return `${tag} ${event.status}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
