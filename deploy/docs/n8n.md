# n8n workflow template

`deploy/n8n/summarize-url.json` sells web page summaries through the gateway using standard n8n nodes. With the demo gateway price, an agent pays 0.02 USDC for a short summary of a public HTTPS URL. The workflow was tested on n8n 2.47.6.

## Setup

1. Import `deploy/n8n/summarize-url.json` into n8n (Workflows, Import from file).
2. Create a Header Auth credential whose header name is `X-Gateway-Secret` and whose value is a long random secret. Select it in `Receive paid request`.
3. Attach your own chat model credential to `Chat model`, or replace that node with another chat model.
4. Activate the workflow. Its production URL ends in `/webhook/summarize-url`.
5. Deploy a gateway with a resource that calls that URL and sends the same secret. The demo configuration `deploy/testnet-demo/config.yaml` defines `summarize_url` this way, with `N8N_WEBHOOK_URL` and `GATEWAY_SHARED_SECRET`; see [the demo README](https://github.com/devlab-group/agent-commerce/blob/master/deploy/testnet-demo/README.md). For gateway setup, see [Deploy Agent Commerce Gateway](deploy.md).

## What a buyer sees

| Case                                  | n8n answers | Buyer receives from the gateway  | Payment |
| ------------------------------------- | ----------- | -------------------------------- | ------- |
| Valid public https URL                | 200         | 200 with `{ url, summary }`      | settled |
| URL fails the check (http, IP, local) | 400         | 502 `BACKEND_ERROR` (status 400) | none    |
| Page or model call fails              | 502         | 502 `BACKEND_ERROR` (status 502) | none    |
| Missing or wrong secret               | 403         | 502 `BACKEND_ERROR` (status 403) | none    |

The gateway hides backend error bodies and reports non-2xx backend responses as `BACKEND_ERROR`. With the default `authorization` payment flow, these failures settle nothing. With `paymentFlow: upfront`, payment settles before n8n runs and remains settled if the workflow fails.

## Limits

- `Fetch page` disables redirects and uses a 10-second timeout. It downloads the full response before the prompt expression strips markup and truncates the text to the limit in `Set service options`.
- The URL check requires an `https://` URL with a dotted domain name. It rejects IP literals and blocks `.local`, `.localhost`, `.internal`, `.lan` and `.home.arpa` suffixes regardless of case. It does not check DNS results or guarantee that a destination is public. Run n8n where private networks are unreachable.
- The page text is sent to your model. The prompt tells it to ignore instructions in that text; keep the model without tools.
