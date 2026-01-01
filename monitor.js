import fs from "fs";
import services from "./services.json" assert { type: "json" };
import sources from "./sources.json" assert { type: "json" };
import { fetchDowndetector } from "./providers/downdetector.js";
import { checkNetblocks } from "./providers/netblocks.js";

const STATE_FILE = "state.json";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// RUN_MODE:
// - "alert" (default): start/resolved alerts per service
// - "daily": one daily snapshot message
const MODE = process.env.RUN_MODE || "alert";

if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
}

// -------------------- STATE --------------------
function loadState() {
  let raw = null;

  if (fs.existsSync(STATE_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch {
      raw = null;
    }
  }

  const state = { incidents: {}, netblocks: {} };

  if (!raw || typeof raw !== "object") return state;

  if (raw.incidents && typeof raw.incidents === "object") state.incidents = raw.incidents;
  if (raw.netblocks && typeof raw.netblocks === "object") state.netblocks = raw.netblocks;

  // migration from old format: { "ServiceName": true }
  for (const [k, v] of Object.entries(raw)) {
    if (k === "incidents" || k === "netblocks") continue;
    if (v === true && !state.incidents[k]) {
      state.incidents[k] = { startedAt: new Date().toISOString(), migrated: true };
    }
  }

  return state;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// -------------------- TELEGRAM --------------------
async function telegramSend(text, buttons = null) {
  const payload = {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true
  };

  if (buttons) {
    payload.reply_markup = { inline_keyboard: buttons };
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

// -------------------- HTTP CHECK (ROBUST) --------------------
// Many services block HEAD or return 403 to bots.
// We treat any status < 500 as "reachable" (3xx/4xx still means server is there).
async function httpReachable(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (DowndetectorMonitor/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Range": "bytes=0-0"
      }
    });

    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- HELPERS --------------------
function groupByCategory(items) {
  const out = {};
  for (const it of items) {
    const key = it.category || "internet";
    out[key] = out[key] || [];
    out[key].push(it);
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

function nowIso() {
  return new Date().toISOString();
}

function buildButtons(ddUrl) {
  const quicklookUrl =
    sources.telegram?.quicklookUrl || "https://atlas.ripe.net/use-cases/quicklook";
  return [
    [{ text: "🧪 Quicklook (manual test)", url: quicklookUrl }],
    [{ text: "🔎 Apri Downdetector", url: ddUrl }]
  ];
}

// Builds a compact line used in daily reports
function dailyLine(f, ddThreshold) {
  const ddPart =
    typeof f.ddReports === "number"
      ? `${f.ddReports >= ddThreshold ? "⚠️" : "—"} DD:${f.ddReports}`
      : `${f.ddAbnormal ? "⚠️" : "—"} DD`;
  const httpPart = f.httpIncident ? "❌ HTTP" : "✅ HTTP";
  return `• ${f.name} — ${ddPart}, ${httpPart}`;
}

// -------------------- MAIN --------------------
(async function main() {
  const state = loadState();

  const timeoutMs = sources.http?.timeoutMs ?? 8000;

  const ddBaseUrl = sources.downdetector?.baseUrl ?? "https://downdetector.it/problemi";
  const ddThreshold = sources.downdetector?.reportsThreshold ?? 10;
  const ddWindowMin = sources.downdetector?.windowMinutes ?? 30;

  const nbEnabled = !!sources.netblocks?.enabled;
  let netblocksLatest = [];

  if (nbEnabled) {
    netblocksLatest = await checkNetblocks({ watchPages: sources.netblocks.pages || [] });
  }

  const findings = [];

  for (const svc of services) {
    // HTTP: reachable if at least one endpoint answers with status < 500
    let okCount = 0;
    for (const u of svc.checkUrls || []) {
      if (await httpReachable(u, timeoutMs)) okCount++;
    }
    const httpIncident = okCount === 0;

    // Downdetector
    const dd = await fetchDowndetector({
      baseUrl: ddBaseUrl,
      slug: svc.downdetectorSlug,
      windowMinutes: ddWindowMin
    });

    const ddReports = dd.reportsInWindow;
    const ddAbnormal =
      (typeof ddReports === "number" && ddReports >= ddThreshold) || dd.banner === true;

    // NetBlocks match (optional, best-effort)
    const nbMatch = nbEnabled
      ? netblocksLatest.some(x =>
          (x.title || "").toLowerCase().includes((svc.name || "").toLowerCase())
        )
      : false;

    // Alert rule as requested:
    // - immediate alert if DD abnormal OR HTTP not reachable
    const isIncident = ddAbnormal || httpIncident;

    findings.push({
      name: svc.name,
      category: svc.category || "internet",
      httpIncident,
      ddAbnormal,
      ddReports,
      ddUrl: dd.url,
      nbMatch,
      isIncident
    });
  }

  // -------------------- ALERT MODE --------------------
  if (MODE === "alert") {
    for (const f of findings) {
      const prev = !!state.incidents[f.name];

      if (f.isIncident && !prev) {
        const ddLine =
          typeof f.ddReports === "number"
            ? `Downdetector: ⚠️ ${f.ddReports} segnalazioni (~${ddWindowMin} min)\n`
            : `Downdetector: ${f.ddAbnormal ? "⚠️ segnale (banner/heuristic)\n" : "—\n"}`;

        const msg =
          `🚨 DISERVIZIO RILEVATO\n` +
          `${catLabel(f.category)} — ${f.name}\n\n` +
          `${ddLine}` +
          `HTTP reachability: ${f.httpIncident ? "❌ KO" : "✅ OK"}\n` +
          `NetBlocks: ${f.nbMatch ? "⚠️ match" : "—"}\n\n` +
          `Link DD: ${f.ddUrl}`;

        await telegramSend(msg, buildButtons(f.ddUrl));
        state.incidents[f.name] = { startedAt: nowIso() };
      }

      if (!f.isIncident && prev) {
        const msg =
          `✅ RISOLTO\n` +
          `${catLabel(f.category)} — ${f.name}\n\n` +
          `Downdetector: ${f.ddAbnormal ? "⚠️ segnale" : "—"}\n` +
          `HTTP reachability: ${f.httpIncident ? "❌ KO" : "✅ OK"}\n` +
          `NetBlocks: ${f.nbMatch ? "⚠️ match" : "—"}\n\n` +
          `Link DD: ${f.ddUrl}`;

        await telegramSend(msg, buildButtons(f.ddUrl));
        delete state.incidents[f.name];
      }
    }
  }

  // -------------------- DAILY MODE --------------------
  if (MODE === "daily") {
    const byCat = groupByCategory(findings);

    let body = `📌 REPORT GIORNALIERO (snapshot)\n${nowIso()}\n\n`;

    // Fixed order for readability
    const order = ["streaming", "rete", "cloud", "social", "internet"];
    for (const cat of order) {
      if (!byCat[cat]) continue;
      body += `${catLabel(cat)}\n`;
      for (const f of byCat[cat]) {
        body += `${dailyLine(f, ddThreshold)}\n`;
      }
      body += "\n";
    }

    // Any remaining categories not in order
    for (const [cat, items] of Object.entries(byCat)) {
      if (order.includes(cat)) continue;
      body += `${catLabel(cat)}\n`;
      for (const f of items) body += `${dailyLine(f, ddThreshold)}\n`;
      body += "\n";
    }

    const quicklookUrl =
      sources.telegram?.quicklookUrl || "https://atlas.ripe.net/use-cases/quicklook";

    await telegramSend(body, [[{ text: "🧪 Quicklook (manual test)", url: quicklookUrl }]]);
  }

  saveState(state);
})();
