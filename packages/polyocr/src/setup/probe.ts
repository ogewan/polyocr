/**
 * Diagnose-only Ollama probe + URL utility.
 *
 * Wraps `OllamaTranslationAdapter.probe()` (which does the actual HTTP
 * work) so the setup module owns the user-facing diagnosis flow without
 * having to instantiate a full adapter at every call site.
 *
 * The local-URL check lives here because it's a setup-time concern only:
 * the runtime adapter is happy talking to any URL — only `polyocr setup`
 * cares whether installing/starting a daemon on this machine is the right
 * remediation. See the T3 trade-off note in the implementation plan.
 */

import { OllamaTranslationAdapter } from '../translate/ollama.js';
import type { OllamaProbeResult } from '../translate/ollama.js';

/**
 * Returns true when the URL points at the local machine (any loopback
 * address or `0.0.0.0`). `polyocr setup` refuses to attempt installation
 * for non-local URLs — there's nothing it can do remotely.
 */
export function isLocalOllamaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Strip IPv6 brackets (`[::1]` → `::1`).
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.')
  );
}

/**
 * Probe an Ollama daemon for the given URL + configured model. Always
 * resolves — never throws. The returned `OllamaProbeResult` distinguishes
 * `ready`, `daemon-down`, `daemon-error`, and `model-missing` so the setup
 * orchestrator can pick the right next step.
 */
export async function probeOllama(opts: {
  ollamaUrl: string;
  model: string;
}): Promise<OllamaProbeResult> {
  const adapter = new OllamaTranslationAdapter({
    ollamaUrl: opts.ollamaUrl,
    model: opts.model
  });
  return await adapter.probe();
}
