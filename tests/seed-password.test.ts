import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveSeedPassword } from '../src/auth.js'

const builtIn = 'Accs@Qcu2026!'

describe('seed password', () => {
  it('uses SEED_PASSWORD whenever it is set', () => {
    for (const nodeEnv of ['development', 'test', 'production'])
      for (const onLambda of [false, true]) expect(resolveSeedPassword({ seedPassword: 'Stack#Seed-2026', nodeEnv, onLambda })).toBe('Stack#Seed-2026')
  })

  it('uses the built-in password only for local runs and tests', () => {
    expect(resolveSeedPassword({ nodeEnv: 'development', onLambda: false })).toBe(builtIn)
    expect(resolveSeedPassword({ nodeEnv: 'test', onLambda: false })).toBe(builtIn)
  })

  it('disables seeded sign-in in production without SEED_PASSWORD, on Lambda or not', () => {
    for (const onLambda of [false, true]) {
      const password = resolveSeedPassword({ nodeEnv: 'production', onLambda })
      expect(password).not.toBe(builtIn)
      expect(password).toHaveLength(43)
      expect(resolveSeedPassword({ nodeEnv: 'production', onLambda })).not.toBe(password)
    }
  })

  it('fails on Lambda when NODE_ENV is not production and SEED_PASSWORD is missing', () => {
    for (const nodeEnv of ['development', 'test']) expect(() => resolveSeedPassword({ nodeEnv, onLambda: true })).toThrow(/SEED_PASSWORD is not set/)
  })

  describe('at startup', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
      vi.resetModules()
    })

    // A misconfigured stack: Lambda without NODE_ENV (so it defaults to development) and without SEED_PASSWORD.
    it('refuses to load the app instead of accepting the built-in password', async () => {
      vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'accs-dev-api')
      vi.stubEnv('NODE_ENV', undefined)
      vi.stubEnv('SEED_PASSWORD', undefined)
      vi.resetModules()
      await expect(import('../src/lambda.js')).rejects.toThrow(/SEED_PASSWORD is not set and NODE_ENV is "development" on Lambda/)
    })

    it('still loads on Lambda in production without SEED_PASSWORD, with seeded sign-in disabled', async () => {
      vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'accs-prod-api')
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('SEED_PASSWORD', undefined)
      vi.stubEnv('TABLE_PREFIX', 'accs-prod-')
      vi.resetModules()
      const auth = await import('../src/auth.js')
      expect(auth.defaultPassword).not.toBe(builtIn)
    })
  })
})
