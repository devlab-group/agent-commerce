/**
 * The definition of done for SDK conformance: the official client discovers
 * the gateway from its card and invokes a free resource end to end —
 * ClientFactory → card → JSONRPC transport → SendMessage → gateway → adapter →
 * pipeline → merchant fixture → terminal Task with an Artifact.
 */
import { Role, type SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MERCHANT_BODY, type RunningGateway, startConformanceGateway } from './support/gateway.js';

let running: RunningGateway;

beforeAll(async () => {
  running = await startConformanceGateway();
});

afterAll(async () => {
  await running?.close();
});

/** The SDK's own factory: card discovery and transport selection are its job, not ours. */
async function client() {
  return new ClientFactory().createFromUrl(running.url);
}

/**
 * A `SendMessageRequest` in the SDK's own internal representation — the client
 * serialises it, so the wire bytes are the SDK's, not this test's.
 */
function invocation(resource: string, input: Record<string, unknown>): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: 'msg-conformance-1',
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: 'data', value: { resource, input } },
          mediaType: 'application/json',
          filename: '',
          metadata: undefined,
        },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  };
}

describe('free resource, invoked by the official SDK client', () => {
  it('returns a terminal completed task carrying the merchant response', async () => {
    const result = await (await client()).sendMessage(
      invocation('weather_basic', { city: 'Berlin' }),
    );

    // SendMessageResult is Task | Message; a resource execution is a Task.
    expect('status' in result).toBe(true);
    if (!('status' in result)) return;

    expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(result.id).toBeTruthy();
    expect(result.contextId).toBeTruthy();
    expect(result.artifacts).toHaveLength(1);

    const part = result.artifacts[0]?.parts[0];
    expect(part?.mediaType).toBe('application/json');
    expect(part?.content?.$case).toBe('data');
    expect(part?.content?.value).toEqual(MERCHANT_BODY);
  });

  it('carries the delivery summary as artifact metadata', async () => {
    const result = await (await client()).sendMessage(
      invocation('weather_basic', { city: 'Berlin' }),
    );
    if (!('status' in result)) throw new Error('expected a task');

    const metadata = result.artifacts[0]?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.['agent-commerce/delivery']).toMatchObject({ resourceId: 'weather_basic' });
  });

  it('answers a resource that is not exposed over a2a with a failed task, not a transport error', async () => {
    const result = await (await client()).sendMessage(invocation('http_only', {}));
    if (!('status' in result)) throw new Error('expected a task');

    expect(result.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const data = result.artifacts[0]?.parts[0]?.content?.value as Record<string, unknown>;
    expect(data['code']).toBe('RESOURCE_NOT_FOUND');
  });

  it('answers input that fails the resource schema with a failed task', async () => {
    const result = await (await client()).sendMessage(invocation('weather_basic', { city: 42 }));
    if (!('status' in result)) throw new Error('expected a task');

    expect(result.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const data = result.artifacts[0]?.parts[0]?.content?.value as Record<string, unknown>;
    expect(data['code']).toBe('INPUT_INVALID');
  });
});
