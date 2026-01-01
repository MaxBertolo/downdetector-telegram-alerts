import fs from "fs";
import services from "./services.json" assert { type: "json" };
import sources from "./sources.json" assert { type: "json" };
import { fetchDowndetector } from "./providers/downdetector.js";
import { checkNetblocks } from "./providers/netblocks.js";

const STATE_FILE = "state.json";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MODE = process.env.RUN_MODE || "alert"; // "alert" or "daily"

if (!BOT_TOKEN || !CHAT_ID) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { incidents: {} , netblocks: {} };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function telegramSend(text, buttons = null) {
  const payload = {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true
  };

  if (buttons) {
    payload.reply_markup = {
      inline_keyboard: buttons
    };
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new Error(`Telegram send failed: ${res.status}`);
}

async function httpHead(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function groupByCategory(items) {
  const out = {};
  for (const it of items) {
    out[it.category] = out[it.category] || [];
    out[it.category].push(it);
  }
  return out;
}

function catLabel(cat) {
  if (cat === "rete") return "📡 RETE";
  if (cat === "streaming") return "📺 STREAMING";
  if (cat === "cloud") return "☁️ CLOUD";
  if (cat === "social") return "👥 SOCIAL";
  return "🌐 INTERNET";
}

(async function main() {
  const state = loadState();
  const timeoutMs = sources.http?.timeoutMs ?? 8000;

  // NetBlocks macro signal (optional)
  let netblocksLatest = [];
  if (sources.netblocks?.enabled) {
    netblocksLatest = await checkNetblocks({ watchPages: sources.netblocks.pages });
  }

  const findings = [];

  for (const svc of services) {
    // 1) HTTP reachability
    let httpOkCount = 0;
    for (const u of svc.checkUrls) {
      if (await httpHead(u, timeoutMs)) httpOkCount++;
    }
    const httpOk = httpOkCount > 0; // at least one endpoint reachable
    const httpIncident = !httpOk;

    // 2) Downdetector abnormal reports (>= 10 in last 30 min) OR banner
    const dd = await fetchDowndetector({
      baseUrl: sources.downdetector.baseUrl,
      slug: svc.downdetectorSlug,
      windowMinutes: sources.downdetector.windowMinutes
    });

    const ddReports = dd.reportsInWindow;
    const ddAbnormal =
      (typeof ddReports === "number" && ddReports >= sources.downdetector.reportsThreshold) || dd.banner;

    // 3) NetBlocks match (best-effort, not per-service)
    const nbMatch = netblocksLatest.some(x =>
      (x.title || "").toLowerCase().includes(svc.name.toLowerCase())
    );

    findings.push({
      name: svc.name,
      category: svc.category,
      httpIncident,
      ddAbnormal,
      ddReports,
      ddUrl: dd.url,
      nbMatch
    });
  }

  // ALERT MODE: per-service START/RESOLVED based on (ddAbnormal OR httpIncident) (you asked this explicitly)
  if (MODE === "alert") {
    for (const f of findings) {
      const isIncident = f.ddAbnormal || f.httpIncident;
      const prev = !!state.incidents[f.name];

      if (isIncident && !prev) {
        const ddLine =
          typeof f.ddReports === "number"
            ? `Downdetector: ⚠️ ${f.ddReports} segnalazioni (~${sources.downdetector.windowMinutes} min)\n`
            : `Downdetector: ⚠️ segnale (banner/heuristic)\n`;

        const msg =
          `🚨 DISERVIZIO RILEVATO\n` +
          `${catLabel(f.category)} — ${f.name}\n\n` +
          `${ddLine}` +
          `HTTP reachability: ${f.httpIncident ? "❌ KO" : "✅ OK"}\n` +
          `NetBlocks: ${f.nbMatch ? "⚠️ match" : "—"}\n\n` +
          `Link DD: ${f.ddUrl}`;

        await telegramSend(msg, [
          [{ text: "🧪 Quicklook (manual test)", url: sources.telegram.quicklookUrl }],
          [{ text: "🔎 Apri Downdetector", url: f.ddUrl }]
        ]);

        state.incidents[f.name] = { startedAt: new Date().toISOString() };
      }

      if (!isIncident && prev) {
        const msg =
          `✅ RISOLTO\n` +
          `${catLabel(f.category)} — ${f.name}\n\n` +
          `Downdetector: ${f.ddAbnormal ? "⚠️ segnale" : "—"}\n` +
          `HTTP reachability: ${f.httpIncident ? "❌ KO" : "✅ OK"}\n\n` +
          `Link DD: ${f.ddUrl}`;

        await telegramSend(msg, [
          [{ text: "🧪 Quicklook (manual test)", url: sources.telegram.quicklookUrl }],
          [{ text: "🔎 Apri Downdetector", url: f.ddUrl }]
        ]);

        delete state.incidents[f.name];
      }
    }
  }

  // DAILY MODE: one grouped message with status snapshot
  if (MODE === "daily") {
    const byCat = groupByCategory(findings);

    let body = `📌 REPORT GIORNALIERO (snapshot)\n${new Date().toISOString()}\n\n`;
    for (const [cat, items] of Object.entries(byCat)) {
      body += `${catLabel(cat)}\n`;
      for (const f of items) {
        const ddPart =
          typeof f.ddReports === "number"
            ? `${f.ddReports >= sources.downdetector.reportsThreshold ? "⚠️" : "—"} DD:${f.ddReports}`
            : `${f.ddAbnormal ? "⚠️" : "—"} DD`;
        const httpPart = f.httpIncident ? "❌ HTTP" : "✅ HTTP";
        body += `• ${f.name} — ${ddPart}, ${httpPart}\n`;
      }
      body += "\n";
    }

    await telegramSend(body, [
      [{ text: "🧪 Quicklook (manual test)", url: sources.telegram.quicklookUrl }]
    ]);
  }

  saveState(state);
})();
