import type { DefinitionIssue, MetricDefinition } from './contracts';

/** Shared semantic requirements for storage, MCP and the interactive builder. */
export function metricAttributionIssues(definition: Pick<MetricDefinition, 'grain' | 'attribution' | 'journey'>): DefinitionIssue[] {
  const issue = (path: string, message: string): DefinitionIssue[] => [{ code: 'incompatible_attribution', path, message }];
  if (definition.attribution === 'assigned_agent_at_entry' && (definition.grain !== 'journey' || !definition.journey?.start)) {
    return issue('journey.start', 'Attribution at journey entry requires a journey measurement with a defined entry condition. Configure the journey, or choose Current assigned agent for a snapshot count.');
  }
  if (['event_actor', 'outcome_agent'].includes(definition.attribution ?? '') && !['event', 'journey'].includes(definition.grain)) {
    return issue('attribution', 'Event and outcome attribution require a recorded event or journey resolution. Choose a milestone or journey measurement, or use Current assigned agent.');
  }
  if (definition.attribution === 'executing_agent' && !['event', 'journey', 'run', 'runtime_execution'].includes(definition.grain)) {
    return issue('attribution', 'Executing-agent attribution requires recorded executions, events, or journeys. A current task snapshot only identifies its current assigned agent.');
  }
  return [];
}
