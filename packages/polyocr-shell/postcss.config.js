/**
 * PostCSS pipeline for the renderer build.
 *
 * Just two plugins:
 *   - tailwindcss: expands @tailwind directives + processes class utilities.
 *   - autoprefixer: adds vendor prefixes. Electron 33 ships Chromium 130,
 *     so most modern CSS works without prefixes — but autoprefixer also
 *     covers e.g. `-webkit-app-region` for the title bar drag region.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
};
