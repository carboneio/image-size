import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['lib/**/*.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  // tsup strips the node: prefix by default, and from 8.4.0 it does so in the
  // ESM output too. Keeping it marks these imports as Node builtins, so a
  // bundler leaves them alone instead of reaching for a polyfill.
  removeNodeProtocol: false,
  outDir: 'dist',
  outExtension: ({ format }) => ({
    js: format === 'esm' ? '.mjs' : '.cjs'
  }),
})
