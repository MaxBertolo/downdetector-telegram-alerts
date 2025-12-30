import fs from "fs";
import path from "path";
import { evaluateAtlas } from "./providers/ripeAtlas.js";
import { checkNetblocks } from "./providers/netblocks.js";

const SOURCES_PATH = path.resolve("sources.json");
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

function atlasStartMsg(targetName, details) {
  return [
    "🚨 RIPE Atlas Incident START (IT probes)",
    `Target: ${targetName}`,
    `Fail ratio: ${(details.failRatio * 100).toFixed(0)}% (fail ${details.fail}/${details.total})`,
    `Time: ${new Date().toISOString()}`
  ].join("\n");
}

function atlasResolvedMsg(targetName) {
  return [
    "✅ RIPE Atlas Incident RESOLVED (IT probes)",
    `Target: ${targetName}`,
    `Time: ${new Date().toISOString()}`
  ].join("\n");
}

function netblocksMsg(item) {
  return [
    "📰 NetBlocks update",
    `Page: ${item.page}`,
    `Title: ${item.title}`,
    `Link: ${item.href}`,
    `Time: ${new Date().toISOString()}`
  ].join("\n");
}

async function main() {
  const sources = loadJson(SOURCES_PATH, null);
  if (!sources) throw new Error("Missing sources.json");

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const state = loadJson(STATE_PATH, {
    atlas: { status: {}, okRuns: {} }, // status[targetId]=bool incident; okRuns[targetId]=consecutive ok
    netblocks: { lastHrefByPage: {} }
  });

  // ---- RIPE Atlas ----
  if (sources.ripeAtlas?.enabled) {
    const apiKey = process.env.RIPE_ATLAS_API_KEY;
    if (!apiKey) throw new Error("Missing RIPE_ATLAS_API_KEY secret");

    const atlas = await evaluateAtlas({ apiKey, state, cfg: sources.ripeAtlas });

    // per target: incident if failRatio >= threshold
    for (const t of sources.ripeAtlas.targets) {
      const stats = atlas.httpStatus[t.id];
      const prev = state.atlas.status[t.id] ?? false;
      const nowIncident = stats.failRatio >= sources.ripeAtlas.httpFailRatioThreshold;

      if (nowIncident) {
        state.atlas.okRuns[t.id] = 0;
        if (!prev) {
          await telegramSend(token, chatId, atlasStartMsg(t.name, stats));
        }
      } else {
        // resolved only after N consecutive OK runs to avoid flapping
        const okRuns = (state.atlas.okRuns[t.id] ?? 0) + 1;
        state.atlas.okRuns[t.id] = okRuns;
        if (prev && okRuns >= sources.ripeAtlas.resolvedConsecutiveOkRuns) {
          await telegramSend(token, chatId, atlasResolvedMsg(t.name));
          state.atlas.status[t.id] = false;
          continue;
        }
      }

      state.atlas.status[t.id] = nowIncident;
      console.log(`[atlas] ${t.id}: incident=${nowIncident} failRatio=${stats.failRatio.toFixed(2)}`);
    }
  }

  // ---- NetBlocks ----
  if (sources.netblocks?.enabled) {
    const updates = await checkNetblocks({ watchPages: sources.netblocks.watchPages });
    for (const u of updates) {
      const last = state.netblocks.lastHrefByPage[u.page];
      if (u.href && u.href !== last) {
        // first run will also notify; if you prefer no notify on first run, set last=href and skip
        await telegramSend(token, chatId, netblocksMsg(u));
        state.netblocks.lastHrefByPage[u.page] = u.href;
      }
      console.log(`[netblocks] ${u.page}: latest=${u.href}`);
    }
  }

  saveJson(STATE_PATH, state);
  console.log("Done.");
}

await main();
