import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.spec.ts'], environment: 'node' } },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int-spec.ts'],
          environment: 'node',
          hookTimeout: 60_000,
          testTimeout: 60_000,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
})
