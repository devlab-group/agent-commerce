import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { buildToolArguments, isPaidTool } from '../src/tool-args.js';

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: overrides.name ?? 'weather_basic',
    description: overrides.description ?? 'Weather lookup',
    inputSchema: overrides.inputSchema ?? { type: 'object', properties: {} },
  };
}

describe('isPaidTool', () => {
  it('is false when the input schema has no "_payment" property', () => {
    expect(
      isPaidTool(
        makeTool({ inputSchema: { type: 'object', properties: { city: { type: 'string' } } } }),
      ),
    ).toBe(false);
  });

  it('is true when the input schema declares the reserved "_payment" property', () => {
    expect(
      isPaidTool(
        makeTool({
          inputSchema: { type: 'object', properties: { _payment: { type: 'string' } } },
        }),
      ),
    ).toBe(true);
  });

  it('is false when properties is entirely absent', () => {
    expect(isPaidTool(makeTool({ inputSchema: { type: 'object' } }))).toBe(false);
  });
});

describe('buildToolArguments', () => {
  it('returns an empty object when there are no required properties', () => {
    expect(
      buildToolArguments(makeTool({ inputSchema: { type: 'object', properties: {} } })),
    ).toEqual({});
  });

  it('supplies "Paris" for a required "city" property', () => {
    const tool = makeTool({
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    });
    expect(buildToolArguments(tool)).toEqual({ city: 'Paris' });
  });

  it('never includes the reserved "_payment" field even if (incorrectly) marked required', () => {
    const tool = makeTool({
      inputSchema: {
        type: 'object',
        properties: { _payment: { type: 'string' } },
        required: ['_payment'],
      },
    });
    expect(buildToolArguments(tool)).toEqual({});
  });

  it('supplies type-appropriate example values for non-city required properties', () => {
    const tool = makeTool({
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          active: { type: 'boolean' },
          label: { type: 'string' },
        },
        required: ['count', 'active', 'label'],
      },
    });
    expect(buildToolArguments(tool)).toEqual({ count: 0, active: true, label: 'demo' });
  });
});
