/**
 * Tailwind 3.x config for the polyocr-shell renderer.
 *
 * `content` globs cover everything that emits class names so JIT can prune
 * unused styles. The renderer is rooted at ./renderer (per vite.config.ts)
 * so we include all .tsx/.ts files under there.
 *
 * The custom palette extends slate / sky / emerald defaults with one
 * accent color (`brand`) used by the title bar and primary buttons.
 * Keeping it intentionally narrow — the shell's UI is utilitarian.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./renderer/index.html', './renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          400: '#3b82f6',
          500: '#2563eb',
          600: '#1d4ed8',
          700: '#1e40af'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace']
      }
    }
  },
  plugins: []
};
