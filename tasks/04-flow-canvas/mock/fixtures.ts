// Flow model and fixture data for the agent flow canvas task. Self-contained (no imports).

export type NodeType = 'trigger' | 'message' | 'question' | 'condition' | 'action' | 'end'

export interface Position {
  x: number
  y: number
}

interface NodeBase {
  id: string
  type: NodeType
  /** Shown on the node and used in its accessible name. */
  title: string
  /** Top-left corner in flow coordinates (px at 100% zoom). */
  position: Position
}

export interface TriggerNode extends NodeBase {
  type: 'trigger'
  /** Phrases that start the conversation. */
  phrases: string[]
}
export interface MessageNode extends NodeBase {
  type: 'message'
  text: string
}
export type AnswerType = 'text' | 'number' | 'boolean'
export interface QuestionNode extends NodeBase {
  type: 'question'
  prompt: string
  /** Variable that stores the answer. Must be a valid identifier: /^[A-Za-z_][A-Za-z0-9_]*$/ */
  variable: string
  answerType: AnswerType
}
export interface ConditionBranch {
  id: string
  label: string
  expression: string
}
export interface ConditionNode extends NodeBase {
  type: 'condition'
  /** At least one branch. Each branch is an output port (port id = branch id), plus the "else" port. */
  branches: ConditionBranch[]
}
export interface ActionNode extends NodeBase {
  type: 'action'
  /** One of the ids from listTools(). */
  toolId: string
  input: string
}
export interface EndNode extends NodeBase {
  type: 'end'
}

export type FlowNode = TriggerNode | MessageNode | QuestionNode | ConditionNode | ActionNode | EndNode

export interface FlowEdge {
  id: string
  /** Source node id. */
  source: string
  /** Output port id on the source node (see outputPorts). */
  sourcePort: string
  /** Target node id. Edges always end at the target's single input port. */
  target: string
}

export interface FlowDocument {
  id: string
  name: string
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface Tool {
  id: string
  name: string
}

export interface PortInfo {
  id: string
  label: string
}

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  trigger: 'Trigger',
  message: 'Message',
  question: 'Question',
  condition: 'Condition',
  action: 'Action',
  end: 'End',
}

/** Output ports of a node, in display order. */
export function outputPorts(node: FlowNode): PortInfo[] {
  switch (node.type) {
    case 'trigger':
    case 'message':
    case 'question':
      return [{ id: 'next', label: 'Next' }]
    case 'condition':
      return [...node.branches.map((b) => ({ id: b.id, label: b.label })), { id: 'else', label: 'Else' }]
    case 'action':
      return [
        { id: 'success', label: 'Success' },
        { id: 'failure', label: 'Failure' },
      ]
    case 'end':
      return []
  }
}

/** Every node except the trigger has exactly one input port. */
export function hasInput(node: FlowNode): boolean {
  return node.type !== 'trigger'
}

/**
 * Connection rules: the source port must be an output port of the source node, the target must have
 * an input, and a node can't connect to itself. An output port holds at most one edge (connecting an
 * already-connected output replaces its edge). An input port may receive any number of edges.
 */
export function canConnect(doc: FlowDocument, source: string, sourcePort: string, target: string): boolean {
  const s = doc.nodes.find((n) => n.id === source)
  const t = doc.nodes.find((n) => n.id === target)
  if (!s || !t || s.id === t.id) return false
  if (!hasInput(t)) return false
  return outputPorts(s).some((p) => p.id === sourcePort)
}

export const TOOLS: Tool[] = [
  { id: 'lookupOrder', name: 'Look up order' },
  { id: 'createTicket', name: 'Create support ticket' },
  { id: 'sendEmail', name: 'Send email' },
  { id: 'checkInventory', name: 'Check inventory' },
]

/** Grid size for snapping, in flow px. */
export const GRID_SIZE = 20

export const INITIAL_FLOW: FlowDocument = {
  id: 'order-status',
  name: 'Order status',
  nodes: [
    { id: 'n-start', type: 'trigger', title: 'Start', position: { x: 40, y: 220 }, phrases: ['Where is my order', 'Track my package', 'Order status'] },
    { id: 'n-greet', type: 'message', title: 'Greeting', position: { x: 340, y: 220 }, text: 'Hi! I can help you track your order.' },
    { id: 'n-ask', type: 'question', title: 'Ask order number', position: { x: 640, y: 220 }, prompt: "What's your order number?", variable: 'orderNumber', answerType: 'text' },
    { id: 'n-lookup', type: 'action', title: 'Look up order', position: { x: 940, y: 220 }, toolId: 'lookupOrder', input: '{orderNumber}' },
    {
      id: 'n-check',
      type: 'condition',
      title: 'Check status',
      position: { x: 1240, y: 120 },
      branches: [
        { id: 'b-shipped', label: 'Shipped', expression: 'order.status == "shipped"' },
        { id: 'b-processing', label: 'Processing', expression: 'order.status == "processing"' },
      ],
    },
    { id: 'n-shipped', type: 'message', title: 'Shipped reply', position: { x: 1560, y: 20 }, text: 'Your order is on its way.' },
    { id: 'n-processing', type: 'message', title: 'Processing reply', position: { x: 1560, y: 220 }, text: 'Your order is being prepared.' },
    { id: 'n-other', type: 'message', title: 'Other reply', position: { x: 1560, y: 420 }, text: "I'll connect you with an agent." },
    { id: 'n-notfound', type: 'message', title: 'Not found', position: { x: 1240, y: 460 }, text: "I couldn't find that order." },
    { id: 'n-end', type: 'end', title: 'End', position: { x: 1880, y: 240 } },
  ],
  edges: [
    { id: 'e1', source: 'n-start', sourcePort: 'next', target: 'n-greet' },
    { id: 'e2', source: 'n-greet', sourcePort: 'next', target: 'n-ask' },
    { id: 'e3', source: 'n-ask', sourcePort: 'next', target: 'n-lookup' },
    { id: 'e4', source: 'n-lookup', sourcePort: 'success', target: 'n-check' },
    { id: 'e5', source: 'n-lookup', sourcePort: 'failure', target: 'n-notfound' },
    { id: 'e6', source: 'n-check', sourcePort: 'b-shipped', target: 'n-shipped' },
    { id: 'e7', source: 'n-check', sourcePort: 'b-processing', target: 'n-processing' },
    { id: 'e8', source: 'n-check', sourcePort: 'else', target: 'n-other' },
    { id: 'e9', source: 'n-shipped', sourcePort: 'next', target: 'n-end' },
    { id: 'e10', source: 'n-processing', sourcePort: 'next', target: 'n-end' },
    { id: 'e11', source: 'n-other', sourcePort: 'next', target: 'n-end' },
    { id: 'e12', source: 'n-notfound', sourcePort: 'next', target: 'n-end' },
  ],
}

export type RunEvent =
  | { type: 'started'; runId: string }
  | { type: 'step'; nodeId: string; status: 'running' | 'done' | 'failed'; message?: string }
  | { type: 'finished'; outcome: 'completed' | 'failed' | 'stopped'; message?: string }
