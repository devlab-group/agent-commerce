/**
 * Pin the vendored TCK schema to the blob hash recorded in
 * tests/fixtures/a2a/tck-5e6f37c2/README.md and check representative valid and
 * invalid task responses
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tckErrors } from './support/task-schema';

// Git identifies file contents by hashing the blob header and bytes with SHA-1
function gitBlobHash(path: string): string {
  const content = readFileSync(path);
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

const TASK = {
  id: 'task-1',
  contextId: 'context-1',
  status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-11-22T10:00:00.000Z' },
  artifacts: [{ artifactId: 'artifact-1', parts: [{ data: { ok: true } }] }],
};

describe('A2A TCK schema at 5e6f37c2', () => {
  it('is upstream specification/a2a.json', () => {
    expect(gitBlobHash('tests/fixtures/a2a/tck-5e6f37c2/a2a.json')).toBe(
      'd6ea1ed438d788614b597f28009acfc8308aa8db',
    );
  });

  it('accepts a task the proto declares', () => {
    expect(tckErrors('Task', TASK)).toEqual([]);
    expect(tckErrors('Send Message Response', { task: TASK })).toEqual([]);
  });

  it.each([
    ['a property the proto does not declare', { ...TASK, requestId: 'a2a-1' }],
    ['a state outside TaskState', { ...TASK, status: { ...TASK.status, state: 'DONE' } }],
    ['a timestamp that is not RFC 3339', { ...TASK, status: { ...TASK.status, timestamp: 'now' } }],
    ['a part property inside an artifact', { ...TASK, artifacts: [{ parts: [{ json: {} }] }] }],
  ])('rejects a task with %s', (_label, task) => {
    expect(tckErrors('Task', task)).not.toEqual([]);
  });
});
