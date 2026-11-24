import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['tests/setup-clock.ts'],
    // Tests never call the model provider, even when the shell has a key.
    env: { OPENAI_API_KEY: '' },
  },
})
