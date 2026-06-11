export type AtlasWidgetCommand =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'focus-input' }
  | { type: 'set-draft'; text: string; focus?: boolean }
  | { type: 'open-chat-with-draft'; text: string; focus?: boolean };

export interface AtlasWidgetState {
  open: boolean;
  connected: boolean;
  activeTab: 'chat';
  hasSessionKey: boolean;
}

export const ATLAS_WIDGET_COMMAND_EVENT = 'agent-hq:atlas-widget:command';
export const ATLAS_WIDGET_STATE_EVENT = 'agent-hq:atlas-widget:state-changed';

declare global {
  interface Window {
    __agentHqPendingAtlasWidgetCommand?: AtlasWidgetCommand | null;
  }
}

export function dispatchAtlasWidgetCommand(command: AtlasWidgetCommand) {
  if (typeof window === 'undefined') return;
  window.__agentHqPendingAtlasWidgetCommand = command;
  window.dispatchEvent(new CustomEvent(ATLAS_WIDGET_COMMAND_EVENT, { detail: command }));
}

export function consumePendingAtlasWidgetCommand(): AtlasWidgetCommand | null {
  if (typeof window === 'undefined') return null;
  const pending = window.__agentHqPendingAtlasWidgetCommand ?? null;
  window.__agentHqPendingAtlasWidgetCommand = null;
  return pending;
}

export function emitAtlasWidgetState(state: AtlasWidgetState) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ATLAS_WIDGET_STATE_EVENT, { detail: state }));
}
