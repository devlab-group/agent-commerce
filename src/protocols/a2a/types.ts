/**
 * A2A v1 wire shapes, hand-written and confined to this directory.
 *
 * Deliberately not imported from `@a2a-js/sdk`: the SDK is a test-only
 * dependency (conformance asserts these shapes against it), never a runtime
 * one, so a consumer installing the gateway does not install an A2A SDK to
 * serve an Agent Card. Only the subset this adapter emits is modeled.
 */

/**
 * One transport a client can reach this agent through. A2A v1 replaced the
 * single top-level `url` with this list; emitting the old field would tell a
 * v1 client the card was written for an earlier revision.
 */
export interface A2aAgentInterface {
  readonly url: string;
  readonly protocolBinding: string;
  readonly protocolVersion: string;
}

/** An extension the agent supports, which a client activates per request */
export interface A2aAgentExtension {
  readonly uri: string;
  readonly description: string;
  readonly required: boolean;
}

export interface A2aAgentCapabilities {
  readonly streaming: boolean;
  readonly pushNotifications: boolean;
  readonly extendedAgentCard: boolean;
  readonly extensions?: readonly A2aAgentExtension[];
}

/**
 * A discovery descriptor, not a dispatch identifier: A2A has no `skillId` on
 * a request, so `id` is what a caller names inside the invocation envelope
 * (see `message-mapping.ts`), and it is the canonical resource id verbatim.
 *
 * Core A2A v1 `AgentSkill` has no input-schema field, and none is invented: a
 * non-standard property would be ignored by conformant clients and would
 * suggest the card carries more than the protocol defines.
 */
export interface A2aAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly inputModes: readonly string[];
  readonly outputModes: readonly string[];
}

export interface A2aAgentCard {
  readonly name: string;
  readonly description: string;
  /** Version of the agent implementation, not of the protocol */
  readonly version: string;
  readonly supportedInterfaces: readonly A2aAgentInterface[];
  readonly capabilities: A2aAgentCapabilities;
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly A2aAgentSkill[];
}

/** A structured data part, the only part kind an artifact carries */
export interface A2aDataPart {
  readonly data: Record<string, unknown>;
  readonly mediaType: string;
}

/** A human-readable part, used only in a task status message */
export interface A2aTextPart {
  readonly text: string;
}

/** The agent's message on a task status, which carries extension metadata */
export interface A2aMessage {
  readonly role: 'ROLE_AGENT';
  readonly messageId: string;
  readonly parts: readonly A2aTextPart[];
  readonly metadata?: Record<string, unknown>;
}

export interface A2aArtifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly parts: readonly A2aDataPart[];
  readonly metadata?: Record<string, unknown>;
}

export interface A2aTaskStatus {
  readonly state: string;
  readonly timestamp: string;
  readonly message?: A2aMessage;
}

/**
 * A task with no `history`. `GetTask` is unsupported; a pending x402 task
 * can only be resumed with a payment message that names its id.
 */
export interface A2aTask {
  readonly id: string;
  readonly contextId: string;
  readonly status: A2aTaskStatus;
  readonly artifacts: readonly A2aArtifact[];
}
