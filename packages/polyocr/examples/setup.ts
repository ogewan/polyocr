/**
 * Example: drive the `polyocr setup` flow programmatically.
 *
 * Run with:
 *   npx tsx examples/setup.ts <scenario>
 *
 * Scenarios (each exercises one branch of the orchestrator so the
 * implementer can verify behavior without requiring every condition to
 * happen organically):
 *
 *   check       — diagnose-only probe of localhost:11434 with aya:8b.
 *                 Exit 0 if ready, exit 3 with a remediation hint
 *                 otherwise. Safe to run on any system; never installs.
 *
 *   bad-port    — diagnose-only probe of a port nothing's running on.
 *                 Should always report `daemon-down` and exit 3.
 *
 *   remote      — attempt to set up against a non-loopback URL. Should
 *                 always exit 2 with "remote ollama; refusing to install"
 *                 — no network call is made, no install is attempted.
 *
 *   small-pull  — confirm + pull `qwen2.5:0.5b` (~400 MB) so the
 *                 streaming progress code is exercised end-to-end without
 *                 burning bandwidth on aya:8b. Requires Ollama already
 *                 installed and running.
 *
 *   bad-model   — request a model that doesn't exist in the Ollama
 *                 registry (`definitely-not-a-real-model:0.1`). Should
 *                 reach the pull stage, fail with the registry's
 *                 "manifest not found" error, and exit 3.
 *
 *   list        — print the built-in profile registry. No network call.
 */

import { runSetup, formatProfileList } from '../src/setup/index.js';

const scenario = process.argv[2] ?? 'check';

switch (scenario) {
  case 'check': {
    const result = await runSetup({ checkOnly: true });
    console.error(`status=${result.status} exitCode=${result.exitCode}`);
    console.error(result.message);
    process.exit(result.exitCode);
  }
  case 'bad-port': {
    const result = await runSetup({
      ollamaUrl: 'http://localhost:9999',
      checkOnly: true
    });
    console.error(`status=${result.status} exitCode=${result.exitCode}`);
    console.error(result.message);
    process.exit(result.exitCode);
  }
  case 'remote': {
    const result = await runSetup({
      ollamaUrl: 'http://192.168.1.50:11434'
    });
    console.error(`status=${result.status} exitCode=${result.exitCode}`);
    console.error(result.message);
    process.exit(result.exitCode);
  }
  case 'small-pull': {
    const result = await runSetup({
      model: 'qwen2.5:0.5b',
      yes: true
    });
    console.error(`status=${result.status} exitCode=${result.exitCode}`);
    console.error(result.message);
    process.exit(result.exitCode);
  }
  case 'bad-model': {
    const result = await runSetup({
      model: 'definitely-not-a-real-model:0.1',
      yes: true
    });
    console.error(`status=${result.status} exitCode=${result.exitCode}`);
    console.error(result.message);
    process.exit(result.exitCode);
  }
  case 'list': {
    process.stdout.write(formatProfileList());
    process.exit(0);
  }
  default: {
    console.error(`Unknown scenario: ${scenario}`);
    console.error('Available: check, bad-port, remote, small-pull, bad-model, list');
    process.exit(2);
  }
}
