/**
 * The Agent Commerce invocation envelope for A2A.
 *
 * A2A has no `skillId` on a request: `SendMessage` carries a message, not a
 * tool call, so which canonical resource a caller wants has to be stated
 * somewhere the protocol leaves open. That place is a structured data part:
 *
 * ```json
 * { "message": { "role": "ROLE_USER", "messageId": "msg-1",
 *   "parts": [{ "data": { "resource": "market_report",
 *                         "input": { "symbol": "ETH" } },
 *               "mediaType": "application/json" }] } }
 * ```
 *
 * Payment and authorization proofs ride in the reserved `_payment` and
 * `_authorization` input fields, as over MCP; there is no A2A-specific
 * representation.
 *
 * The accepted shape is narrow on purpose. Everything richer that A2A allows
 * (text parts, files, multi-part messages, task continuation) is rejected:
 * `INPUT_INVALID` for a malformed envelope, `PROTOCOL_UNSUPPORTED` for a legal
 * A2A message this adapter does not serve. `details.a2aErrorCode` carries a
 * more specific JSON-RPC code when one applies. Taking the first of several
 * data parts, for example, could execute a paid call the buyer did not mean
 * to make.
 */
import { z } from 'zod';
import { CommerceError } from '../../core';
import { isRecord } from '../../core/is-record';
import { A2A_JSON_MEDIA_TYPE } from './constants';
import { A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED, A2A_ERROR_TASK_NOT_FOUND } from './jsonrpc';

// The only role a request message may carry. A2A v1 spells roles this way
const A2A_USER_ROLE = 'ROLE_USER';

/** The one message shape that calls a skill, as refusals and the Agent Card name it */
export const A2A_CALL_SHAPE = 'one data part {"resource": "<skill id>", "input": {...}}';

/**
 * The refusal for a role other than `ROLE_USER`, or undefined. An A2A 0.x
 * client sends `user`, so this is what turns its messages away.
 */
export function userRoleProblem(role: unknown): string | undefined {
  return role === A2A_USER_ROLE
    ? undefined
    : `Unsupported message role "${String(role)}": only ${A2A_USER_ROLE} is accepted.`;
}

/** What a supported envelope reduces to. Nothing protocol-shaped survives */
export interface A2aInvocation {
  readonly resourceId: string;
  readonly input: Record<string, unknown>;
  /** Client-assigned message id */
  readonly messageId: string;
}

/**
 * Shape only; every semantic rule is checked below, where the failure can name
 * itself. Parts stay untyped records: zod would collapse a file part and a
 * malformed one into the same union failure.
 */
const UnknownRecord = z.record(z.string(), z.unknown());

const MessageSchema = z.object({
  role: z.string(),
  messageId: z.string().optional(),
  parts: z.array(UnknownRecord),
  taskId: z.string().optional(),
  contextId: z.string().optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});

const ParamsSchema = z.object({
  message: MessageSchema,
  taskId: z.string().optional(),
  contextId: z.string().optional(),
});

function invalid(message: string): CommerceError {
  return new CommerceError('INPUT_INVALID', message);
}

function unsupported(message: string, a2aErrorCode?: number): CommerceError {
  return new CommerceError(
    'PROTOCOL_UNSUPPORTED',
    message,
    a2aErrorCode !== undefined ? { details: { a2aErrorCode } } : {},
  );
}

/**
 * Continuation is refused rather than ignored: a caller resuming a task would
 * otherwise get a fresh, independently billed execution back and no signal
 * that their task id meant nothing here. Since this adapter stores no tasks,
 * it returns `TaskNotFoundError` for every supplied task id.
 */
function assertNoContinuation(params: z.infer<typeof ParamsSchema>): void {
  const message = params.message;
  if (params.taskId !== undefined || message.taskId !== undefined) {
    throw unsupported(
      'Task not found: tasks are not persisted, so send a request with no taskId.',
      A2A_ERROR_TASK_NOT_FOUND,
    );
  }
  if (params.contextId !== undefined || message.contextId !== undefined) {
    throw unsupported(
      'Multi-turn conversational continuation is not supported: send a request with no contextId.',
    );
  }
  if (message.referenceTaskIds !== undefined && message.referenceTaskIds.length > 0) {
    throw unsupported('Referencing previous tasks is not supported.');
  }
}

/**
 * Names the part kind so a caller learns which of theirs is the problem.
 *
 * A2A v1 gives `Part` a content oneof (`text`, `data`, `raw` for inline bytes,
 * or `url`) with `filename` and `mediaType` beside it, where v0.3 used a
 * nested `file` object. Both spellings are refused as unsupported, so a
 * v0.3-shaped client is not told its envelope is malformed.
 */
function assertSupportedPart(part: Record<string, unknown>): void {
  if ('file' in part || 'raw' in part || 'url' in part) {
    throw unsupported(
      `File and URL parts are not supported: send ${A2A_CALL_SHAPE}.`,
      A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED,
    );
  }
  if ('text' in part) {
    throw unsupported(
      `Text parts are not supported: send ${A2A_CALL_SHAPE}.`,
      A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED,
    );
  }
  if (!('data' in part)) {
    throw invalid('Message part carries no "data": send a structured data part.');
  }
  const mediaType = part['mediaType'];
  if (mediaType !== undefined && mediaType !== A2A_JSON_MEDIA_TYPE) {
    throw unsupported(
      `Media type "${String(mediaType)}" is not supported: parts must be ${A2A_JSON_MEDIA_TYPE}.`,
      A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED,
    );
  }
}

/**
 * Turns `SendMessage` params into a resource id and an input object, or throws
 * a `CommerceError`. Pure: it resolves no resource and touches no payment.
 */
export function parseInvocation(rawParams: unknown): A2aInvocation {
  const parsed = ParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw invalid(
      'Request must carry a "message" with a "role" and a "parts" array of structured data parts.',
    );
  }
  const params = parsed.data;
  const message = params.message;
  // A2A requires a message id. This adapter also rejects an empty one.
  if (message.messageId === undefined || message.messageId.length === 0) {
    throw invalid('Message must carry a non-empty "messageId".');
  }
  const messageId = message.messageId;

  assertNoContinuation(params);

  const roleProblem = userRoleProblem(message.role);
  if (roleProblem !== undefined) throw invalid(roleProblem);
  if (message.parts.length === 0) {
    throw invalid('Message carries no parts: send exactly one structured data part.');
  }
  if (message.parts.length > 1) {
    throw unsupported(
      `Multi-part messages are not supported: send exactly one structured data part (received ${message.parts.length}).`,
    );
  }

  const part = message.parts[0];
  if (part === undefined) throw invalid('Message carries no parts.');
  assertSupportedPart(part);

  const data = part['data'];
  if (!isRecord(data)) {
    throw invalid('Message part "data" must be a JSON object.');
  }

  const resourceId = data['resource'];
  if (typeof resourceId !== 'string') {
    throw invalid('Message part data must carry a "resource" string naming a canonical resource.');
  }
  if (resourceId.length === 0) {
    throw invalid('Message part data "resource" must not be empty.');
  }

  const rawInput = data['input'];
  // Absent means "no arguments", which is a real case for a zero-input
  // resource. Present-but-not-an-object is a mistake, never an empty call.
  if (rawInput !== undefined && !isRecord(rawInput)) {
    throw invalid('Message part data "input" must be a JSON object.');
  }

  return { resourceId, input: rawInput ?? {}, messageId };
}
