import fs from "fs";
import path from "path";

const CFG_PATH = path.resolve("services.json");
const STATE_PATH = path.resolve("state.json");

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function saveJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

async function telegramSend(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
}

/**
 * Heuristics: detect "incident" from page content.
 * We aim to be stable over time (avoid fragile selectors).
 */
function hasIncident(html) {
  const h = html.toLowerCase();

  // Strong textual signals (IT/EN) commonly shown when DD flags an incident
  const signals = [
    "segnalazioni degli utenti indicano problemi",
    "gli utenti segnalano problemi",
    "segnalazioni indicano problemi",
    "user reports indicate problems",
    "reports indicate problems",
    "problems at"
  ];

  // Count hits across signals; require at least 1 strong hit
  let hits = 0;
  for (const s of signals) if (h.includes(s)) hits++;

  return hits >= 1;
}

function msgStart(svc) {
  return [
    "🚨 Downdetector Incident START",
    `Servizio: ${svc.name}`,
    `Link: ${svc.url}`,
    `Time: ${new Date().toISOString()}`,
    "",
    "Rilevato: Downdetector indica problemi per questo servizio."
  ].join("\n");
}

function msgResolved(svc) {
  return [
    "✅ Downdetector Incident RESOLVED",
    `Servizio: ${svc.name}`,
    `Link: ${svc.url}`,
    `Time: ${new Date().toISOString()}`,
    "",
    "Rilevato: Downdetector non mostra più indicatori di problemi."
  ].join("\n");
}

async function main() {
  const cfg = loadJson(CFG_PATH, null);
  if (!cfg) throw new Error("Missing services.json");

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  // status[slug] = true/false (incident state)
  const state = loadJson(STATE_PATH, { status: {} });

  for (const svc of cfg.services) {
    try {
      const res = await fetch(svc.url, {
        headers: { "User-Agent": "Mozilla/5.0 (dd-monitor personal)" }
      });

      // If DD blocks/returns something odd, treat as no incident but log it
      const html = await res.text();
      const incident = hasIncident(html);

      const prev = state.status[svc.slug] ?? false;

      // Notify only on state transitions
      if (incident && !prev) {
        await telegramSend(token, chatId, msgStart(svc));
      } else if (!incident && prev) {
        await telegramSend(token, chatId, msgResolved(svc));
      }

      state.status[svc.slug] = incident;

      console.log(`[${svc.slug}] incident=${incident} (prev=${prev})`);
    } catch (e) {
      console.error(`[${svc.slug}] error: ${e.message}`);
    }
  }

  saveJson(STATE_PATH, state);
  console.log("Done.");
}

await main();
