/**
 * Agent-to-agent module entry point.
 *
 * Registers delivery actions for create_agent and fan_out. The A2A
 * routing path is NOT a system action — core `delivery.ts` dispatches into
 * `agent-route.ts` directly via a `channel_type === 'agent'` branch.
 *
 * Two paths out of delivery.ts for agent traffic:
 *   - `channel_type === 'agent'` messages → routeAgentMessage() in agent-route.ts
 *   - `kind === 'system'` + `action === 'create_agent'` → handleCreateAgent()
 *   - `kind === 'system'` + `action === 'fan_out'` → handleFanOut()
 *
 * The module-not-installed guard: delivery.ts checks `hasTable('agent_destinations')`
 * before the `channel_type='agent'` branch. If that table is absent it throws,
 * system action logs "Unknown system action", `channel_type='agent'` messages
 * get a "module not installed" error → normal retry → mark failed path.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleCreateAgent } from './create-agent.js';
import { handleFanOut } from './fan-out.js';
import { handleRunTask } from './run-task.js';

registerDeliveryAction('create_agent', handleCreateAgent);
registerDeliveryAction('fan_out', handleFanOut);
registerDeliveryAction('run_task', handleRunTask);
