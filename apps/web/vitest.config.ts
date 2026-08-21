import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The web app has almost nothing worth unit testing: its pages are server
 * components whose behaviour lives in the API, and the e2e suite drives the
 * real browser over the real stack. The exception is the generated images.
 *
 * Satori (what `next/og` renders with) refuses layouts at RUNTIME that
 * TypeScript and the build accept happily, and the failure is invisible in
 * every other check: the page still builds, the route still exists, and only
 * a request for the image itself produces the error. So these get a test that
 * actually renders them to bytes.
 */
export default defineConfig({
  /* Next's tsconfig sets jsx: preserve, because in the app the bundler is
   * what turns JSX into calls. Nothing runs after the transform here, so the
   * runner has to emit them itself. */
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  /* These modules are server components, and `server-only` is a package that
   * exists to throw for anything that is not one. It resolves to an empty
   * module under the `react-server` condition, which is how Next loads it and
   * how it has to be loaded here; tests run through Vite's SSR resolver, so
   * this is the knob that reaches them. */
  ssr: { resolve: { conditions: ['react-server', 'node', 'import', 'default'] } },
  test: { include: ['src/**/*.test.ts?(x)'], environment: 'node' },
});
