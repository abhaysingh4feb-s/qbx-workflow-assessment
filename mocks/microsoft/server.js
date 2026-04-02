import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.MS_PORT ? Number(process.env.MS_PORT) : 4020;
let fail429 = process.env.MS_FAIL_429_N ? Number(process.env.MS_FAIL_429_N) : 0;
let fail500 = process.env.MS_FAIL_500_N ? Number(process.env.MS_FAIL_500_N) : 0;

function authOk(req) {
  const auth = req.headers["authorization"] || "";
  return auth.trim() === "Bearer ms-test-token";
}

function validateSendMail(body) {
  const msg = body?.message;
  const to = msg?.toRecipients?.[0]?.emailAddress?.address;
  const subject = msg?.subject;
  const content = msg?.body?.content;
  const contentType = msg?.body?.contentType;
  return Boolean(to && subject && content && contentType);
}

app.post("/me/sendMail", (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: { code: "InvalidAuthenticationToken" } });

  if (!validateSendMail(req.body)) {
    return res.status(400).json({ error: { code: "BadRequest", message: "Invalid payload" } });
  }

  if (fail429 > 0) {
    fail429 -= 1;
    return res.status(429).json({ error: { code: "TooManyRequests" } });
  }
  if (fail500 > 0) {
    fail500 -= 1;
    return res.status(500).json({ error: { code: "InternalServerError" } });
  }

  // Graph usually returns 202 Accepted (no content) for sendMail
  return res.status(202).send();
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Microsoft mock listening on http://localhost:${PORT}`);
  console.log(`Failure injection: MS_FAIL_429_N=${process.env.MS_FAIL_429_N || 0}, MS_FAIL_500_N=${process.env.MS_FAIL_500_N || 0}`);
});
