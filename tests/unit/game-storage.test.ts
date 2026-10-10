import { afterEach, describe, expect, it } from 'vitest'
import { keyedStorage, safeStorage } from '@/game/personal-best'
import { safeLocalStorage } from '@/game/storage'

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('safeLocalStorage (BE-1: the one accessor the editor and personal-best share)', () => {
  it('is null where there is no localStorage at all (node)', () => {
    Reflect.deleteProperty(globalThis, 'localStorage')
    expect(safeLocalStorage()).toBeNull()
  })

  it('is null where the ACCESS throws, not only where getItem would', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    expect(safeLocalStorage()).toBeNull()
    expect(safeStorage()).toBeNull()
    expect(keyedStorage()).toBeNull()
  })

  it('hands back the same object to every narrowed view', () => {
    const store = new Map<string, string>()
    const fake = {
      length: 0,
      key: () => null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    } satisfies Storage
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake })
    expect(safeLocalStorage()).toBe(fake)
    expect(safeStorage()).toBe(fake)
    expect(keyedStorage()).toBe(fake)
  })
})
