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
 * A payment proof rides in the reserved `_payment` input field, exactly as it
 * does over MCP — there is deliberately no second, A2A-specific payment
 * representation to keep in sync.
 *
 * The accepted shape is narrow on purpose. Everything richer that A2A allows
 * (text parts, files, multi-part messages, task continuation) is rejected with
 * a code that says which of the two it is: `INPUT_INVALID` for an envelope
 * that is malformed, `PROTOCOL_UNSUPPORTED` for one that is a legal A2A
 * message this adapter does not serve. Guessing at intent — picking the first
 * data part out of several, say — would make a caller's mistake look like a
 * successful, possibly *paid*, call for something they did not ask for.
 */
import { z } from 'zod';
import {
  CommerceError,
  type CommerceResource,
  PAYMENT_INPUT_FIELD,
  type PaymentSubmission,
} from '../../core/index.js';
import { A2A_JSON_MEDIA_TYPE } from './constants.js';

/** The only role a request message may carry. A2A v1 spells roles this way. */
export const A2A_USER_ROLE = 'ROLE_USER';

/** What a supported envelope reduces to. Nothing protocol-shaped survives. */
export interface A2aInvocation {
  readonly resourceId: string;
  readonly input: Record<string, unknown>;
  /** Client-assigned message id, echoed back on the response when present. */
  readonly messageId?: string;
}

/**
 * Shape only — every semantic rule is checked below, where the failure can
 * name itself. Parts stay untyped records: classifying one is what tells a
 * file part apart from a malformed one, and zod would collapse both into the
 * same union failure.
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

function unsupported(message: string): CommerceError {
  return new CommerceError('PROTOCOL_UNSUPPORTED', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Continuation is refused rather than ignored: a caller resuming a task would
 * otherwise get a fresh, independently billed execution back and no signal
 * that their task id meant nothing here.
 */
function assertNoContinuation(params: z.infer<typeof ParamsSchema>): void {
  const message = params.message;
  if (params.taskId !== undefined || message.taskId !== undefined) {
    throw unsupported('Task continuation is not supported: send a request with no taskId.');
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
 * A2A v1 gives `Part` a content oneof — `text`, `data`, `raw` (inline bytes)
 * or `url` — and carries `filename`/`mediaType` beside it, rather than the
 * nested `file` object v0.3 used. Both spellings are refused: a v0.3-shaped
 * client reaching this endpoint should be told its part kind is unsupported,
 * not that its envelope is malformed.
 */
function assertSupportedPart(part: Record<string, unknown>): void {
  if ('file' in part || 'raw' in part || 'url' in part) {
    throw unsupported('File and URL parts are not supported: send a structured data part.');
  }
  if ('text' in part) {
    throw unsupported('Text parts are not supported: send a structured data part.');
  }
  if (!('data' in part)) {
    throw invalid('Message part carries no "data": send a structured data part.');
  }
  const mediaType = part['mediaType'];
  if (mediaType !== undefined && mediaType !== A2A_JSON_MEDIA_TYPE) {
    throw unsupported(
      `Media type "${String(mediaType)}" is not supported: parts must be ${A2A_JSON_MEDIA_TYPE}.`,
    );
  }
}

/**
 * Turns `SendMessage` params into a resource id and an input object, or throws
 * a `CommerceError`. Pure: it resolves nothing, checks no resource exists and
 * touches no payment — the pipeline owns all three.
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

  assertNoContinuation(params);

  if (message.role !== A2A_USER_ROLE) {
    throw invalid(`Unsupported message role "${message.role}": only ${A2A_USER_ROLE} is accepted.`);
  }
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
  if (!isPlainObject(data)) {
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
  if (rawInput !== undefined && !isPlainObject(rawInput)) {
    throw invalid('Message part data "input" must be a JSON object.');
  }

  return {
    resourceId,
    input: rawInput ?? {},
    ...(message.messageId !== undefined ? { messageId: message.messageId } : {}),
  };
}

/**
 * Lifts a payment proof out of the reserved input field into the canonical
 * `PaymentSubmission` the pipeline reads, leaving the rest of the input alone.
 *
 * The *convention* is shared with MCP — one reserved field named once in
 * `core` — but the code is not: a cross-adapter import would make an A2A
 * deployment's payment retry depend on the MCP SDK being installed. The
 * adapter decides nothing about the payment here; it only moves it to where
 * the pipeline looks, and the rail comes from the resource's own declaration.
 */
export function extractPaymentSubmission(
  rawInput: Record<string, unknown>,
  resource: CommerceResource | undefined,
): { input: Record<string, unknown>; payment?: PaymentSubmission } {
  const { [PAYMENT_INPUT_FIELD]: proof, ...input } = rawInput;
  const method = resource?.paymentMethods[0];
  if (typeof proof === 'string' && proof.length > 0 && method !== undefined) {
    return { input, payment: { method, payload: proof } };
  }
  return { input };
}
