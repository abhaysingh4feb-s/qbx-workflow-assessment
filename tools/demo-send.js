import { readFile } from "node:fs/promises";

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

function trunc(s, n=240){ return (s || "").length > n ? (s.slice(0, n-3) + "...") : (s || ""); }

function normalize(incident){
  const req = ["incidentId","severity","title","createdAt"];
  for (const k of req) {
    if (!incident?.[k]) throw new Error(`Missing required field: ${k}`);
  }
  const sevMap = { P1: 1, P2: 2, P3: 3, P4: 4 };
  const severityRank = sevMap[incident.severity];
  if (!severityRank) throw new Error(`Invalid severity: ${incident.severity}`);

  const correlationId = incident?.metadata?.correlationId || "";
  const dedupeKey = `${incident.incidentId}|${incident.severity}|${incident.title}`;

  const message = {
    incidentId: incident.incidentId,
    severity: incident.severity,
    severityRank,
    title: incident.title,
    descriptionShort: trunc(incident.description, 240),
    correlationId,
    createdAt: incident.createdAt
  };

  return { message, dedupeKey, correlationId };
}

const incidentPath = process.argv[2] || "fixtures/incidents/INC-10001.json";
const incident = JSON.parse(await readFile(incidentPath, "utf-8"));
const { message } = normalize(incident);

const slackPayload = {
  channel: "#oncall-alerts",
  text: `[${message.severity}] ${message.incidentId} — ${message.title} (corr=${message.correlationId})`
};

const msPayload = {
  message: {
    subject: `[${message.severity}] ${message.incidentId} — ${message.title}`,
    body: { contentType: "Text", content: `${message.descriptionShort}\n\nCorrelationId: ${message.correlationId}\nCreatedAt: ${message.createdAt}` },
    toRecipients: [{ emailAddress: { address: incident.ownerEmail } }]
  },
  saveToSentItems: false
};

console.log("Sending to Slack mock...");
console.log(await postJson("http://localhost:4010/chat.postMessage", { Authorization: "Bearer slack-test-token" }, slackPayload));

console.log("Sending to Microsoft mock...");
console.log(await postJson("http://localhost:4020/me/sendMail", { Authorization: "Bearer ms-test-token" }, msPayload));
