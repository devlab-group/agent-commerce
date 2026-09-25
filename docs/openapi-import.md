# OpenAPI import

`agent-commerce import openapi` converts a local OpenAPI document into
reviewable Agent Commerce resource drafts:

```text
OpenAPI document -> importer -> resource drafts -> config.yaml -> canonical model
```

The generated file is configuration, not a second runtime path. Review it, add
commerce policy and credentials, then merge it into `config.yaml`. The gateway
does not read the OpenAPI document again.

The importer is experimental. It supports common REST shapes and skips or
refuses shapes the gateway cannot represent safely.

## Workflow

```bash
agent-commerce import openapi openapi.yaml
```

Then:

1. Review the generated resources.
2. Add `pricing`, unless you passed `--free`.
3. Add `expose`, unless you passed `--expose`.
4. Add backend credentials under `backend.headers` using `${ENV_VAR}`
   placeholders.
5. Merge the fragment under `resources:` in `config.yaml`.
6. Run `agent-commerce validate`.
7. Run `agent-commerce doctor`.

Without both pricing and exposure, the draft does not pass config validation.
OpenAPI does not say what an operation costs or which agent surfaces should
publish it.

### Options

| Option | Effect |
| --- | --- |
| `--output <path>` | Write to this path. The default is `<source-stem>.agent-commerce.yaml` in the working directory |
| `--force` | Replace an existing output file. Without it, an existing file stops the run |
| `--base-url <url>` | Override document `servers` entries. The value must be absolute HTTP(S), with no query or fragment |
| `--operation <id>` | Import a matching `operationId` or generated resource id. Repeatable; an unmatched value fails the run |
| `--tag <tag>` | Import operations carrying any named tag. Repeatable |
| `--free` | Add `pricing: { type: free }` |
| `--expose <list>` | Add a comma-separated `expose` list from `http,mcp,a2a,acp` |
| `--strict` | Treat any warning as a failed run |
| `--json` | Print a machine-readable summary |

To use an imported resource for ACP, enable `protocols.acp` and map the resource
to one checkout operation. Each mapped resource must be free at the Agent
Commerce layer; `--expose acp` only adds the exposure.

The command exits `0` after a successful import, including one with warnings.
It exits `1` for load, import or write errors; an invalid `--expose` value;
unmatched `--operation` values; no supported operations; an existing output
without `--force`; or warnings under `--strict`. Failed runs do not write an
output file.

## Generated shape

For example, `POST /users/{userId}/orders?notify=true` with a JSON body becomes:

```yaml
resources:
  # REVIEW: pricing and exposure are not inferred from OpenAPI. Add e.g.
  #   pricing: { type: free }   # or { type: fixed, amount: "0.01", currency: USDC } with payments: [x402]
  #   expose: [http]           # http | mcp | a2a | acp
  createOrder:
    name: Create an order
    description: Create an order
    input:
      type: object
      properties:
        path:
          type: object
          properties:
            userId:
              type: string
          required:
            - userId
          additionalProperties: false
        query:
          type: object
          properties:
            notify:
              type: boolean
          required:
            - notify
          additionalProperties: false
        body:
          type: object
          properties:
            productId:
              type: string
            quantity:
              type: integer
          required:
            - productId
          additionalProperties: false
      required:
        - path
        - query
        - body
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

Path, query and body fields use separate namespaces, so equal parameter names
cannot collide. `backend.inputBindings` tells the executor how to build the
request; see [configuration.md](configuration.md#backendinputbindings).

Resource ids come from normalized `operationId` values, or from
`<method>_<path>` when no usable operation id exists. They do not use counters
or random suffixes. If two operations produce the same id, import fails and
names both operations.

## Support matrix

| Feature | Status |
| --- | --- |
| OpenAPI 3.0, 3.1 and 3.2 | supported |
| Swagger 2.0 | unsupported; convert first |
| local YAML or JSON source | supported |
| remote URL source | unsupported |
| internal `$ref` | supported for path items, parameters, request bodies, schemas, responses and servers; OpenAPI 3.2 media-type object references are also supported |
| external file or URL `$ref` | refused |
| GET, POST, PUT, PATCH, DELETE | supported |
| HEAD, OPTIONS, TRACE, QUERY and other methods | skipped with a warning |
| path parameters | primitive values using default `simple` style |
| query parameters | primitive values using default `form` style |
| `deepObject`, `spaceDelimited`, `pipeDelimited` | unsupported |
| object/array parameters or parameter `content` | unsupported |
| `application/json` request body | supported |
| `application/*+json` request body | supported with a static `Content-Type` header |
| multipart, form-urlencoded, binary or streaming bodies | unsupported |
| body on GET or DELETE | omitted with a warning |
| dynamic header or cookie parameters | unsupported |
| security credential import | unsupported |
| output schema | one deterministically selected explicit 2xx JSON response |

An unsupported required parameter or body normally skips the operation. GET and
DELETE bodies are always omitted with a warning, even when marked required. An
unsupported optional feature is also omitted with a warning. This avoids
producing a paid resource that calls the merchant with the wrong request shape.

### Schemas

The importer carries this structural subset:
`type` (including OpenAPI 3.0 `nullable`), `properties`, `required`,
`additionalProperties`, `enum` and `items`, plus `title`, `description`,
`default`, `example`, `examples` and `deprecated`.

An object with `properties` is closed unless the source sets
`additionalProperties`; a bare `type: object` stays open. A body with no schema
is explicitly open. A merged `allOf` object is closed unless a branch sets
`additionalProperties: true`, which keeps the merge open. The config loader
later closes schema nodes that still omit `additionalProperties`, so the loaded
resource can be stricter than the generated draft and the OpenAPI source.

Unenforced constraints such as `pattern`, `format`, `minimum`,
`maxLength` and tuple-form `items` are dropped and reported. See
[configuration.md](configuration.md#unsupported-json-schema-keywords-have-a-cost).

Compatible object branches in `allOf` are merged. A branch with a schema-valued
`additionalProperties`, conflicting branches, `oneOf`, `anyOf`, `not`,
`discriminator` and reference cycles make a schema unsupported. A required
parameter or required request body then causes the operation to be skipped,
except that GET and DELETE bodies are always omitted with a warning. An optional
unsupported input is omitted with a warning. An unsupported output schema is
omitted without dropping the operation.

## Security properties

The importer accepts local files only, executes nothing from a document, and
makes no network requests. It refuses sources larger than 10 MiB before parsing
and rejects every external `$ref`
before the OpenAPI validator runs. Internal references are resolved lazily with
cycle and depth checks.

Backend hosts come from operator-supplied `servers` entries or `--base-url`.
A relative or malformed server URL, a non-HTTP(S) URL, or one with a query or
fragment skips that operation with a diagnostic for that condition. Other
supported operations may still be written and the run may exit `0`; request
input never selects the backend host.

OpenAPI security declarations produce a warning and a review comment. The
importer does not copy credentials or security-scheme data. Schema examples
are retained as data where supported. Add operator credentials yourself, for
example:

```yaml
backend:
  headers:
    Authorization: Bearer ${BACKEND_TOKEN}
```

OpenAPI header parameters named `Accept`, `Content-Type` or `Authorization`
are ignored as transport or operator concerns. Security schemes never become
agent input.

Descriptions and examples are serialized as data where supported. Vendor
extensions are ignored and cannot alter pricing, payments, backend URLs or
exposure. The importer does not merge output into `config.yaml`, but
`--output config.yaml --force` can deliberately replace that file. Output
replacement requires `--force`, and writes use a temporary sibling followed by
rename.

See [security.md](security.md#openapi-import) for the threat model.

## Operational limits

- Multi-file documents must be bundled before import.
- For output discovery, the importer first keeps explicit 2xx responses with
  JSON content, then selects `200`, `201`, `202`, or another status in ascending
  order. If that response has no schema, the importer warns and omits the
  output. If its schema cannot be converted, it also warns and omits the output.
  It does not fall back to another response. The warning about other JSON
  success responses is emitted only when the selected schema converts.
- The CLI can generate only free pricing. Fixed prices are a manual edit.
- Re-import replaces an output file when `--force` is present; it never merges.
  Generate to a new path when you want a reviewable diff.

## Code map

Core importer code is under `src/openapi/`; command registration and handling
live under `src/cli/`:

| File | Responsibility |
| --- | --- |
| `load.ts` | read, parse and validate the local document; reject external references |
| `refs.ts` | resolve internal references |
| `discover.ts` | find operations, ids and server URLs |
| `schema.ts` | convert schemas |
| `request.ts` | map parameters and JSON bodies |
| `draft.ts` | build drafts and render YAML |
| `src/cli/program.ts` | register the command and define its flags |
| `src/cli/commands/import-openapi.ts` | handle the command |
