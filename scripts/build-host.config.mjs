/** Linux Companion bundle with Harness runtime dependencies supplied by the profile. */
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

export default defineConfig({
  cwd: resolve('packages/remote/companion'), entry: ['lib/types/index.js'],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, clean: false, dts: false,
  deps: { neverBundle: [/^@deepseek-ai\//u] },
})
