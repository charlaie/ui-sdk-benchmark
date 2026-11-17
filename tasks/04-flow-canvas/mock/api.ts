// Mock API for the agent flow canvas task. Simulated latency; failures can be forced with URL
// parameters (see ./runtime.ts), e.g. `?mock-fail=saveFlow`, `?mock-fail-once=saveFlow`,
// `?mock-fail=runAction` (Action steps take their Failure branch during a test run).
import { isForcedFailure, mockCall, sleep } from './runtime'
import { INITIAL_FLOW, TOOLS, canConnect, outputPorts, type FlowDocument, type FlowEdge, type FlowNode, type RunEvent, type Tool } from './fixtures'

export * from './fixtures'
export { MockApiError } from './runtime'

let saved: FlowDocument = structuredClone(INITIAL_FLOW)
let version = 1

/** Load a flow. Default latency 600 ms. */
export function loadFlow(id = 'order-status'): Promise<FlowDocument> {
  return mockCall('loadFlow', [id], 600, () => {
    if (id !== saved.id) throw new Error(`No flow ${id}`)
    return saved
  })
}

/** Save the whole flow document. Rejects documents that break the model's rules. Default latency 700 ms. */
export function saveFlow(doc: FlowDocument): Promise<{ version: number; savedAt: string }> {
  return mockCall('saveFlow', [doc], 700, () => {
    const ids = new Set(doc.nodes.map((n) => n.id))
    if (ids.size !== doc.nodes.length) throw new Error('Duplicate node id')
    if (doc.nodes.filter((n) => n.type === 'trigger').length !== 1) throw new Error('A flow needs exactly one trigger')
    const usedPorts = new Set<string>()
    for (const e of doc.edges) {
      if (!canConnect(doc, e.source, e.sourcePort, e.target)) throw new Error(`Invalid edge ${e.id}`)
      const key = `${e.source}:${e.sourcePort}`
      if (usedPorts.has(key)) throw new Error(`Output ${key} has more than one edge`)
      usedPorts.add(key)
    }
    saved = structuredClone(doc)
    version += 1
    return { version, savedAt: new Date().toISOString() }
  })
}

/** Tools an Action node can call. Default latency 200 ms. */
export function listTools(): Promise<Tool[]> {
  return mockCall('listTools', [], 200, () => TOOLS)
}

/**
 * Placeholder for executing the flow: nothing is really run. Walks the graph from the trigger and
 * reports each step through `onEvent`, one step about every 600 ms: Condition nodes take their first
 * connected branch (else "else"), Action nodes take "success" (or "failure" with ?mock-fail=runAction),
 * and the run fails at a non-End node with no outgoing edge. Abort the signal to stop the run.
 */
export async function startTestRun(
  doc: FlowDocument,
  onEvent: (event: RunEvent) => void,
  options: { signal?: AbortSignal; stepMs?: number } = {},
): Promise<{ outcome: 'completed' | 'failed' | 'stopped' }> {
  const stepMs = options.stepMs ?? 600
  const flow: FlowDocument = structuredClone(doc)
  await mockCall('startTestRun', [flow.id], 200, () => undefined)
  const emit = (e: RunEvent) => onEvent(structuredClone(e))
  emit({ type: 'started', runId: `run-${Date.now()}` })
  let node: FlowNode | undefined = flow.nodes.find((n) => n.type === 'trigger')
  try {
    for (let steps = 0; node && steps < 50; steps++) {
      emit({ type: 'step', nodeId: node.id, status: 'running' })
      await sleep(stepMs, options.signal)
      let port = 'next'
      let failed = false
      if (node.type === 'condition') {
        const current = node
        const branch = current.branches.find((b) => flow.edges.some((e) => e.source === current.id && e.sourcePort === b.id))
        port = branch?.id ?? 'else'
      } else if (node.type === 'action') {
        failed = isForcedFailure('runAction')
        port = failed ? 'failure' : 'success'
      }
      emit({ type: 'step', nodeId: node.id, status: failed ? 'failed' : 'done' })
      if (node.type === 'end') {
        emit({ type: 'finished', outcome: 'completed' })
        return { outcome: 'completed' }
      }
      const from: FlowNode = node
      const edge: FlowEdge | undefined = flow.edges.find((e) => e.source === from.id && e.sourcePort === port && outputPorts(from).some((p) => p.id === port))
      if (!edge) {
        const message = `"${node.title}" has no next step`
        emit({ type: 'finished', outcome: 'failed', message })
        return { outcome: 'failed' }
      }
      node = flow.nodes.find((n) => n.id === edge.target)
    }
    emit({ type: 'finished', outcome: 'failed', message: 'The run did not reach an End step' })
    return { outcome: 'failed' }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      emit({ type: 'finished', outcome: 'stopped' })
      return { outcome: 'stopped' }
    }
    throw error
  }
}
