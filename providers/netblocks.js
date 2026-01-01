import { load } from "cheerio";

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (personal-monitor)" }
  });
  if (!res.ok) throw new Error(`NetBlocks HTTP ${res.status}`);
  return res.text();
}

function extractLatestPost(html) {
  const $ = load(html);
  const first = $("article a").first();
  const href = first.attr("href");
  const title = first.text().trim() || $("article h2, article h3").first().text().trim();
  return {
    href: href ? (href.startsWith("http") ? href : `https://netblocks.org${href}`) : null,
    title: title || null
  };
}

export async function checkNetblocks({ watchPages }) {
  const out = [];
  for (const page of watchPages) {
    try {
      const html = await fetchHtml(page);
      const latest = extractLatestPost(html);
      if (latest.title && latest.href) out.push({ page, ...latest });
    } catch {
      // ignore
    }
  }
  return out;
}
