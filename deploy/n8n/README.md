# n8n template

`summarize-url.json` sells a web page summary behind the gateway. Setup, behavior and limits are in [docs/n8n.md](../docs/n8n.md).

The export contains no credentials, credential names or ids, pinned data or deployment-specific webhook URL. It keeps the webhook path (`summarize-url`) and the `webhookId` n8n uses to register it.

## Test notes

Tested on n8n 2.47.6 (`n8nio/n8n:2.47.6`):

- A fresh `n8n import:workflow --input=summarize-url.json` imports without errors; `Receive paid request` and `Chat model` show the expected missing-credential warnings.
- With a Header Auth credential and an OpenAI-compatible stub in place of a real model: no secret or a wrong secret gets 403; an empty body, a non-string `url`, `http://`, `localhost`, an IP literal, `*.internal` and a URL with user info get 400; an unresolvable host, a page that returns 404 and an unreachable model get 502; `https://example.com` gets 200 with `{ url, summary }`.
- Through a gateway on a local chain, bad input (backend 400) and a backend error (502) settle nothing, and the valid call settles 0.02 USDC.
- `Validate input` was changed to `caseSensitive: false` after these runs. For n8n 2.47.6, review of the `n8n-workflow` 2.47.2 source showed that this lowercases the URL for both checks without changing the regex patterns. The change has not been tested at runtime.
- Still untested: summary quality, the chat model node with a real provider, and the n8n Creator Hub submission checks.
