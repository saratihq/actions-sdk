import { parse as parseHtml } from 'node-html-parser';
import { Converter } from 'showdown';
import TurndownService from 'turndown';

import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import { checkbox, dropdown, json, longText, number, shortText } from '../../core/props';

/**
 * Text utilities — no-auth (`none` scheme) actions. The core string
 * transforms are dependency-free; the HTML/Markdown trio uses small permissive
 * libraries (`showdown` MIT, `turndown` MIT, `node-html-parser` MIT). Type names
 * the SDK namespace forbids (`stripHtml`, `defaultValue`) are re-spelled
 * snake_case; `markdown_to_html`, `html_to_markdown` and `extract_from_html`
 * already match snake_case.
 */

type MarkdownFlavor = 'github' | 'original' | 'vanilla';
type ExtractTarget = 'title' | 'links' | 'images' | 'headings' | 'paragraphs' | 'custom';
type ExtractionType = 'textContent' | 'innerHtml' | 'outerHtml' | 'attribute';

function build(pattern: string, useRegex: boolean, caseInsensitive: boolean, global: boolean): RegExp {
  const flags = `${global ? 'g' : ''}${caseInsensitive ? 'i' : ''}`;
  // A literal search escapes regex metacharacters; a regex search uses the pattern verbatim.
  const source = useRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new ActionError({
      code: 'invalid_input',
      message: `invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
    });
  }
}

export const CONCAT_TYPE = 'text.concat';
export const concat = defineAction({
  type: CONCAT_TYPE,
  name: 'Concatenate',
  description: 'Join a list of values into a single string with an optional separator.',
  auth: { type: 'none' },
  props: {
    texts: json({ label: 'Texts', description: 'A JSON array of values to join.', required: true }),
    separator: shortText({ label: 'Separator', required: false, defaultValue: '' }),
  },
  // Returns the joined string DIRECTLY (not `{ result }`): the output is the bare
  // concatenated string, so wrapping it in an object would change that contract.
  run: ({ props }): Promise<string> => {
    if (!Array.isArray(props.texts)) {
      throw new ActionError({
        code: 'invalid_input',
        message: '"texts" must be a JSON array',
        retryable: false,
      });
    }
    const parts = props.texts.map((v) =>
      v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v),
    );
    return Promise.resolve(parts.join(props.separator ?? ''));
  },
});

export const REPLACE_TYPE = 'text.replace';
export interface ReplaceResult {
  result: string;
}
export const replace = defineAction({
  type: REPLACE_TYPE,
  name: 'Replace',
  description: 'Replace occurrences of a pattern in the text.',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Text', required: true }),
    find: shortText({ label: 'Find', required: true }),
    replacement: shortText({ label: 'Replace with', required: false, defaultValue: '' }),
    useRegex: checkbox({ label: 'Use regular expression', required: false, defaultValue: false }),
    caseInsensitive: checkbox({ label: 'Case insensitive', required: false, defaultValue: false }),
  },
  run: ({ props }): Promise<ReplaceResult> => {
    const re = build(props.find, props.useRegex ?? false, props.caseInsensitive ?? false, true);
    return Promise.resolve({ result: props.text.replace(re, props.replacement ?? '') });
  },
});

export const SPLIT_TYPE = 'text.split';
export interface SplitResult {
  result: string[];
}
export const split = defineAction({
  type: SPLIT_TYPE,
  name: 'Split',
  description: 'Split the text into a list by a delimiter.',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Text', required: true }),
    delimiter: shortText({ label: 'Delimiter', required: true, defaultValue: ',' }),
  },
  run: ({ props }): Promise<SplitResult> => Promise.resolve({ result: props.text.split(props.delimiter) }),
});

export const FIND_TYPE = 'text.find';
export interface FindResult {
  found: boolean;
  index: number;
  match: string | null;
}
export const find = defineAction({
  type: FIND_TYPE,
  name: 'Find',
  description: 'Find the first occurrence of a pattern in the text.',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Text', required: true }),
    pattern: shortText({ label: 'Pattern', required: true }),
    useRegex: checkbox({ label: 'Use regular expression', required: false, defaultValue: false }),
    caseInsensitive: checkbox({ label: 'Case insensitive', required: false, defaultValue: false }),
  },
  run: ({ props }): Promise<FindResult> => {
    const re = build(props.pattern, props.useRegex ?? false, props.caseInsensitive ?? false, false);
    const m = re.exec(props.text);
    return Promise.resolve(
      m ? { found: true, index: m.index, match: m[0] } : { found: false, index: -1, match: null },
    );
  },
});

export const FIND_ALL_TYPE = 'text.find_all';
export interface FindAllResult {
  matches: string[];
  count: number;
}
export const findAll = defineAction({
  type: FIND_ALL_TYPE,
  name: 'Find All',
  description: 'Find every occurrence of a pattern in the text.',
  auth: { type: 'none' },
  props: {
    text: longText({ label: 'Text', required: true }),
    pattern: shortText({ label: 'Pattern', required: true }),
    useRegex: checkbox({ label: 'Use regular expression', required: false, defaultValue: false }),
    caseInsensitive: checkbox({ label: 'Case insensitive', required: false, defaultValue: false }),
  },
  run: ({ props }): Promise<FindAllResult> => {
    const re = build(props.pattern, props.useRegex ?? false, props.caseInsensitive ?? false, true);
    const matches = props.text.match(re) ?? [];
    return Promise.resolve({ matches: [...matches], count: matches.length });
  },
});

export const SLUGIFY_TYPE = 'text.slugify';
export interface SlugifyResult {
  slug: string;
}
export const slugify = defineAction({
  type: SLUGIFY_TYPE,
  name: 'Slugify',
  description: 'Convert the text to a URL-friendly slug.',
  auth: { type: 'none' },
  props: { text: shortText({ label: 'Text', required: true }) },
  run: ({ props }): Promise<SlugifyResult> => {
    const slug = props.text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return Promise.resolve({ slug });
  },
});

export const DEFAULT_VALUE_TYPE = 'text.default_value';
export interface DefaultValueResult {
  result: string;
}
export const defaultValue = defineAction({
  type: DEFAULT_VALUE_TYPE,
  name: 'Use Default Value if Input is Empty',
  description: 'Return the text, or a default when the text is empty.',
  auth: { type: 'none' },
  props: {
    text: shortText({ label: 'Text', required: false }),
    default: shortText({ label: 'Default value', required: true }),
  },
  run: ({ props }): Promise<DefaultValueResult> => {
    const value = props.text ?? '';
    return Promise.resolve({ result: value.trim().length > 0 ? value : props.default });
  },
});

export const STRIP_HTML_TYPE = 'text.strip_html';
export interface StripHtmlResult {
  text: string;
}
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};
export const stripHtml = defineAction({
  type: STRIP_HTML_TYPE,
  name: 'Remove HTML Tags',
  description: 'Strip HTML tags from the text, leaving the plain text.',
  auth: { type: 'none' },
  props: { html: longText({ label: 'HTML', required: true }) },
  run: ({ props }): Promise<StripHtmlResult> => {
    const withoutTags = props.html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '');
    const decoded = withoutTags
      .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
    return Promise.resolve({ text: decoded.replace(/[ \t]+/g, ' ').trim() });
  },
});

export const JSON_TO_TABLE_TYPE = 'text.json_to_ascii_table';
export interface JsonToTableResult {
  table: string;
}
function cell(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export const jsonToAsciiTable = defineAction({
  type: JSON_TO_TABLE_TYPE,
  name: 'List to Text Table',
  description: 'Render a JSON array of objects as a monospaced ASCII table.',
  auth: { type: 'none' },
  props: { data: json({ label: 'Rows', description: 'A JSON array of objects.', required: true }) },
  run: ({ props }): Promise<JsonToTableResult> => {
    if (!Array.isArray(props.data)) {
      throw new ActionError({
        code: 'invalid_input',
        message: '"data" must be a JSON array',
        retryable: false,
      });
    }
    const rows = props.data.filter(
      (r): r is { [k: string]: JsonValue } => typeof r === 'object' && r !== null && !Array.isArray(r),
    );
    const columns: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }
    if (columns.length === 0) return Promise.resolve({ table: '' });
    const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => cell(row[col]).length), 0));
    const line = (cells: string[]): string =>
      `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
    const divider = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
    const body = rows.map((row) => line(columns.map((col) => cell(row[col]))));
    return Promise.resolve({ table: [divider, line(columns), divider, ...body, divider].join('\n') });
  },
});

export const MARKDOWN_TO_HTML_TYPE = 'text.markdown_to_html';
export interface MarkdownToHtmlResult {
  html: string;
}
export const markdownToHtml = defineAction({
  type: MARKDOWN_TO_HTML_TYPE,
  name: 'Markdown to HTML',
  description: 'Convert Markdown to HTML.',
  auth: { type: 'none' },
  props: {
    markdown: longText({ label: 'Markdown Content', required: true }),
    flavor: dropdown<MarkdownFlavor, false>({
      label: 'Flavor of Markdown',
      required: false,
      defaultValue: 'github',
      options: [
        { label: 'Default', value: 'vanilla' },
        { label: 'Original', value: 'original' },
        { label: 'GitHub', value: 'github' },
      ],
    }),
    headerLevelStart: number({ label: 'Minimum Header Level', required: false, defaultValue: 1 }),
    tables: checkbox({ label: 'Support Tables', required: false, defaultValue: true }),
    noHeaderId: checkbox({ label: 'No Header ID', required: false, defaultValue: false }),
    simpleLineBreaks: checkbox({ label: 'Simple Line Breaks', required: false, defaultValue: false }),
    openLinksInNewWindow: checkbox({
      label: 'Open Links in New Window',
      required: false,
      defaultValue: false,
    }),
  },
  run: ({ props }): Promise<MarkdownToHtmlResult> => {
    const headerLevelStart = props.headerLevelStart ?? 1;
    if (headerLevelStart < 1 || headerLevelStart > 6) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'Minimum Header Level must be between 1 and 6.',
        retryable: false,
      });
    }
    const converter = new Converter({
      headerLevelStart,
      omitExtraWLInCodeBlocks: true,
      noHeaderId: props.noHeaderId ?? false,
      tables: props.tables ?? true,
      simpleLineBreaks: props.simpleLineBreaks ?? false,
      openLinksInNewWindow: props.openLinksInNewWindow ?? false,
    });
    converter.setFlavor(props.flavor ?? 'github');
    return Promise.resolve({ html: converter.makeHtml(props.markdown) });
  },
});

export const HTML_TO_MARKDOWN_TYPE = 'text.html_to_markdown';
export interface HtmlToMarkdownResult {
  markdown: string;
}
export const htmlToMarkdown = defineAction({
  type: HTML_TO_MARKDOWN_TYPE,
  name: 'HTML to Markdown',
  description: 'Convert HTML to Markdown.',
  auth: { type: 'none' },
  props: { html: longText({ label: 'HTML Content', required: true }) },
  run: ({ props }): Promise<HtmlToMarkdownResult> => {
    const service = new TurndownService();
    service.remove('script');
    return Promise.resolve({ markdown: service.turndown(props.html) });
  },
});

const PREDEFINED_SELECTORS: Record<Exclude<ExtractTarget, 'custom'>, string> = {
  title: 'title',
  links: 'a[href]',
  images: 'img[src]',
  headings: 'h1, h2, h3',
  paragraphs: 'p',
};

export const EXTRACT_FROM_HTML_TYPE = 'text.extract_from_html';
export interface ExtractFromHtmlResult {
  result: string | string[] | null;
}
export const extractFromHtml = defineAction({
  type: EXTRACT_FROM_HTML_TYPE,
  name: 'Extract from HTML',
  description: 'Extract elements or data from an HTML document with a CSS selector.',
  auth: { type: 'none' },
  props: {
    html: longText({ label: 'HTML Content', required: true }),
    target: dropdown<ExtractTarget, false>({
      label: 'Extraction Target',
      required: false,
      defaultValue: 'title',
      options: [
        { label: 'Page Title', value: 'title' },
        { label: 'All Links (<a> elements)', value: 'links' },
        { label: 'All Images', value: 'images' },
        { label: 'Main Headings (H1, H2, H3)', value: 'headings' },
        { label: 'Paragraphs / Text Blocks', value: 'paragraphs' },
        { label: 'Custom CSS Selector (Advanced)', value: 'custom' },
      ],
    }),
    selector: shortText({ label: 'Custom CSS Selector', required: false }),
    extractionType: dropdown<ExtractionType, false>({
      label: 'Extraction Type',
      required: false,
      defaultValue: 'textContent',
      options: [
        { label: 'Text Content (Clean Text)', value: 'textContent' },
        { label: 'Inner HTML', value: 'innerHtml' },
        { label: 'Outer HTML', value: 'outerHtml' },
        { label: 'Attribute (e.g., href, src)', value: 'attribute' },
      ],
    }),
    attributeName: shortText({ label: 'Attribute Name', required: false }),
    returnMultiple: checkbox({ label: 'Return Multiple Elements', required: false, defaultValue: false }),
  },
  run: ({ props }): Promise<ExtractFromHtmlResult> => {
    const target = props.target ?? 'title';
    const extractionType = props.extractionType ?? 'textContent';
    const finalSelector = target === 'custom' ? props.selector : PREDEFINED_SELECTORS[target];
    if (target === 'custom' && (!finalSelector || finalSelector.length === 0)) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'A Custom CSS Selector is required when the target is "Custom".',
        retryable: false,
      });
    }
    if (extractionType === 'attribute' && (!props.attributeName || props.attributeName.length === 0)) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'An Attribute Name is required when the extraction type is "Attribute".',
        retryable: false,
      });
    }
    let elements;
    try {
      elements = parseHtml(props.html).querySelectorAll(finalSelector ?? '');
    } catch (err) {
      throw new ActionError({
        code: 'invalid_input',
        message: `Invalid CSS selector "${finalSelector}": ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      });
    }
    const returnMultiple = props.returnMultiple ?? false;
    if (elements.length === 0) return Promise.resolve({ result: returnMultiple ? [] : null });
    const extract = (el: (typeof elements)[number]): string => {
      switch (extractionType) {
        case 'innerHtml':
          return el.innerHTML;
        case 'outerHtml':
          return el.outerHTML;
        case 'attribute':
          return el.getAttribute(props.attributeName ?? '') ?? '';
        case 'textContent':
        default:
          return (el.textContent ?? '').trim();
      }
    };
    if (returnMultiple) return Promise.resolve({ result: elements.map(extract) });
    const first = elements[0];
    return Promise.resolve({ result: first ? extract(first) : null });
  },
});
