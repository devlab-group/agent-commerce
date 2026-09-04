# OpenAPI import

`agent-commerce import openapi` reads an OpenAPI description and writes Agent
Commerce resource drafts. The output is configuration. You review it, fill in
the parts OpenAPI cannot tell us, and merge it into `config.yaml`; from there
an imported resource is handled exactly like one you typed by hand.

```text
OpenAPI document -> importer -> resource drafts -> config.yaml -> canonical model
```

The importer stops at that boundary. There is no second executor, `src/core`
contains no OpenAPI type, and once the drafts are written nothing reads the
document again.

The feature is experimental. It handles the shapes most REST APIs are built
from and refuses the rest instead of approximating them, so check the
[support matrix](#support-matrix) before assuming a document will import whole.

## Workflow

```bash
agent-commerce import openapi openapi.yaml
```

Then work through the generated file:

1. read the resources it produced, which describe the API shape and nothing else;
2. decide pricing, free or a fixed amount and currency;
3. decide exposure: `http`, `mcp`, `a2a`;
4. add backend authentication under `backend.headers`, using `${ENV_VAR}`
   placeholders rather than a literal credential;
5. merge the resources into `config.yaml` under `resources:`;
6. run `agent-commerce validate`;
7. run `agent-commerce doctor`.

The generated file is a `resources:` fragment with review comments above each
entry. Unless you passed `--free` and `--expose`, it has no `pricing` or
`expose` keys at all and will not load until steps 2 and 3 have happened. An
OpenAPI document says nothing about what an operation costs or who should see
it, and a wrong guess either gives a merchant's endpoint away or publishes it
to an agent network.

### Options

| Option | Effect |
| --- | --- |
| `--output <path>` | default `<source-stem>.agent-commerce.yaml` in the working directory |
| `--force` | overwrite an existing output file; without it, an existing file stops the run |
| `--base-url <url>` | backend base URL, overriding every `servers` entry. Must be absolute `http(s)` with no query or fragment |
| `--operation <id>` | import only this operation (repeatable; matches `operationId` or the generated id). One that matches nothing fails the run |
| `--tag <tag>` | import only operations carrying this tag (repeatable, OR-ed) |
| `--free` | write `pricing: { type: free }` |
| `--expose <list>` | write `expose:`, comma-separated `http,mcp,a2a` |
| `--strict` | any warning fails the run |
| `--json` | machine-readable summary instead of the report |

The command exits `0` on success, warnings included. It exits `1` on a fatal
load, import or write error, on an `--operation` that matched nothing, when no
supported operation was imported, and on any warning under `--strict`. A failed
run writes no file, so the next command cannot pick up half an import.

## What a draft looks like

`POST /users/{userId}/orders?notify=true` with a JSON body becomes:

```yaml
resources:
  # REVIEW: pricing and exposure are not inferred from OpenAPI. Add e.g.
  #   pricing: { type: free }
  #   expose: [http]
  createOrder:
    name: Create an order
    input:
      type: object
      properties:
        path:
          type: object
          properties:
            userId: { type: string }
          required: [userId]
          additionalProperties: false
        query:
          type: object
          properties:
            notify: { type: boolean }
          required: [notify]
          additionalProperties: false
        body:
          type: object
          properties:
            productId: { type: string }
            quantity: { type: integer }
          required: [productId]
          additionalProperties: false
      required: [path, query, body]
      additionalProperties: false
    backend:
      type: http
      method: POST
      url: https://api.example.com/users/{userId}/orders
      inputBindings:
        path: path
        query: query
        body: body
```

Each location gets its own namespace, so a `?id=` and a `{id}` in the same
operation cannot collide, and `backend.inputBindings` tells the executor where
to read each part of the request from. See
[configuration.md](configuration.md#backendinputbindings).

Resource ids are stable across runs. An id comes from `operationId`, normalised
to the allowed character set, or from `<method>_<path>` when the operation has
none. Counters and random suffixes are never used, because an agent discovers
an id and then hard-codes it. If two operations resolve to the same id the
import fails and names both, rather than quietly renaming one of them.

## Support matrix

| Feature | Status |
| --- | --- |
| OpenAPI 3.0 | supported |
| OpenAPI 3.1 | supported |
| OpenAPI 3.2 | supported |
| Swagger 2.0 | unsupported, convert first |
| YAML source | supported |
| JSON source | supported |
| internal `$ref` | supported |
| external `$ref` (file or URL) | unsupported, refused |
| remote URL source | unsupported |
| GET, POST, PUT, PATCH, DELETE | supported |
| HEAD, OPTIONS, TRACE, QUERY, other | skipped with a warning |
| path parameters | supported subset: primitive, default (`simple`) style |
| query parameters | supported subset: primitive, default (`form`) style |
| `deepObject`, `spaceDelimited`, `pipeDelimited` | unsupported |
| object/array parameters, parameter `content` form | unsupported |
| `application/json` body | supported |
| `application/*+json` body | supported, with a static `Content-Type` header |
| multipart, form-urlencoded, binary, streaming bodies | unsupported |
| body on GET/DELETE | omitted with a warning; the gateway sends none |
| dynamic header parameters | unsupported |
| cookie parameters | unsupported |
| security credential import | unsupported, deliberately |
| output schema | one deterministic 2xx JSON response |

When an operation requires something from that list that the gateway cannot
represent, the whole operation is skipped. When the same thing is optional, it
is left out and you get a warning. Approximating it would produce a resource
that looks importable, takes payment, and then calls the backend wrongly, which
on a paid resource means a buyer pays for a request the merchant never receives
correctly.

### Schemas

Schemas are converted to the subset the gateway enforces: `type` (with 3.0
`nullable` folded into a union type), `properties`, `required`,
`additionalProperties`, `enum` and `items`, plus the descriptive `title`,
`description`, `default` and `example`/`examples`.

Anything else is dropped and listed in the import warnings. That includes
`pattern`, `format`, `minimum`, `maxLength` and tuple-form `items`. Copying
them through would advertise validation to agents that no code performs; see
[configuration.md](configuration.md#unsupported-json-schema-keywords-have-a-cost)
for what that costs you.

An `allOf` of compatible object schemas is merged. A branch conflict,
`oneOf`, `anyOf`, `not`, `discriminator` or a reference cycle makes a request
schema unsupported and skips the operation. In an output schema the same cases
only omit the schema, since output is descriptive and carries no request
safety.

## Security model

The importer reads a local document that the operator supplied. There is no
remote source option, and it makes no network requests of its own. Every `$ref`
is checked before the validator sees the document, and an external one
(`https://example.com/types.yaml`, `./types.yaml`, `file:///tmp/types.yaml`) is
refused by name. Internal references resolve lazily with cycle detection, so a
recursive schema produces a diagnostic instead of expanding until the process
runs out of memory.

Backend hosts come from the document's `servers` or from `--base-url`, both
operator input at import time. A relative or unresolvable server URL is refused
rather than guessed from the filename, and agent input never contributes to a
backend host. See [security.md](security.md#ssrf).

No credential is ever imported. An operation that declares OpenAPI security
gets a warning and a review comment asking you to add
`backend.headers: { Authorization: Bearer ${BACKEND_TOKEN} }` yourself. The
scheme name, the header name and any example value stay out of the generated
file, and a security scheme never becomes agent-supplied input. Header
parameters named `Accept`, `Content-Type` or `Authorization` are ignored, as
the OpenAPI specification requires; they are transport and operator concerns.

Descriptions, examples and vendor `x-` extensions are data. They are either
serialised into YAML or dropped, nothing in a document is executed, and no `x-`
extension can change pricing, payments, the backend URL or protocol exposure.
The output file is never overwritten without `--force`, and `config.yaml` is
never modified.

## Limitations worth knowing before you start

Multi-file descriptions do not work. Bundle them first with `redocly bundle` or
`swagger-cli bundle`, then import the single file.

Only one success response is used: `200`, then `201`, `202`, then the remaining
explicit 2xx codes in ascending order. Status-dependent unions are not
modelled, and when several responses carry a JSON body the import warns and
names the one it took.

The only pricing the CLI writes is `--free`. Per-operation prices are a manual
edit.

Re-importing overwrites, it never merges. The importer does not edit an
existing file, so run it into a new path and diff the two.

## Where the code lives

Everything lives under `src/openapi/`: `load.ts` reads and validates the
document and refuses external refs, `refs.ts` resolves internal references,
`discover.ts` finds operations and works out ids and server URLs, `schema.ts`
converts schemas, `request.ts` turns parameters and the request body into an
input schema plus bindings, and `draft.ts` builds the resource drafts and
renders the YAML. The command itself is
`src/cli/commands/import-openapi.ts`.
