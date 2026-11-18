import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    provider: 'src/provider.ts',
    commands: 'src/commands.ts',
    installer: 'src/installer.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  // The framework is a peer: an app has exactly one copy (container tokens rely on it).
  deps: { neverBundle: [/^@strutvane\//] },
})
