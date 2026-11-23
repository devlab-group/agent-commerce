/**
 * Normalize field names and validate parameters for `SendMessage`, `GetTask`,
 * `ListTasks` and `CancelTask` before task lookup or execution. A2A 1.0.1
 * section 3.3.2 requires parameter validation before processing.
 *
 * Accept proto names (`context_id`) and JSON names (`contextId`). Normalize
 * request, `configuration`, message and part keys while preserving keys within
 * `data` and `metadata` values, which hold merchant input and extension JSON.
 * Reject fields sent under both names to avoid choosing between their values.
 *
 * Ignore unknown parameters after checking for name collisions (section 5.7).
 * Treat `null` as absent in the request and configuration parameters read here;
 * message fields are validated separately.
 */
import { CommerceError } from '../../core';
import { isRecord } from '../../core/is-record';
import { A2A_JSON_MEDIA_TYPE } from './constants';
import {
  A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED,
  A2A_ERROR_PUSH_NOTIFICATION_NOT_SUPPORTED,
} from './jsonrpc';

/** Create an error for a malformed parameter, mapped to JSON-RPC invalid params */
export function invalid(message: string): CommerceError {
  return new CommerceError('INPUT_INVALID', message);
}

/**
 * Create an error for a valid A2A request this adapter cannot serve. Map it to
 * `UnsupportedOperationError` unless `a2aErrorCode` specifies another error.
 */
export function unsupported(message: string, a2aErrorCode?: number): CommerceError {
  return new CommerceError(
    'PROTOCOL_UNSUPPORTED',
    message,
    a2aErrorCode !== undefined ? { details: { a2aErrorCode } } : {},
  );
}

// Remove an underscore and uppercase the following lowercase letter or digit
const PROTO_NAME_WORD = /_([a-z0-9])/g;

// Normalize one object's field names and reject collisions
function jsonNames(value: Record<string, unknown>, where: string): Record<string, unknown> {
  const sentAs = new Map<string, string>();
  const entries: [string, unknown][] = [];
  for (const [key, field] of Object.entries(value)) {
    const name = key.replace(PROTO_NAME_WORD, (_, next: string) => next.toUpperCase());
    const earlier = sentAs.get(name);
    if (earlier !== undefined) {
      throw invalid(`${where} sends "${earlier}" and "${key}", two names for one field: send one.`);
    }
    sentAs.set(name, key);
    entries.push([name, field]);
  }
  return Object.fromEntries(entries);
}

function read(params: Record<string, unknown>, key: string): unknown {
  const value = params[key];
  return value === null ? undefined : value;
}

function checkTenant(params: Record<string, unknown>): void {
  const tenant = read(params, 'tenant');
  if (tenant === undefined || tenant === '') return;
  if (typeof tenant !== 'string') throw invalid('"tenant" must be a string.');
  throw unsupported('Tenants are not supported: omit "tenant" or send an empty string.');
}

function checkMetadata(params: Record<string, unknown>): void {
  const metadata = read(params, 'metadata');
  if (metadata !== undefined && !isRecord(metadata)) {
    throw invalid('"metadata" must be a JSON object.');
  }
}

const INT32_MAX = 2_147_483_647;

// Read an int32 from a JSON number or a decimal integer string
function readInteger(value: unknown, name: string, min: number, max = INT32_MAX) {
  if (value === undefined) return undefined;
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalid(`"${name}" must be an integer from ${min} to ${max}.`);
  }
  return n;
}

function readBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(`"${name}" must be true or false.`);
  return value;
}

// Section 5.6.1: UTC with a `Z`, fractional seconds optional
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// `Date.parse` rolls 30 February over to March; the round trip catches it
function isUtcTimestamp(value: string): boolean {
  if (!UTC_TIMESTAMP.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

// A media range admitting JSON: the type itself, `application/*` or `*/*`
function admitsJson(range: string): boolean {
  const type = (range.split(';')[0] ?? '').trim().toLowerCase();
  return type === A2A_JSON_MEDIA_TYPE || type === 'application/*' || type === '*/*';
}

/** Normalized and validated `SendMessage` parameters; message validation follows separately */
export interface SendMessageParams {
  /** Request with normalized top-level, message and part field names */
  readonly params: Record<string, unknown>;
  readonly historyLength?: number;
  readonly returnImmediately: boolean;
}

export function readSendMessageParams(raw: Record<string, unknown>): SendMessageParams {
  const params = jsonNames(raw, 'The request');
  const message = params['message'];
  if (isRecord(message)) {
    const named = jsonNames(message, 'The message');
    const parts = named['parts'];
    params['message'] = Array.isArray(parts)
      ? {
          ...named,
          parts: parts.map((part) => (isRecord(part) ? jsonNames(part, 'A message part') : part)),
        }
      : named;
  }
  checkTenant(params);
  checkMetadata(params);

  const configuration = read(params, 'configuration');
  if (configuration === undefined) return { params, returnImmediately: false };
  if (!isRecord(configuration)) throw invalid('"configuration" must be a JSON object.');
  const options = jsonNames(configuration, 'The configuration');
  if (read(options, 'taskPushNotificationConfig') !== undefined) {
    throw unsupported(
      'Push notifications are not supported: omit "configuration.taskPushNotificationConfig".',
      A2A_ERROR_PUSH_NOTIFICATION_NOT_SUPPORTED,
    );
  }
  const modes = read(options, 'acceptedOutputModes');
  if (modes !== undefined) {
    if (!Array.isArray(modes) || !modes.every((mode) => typeof mode === 'string')) {
      throw invalid('"configuration.acceptedOutputModes" must be an array of media types.');
    }
    // An empty list leaves the output mode to the agent
    if (modes.length > 0 && !modes.some(admitsJson)) {
      throw unsupported(
        `This agent answers in ${A2A_JSON_MEDIA_TYPE} only: list it in "configuration.acceptedOutputModes", or omit the field.`,
        A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED,
      );
    }
  }
  const historyLength = readInteger(
    read(options, 'historyLength'),
    'configuration.historyLength',
    0,
  );
  return {
    params,
    ...(historyLength !== undefined ? { historyLength } : {}),
    returnImmediately:
      readBoolean(read(options, 'returnImmediately'), 'configuration.returnImmediately') ?? false,
  };
}

function taskOperationParams(raw: Record<string, unknown>): Record<string, unknown> {
  const params = jsonNames(raw, 'The request');
  checkTenant(params);
  return params;
}

function readTaskId(params: Record<string, unknown>): string {
  const id = read(params, 'id');
  if (typeof id !== 'string' || id.length === 0) {
    throw invalid('The request must carry a non-empty task "id".');
  }
  return id;
}

export interface GetTaskParams {
  readonly id: string;
  readonly historyLength?: number;
}

export function readGetTaskParams(raw: Record<string, unknown>): GetTaskParams {
  const params = taskOperationParams(raw);
  const id = readTaskId(params);
  const historyLength = readInteger(read(params, 'historyLength'), 'historyLength', 0);
  return { id, ...(historyLength !== undefined ? { historyLength } : {}) };
}

export interface CancelTaskParams {
  readonly id: string;
}

export function readCancelTaskParams(raw: Record<string, unknown>): CancelTaskParams {
  const params = taskOperationParams(raw);
  checkMetadata(params);
  return { id: readTaskId(params) };
}

// Accepted proto `TaskState` names; treat `TASK_STATE_UNSPECIFIED` as no filter
const TASK_STATES: readonly string[] = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
];

/** Proto `ListTasksRequest.page_size`: 50 when unset, at most 100 */
export const A2A_LIST_PAGE_SIZE = { default: 50, max: 100 } as const;

/** Task position encoded in a pagination token */
export interface ListCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export function encodePageToken(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id]), 'utf8').toString('base64url');
}

function decodePageToken(token: string): ListCursor | undefined {
  // `Buffer.from` skips characters outside the alphabet instead of failing
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [updatedAt, id] = value as unknown[];
  return typeof updatedAt === 'string' &&
    isUtcTimestamp(updatedAt) &&
    typeof id === 'string' &&
    id.length > 0
    ? { updatedAt, id }
    : undefined;
}

export interface ListTasksParams {
  /** Absent when `contextId` is omitted, null or empty */
  readonly contextId?: string;
  readonly status?: string;
  readonly pageSize: number;
  /** Decoded cursor; absent when no page token is supplied */
  readonly after?: ListCursor;
  readonly historyLength?: number;
  /** UTC timestamp supplied as the inclusive lower bound, preserved as sent */
  readonly statusTimestampAfter?: string;
  readonly includeArtifacts: boolean;
}

export function readListTasksParams(raw: Record<string, unknown>): ListTasksParams {
  const params = taskOperationParams(raw);

  const contextId = read(params, 'contextId');
  if (contextId !== undefined && typeof contextId !== 'string') {
    throw invalid('"contextId" must be a string.');
  }
  const status = read(params, 'status');
  if (
    status !== undefined &&
    status !== 'TASK_STATE_UNSPECIFIED' &&
    !(typeof status === 'string' && TASK_STATES.includes(status))
  ) {
    throw invalid('"status" must be a TaskState name, such as "TASK_STATE_COMPLETED".');
  }
  const pageSize =
    readInteger(read(params, 'pageSize'), 'pageSize', 1, A2A_LIST_PAGE_SIZE.max) ??
    A2A_LIST_PAGE_SIZE.default;
  const pageToken = read(params, 'pageToken');
  let after: ListCursor | undefined;
  if (pageToken !== undefined && pageToken !== '') {
    after = typeof pageToken === 'string' ? decodePageToken(pageToken) : undefined;
    if (after === undefined) {
      throw invalid('"pageToken" must be a nextPageToken this agent returned.');
    }
  }
  const historyLength = readInteger(read(params, 'historyLength'), 'historyLength', 0);
  const statusTimestampAfter = read(params, 'statusTimestampAfter');
  if (
    statusTimestampAfter !== undefined &&
    !(typeof statusTimestampAfter === 'string' && isUtcTimestamp(statusTimestampAfter))
  ) {
    throw invalid(
      '"statusTimestampAfter" must be a UTC timestamp such as "2026-01-01T00:00:00.000Z".',
    );
  }
  const includeArtifacts = readBoolean(read(params, 'includeArtifacts'), 'includeArtifacts');

  return {
    ...(typeof contextId === 'string' && contextId !== '' ? { contextId } : {}),
    ...(typeof status === 'string' && status !== 'TASK_STATE_UNSPECIFIED' ? { status } : {}),
    pageSize,
    ...(after !== undefined ? { after } : {}),
    ...(historyLength !== undefined ? { historyLength } : {}),
    ...(typeof statusTimestampAfter === 'string' ? { statusTimestampAfter } : {}),
    includeArtifacts: includeArtifacts ?? false,
  };
}
