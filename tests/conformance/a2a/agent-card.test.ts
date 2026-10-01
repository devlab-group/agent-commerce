/**
 * Agent Card discovery through the official SDK's own resolver.
 *
 * The SDK acts only as an external client. No SDK server helper is used,
 * not even to derive expected behavior, or the suite would check the SDK
 * against itself instead of this gateway against the protocol.
 */
import { DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningGateway, startConformanceGateway } from './support/gateway';

let running: RunningGateway;

beforeAll(async () => {
  running = await startConformanceGateway();
});

afterAll(async () => {
  await running?.close();
});

describe('A2A agent card, resolved by the official SDK', () => {
  it('is found at the well-known path the SDK looks in by default', async () => {
    const card = await new DefaultAgentCardResolver().resolve(running.url);

    expect(card.name).toBe('Demo Weather Store');
    expect(card.version).toBeTruthy();
    // No agentDescription is configured, so this is the published default
    expect(card.description).toBe(
      'Agent Commerce Gateway: canonical commerce resources exposed as A2A skills.',
    );
  });

  it('declares a JSONRPC interface at protocol version 1.0', async () => {
    const card = await new DefaultAgentCardResolver().resolve(running.url);

    expect(card.supportedInterfaces).toHaveLength(1);
    const [iface] = card.supportedInterfaces;
    expect(iface?.protocolBinding).toBe('JSONRPC');
    expect(iface?.protocolVersion).toBe('1.0');
    expect(iface?.url).toBe(`${running.url}/a2a`);
  });

  it('publishes a2a-exposed resources as skills, and nothing else', async () => {
    const card = await new DefaultAgentCardResolver().resolve(running.url);

    // `http_only` is configured but exposed elsewhere, so it must not appear
    expect(card.skills.map((skill) => skill.id)).toEqual(['weather_basic', 'market_report']);
    const [skill] = card.skills;
    expect(skill?.name).toBe('Basic Weather');
    expect(skill?.inputModes).toEqual(['application/json']);
    expect(skill?.outputModes).toEqual(['application/json']);
    // Core AgentSkill defines no input schema field; none is invented
    expect(skill).not.toHaveProperty('inputSchema');
  });

  it('declares the capabilities it actually has', async () => {
    const card = await new DefaultAgentCardResolver().resolve(running.url);

    expect(card.capabilities?.streaming).toBe(false);
    expect(card.capabilities?.pushNotifications).toBe(false);
    expect(card.capabilities?.extendedAgentCard).toBe(false);
    expect(card.defaultInputModes).toEqual(['application/json']);
    expect(card.defaultOutputModes).toEqual(['application/json']);
  });

  it('carries no obsolete top-level endpoint field', async () => {
    const raw = await (await fetch(`${running.url}/.well-known/agent-card.json`)).json();

    expect(raw).not.toHaveProperty('url');
    expect(raw).not.toHaveProperty('preferredTransport');
  });

  /**
   * A2A v1 carries the protocol version per interface, and the SDK's `AgentCard`
   * has no top-level `protocolVersion`, so none may be emitted
   */
  it('states the protocol version per interface, not on the card itself', async () => {
    const raw = (await (
      await fetch(`${running.url}/.well-known/agent-card.json`)
    ).json()) as Record<string, unknown>;

    expect(raw).not.toHaveProperty('protocolVersion');
    expect((raw['supportedInterfaces'] as { protocolVersion: string }[])[0]?.protocolVersion).toBe(
      '1.0',
    );
  });
});
