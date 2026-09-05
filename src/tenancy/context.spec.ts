import { describe, expect, it } from 'vitest'
import type { Database } from '../db/client.js'
import {
  currentActor,
  currentDb,
  currentScope,
  currentTenant,
  MissingTenantContextError,
  runInTenantScope,
  type TenantScope,
  tryCurrentScope,
  withActor,
} from './context.js'
import type { TenantRecord } from './tenant.js'

function tenant(id: string): TenantRecord {
  return {
    id,
    name: id,
    databaseUrl: `postgres://localhost/${id}`,
    status: 'active',
    entitlements: [],
  }
}

function scope(id: string, marker: string): TenantScope {
  return {
    tenant: tenant(id),
    // The tests care only about which handle comes back, not about SQL.
    db: { marker } as unknown as Database,
    actor: null,
  }
}

describe('tenant scope', () => {
  it('refuses to hand out a database outside any tenant', () => {
    expect(() => currentDb()).toThrow(MissingTenantContextError)
    expect(() => currentScope()).toThrow(MissingTenantContextError)
    expect(tryCurrentScope()).toBeNull()
  })

  it('explains what to do in the error', () => {
    expect(() => currentDb()).toThrow(/runInTenantScope/)
  })

  it('gives each scope its own connection', async () => {
    const seen: string[] = []
    const capture = async (): Promise<void> => {
      seen.push((currentDb() as unknown as { marker: string }).marker)
    }

    await Promise.all([
      runInTenantScope(scope('alpha', 'db-alpha'), capture),
      runInTenantScope(scope('beta', 'db-beta'), capture),
    ])

    expect(seen.sort()).toEqual(['db-alpha', 'db-beta'])
  })

  it('keeps scopes apart across interleaved async work', async () => {
    const readAfterDelay = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return `${currentTenant().id}:${(currentDb() as unknown as { marker: string }).marker}`
    }

    const [a, b] = await Promise.all([
      runInTenantScope(scope('alpha', 'db-alpha'), readAfterDelay),
      runInTenantScope(scope('beta', 'db-beta'), readAfterDelay),
    ])

    expect(a).toBe('alpha:db-alpha')
    expect(b).toBe('beta:db-beta')
  })

  it('does not leak a scope after the call returns', async () => {
    await runInTenantScope(scope('alpha', 'db-alpha'), async () => {
      expect(currentTenant().id).toBe('alpha')
    })
    expect(tryCurrentScope()).toBeNull()
  })

  it('carries the actor and allows swapping it within the tenant', async () => {
    await runInTenantScope(
      { ...scope('alpha', 'db-alpha'), actor: { type: 'human', id: 'user-1' } },
      async () => {
        expect(currentActor()).toEqual({ type: 'human', id: 'user-1' })
        await withActor({ type: 'bot', id: 'bot-1', conversationId: 'c-9' }, async () => {
          expect(currentActor()?.type).toBe('bot')
          expect(currentTenant().id).toBe('alpha')
        })
        expect(currentActor()?.id).toBe('user-1')
      },
    )
  })

  it('propagates a nested scope only to its own subtree', async () => {
    await runInTenantScope(scope('alpha', 'db-alpha'), async () => {
      await runInTenantScope(scope('beta', 'db-beta'), async () => {
        expect(currentTenant().id).toBe('beta')
      })
      expect(currentTenant().id).toBe('alpha')
    })
  })
})
