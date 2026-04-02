import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.SLACK_PORT ? Number(process.env.SLACK_PORT) : 4010;
let fail429 = process.env.SLACK_FAIL_429_N ? Number(process.env.SLACK_FAIL_429_N) : 0;
let fail500 = process.env.SLACK_FAIL_500_N ? Number(process.env.SLACK_FAIL_500_N) : 0;

function authOk(req) {
  const auth = req.headers["authorization"] || "";
  return auth.trim() === "Bearer slack-test-token";
}

app.post("/chat.postMessage", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  const { channel, text } = req.body || {};
  if (!channel || !text) return res.status(400).json({ ok: false, error: "invalid_payload" });

  if (fail429 > 0) {
    fail429 -= 1;
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }
  if (fail500 > 0) {
    fail500 -= 1;
    return res.status(500).json({ ok: false, error: "server_error" });
  }

  return res.status(200).json({
    ok: true,
    channel,
    ts: String(Date.now() / 1000),
    message: { text }
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Slack mock listening on http://localhost:${PORT}`);
  console.log(`Failure injection: SLACK_FAIL_429_N=${process.env.SLACK_FAIL_429_N || 0}, SLACK_FAIL_500_N=${process.env.SLACK_FAIL_500_N || 0}`);
});
