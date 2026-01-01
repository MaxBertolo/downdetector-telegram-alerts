import { load } from "cheerio";

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (personal-monitor)" }
  });
  if (!res.ok) throw new Error(`NetBlocks HTTP ${res.status}: ${await res.text()}`);
  return res.text();
}

function extractLatestPost(html) {
  const $ = load(html);

  // Best-effort: first article link + title
  const firstLink = $("article a").first();
  const href = firstLink.attr("href");
  const title = firstLink.text().trim();

  // fallback: any h2/h3 within article
  const title2 = $("article h2, article h3").first().text().trim();

  return {
    href: href ? (href.startsWith("http") ? href : `https://netblocks.org${href}`) : null,
    title: title || title2 || null
  };
}

export async function checkNetblocks({ watchPages }) {
  const out = [];
  for (const url of watchPages) {
    const html = await fetchHtml(url);
    const latest = extractLatestPost(html);
    if (latest.title && latest.href) out.push({ page: url, ...latest });
  }
  return out;
}
