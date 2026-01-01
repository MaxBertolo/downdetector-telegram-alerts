import fs from "fs";
import services from "./services.json" assert { type: "json" };
import sources from "./sources.json" assert { type: "json" };
import { checkNetblocks } from "./providers/netblocks.js";
import { checkDowndetector } from "./providers/downdetector.js";

const STATE_FILE = "state.json";
const TELEGRAM_API = "https://api.telegram.org";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(message) {
  await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "Markdown" })
  });
}

async function httpCheck(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

(async function main() {
  const state = loadState();
  const timeoutMs = sources.http?.timeoutMs ?? 8000;

  // 1) NetBlocks (macro)
  const netblocksFindings = await checkNetblocks({
    watchPages: sources.netblocks.pages
  });

  for (const svc of services) {
    let confidence = 0;

    // 2) Downdetector signal (heuristic)
    const dd = await checkDowndetector(sources.downdetector.baseUrl, svc.downdetectorSlug);
    const ddSignal = dd.ok && dd.score >= 1; // 1 or 2 based on page structure
    if (ddSignal) confidence++;

    // 3) HTTP checks
    let failures = 0;
    for (const url of svc.checkUrls) {
      const ok = await httpCheck(url, timeoutMs);
      if (!ok) failures++;
    }
    const httpIncident = failures >= (svc.httpFailureThreshold ?? 1);
    if (httpIncident) confidence++;

    // 4) NetBlocks correlation (best-effort)
    const nbSignal = netblocksFindings.some(f =>
      (f.title || "").toLowerCase().includes(svc.name.toLowerCase())
    );
    if (nbSignal) confidence++;

    const threshold = svc.alertConfidence ?? 2;

    // START incident
    if (confidence >= threshold && !state[svc.name]) {
      await sendTelegram(
        `🚨 *DISSERVIZIO RILEVATO*\n` +
          `*Servizio:* ${svc.name}\n\n` +
          `• Downdetector: ${ddSignal ? "⚠️ Segnale" : "—"}\n` +
          `• HTTP: ${httpIncident ? "❌ KO" : "✅ OK"}\n` +
          `• NetBlocks: ${nbSignal ? "⚠️ Macro" : "—"}\n\n` +
          `_2 fonti su 3 (o più) hanno concordato_`
      );
      state[svc.name] = { startedAt: new Date().toISOString() };
    }

    // RESOLVED (optional): if previously incident and now below threshold
    if (state[svc.name] && confidence < threshold) {
      await sendTelegram(
        `✅ *RISOLTO*\n` +
          `*Servizio:* ${svc.name}\n\n` +
          `• Downdetector: ${ddSignal ? "⚠️ Segnale" : "—"}\n` +
          `• HTTP: ${httpIncident ? "❌ KO" : "✅ OK"}\n` +
          `• NetBlocks: ${nbSignal ? "⚠️ Macro" : "—"}\n\n` +
          `_Incident rientrato sotto soglia_`
      );
      delete state[svc.name];
    }
  }

  saveState(state);
})();
