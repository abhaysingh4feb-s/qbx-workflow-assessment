# Incident Notifier Workflow -- Technical Notes

## How to Run

### Prerequisites
- Node.js 18+
- n8n installed locally (`npm install -g n8n` or via Docker)

### Steps

1. **Install dependencies** (from repo root):
   ```bash
   npm install
   ```

2. **Start the offline mock servers**:
   ```bash
   npm run mocks
   ```
   This starts:
   - Slack mock on `http://localhost:4010`
   - Microsoft Graph mock on `http://localhost:4020`

3. **Start n8n** (in a separate terminal):
   ```bash
   NODE_FUNCTION_ALLOW_BUILTIN=* NODE_FUNCTION_ALLOW_EXTERNAL=* n8n start
   ```
   > **Why the env vars?** n8n 2.x sandboxes Code nodes and blocks `require()` by default. The Send Notifications node uses `require('axios')` for HTTP calls with custom retry logic (status-code-aware backoff). These env vars enable that. The axios library is already bundled as an n8n dependency -- no additional install needed.

4. **Import the workflow**:
   - Open n8n at `http://localhost:5678`
   - Go to **Workflows > Import from File**
   - Select `submission/workflow.json`
   - **Activate** the workflow (toggle in top-right)

5. **Test with sample incidents**:
   ```bash
   # Valid P2 incident
   curl -X POST http://localhost:5678/webhook/incident \
     -H "Content-Type: application/json" \
     -d @fixtures/incidents/INC-10001.json

   # Valid P1 incident
   curl -X POST http://localhost:5678/webhook/incident \
     -H "Content-Type: application/json" \
     -d @fixtures/incidents/INC-10002.json

   # Invalid incident (missing createdAt) -- triggers validation error
   curl -X POST http://localhost:5678/webhook/incident \
     -H "Content-Type: application/json" \
     -d @fixtures/incidents/INC-10003.json

   # Replay INC-10001 -- should return "skipped/duplicate"
   curl -X POST http://localhost:5678/webhook/incident \
     -H "Content-Type: application/json" \
     -d @fixtures/incidents/INC-10001.json
   ```

6. **Test with failure injection** (restart mocks with env vars):
   ```bash
   SLACK_FAIL_429_N=2 npm run mocks
   ```
   Then POST INC-10001 again -- the workflow retries Slack twice (429), succeeds on the 3rd attempt.

---

## Workflow Architecture

```
Webhook (POST /incident)
  |
  v
Normalize Incident (Code node)
  |
  v
IF Valid? --------(invalid)--------> Handle Validation Error
  |                                   [persists failure, returns error]
  (valid)
  |
  v
Check Idempotency (Code node)
  |
  v
IF Duplicate? ---(is duplicate)----> Return Duplicate Response
  |                                   [returns "already processed"]
  (new)
  |
  v
Send Notifications (Code node)
  |   Slack + O365 in parallel via Promise.allSettled
  |   Custom retry with exponential backoff
  v
Process Results (Code node)
  |   Records dedupe key on full success
  |   Persists failure records on any failure
  v
Webhook Response
```

**Total: 9 nodes** (Webhook, Normalize, IF Valid, Handle Validation Error, Check Idempotency, IF Duplicate, Return Duplicate Response, Send Notifications, Process Results)

---

## Retry / Backoff Implementation

Implemented as a custom `sendWithRetry()` function inside the **Send Notifications** Code node using `require('axios')` with `validateStatus: () => true` (to receive all status codes without throwing). This approach was chosen over n8n's built-in "Retry On Fail" because:

- n8n's built-in retry retries on **all** errors (including 400, 401) -- the requirement says do NOT retry on non-429 4xx.
- n8n's built-in retry uses a **fixed delay**, not exponential backoff.
- `fetch` is not available in n8n 2.x Code node sandbox; `axios` is used via `require('axios')` (bundled n8n dependency).

### Retry parameters

| Parameter | Value |
|-----------|-------|
| Max attempts | 5 |
| Base delay | 500ms |
| Backoff strategy | Exponential: 500ms, 1s, 2s, 4s, 8s |
| Retryable status codes | `429` (rate limited), `500-599` (server errors) |
| Non-retryable | All other `4xx` (400, 401, 403, etc.) -- fails immediately |
| Network errors | Treated as retryable |

### Parallel execution

Both Slack and O365 notifications fire in parallel using `Promise.allSettled()`. This ensures:
- One channel's failure/retry does not block the other
- Both results are always captured regardless of success/failure

---

## Dedupe / Idempotency Implementation

### DedupeKey Formula

```
dedupeKey = `${incidentId}|${severity}|${title}`
```

**Rationale**: This composite key uniquely identifies an incident event. If the same incident is replayed with identical ID, severity, and title, it is treated as a duplicate. A severity change (e.g., P2 -> P1 escalation) produces a different key -- this is intentional, as a severity change is a meaningful update that should trigger new notifications.

### Storage mechanism

Uses n8n's built-in **`$getWorkflowStaticData('global')`** -- a native persistence mechanism that stores data in n8n's internal database (SQLite by default). This was chosen over file-based storage (`require('fs')`) because:

- n8n Code nodes are sandboxed -- `require()` is blocked by default
- `$getWorkflowStaticData` works out of the box with zero configuration
- Data persists across workflow executions
- Works in all n8n deployment modes (npm, Docker, desktop)

### Write timing

The dedupeKey is recorded **only after both Slack and O365 succeed**. If either channel fails, the key is NOT written, allowing the incident to be retried later. This prevents the scenario where a partial success is recorded as "done" while one channel never received the notification.

### Check timing

Idempotency is checked **after validation, before any HTTP calls**. If the key exists in the store, the workflow short-circuits immediately and returns a `{status: "skipped", reason: "duplicate"}` response.

---

## Failure Records

### Storage location

Failure records are persisted in **`$getWorkflowStaticData('global').failureLog`** -- an array stored in n8n's internal database.

### What is recorded

Each failure entry contains:

```json
{
  "timestamp": "2026-02-25T17:25:00.000Z",
  "incidentId": "INC-10001",
  "dedupeKey": "INC-10001|P2|Search latency elevated",
  "channel": "slack | o365 | validation",
  "lastStatus": 429,
  "attempts": 5,
  "error": { "ok": false, "error": "rate_limited" }
}
```

### When failures are recorded

1. **Validation failure**: When required fields are missing or severity is invalid (channel = `validation`)
2. **Notification failure**: When Slack or O365 fails after all retry attempts are exhausted (channel = `slack` or `o365`)

### Viewing failure records

Failure records are included in the webhook response body when a partial failure occurs. They can also be inspected via n8n's execution history in the UI.

For production use, these records would be written to an external store (database, message queue, or monitoring system) for alerting and manual retry.

---

## Design Decisions

1. **Single Code node for both HTTP calls** vs. separate n8n HTTP Request nodes with parallel branches: Avoids the complexity of n8n's Merge node while keeping retry logic DRY and centralized. Uses `Promise.allSettled` for true parallel execution internally.

2. **Code node v2** over deprecated Function node v2: Supports top-level `await` required for async retry/backoff logic with `fetch()` and `setTimeout()`.

3. **Validation returns data (not throws)**: The Normalize node returns `{_valid: false, error: "..."}` instead of throwing. This keeps flow control in n8n's IF nodes rather than relying on error handlers, making the workflow more readable and debuggable.

4. **`responseMode: "lastNode"`**: Every terminal branch (Handle Validation Error, Return Duplicate Response, Process Results) returns structured JSON so the webhook caller always gets a meaningful response.
