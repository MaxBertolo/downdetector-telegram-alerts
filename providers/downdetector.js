import { load } from "cheerio";

export async function checkDowndetector(baseUrl, slug) {
  const url = `${baseUrl}/${slug}/`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (personal-monitor)" }
    });
    if (!res.ok) return { ok: false, score: 0, url };

    const html = await res.text();
    const $ = load(html);

    // Heuristics: presence of the main report chart section / text blocks
    const hasChart = $("svg").length > 0 || $("[data-test='chart']").length > 0;
    const hasReportsBlock =
      $("h3, h2").filter((_, el) => /Segnalazioni|Reports/i.test($(el).text())).length > 0;

    // score is binary-ish but stable
    const score = (hasChart ? 1 : 0) + (hasReportsBlock ? 1 : 0);

    // We treat DD as "available" but not necessarily "incident".
    // Incident will be decided in monitor.js by combining signals.
    return { ok: true, score, url };
  } catch {
    return { ok: false, score: 0, url };
  }
}
