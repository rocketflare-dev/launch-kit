import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    // A Neon gate branch is a network away; give each test room.
    testTimeout: process.env.DATABASE_DRIVER === 'neon' ? 30_000 : 10_000,
    hookTimeout: 60_000,
  },
})
