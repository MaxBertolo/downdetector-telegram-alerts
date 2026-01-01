import { load } from "cheerio";

/**
 * Best-effort: tries to extract time-series points from inline scripts and
 * sums last `windowMinutes` values (assuming points are minute-bucketed or 5-min bucketed).
 * If it can't parse, returns null for reportsInWindow.
 */
function tryExtractSeriesPoints(html) {
  // Look for common patterns: arrays of [timestamp,value] in scripts
  // We keep it conservative and only parse JSON-looking fragments.
  const candidates = [];
  const re = /\[\s*\d{10,13}\s*,\s*\d+\s*\]/g; // [ts, value]
  const matches = html.match(re);
  if (!matches || matches.length < 5) return null;

  for (const m of matches) {
    // m like "[1700000000000,12]" or "[1700000000,12]"
    const inner = m.replace(/^\[/, "").replace(/\]$/, "");
    const [tsRaw, vRaw] = inner.split(",").map(s => s.trim());
    const ts = Number(tsRaw);
    const v = Number(vRaw);
    if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;

    // normalize ts to ms
    const tsMs = ts < 10_000_000_000 ? ts * 1000 : ts;
    candidates.push([tsMs, v]);
  }

  if (candidates.length < 10) return null;

  // Keep unique & sorted
  const byTs = new Map();
  for (const [t, v] of candidates) byTs.set(t, v);
  const points = Array.from(byTs.entries()).sort((a, b) => a[0] - b[0]);
  return points;
}

function detectIncidentBanner($) {
  const text = $("body").text().toLowerCase();
  const signals = [
    "segnalazioni degli utenti indicano problemi",
    "gli utenti segnalano problemi",
    "segnalazioni indicano problemi",
    "user reports indicate problems",
    "reports indicate problems"
  ];
  return signals.some(s => text.includes(s));
}

export async function fetchDowndetector({ baseUrl, slug, windowMinutes }) {
  const url = `${baseUrl}/${slug}/`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (personal-monitor)" }
    });
    if (!res.ok) return { ok: false, url, banner: false, reportsInWindow: null };

    const html = await res.text();
    const $ = load(html);

    const banner = detectIncidentBanner($);

    const points = tryExtractSeriesPoints(html);
    let reportsInWindow = null;

    if (points && points.length) {
      const now = Date.now();
      const cutoff = now - windowMinutes * 60 * 1000;

      // sum values of points in the time window
      reportsInWindow = points
        .filter(([t]) => t >= cutoff)
        .reduce((acc, [, v]) => acc + v, 0);
    }

    return { ok: true, url, banner, reportsInWindow };
  } catch {
    return { ok: false, url, banner: false, reportsInWindow: null };
  }
}
