# A2A

Enable with `protocols.a2a.enabled: true`. The [x402 extension](#x402-extension)
is experimental and may change in a minor release.

| Property      | Value                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Binding       | JSON-RPC 2.0 over HTTP(S)                                                                                                         |
| Methods       | `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`; not legacy `message/send`                                                    |
| Version       | `A2A-Version: 1.0` header, or an `A2A-Version` query parameter when the header is absent; patch suffixes are accepted but ignored |
| Agent Card    | `GET /.well-known/agent-card.json`                                                                                                |
| Default mount | `/a2a`                                                                                                                            |
| Task model    | blocking by default; `returnImmediately: true` enables background execution; responses retained for reads (see [Tasks](#tasks))   |

Each A2A resource becomes an Agent Card skill. Paid skills have a `paid` tag
and a price in their description. A2A v1.0 has no input-schema field for
skills, so each skill includes an illustrative JSON call example with
required input. The agent description explains the call shape and points to
`<publicBaseUrl>/api/resources` for input schemas. It also names
`input._payment` when any skill is paid. Enabling the adapter requires at
least one A2A resource.

The card has a content-based `ETag` and `Cache-Control: public, max-age=300`.
A matching `If-None-Match` request receives `304` without a body.

The card builds its advertised endpoint from `merchant.publicBaseUrl` and
`mountPath`. A2A 1.0.1 requires encrypted transport in production (section 7.1).
Config still accepts HTTP URLs in 2.x. When A2A is enabled,
`agent-commerce doctor` warns about an HTTP base URL unless its host is
`localhost`, a subdomain of `localhost`, an address in `127.0.0.0/8`, or `::1`.

## Invocation and payment

The adapter requires a non-empty `messageId` and exactly one structured data
part in `SendMessage`. The part has this shape:

```json
{
  "data": {
    "resource": "market_report",
    "input": { "symbol": "ETH" }
  },
  "mediaType": "application/json"
}
```

A paid retry adds the same reserved field used by MCP:

```json
{
  "data": {
    "resource": "market_report",
    "input": {
      "symbol": "ETH",
      "_payment": "<payment proof>"
    }
  },
  "mediaType": "application/json"
}
```

`_payment` is this gateway's carrier, not part of A2A or of either rail. MPP
defines no A2A binding, so `_payment` is the only way to pay an MPP skill.

For a new purchase, the adapter refuses text, file, inline-byte and URL
parts, multipart messages, non-user roles, and task or context continuation.
The text and file refusals name the expected part shape. A payment message can
resume a pending x402 extension task.

## Request parameters

The adapter validates the parameters below before reading the task store or
calling a backend. For these parameters, `null` counts as absent. Type errors
return `-32602`, except that any non-null
`configuration.taskPushNotificationConfig` returns `-32003`. Unknown parameters
are ignored after field-name checks.

Requests may use proto field names, such as `context_id` for `contextId`.
The adapter converts request, `configuration`, message and part keys to JSON
names. Keys within `data` and `metadata` values stay unchanged, preserving
merchant input and extension metadata. Sending both names for a field returns
`-32602`. Integer parameters accept JSON numbers or decimal integer strings.

| Parameter                                      | Accepted                                                                              | Otherwise |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | --------- |
| `tenant`                                       | absent or `""`                                                                        | `-32004`  |
| `configuration.acceptedOutputModes`            | absent, empty, or a list that includes `application/json`, `application/*` or `*/*`   | `-32005`  |
| `configuration.taskPushNotificationConfig`     | absent                                                                                | `-32003`  |
| `configuration.historyLength`, `historyLength` | absent or an integer from 0 to 2,147,483,647; ignored because no task history is kept | `-32602`  |
| `configuration.returnImmediately`              | absent or a boolean; see [Background tasks](#background-tasks)                        | `-32602`  |
| `metadata` on `SendMessage` and `CancelTask`   | absent or an object; ignored                                                          | `-32602`  |
| `id` on `GetTask` and `CancelTask`             | a non-empty string                                                                    | `-32602`  |
| `contextId` on `ListTasks`                     | absent or a string; absent, `null` and `""` list nothing                              | `-32602`  |
| `status` on `ListTasks`                        | absent or a `TaskState` name; `TASK_STATE_UNSPECIFIED` filters nothing                | `-32602`  |
| `pageSize` on `ListTasks`                      | absent (50) or an integer from 1 to 100                                               | `-32602`  |
| `pageToken` on `ListTasks`                     | absent, `""`, or a valid base64url cursor; use `nextPageToken` to continue            | `-32602`  |
| `statusTimestampAfter` on `ListTasks`          | absent or a UTC timestamp such as `2026-01-01T00:00:00.000Z`                          | `-32602`  |
| `includeArtifacts` on `ListTasks`              | absent or a boolean                                                                   | `-32602`  |

## x402 extension

A client activates the extension by including
`https://github.com/google-a2a/a2a-x402/v0.1` in either `A2A-Extensions`
(A2A 1.0) or `X-A2A-Extensions` (a2a-x402 v0.1). Both accept comma-separated
URI lists and repeated headers. Activation lets the client pay without
`_payment`. The gateway uses x402 v2 documents from the
[x402 A2A transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/a2a.md).
The transport's examples use lowercase task states and roles, with `kind` on
parts. This gateway uses the A2A 1.0 forms: `TASK_STATE_INPUT_REQUIRED`,
`ROLE_AGENT` and parts without `kind`. The Agent Card advertises the extension
as optional, with `params: { "x402Version": 2 }`, when x402 is a skill's selected
payment rail.

Responses echo the extension URI under both header names when the task's status
message lists the extension. This includes input-required tasks, payment
responses even when the request omits activation headers, and `GetTask` reads
of those tasks. MPP tasks and JSON-RPC errors carry neither header. For origins
in `server.allowedOrigins`, CORS permits both request headers and exposes both
response headers to browser code. Extension status messages carry `contextId`,
`taskId`, `extensions: [<extension URI>]` and `x402.payment.*` metadata.

1. A blocking x402 paid call without a proof returns `TASK_STATE_INPUT_REQUIRED`. The status
   message carries `x402.payment.status: payment-required` and the v2
   `PaymentRequired` in `x402.payment.required`.
2. The client sends a message with that `taskId` and sets
   `x402.payment.status` to `payment-submitted` in the message metadata. It
   puts the `PaymentPayload` in `x402.payment.payload`. The gateway reruns the
   stored purchase through input validation, payment verification, replay
   reservation and settlement.
3. A successful purchase returns `TASK_STATE_COMPLETED`,
   `payment-completed` and a settlement entry in `x402.payment.receipts`. A
   payment failure returns `TASK_STATE_FAILED`, `payment-failed`, an
   `x402.payment.error` code and a failed receipt. If the backend fails after
   settlement, the task fails but its status message reports
   `payment-completed` with the settlement entry. A client can also send
   `payment-rejected` to end the task without paying.

The gateway holds unpaid tasks in the receipt database until the payment
requirement expires, for no longer than one hour. If the requirement has no
expiry, the task waits ten minutes. While 256 tasks are pending, a new
purchase fails with `GATEWAY_BUSY`; no waiting task is evicted to make room.
An unexpired stored task can survive a restart. The SQLite store deletes
expired tasks when initializing a writable store and when storing or taking
a task. After validating a follow-up message, the adapter atomically takes
the task before running the purchase. A competing payment message or
`CancelTask` that loses the take receives the response for the retained task's
state (see [Tasks](#tasks)). The adapter stores the purchase input but keeps
the parsed AP2 mandate in process memory.
After a restart, a payment for a resource requiring a mandate must carry
`_authorization` again. An otherwise valid payment without it fails with
`AUTHORIZATION_REQUIRED` after the task has been taken. A payment
sent to an instance with its own receipt database also finds no task; the
client gets `TaskNotFoundError` and must start a new purchase.
`GetTask` returns a pending task as it was sent, and the task stays payable.
`CancelTask` ends it without a payment.

These follow-ups return `-32602` and keep the task pending: a malformed payment
message, a `contextId` that differs from the task's, a role other than
`ROLE_USER`, and a malformed `_authorization`. Clients published for this
extension URI send x402 v1 payloads over A2A 0.x. The 0.x role gets `-32602`,
and an x402 v1 payload fails the task with
`x402.payment.error: invalid_x402_version`. A failed receipt always names a
`network`, the requirement's when the error carries none.

If the first message carried no AP2 mandate, the payment message may carry one
in a data part as `{"data": {"input": {"_authorization": {...}}}}`. It is
verified against the stored purchase, and the rest of that part is ignored. A
mandate from the first message takes precedence.

On a resource with [`idempotency.redelivery`](../configuration.md#resources)
(experimental), `x402.payment.required` declares the
[payment identifier](x402.md#payment-identifier). Each pending task accepts one
payment submission; a resend while its record is retained returns
`UnsupportedOperationError`. To retry, start a new task with the same input
and submit a proof with the same `id`. Redelivery completes the new task with
`payment-completed` and the original settlement entry, without another
settlement. If the resource requires a mandate, the new
task must carry the same `_authorization`. A refusal fails the task and records
its `payment_identifier_*` reason in `x402.payment.error`. An in-flight refusal
reports `retryable: false` without `retryAfterSeconds`, because the task has
been consumed. Start a new task with the same payment `id`. For the same refusal,
a `_payment` call reports `retryable: true` and `retryAfterSeconds: 1`.

The extension applies only to x402. An MPP resource still returns a terminal
task.

## Results

These outcomes return a terminal task with one artifact:

| Outcome                           | State                  | Artifact data                                            |
| --------------------------------- | ---------------------- | -------------------------------------------------------- |
| Delivered                         | `TASK_STATE_COMPLETED` | Merchant response and `agent-commerce/delivery` metadata |
| Payment required on terminal path | `TASK_STATE_FAILED`    | Shared payment-required envelope                         |
| Commerce failure                  | `TASK_STATE_FAILED`    | Shared error envelope                                    |

Every `TASK_STATE_FAILED` task has a `ROLE_AGENT` status message. Ordinary
failures and `payment_identifier_*` refusals use the envelope's `message` as
their text. Other extension payment failures summarize the payment outcome.
Only extension status messages carry `metadata` and `extensions`.

With the x402 extension, an unpaid task is `TASK_STATE_INPUT_REQUIRED`; its
payment terms are in the status message metadata. If the client declines,
the task ends with no artifact.

Redelivery sets `redelivered: true` in the artifact's `agent-commerce/delivery`
summary. A non-object merchant body is wrapped as `{ "value": ... }`. Without
the x402 extension, payment required is terminal; the buyer sends a new message
with the proof.

## Tasks

`SendMessage` generates task and context ids with `randomUUID()`, independently
of the gateway's `IdGenerator`. Receipts correlate with tasks through the
artifact's `requestId`. Each new purchase starts a new context containing one
adapter-created task.

The adapter retains task responses in a receipt store with the complete
`task_records` group, including the built-in SQLite store. A durable store
can preserve unexpired records across restarts. Without that group, tasks
stay in process memory under the same limits and are lost on restart.

Records contain the merchant response, status messages and x402 metadata.
Settlement receipts can include the payer address and transaction hash. The
adapter does not separately attach request input, payment proofs or AP2
mandates. Merchant response content is retained without redaction.

`protocols.a2a.tasks.retentionHours` controls how long a task remains readable
after it is stored or updated (default 24 hours). An unpaid x402 extension
task uses the pending-payment expiry described above instead. See
[`protocols.a2a`](../configuration.md#protocolsa2a).

Once the store has `protocols.a2a.tasks.maxRetained` unexpired records (default
1000), it refuses new records and permits replacements. It does not evict
records, even if the limit is lowered. Free calls cannot evict an unexpired
paid result. A new extension purchase at capacity fails with `GATEWAY_BUSY`
without holding a pending purchase. Other blocking responses are returned
without being retained, and the adapter logs at `warn`. Write exceptions are
logged at `error`. Background startup refusals are described below. Retention
changes affect subsequent writes.

### Access

The adapter has no A2A authentication. A task id acts as an access key: anyone
holding it can read the task or request cancellation. An unknown id and
another protocol's task get the same `TaskNotFoundError`. `ListTasks` reads
only the named context and returns no tasks without one. The adapter logs
request ids for correlation; it does not add task or context ids as dedicated
log fields.

### Operations

`GetTask` returns the task without `history`, which the adapter does not keep.
A task waiting for payment retains its x402 metadata and remains payable.

`ListTasks` returns `tasks`, `nextPageToken`, `pageSize` and `totalSize` on
every page. It filters the context's tasks by `status` and the inclusive
`statusTimestampAfter` bound. Tasks are sorted newest first by status timestamp,
then by id in descending order. `totalSize` counts the tasks that match the
filters, and `nextPageToken` is `""` on the last page. Tasks omit `artifacts`
unless `includeArtifacts` is `true`.

`CancelTask` atomically takes a task waiting for an x402 extension payment,
using the same operation as a payment message. Only the call that takes the
pending task proceeds. The canceled task has no artifacts and carries the
status message "Task canceled." Repeating the cancellation returns it
unchanged. A running or finished task returns `TaskNotCancelableError`. If
the canceled task cannot be recorded, the call returns `-32603`; the pending
purchase has already been removed and can no longer be paid.

A `SendMessage` that names a task gets these answers:

| The `taskId` names                                   | Answer                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| a task waiting for payment                           | the payment path above; a missing `contextId` is inferred    |
| a task waiting for payment, with another `contextId` | `-32602`; the task stays payable                             |
| any other kept task, with another `contextId`        | `-32602`                                                     |
| any other kept task                                  | `UnsupportedOperationError`: the task takes no more messages |
| no kept task                                         | `TaskNotFoundError`                                          |

### Background tasks

With `configuration.returnImmediately: true`, `SendMessage` stores and returns
a `TASK_STATE_WORKING` task without waiting for the purchase result.
`GetTask` and `ListTasks` expose the result once recorded: a finished task or
one waiting for an x402 extension payment. The option also lets a payment
submission run in the background. Declined payments and unknown resources
still return failed tasks immediately.

Background work can outlive its HTTP request, so each adapter has a separate
limit of 20 background slots. Startup refusals happen before payment
verification, settlement or backend calls:

- A new purchase returns an unretained failed `GATEWAY_BUSY` task if no slot
  is free or its working record does not fit in the task store.
- A payment submission refused because no slot is free returns JSON-RPC
  `-32603` with a `google.rpc.RetryInfo` delay instead of a task. A failed
  task would be terminal, while this one stays unchanged and payable; resend
  the payment after the delay.
- If storing the working task fails for another reason, the call returns a
  failed task. A payment submission has already taken its pending purchase,
  which is no longer payable.

Graceful shutdown waits for started background work to settle, including its
result-write attempts. `agent-commerce start` then closes the receipt store.

A stored `TASK_STATE_WORKING` task that is absent from this process's running
set is reported by `GetTask` and `ListTasks` as `TASK_STATE_FAILED`. This can
follow a forced shutdown during background work or a failed final-result
write. Its `INTERNAL_ERROR` envelope tells the buyer to check with the
merchant before paying again. Reads do not rewrite the record. This assumes
one gateway per receipt store. `reconcile` and manual resolution update the
payment attempt, not the task.

## Errors

The adapter returns JSON-RPC errors for invalid requests, A2A features it
cannot serve and calls it is too busy to start. Alongside `-32700`, `-32600`,
`-32601`, `-32602` and `-32603`, it uses these A2A codes:

| Code     | A2A error                           | Returned for                                                                                                                         |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `-32001` | `TaskNotFoundError`                 | a task id with no unexpired task, on `GetTask`, `CancelTask` or `SendMessage`                                                        |
| `-32002` | `TaskNotCancelableError`            | `CancelTask` on a running or finished task                                                                                           |
| `-32003` | `PushNotificationNotSupportedError` | the four push notification configuration methods; any non-null `configuration.taskPushNotificationConfig`                            |
| `-32004` | `UnsupportedOperationError`         | other unsupported methods; a non-empty `tenant`; a message on a kept task not waiting for payment; the message features listed below |
| `-32005` | `ContentTypeNotSupportedError`      | a text, file, inline-byte or URL part; a non-JSON `mediaType`; an `acceptedOutputModes` list that excludes JSON                      |
| `-32009` | `VersionNotSupportedError`          | an unsupported version; a missing header and parameter, or an empty header, is treated as `0.3`                                      |

Multipart messages, a `contextId` without a task and non-empty
`referenceTaskIds` return `-32004`. Missing `messageId` or a non-user role
returns `-32602`. A request without an `id` returns `-32600` without running.
Each A2A error carries a `google.rpc.ErrorInfo` in `error.data`, with a reason
such as `VERSION_NOT_SUPPORTED` and the domain `a2a-protocol.org`.

## Pins

<!-- support-record:begin pins -->

| Pin                      | Value                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Pinned revision          | v1.0.1; negotiation `1.0`; `JSONRPC` binding                                                                 |
| Upstream source          | [`a2aproject/A2A@33035925`](https://github.com/a2aproject/A2A/tree/3303592588e388e62e0f69f701af531d2f4e3991) |
| Declared stable upstream | yes                                                                                                          |
| Upstream wording         | "the first stable, production-ready version" (read 2026-11-17)                                               |
| `@a2a-js/sdk`            | `1.3.0`, tests only                                                                                          |

<!-- support-record:end -->

## Deviations

Each entry cites the section of the pinned revision the gateway departs from
and the tests that verify the behavior.

<!-- support-record:begin deviations -->

- **A2A 1.0.1 §5.7; `ListTasksResponse.tasks`**: A `ListTasks` page with no matching task has an empty `tasks` array. The proto marks `tasks` REQUIRED, and §5.7 requires a REQUIRED array to hold an element, but an empty result has none to return. Tests: `tests/conformance/a2a/tasks.test.ts`.

<!-- support-record:end -->

## A2A exclusions

The A2A descriptor in `GET /.well-known/agent-commerce` lists these names in
`unsupported`, and `agent-commerce doctor` prints them when A2A is enabled:

<!-- support-record:begin exclusions -->

- `SendStreamingMessage`
- `SubscribeToTask`
- `CreateTaskPushNotificationConfig`
- `GetTaskPushNotificationConfig`
- `ListTaskPushNotificationConfigs`
- `DeleteTaskPushNotificationConfig`
- `GetExtendedAgentCard`
- `HTTP+JSON/REST binding`
- `gRPC binding`
- `SSE`
- `resuming a background task after a restart`: A task the gateway stopped in reads as failed; any payment is in the gateway records.
- `task resumption other than an x402 extension payment`
- `push notifications`
- `multi-turn conversational continuation`
- `client-chosen contextId`: A `contextId` without a task gets `UnsupportedOperationError`; each new task opens a context the gateway generates.
- `listing tasks across contexts`: `ListTasks` reads only the given `contextId`; without one, the page is empty.
- `task history`: Tasks omit `history`; `historyLength` is validated but has nothing to cap.
- `non-empty tenant`
- `text parts`
- `file and URL parts (including inline bytes)`
- `multi-part messages`
- `message roles other than ROLE_USER`
- `authenticated extended agent cards`
- `A2A authentication schemes`
- `artifact types beyond Agent Commerce outcome data`
- `tasks across gateway instances`: Instances with separate receipt stores cannot read, cancel or pay each other's tasks.

<!-- support-record:end -->

Only a task waiting for an x402 extension payment accepts another message.

The A2A adapter accepts `_payment` but does not verify or settle payments
or call merchant backends. `@a2a-js/sdk` is a test-only dependency.
