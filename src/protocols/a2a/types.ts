/**
 * A2A v1 wire shapes, hand-written and confined to this directory.
 *
 * Deliberately not imported from `@a2a-js/sdk`: the SDK is a test-only
 * dependency (conformance asserts these shapes against it), never a runtime
 * one, so a consumer installing the gateway does not install an A2A SDK to
 * serve an Agent Card. Only the subset this adapter emits is modelled.
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

export interface A2aAgentCapabilities {
  readonly streaming: boolean;
  readonly pushNotifications: boolean;
  readonly extendedAgentCard: boolean;
}

/**
 * A discovery descriptor, not a dispatch identifier: A2A has no `skillId` on
 * a request, so `id` is what a caller names inside the invocation envelope
 * (see the adapter), and it is the canonical resource id verbatim.
 *
 * Core A2A v1 `AgentSkill` has no input-schema field. One is not invented
 * here — a non-standard property would be ignored by conformant clients and
 * would misrepresent the card as carrying more than the protocol defines.
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
  /** Version of the agent implementation, not of the protocol. */
  readonly version: string;
  readonly supportedInterfaces: readonly A2aAgentInterface[];
  readonly capabilities: A2aAgentCapabilities;
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly A2aAgentSkill[];
}

/** A structured data part — the only part kind this adapter emits. */
export interface A2aDataPart {
  readonly data: Record<string, unknown>;
  readonly mediaType: string;
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
}

/**
 * A terminal task. No `history`, and no id a caller can fetch later: tasks are
 * ephemeral representations of a synchronous result, which is why `GetTask` is
 * unsupported rather than missing.
 */
export interface A2aTask {
  readonly id: string;
  readonly contextId: string;
  readonly status: A2aTaskStatus;
  readonly artifacts: readonly A2aArtifact[];
}
