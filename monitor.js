import fs from "fs";
import services from "./services.json" assert { type: "json" };
import sources from "./sources.json" assert { type: "json" };
import { checkNetblocks } from "./providers/netblocks.js";

const STATE_FILE = "state.json";
const TELEGRAM_API = "https://api.telegram.org";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
}

// ---------- utils ----------
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(message) {
  const url = `${TELEGRAM_API}/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    })
  });
}

async function httpCheck(url) {
  try {
    const res = await fetch(url, { method: "HEAD", timeout: 8000 });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- main ----------
(async function main() {
  const state = loadState();
  const incidents = [];

  // 1️⃣ NetBlocks (macro)
  const netblocksFindings = await checkNetblocks({
    watchPages: sources.netblocks.pages
  });

  // 2️⃣ HTTP checks (technical)
  for (const service of services) {
    let failures = 0;

    for (const url of service.checkUrls) {
      const ok = await httpCheck(url);
      if (!ok) failures++;
    }

    const httpIncident = failures >= service.httpFailureThreshold;

    // 3️⃣ Correlazione
    const netblocksMatch = netblocksFindings.some(f =>
      f.title.toLowerCase().includes(service.name.toLowerCase())
    );

    const confidence =
      (httpIncident ? 1 : 0) +
      (netblocksMatch ? 1 : 0);

    if (confidence >= service.alertConfidence) {
      incidents.push({
        service: service.name,
        httpIncident,
        netblocksMatch
      });
    }
  }

  // 4️⃣ Alert solo se nuovo
  for (const incident of incidents) {
    if (state[incident.service]) continue;

    const message = `
🚨 *DISERVIZIO RILEVATO*
*Servizio:* ${incident.service}

• HTTP check: ${incident.httpIncident ? "❌ KO" : "✅ OK"}
• NetBlocks: ${incident.netblocksMatch ? "⚠️ Segnalazioni" : "—"}

_Fonte automatica_
`;

    await sendTelegram(message);
    state[incident.service] = true;
  }

  // reset stati se tutto ok
  for (const s of services) {
    if (!incidents.find(i => i.service === s.name)) {
      delete state[s.name];
    }
  }

  saveState(state);
})();
