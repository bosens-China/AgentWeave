import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22.13',
  fixedExtension: true,
  clean: ['dist/cli.mjs'],
  dts: false,
})
