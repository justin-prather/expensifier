# AI classification provider decision

Decision date: 2026-08-21

## Decision

Expensifier uses DeepSeek V4 Flash through OpenCode Zen's OpenAI-compatible Chat Completions API. The
default model is `deepseek-v4-flash`; deployments may override the model and endpoint through
environment variables. DeepSeek JSON mode guarantees a JSON object, while Expensifier enforces the
required schema and candidate IDs locally. The provider remains replaceable through
`ClassificationService`, and no provider types cross that service boundary.

## Evaluation method

The sanitized fixtures in `src/lib/server/fixtures/classification/` form the manual evaluation corpus
for normalized OCR scenarios. They contain no receipt, filename, path, raw provider response, tax
identifier, or real organization data. Automated tests separately enforce the production projection,
request envelope, response limit, and strict candidate-ID validation.

The candidates were compared on the requirements below. Scores are relative (1 poor, 5 strong),
not a live latency benchmark. Pricing and model latency change frequently and must be rechecked
before changing the configured model.

| Candidate                                   | Accuracy fit | Structured output | Privacy controls | Relative cost | Relative latency | Integration score |
| ------------------------------------------- | -----------: | ----------------: | ---------------: | ------------: | ---------------: | ----------------: |
| OpenCode Zen / DeepSeek V4 Flash            |            4 |                 4 |                5 |             5 |                5 |                 5 |
| OpenAI Responses API / GPT-4.1 mini         |            4 |                 5 |                4 |             4 |                4 |                 5 |
| Anthropic Messages API / Claude Haiku class |            4 |                 4 |                4 |             4 |                4 |                 4 |
| Google Gemini API / Flash class             |            4 |                 4 |                4 |             5 |                5 |                 4 |

DeepSeek V4 Flash through OpenCode Zen was selected for its low cost, low latency, JSON output mode,
and Zen's stated zero-retention policy for this model. The integration uses direct `fetch` without an
SDK. OpenAI, Anthropic, and Gemini remain viable replacement Layers if fixture accuracy, deployment
policy, cost, or measured latency favors them later.

## Privacy boundary

`projectStructuredOcr` constructs a new allow-listed object. The request contains only:

- merchant, date, total, tax, currency, and line-item normalized values with confidence;
- active payment-account, category, and client IDs/names;
- `{ "matched": false }` deterministic-rule context.

The original document, filename, filesystem path, raw OCR JSON, OCR source paths, credentials, and
audit history are impossible to reach from `ClassificationService.classify`'s input type. Provider
responses are accepted only when every non-null ID exists in the supplied candidate set. Requests
use DeepSeek JSON mode and are covered by OpenCode Zen's stated zero-retention policy.

## Operations

- Secret: `CLASSIFICATION_API_KEY` (environment only).
- Non-secret overrides: `CLASSIFICATION_ENDPOINT`, `CLASSIFICATION_MODEL`, timeout, response limit.
- Provider failures never change local expense status or prevent manual review.
- Durable retries are bounded by the shared job retry policy.
- Suggestions and explicit reviewer outcomes are retained locally and appended to audit history.
