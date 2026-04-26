/**
 * Tiny readline wrapper. Centralizes the prompt UX so the CLI, the example
 * scripts, and any future Electron-shell consumer can share the same
 * y/N convention.
 *
 * Why output goes to stderr: `cli.ts` writes the formatted result (JSON,
 * CSV, etc.) to stdout when `--output` is omitted. Mixing prompts into
 * stdout would corrupt that pipe. `logProgress` in `cli.ts` follows the
 * same convention.
 *
 * Why no `inquirer`/`enquirer`: we don't pull a dep just to print a
 * question and read a line. The CLI is intentionally hand-rolled — see
 * the rationale in `cli.ts`.
 */

import { createInterface } from 'node:readline';

/**
 * Read one line of input. Returns the trimmed string.
 *
 * Throws when stdin isn't a TTY — callers should check `process.stdin.isTTY`
 * (or use the `--yes` flag) before prompting in non-interactive contexts.
 */
export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Cannot prompt: stdin is not a TTY. Pass --yes to skip confirmation, or run interactively.`
    );
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true
  });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

/**
 * Yes/no prompt. Accepts `y|yes|n|no` (case-insensitive). Empty answer
 * returns `defaultYes`. Anything else is treated as "no" without
 * re-prompting — keeps the UX predictable.
 *
 * The `[y/N]` / `[Y/n]` suffix is appended automatically based on
 * `defaultYes` so callers don't have to remember to match.
 */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${question} ${suffix} `)).toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}
