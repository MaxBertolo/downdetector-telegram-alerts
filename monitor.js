import fs from "fs";
import path from "path";
import { downdetector } from "downdetector-api";

const CFG_PATH = path.resolve("services.json");
const STATE_PATH = path.resolve("state.json");

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}
function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function nowIso() { return new Date().toISOString(); }

function minutesBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  return Math.abs(b - a) / 60000;
}

async function telegramSend(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

function formatAlert(svc, reportsNow, baselineNow) {
  const ratio = baselineNow > 0 ? (reportsNow / baselineNow).toFixed(1) : "∞";
  return [
    "🚨 Downdetector Alert",
    `Servizio: ${svc.name}`,
    `Reports (ultimo punto): ${reportsNow}`,
    `Baseline (ultimo punto): ${baselineNow}`,
    `Rapporto reports/baseline: ${ratio}`,
    `Link: ${svc.url}`,
    `Time: ${nowIso()}`
  ].join("\n");
}

async function main() {
  const cfg = loadJson(CFG_PATH, null);
  if (!cfg) throw new Error("Missing services.json");

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars");

  const state = loadJson(STATE_PATH, { lastSent: {} });
  const { threshold, cooldownMinutes, country, services } = cfg;

  let alerts = 0;

  for (const svc of services) {
    try {
      // downdetector-api returns arrays of {date, value} for reports & baseline :contentReference[oaicite:12]{index=12}
      const data = await downdetector(svc.slug, country);

      const reportsSeries = data?.reports ?? [];
      const baselineSeries = data?.baseline ?? [];
      const reportsNow = reportsSeries.at(-1)?.value ?? 0;
      const baselineNow = baselineSeries.at(-1)?.value ?? 0;

      const shouldAlert = reportsNow > threshold;

      // cooldown per-service
      const last = state.lastSent[svc.slug];
      const cooledDown = !last || minutesBetween(last, nowIso()) >= cooldownMinutes;

      if (shouldAlert && cooledDown) {
        await telegramSend(token, chatId, formatAlert(svc, reportsNow, baselineNow));
        state.lastSent[svc.slug] = nowIso();
        alerts += 1;
      }
    } catch (e) {
      // optional: you can also telegram errors, but it may spam; keep as log
      console.error(`[${svc.slug}] error`, e.message);
    }
  }

  saveJson(STATE_PATH, state);
  console.log(`Done. Alerts sent: ${alerts}`);
}

await main();
