import type { ManifestEntry } from '../core/catalog';
import { catalogActions, catalogTriggers, pollingTriggers, referenceTriggers, utilityActions } from './index';

/**
 * Catalog-projection contract. Mirrors how a host runtime consumes the SDK: it
 * reads the flat `catalogActions`/`pollingTriggers` arrays and projects each via
 * `toManifest()` into a platform catalog row. These assertions guard that path —
 * every entry has a unique, namespace-valid public type and projects cleanly.
 */

const TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The consumer's projection (a host runtime's `manifestToCatalogEntry`), inlined. */
function projectRow(manifest: ManifestEntry): Record<string, unknown> {
  return {
    name: manifest.displayName,
    type: manifest.type,
    category: manifest.type.slice(0, manifest.type.indexOf('.')),
    description: manifest.description,
    auth: manifest.authType === 'none' ? 'none' : 'connection',
    parameters: manifest.props,
  };
}

describe('SDK action catalog projection', () => {
  it('every catalog action has a unique, namespace-valid public type', () => {
    const types = catalogActions.map((a) => a.type);
    expect(new Set(types).size).toBe(types.length); // no duplicates
    for (const type of types) expect(type).toMatch(TYPE_PATTERN);
  });

  it('projects every catalog action into a well-formed row', () => {
    for (const action of catalogActions) {
      const row = projectRow(action.toManifest());
      expect(typeof row.name).toBe('string');
      expect(row.type).toBe(action.type);
      expect(row.category).toBe(action.type.slice(0, action.type.indexOf('.')));
    }
  });

  it('registers the ported no-auth utility apps (phase-1 + heavy-lib phase-2)', () => {
    const utilityTypes = new Set(utilityActions.map((a) => a.type));
    const expected = [
      'http.send_request',
      'http.parse_url',
      'text.concat',
      'text.markdown_to_html',
      'text.html_to_markdown',
      'text.extract_from_html',
      'date.format_date',
      'math.addition_math',
      'json.merge_json',
      'json.run_jsonata_query',
      'xml.convert_json_to_xml',
      'xml.convert_xml_to_json',
      'csv.convert_csv_to_json',
      'csv.convert_excel_to_csv',
      'crypto.hash_text',
      'data_mapper.advanced_mapping',
      'graphql.send_request',
      'hackernews.fetch_top_stories',
      'binance.fetch_crypto_pair_price',
      'pdf.extract_text',
      'pdf.merge_pdfs',
      'qrcode.text_to_qrcode',
    ];
    for (const type of expected) expect(utilityTypes.has(type)).toBe(true);
    // Utility apps carry no credential — every one must project as `none` auth.
    for (const action of utilityActions) expect(action.auth.type).toBe('none');
    // 14 utility apps across the ported set.
    const apps = new Set([...utilityTypes].map((t) => t.slice(0, t.indexOf('.'))));
    expect(apps).toEqual(
      new Set([
        'http',
        'text',
        'date',
        'math',
        'json',
        'xml',
        'csv',
        'crypto',
        'data_mapper',
        'graphql',
        'hackernews',
        'binance',
        'pdf',
        'qrcode',
      ]),
    );
  });
});

describe('SDK polling-trigger catalog projection', () => {
  it('registers the reference polling triggers, all namespace-valid and polling-strategy', () => {
    const types = pollingTriggers.map((t) => t.type);
    expect(types).toContain('slack.new_channel');
    expect(types).toContain('http.new_item');
    expect(types).toContain('hackernews.new_story');
    expect(types).toContain('rss.new_item');
    for (const trigger of pollingTriggers) {
      expect(trigger.type).toMatch(TYPE_PATTERN);
      expect(trigger.strategy).toBe('polling');
      expect(typeof trigger.runPoll).toBe('function');
    }
  });

  it('projects every polling trigger into a well-formed row', () => {
    for (const trigger of pollingTriggers) {
      const row = projectRow(trigger.toManifest());
      expect(row.type).toBe(trigger.type);
      expect(typeof row.name).toBe('string');
    }
  });

  it('catalogTriggers unions the shipped webhook + polling triggers with unique types', () => {
    const types = catalogTriggers.map((t) => t.type);
    expect(new Set(types).size).toBe(types.length);
    // Webhook reference triggers are present alongside the polling ones.
    expect(types).toContain('github.new_push');
    // slack.new_message is an app-level webhook (Slack Events) with no service-side
    // intake rail yet, so it is deliberately excluded from the shipped catalog even
    // though its definition still ships in referenceTriggers (see src/actions/index.ts).
    expect(types).not.toContain('slack.new_message');
    for (const trigger of referenceTriggers) {
      if (trigger.type === 'slack.new_message') continue; // deliberately unshipped (see above)
      expect(catalogTriggers).toContain(trigger);
    }
    for (const trigger of pollingTriggers) expect(types).toContain(trigger.type);
  });
});
