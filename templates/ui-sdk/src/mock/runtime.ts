/**
 * Mock runtime shared by every task's mock API. Do not edit: the hidden evaluation relies on it.
 *
 * Every mock API function goes through `mockCall`, which:
 *  - waits a simulated latency (abortable with an AbortSignal),
 *  - can be forced to fail through URL parameters,
 *  - records each call in `window.__mock.calls`,
 *  - returns a deep copy, so callers can never mutate the mock's internal data by accident.
 *
 * URL parameters (all optional):
 *  - `mock-fail=opA,opB`       every call to these operations rejects with MockApiError (`all` = every op)
 *  - `mock-fail-once=opA,opB`  the first call to each operation rejects, later calls succeed
 *  - `mock-latency=300`        latency in ms for every operation
 *  - `mock-latency=opA:3000,opB:0`  per-operation latency (others keep their default)
 */

export class MockApiError extends Error {
  readonly op: string
  constructor(op: string, message = `Mock API call "${op}" failed`) {
    super(message)
    this.name = 'MockApiError'
    this.op = op
  }
}

export interface MockCallRecord {
  op: string
  args: unknown[]
  startedAt: number
  endedAt?: number
  outcome?: 'ok' | 'error' | 'aborted'
}

interface MockConfig {
  fail: Set<string>
  failOnce: Set<string>
  latencyAll?: number
  latencyByOp: Map<string, number>
}

declare global {
  interface Window {
    __mock?: { calls: MockCallRecord[] }
  }
}

function readConfig(): MockConfig {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const list = (name: string) =>
    new Set(
      (params.get(name) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  const config: MockConfig = { fail: list('mock-fail'), failOnce: list('mock-fail-once'), latencyByOp: new Map() }
  for (const part of (params.get('mock-latency') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b] = part.split(':')
    if (b === undefined && !Number.isNaN(Number(a))) config.latencyAll = Number(a)
    else if (b !== undefined && !Number.isNaN(Number(b))) config.latencyByOp.set(a, Number(b))
  }
  return config
}

const config = readConfig()
const failedOnce = new Set<string>()
const calls: MockCallRecord[] = []
if (typeof window !== 'undefined') window.__mock = { calls }

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

export function latencyFor(op: string, defaultMs: number): number {
  return config.latencyByOp.get(op) ?? config.latencyAll ?? defaultMs
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function shouldFail(op: string): boolean {
  if (config.fail.has(op) || config.fail.has('all')) return true
  if (config.failOnce.has(op) && !failedOnce.has(op)) {
    failedOnce.add(op)
    return true
  }
  return false
}

export async function mockCall<T>(
  op: string,
  args: unknown[],
  defaultLatencyMs: number,
  run: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const record: MockCallRecord = { op, args: clone(args), startedAt: Date.now() }
  calls.push(record)
  try {
    await sleep(latencyFor(op, defaultLatencyMs), signal)
    if (shouldFail(op)) throw new MockApiError(op)
    const result = clone(await run())
    record.outcome = 'ok'
    return result
  } catch (error) {
    record.outcome = error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'error'
    throw error
  } finally {
    record.endedAt = Date.now()
  }
}

/** True when the operation is configured to fail on its next call. For mock modules only. */
export function isForcedFailure(op: string): boolean {
  return shouldFail(op)
}

/** Small deterministic PRNG (mulberry32) for fixture generation. */
export function createRng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  }
}
