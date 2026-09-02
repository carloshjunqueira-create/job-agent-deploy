import { httpText, norm, stripHtml } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "rss";

const pick = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
};

/** Conector generico de RSS/Atom. Serve para alertas de emprego e boards de nicho. */
export async function collect({ options = {}, profile, log }) {
  const feeds = options.feeds || [];
  const terms = (profile.must_have_any || []).map(norm);
  const jobs = [];
  for (const feed of feeds) {
    const xml = await httpText(feed, { headers: { Accept: "application/rss+xml, application/xml, text/xml, */*" } });
    const items = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
    for (const block of items) {
      const title = stripHtml(pick(block, "title"));
      if (terms.length && !terms.some((t) => t.length > 3 && norm(title).includes(t))) continue;
      const linkTag = pick(block, "link") || (block.match(/<link[^>]*href="([^"]+)"/i)?.[1] || "");
      jobs.push(toCanonicalJob({
        title,
        company: stripHtml(pick(block, "author") || pick(block, "dc:creator")) || "Ver anuncio",
        location_raw: "",
        description: stripHtml(pick(block, "description") || pick(block, "content:encoded") || pick(block, "summary")),
        url: linkTag,
        posted_at: pick(block, "pubDate") || pick(block, "updated") || pick(block, "published") || null
      }, "rss"));
    }
  }
  log?.(`rss: ${jobs.length} vagas de ${feeds.length} feed(s)`);
  return jobs;
}
