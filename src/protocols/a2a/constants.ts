/**
 * A2A pins, kept in one place so nothing infers one version from another.
 *
 * The specification revision and the negotiation version look alike but
 * differ: `1.0.1` names the document this adapter was written against, `1.0`
 * is what a client negotiates on the wire. Neither is this package's version
 * (`PACKAGE_VERSION`).
 */

/** A2A specification revision this adapter targets */
export const A2A_SPEC_VERSION = '1.0.1';

/** Protocol negotiation version carried on the wire */
export const A2A_PROTOCOL_VERSION = '1.0';

/** The only transport binding this adapter serves */
export const A2A_PROTOCOL_BINDING = 'JSONRPC';

/**
 * Fixed by the A2A specification: a client fetches the card from this exact
 * path, so it is not configurable. `src/config` reserves it against adapter
 * mounts for the same reason.
 */
export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** Mount serving the JSON-RPC endpoint, unless configuration says otherwise */
export const A2A_DEFAULT_MOUNT_PATH = '/a2a';

/** Content type on both sides of every supported A2A exchange */
export const A2A_JSON_MEDIA_TYPE = 'application/json';

/** Card identity when the operator names none. Matches the MCP adapter's default server name */
export const A2A_DEFAULT_AGENT_NAME = 'agent-commerce';

/**
 * Version negotiation header. An absent or empty value means `0.3`, which
 * this adapter does not serve.
 */
export const A2A_VERSION_HEADER = 'a2a-version';

/** JSON-RPC method for sending a message */
export const A2A_METHOD_SEND_MESSAGE = 'SendMessage';

/** Methods for reading, listing and canceling retained tasks */
export const A2A_METHOD_GET_TASK = 'GetTask';
export const A2A_METHOD_LIST_TASKS = 'ListTasks';
export const A2A_METHOD_CANCEL_TASK = 'CancelTask';

/**
 * Push notification configuration methods. The card declares no push
 * support, so these return `PushNotificationNotSupportedError`.
 */
export const A2A_PUSH_CONFIG_METHODS: readonly string[] = [
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
];

/**
 * A2A methods that exist and are not served here, kept apart from unknown
 * methods so a caller learns whether it hit a refused method or a typo. The
 * descriptor and the transport both read this one list.
 */
export const A2A_UNSUPPORTED_METHODS: readonly string[] = [
  'SendStreamingMessage',
  'SubscribeToTask',
  ...A2A_PUSH_CONFIG_METHODS,
  'GetExtendedAgentCard',
];

/** Terminal states for completed, failed and canceled tasks */
export const A2A_TASK_STATE_COMPLETED = 'TASK_STATE_COMPLETED';
export const A2A_TASK_STATE_FAILED = 'TASK_STATE_FAILED';
export const A2A_TASK_STATE_CANCELED = 'TASK_STATE_CANCELED';

/** A task processing an x402 payment submission */
export const A2A_TASK_STATE_WORKING = 'TASK_STATE_WORKING';

/** An unpaid x402 extension task waiting for a payment message */
export const A2A_TASK_STATE_INPUT_REQUIRED = 'TASK_STATE_INPUT_REQUIRED';

/** Extension activation header, a comma-separated list of extension URIs */
export const A2A_EXTENSIONS_HEADER = 'a2a-extensions';

/** Hour bounds and default for task retention in `protocols.a2a.tasks.retentionHours` */
export const A2A_TASK_RETENTION_HOURS = { min: 1, max: 8760, default: 24 } as const;

/** Bounds and default for the record admission limit, `protocols.a2a.tasks.maxRetained` */
export const A2A_MAX_RETAINED_TASKS = { min: 1, max: 1_000_000, default: 1000 } as const;
