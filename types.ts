// =============================================================================
// Type definitions for the Pocket Universe plugin
// =============================================================================

// ============================================================================
// Internal Types
// ============================================================================

export interface Message {
  id: string; // Internal ID (random string)
  msgIndex: number; // Numeric index for display (1-based, per session)
  from: string;
  to: string;
  body: string;
  timestamp: number;
  handled: boolean;
}

// DORMANT: parent alias feature
export interface CachedParentId {
  value: string | null;
  cachedAt: number;
}

/** Minimal interface for OpenCode SDK client session API */
export interface OpenCodeSessionClient {
  session: {
    get: (params: {
      path: { id: string };
    }) => Promise<{ data?: { parentID?: string } }>;
    create: (params: {
      body?: { parentID?: string; title?: string };
    }) => Promise<{ data?: { id: string } }>;
    messages: (params: { path: { id: string } }) => Promise<{
      data?: Array<{
        info: { id: string; role: string; sessionID: string };
        parts?: unknown[];
      }>;
    }>;
    prompt: (params: {
      path: { id: string };
      body: {
        parts: Array<{ type: string; text?: string }>;
        agent?: string;
        model?: { modelID?: string; providerID?: string };
      };
    }) => Promise<{ data?: unknown; error?: unknown }>;
    promptAsync: (params: {
      path: { id: string };
      body: {
        parts: Array<{ type: string; text?: string }>;
        agent?: string;
        model?: { modelID?: string; providerID?: string };
      };
    }) => Promise<{ data?: unknown }>;
  };
  part: {
    update: (params: {
      path: { sessionID: string; messageID: string; partID: string };
      body: {
        id: string;
        sessionID: string;
        messageID: string;
        type: string;
        prompt?: string;
        description?: string;
        agent?: string;
      };
    }) => Promise<{ data?: unknown; error?: unknown }>;
  };
}

/** Internal client interface (accessed via type assertion) */
export interface InternalClient {
  post?: (params: { url: string; body: unknown }) => Promise<unknown>;
  patch?: (params: { url: string; body: unknown }) => Promise<unknown>;
}

/** Message info from OpenCode SDK */
export interface MessageInfo {
  id: string;
  sessionID: string;
  role: string;
  agent?: string;
  model?: {
    modelID?: string;
    providerID?: string;
  };
  variant?: unknown;
}

/** User message structure from OpenCode SDK */
export interface UserMessage {
  info: MessageInfo;
  parts: unknown[];
}

/** Tool execution context */
export interface ToolContext {
  sessionID: string;
}

/** Hook input for tool.execute.after */
export interface ToolExecuteInput {
  tool: string;
  sessionID: string;
}

/** Hook output for tool.execute.after */
export interface ToolExecuteOutput {
  metadata?: {
    sessionId?: string;
    session_id?: string;
  };
  output?: string;
}

/** Hook input for system.transform */
export interface SystemTransformInput {
  sessionID?: string;
}

/** Hook output for system.transform */
export interface SystemTransformOutput {
  system: string[];
}

/** Hook output for messages.transform */
export interface MessagesTransformOutput {
  messages: UserMessage[];
}

/** Hook output for config.transform */
export interface ConfigTransformOutput {
  experimental?: {
    subagent_tools?: string[];
    [key: string]: unknown;
  };
}

// ============================================================================
// Session State Tracking
// ============================================================================

export interface SessionState {
  sessionId: string;
  alias: string;
  status: "active" | "idle";
  lastActivity: number;
}

// Track spawned sessions that need to be injected into parent's message history
export interface SpawnInfo {
  sessionId: string;
  alias: string;
  description: string;
  prompt: string;
  timestamp: number;
  injected: boolean;
  // For updating the task part when spawn completes
  partId?: string;
  parentMessageId?: string;
  parentSessionId?: string;
}

// ============================================================================
// Assistant Message Structure (for synthetic injection)
// ============================================================================

export interface AssistantMessage {
  info: {
    id: string;
    sessionID: string;
    role: string;
    agent: string;
    parentID: string;
    modelID: string;
    providerID: string;
    mode: string;
    path: { cwd: string; root: string };
    time: { created: number; completed: number };
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    variant?: unknown;
  };
  parts: Array<{
    id: string;
    sessionID: string;
    messageID: string;
    type: string;
    callID: string;
    tool: string;
    state: {
      status: string;
      input: Record<string, unknown>;
      output: string;
      title: string;
      metadata: Record<string, unknown>;
      time: { start: number; end: number };
    };
  }>;
}
