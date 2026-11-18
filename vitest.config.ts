import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Every suite runs without Docker: the database checks and the results table use the framework's
// real SQLite driver (`node:sqlite`), the HTTP tests boot a real Application in-process.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      testTimeout: 30_000,
      // The migration test replays the shipped migration in the framework's sandbox (a child
      // process); on a loaded machine that can take several seconds.
      hookTimeout: 60_000,
    },
  }),
)
