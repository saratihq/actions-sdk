/** A dependency-free RSS/Atom item extractor — targets `<item>`/`<entry>` blocks only, not general XML. */

export interface FeedItem {
  title: string;
  link: string;
  id: string;
  pubDate: string | null;
  summary: string;
  /** Who posted it: Atom `<author><name>`, else `<dc:creator>`, else RSS `<author>`; null when absent. */
  author: string | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => NAMED_ENTITIES[m] ?? m);
}

/** Unwrap a CDATA section (if present), decode entities, and trim. */
function clean(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const inner = cdata ? (cdata[1] ?? '') : raw;
  return decodeEntities(inner).trim();
}

/** The text content of the first `<tag>…</tag>` in a block, or null. */
function firstTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? clean(match[1] ?? '') : null;
}

/**
 * Resolve an item's author. Atom nests it (`<author><name>…`), RSS 2.0 uses `<dc:creator>` or an
 * `<author>` that is an email address — take the first that carries text.
 */
function extractAuthor(block: string): string | null {
  const atom = /<author\b[^>]*>([\s\S]*?)<\/author>/i.exec(block);
  if (atom) {
    const nested = firstTag(atom[1] ?? '', 'name');
    const inner = nested ?? clean(atom[1] ?? '');
    if (inner) return inner;
  }
  return firstTag(block, 'dc:creator') ?? firstTag(block, 'creator');
}

/** Resolve an item's link: an Atom `<link href="…"/>` first, else an RSS `<link>…</link>`. */
function extractLink(block: string): string {
  const atom = /<link\b[^>]*\bhref="([^"]*)"[^>]*\/?>/i.exec(block);
  if (atom) return decodeEntities(atom[1] ?? '').trim();
  return firstTag(block, 'link') ?? '';
}

/** Parse an RSS/Atom feed into normalised items, in source order. */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi);
  for (const [block] of blocks) {
    const link = extractLink(block);
    const id = firstTag(block, 'guid') ?? firstTag(block, 'id') ?? link;
    items.push({
      title: firstTag(block, 'title') ?? '',
      link,
      id,
      pubDate: firstTag(block, 'pubDate') ?? firstTag(block, 'published') ?? firstTag(block, 'updated'),
      summary: firstTag(block, 'description') ?? firstTag(block, 'summary') ?? '',
      author: extractAuthor(block),
    });
  }
  return items;
}
