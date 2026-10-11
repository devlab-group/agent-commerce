# A2A

**Experimental.** Enable with `protocols.a2a.enabled: true`.

| Property      | Value                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Binding       | JSON-RPC 2.0 over HTTP(S)                                                                                                         |
| Method        | `SendMessage`, not legacy `message/send`                                                                                          |
| Version       | `A2A-Version: 1.0` header, or an `A2A-Version` query parameter when the header is absent; patch suffixes are accepted but ignored |
| Agent Card    | `GET /.well-known/agent-card.json`                                                                                                |
| Default mount | `/a2a`                                                                                                                            |
| Task model    | synchronous; terminal except an unpaid x402 extension task                                                                        |

Each A2A resource becomes an Agent Card skill. Paid skills have a `paid` tag
and a price in their description. A2A v1.0 has no input-schema field for
skills, so each skill includes an illustrative JSON call example with
required input. The agent description explains the call shape and points to
`<publicBaseUrl>/api/resources` for input schemas. It also names
`input._payment` when any skill is paid. Enabling the adapter requires at
least one A2A resource.

The card has a content-based `ETag` and `Cache-Control: public, max-age=300`.
A matching `If-None-Match` request receives `304` without a body.

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

## x402 extension

A client activates the extension with
`A2A-Extensions: https://github.com/google-a2a/a2a-x402/v0.1` and can then
pay without `_payment`. The gateway uses x402 v2 documents from the
[x402 A2A transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/a2a.md).
Its examples use lowercase task states and roles, `kind` on parts, and the
`X-A2A-Extensions` header. This gateway uses the A2A 1.0 forms:
`TASK_STATE_INPUT_REQUIRED`, `ROLE_AGENT`, parts without `kind`, and
`A2A-Extensions`. The Agent Card advertises the extension as optional, with
`params: { "x402Version": 2 }`, when x402 is a skill's selected payment rail.

A response carries the `A2A-Extensions` header when its task status message
lists the extension: the input-required task, and every task answered to a
payment message, even one sent without the header. Other responses, such as an
MPP skill's task or a JSON-RPC error, omit it. An extension status message
carries `contextId`, `taskId`, `extensions: [<extension URI>]` and the
`x402.payment.*` metadata.

1. An x402 paid call without a proof returns `TASK_STATE_INPUT_REQUIRED`. The status
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

The gateway holds unpaid tasks in process memory until the payment
requirement expires, for no longer than one hour. If the requirement has no
expiry, the task waits ten minutes. While 256 tasks are pending, a new
purchase fails with `GATEWAY_BUSY`; no waiting task is evicted to make room.
A restart or a payment routed to another instance loses the task;
the client receives `TaskNotFoundError` and must start a new purchase.
`GetTask` and `CancelTask` also answer `TaskNotFoundError` for a pending task,
which stays payable.

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

The extension applies only to x402. An MPP resource still returns a terminal
task.

## Results

These outcomes return a terminal task with one artifact:

| Outcome                           | State                  | Artifact data                                            |
| --------------------------------- | ---------------------- | -------------------------------------------------------- |
| Delivered                         | `TASK_STATE_COMPLETED` | Merchant response and `agent-commerce/delivery` metadata |
| Payment required on terminal path | `TASK_STATE_FAILED`    | Shared payment-required envelope                         |
| Commerce failure                  | `TASK_STATE_FAILED`    | Shared error envelope                                    |

Every `TASK_STATE_FAILED` task has a `ROLE_AGENT` status message whose text is
the envelope's `message`; after an extension payment, the text summarizes the
payment outcome instead. Only extension status messages carry `metadata` and
`extensions`.

With the x402 extension, an unpaid task is `TASK_STATE_INPUT_REQUIRED`; its
payment terms are in the status message metadata. If the client declines,
the task ends with no artifact.

A non-object merchant body is wrapped as `{ "value": ... }`. Without the x402
extension, payment required is terminal; the buyer sends a new message with
the proof.

The adapter returns JSON-RPC errors for invalid requests and A2A features it
cannot serve. Alongside `-32700`, `-32600`, `-32601`, `-32602` and `-32603`, it
uses these A2A codes:

| Code     | A2A error                           | Returned for                                                                                    |
| -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `-32001` | `TaskNotFoundError`                 | an unknown, expired or completed `taskId`; `GetTask` and `CancelTask` for any id                |
| `-32003` | `PushNotificationNotSupportedError` | the four push notification configuration methods                                                |
| `-32004` | `UnsupportedOperationError`         | other unsupported methods and message features listed below                                     |
| `-32005` | `ContentTypeNotSupportedError`      | a text, file, inline-byte or URL part, or a non-JSON `mediaType`                                |
| `-32009` | `VersionNotSupportedError`          | an unsupported version; a missing header and parameter, or an empty header, is treated as `0.3` |

Multipart messages, a `contextId` and non-empty `referenceTaskIds` return
`-32004`. Missing `messageId` or a non-user role returns `-32602`. A request
without an `id` returns `-32600` without running. Each A2A error carries a
`google.rpc.ErrorInfo` in `error.data`, with a reason such as
`VERSION_NOT_SUPPORTED` and the domain `a2a-protocol.org`.

## A2A exclusions

Unsupported methods are `SendStreamingMessage`, `GetTask`, `ListTasks`,
`CancelTask`, `SubscribeToTask`, the four task-push-notification-config
methods and `GetExtendedAgentCard`. The adapter also excludes REST and gRPC
bindings, SSE, persistent tasks, task continuation beyond the pending x402
payment, push delivery, multi-turn continuation, authenticated
extended cards, A2A authentication and other artifact types.

The A2A adapter accepts `_payment` but does not verify or settle payments
or call merchant backends. `@a2a-js/sdk` is a test-only dependency.
