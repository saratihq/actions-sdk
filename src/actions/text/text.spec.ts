import { FakeTransport, stubAuth } from '../../testing/fakes';
import {
  concat,
  defaultValue,
  extractFromHtml,
  find,
  findAll,
  htmlToMarkdown,
  jsonToAsciiTable,
  markdownToHtml,
  replace,
  slugify,
  split,
  stripHtml,
  textActions,
} from './index';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

describe('text actions', () => {
  it('concatenates values with a separator', async () => {
    // Returns the joined string directly (a bare string) — not `{ result }`.
    expect(await concat.execute({ auth: noAuth, props: { texts: ['a', 'b', 'c'], separator: '-' } })).toBe(
      'a-b-c',
    );
    expect(await concat.execute({ auth: noAuth, props: { texts: [1, 2, 3] } })).toBe('123');
  });

  it('rejects a non-array concat input', async () => {
    await expect(concat.execute({ auth: noAuth, props: { texts: 'not-an-array' } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('replaces literally and by regex', async () => {
    expect(
      await replace.execute({ auth: noAuth, props: { text: 'a.b.c', find: '.', replacement: '_' } }),
    ).toEqual({ result: 'a_b_c' });
    expect(
      await replace.execute({
        auth: noAuth,
        props: { text: 'foo123bar', find: '\\d+', replacement: '#', useRegex: true },
      }),
    ).toEqual({ result: 'foo#bar' });
  });

  it('surfaces an invalid regex as invalid_input', async () => {
    await expect(
      replace.execute({ auth: noAuth, props: { text: 'x', find: '(', replacement: '', useRegex: true } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('splits by a delimiter', async () => {
    expect(await split.execute({ auth: noAuth, props: { text: 'a,b,c', delimiter: ',' } })).toEqual({
      result: ['a', 'b', 'c'],
    });
  });

  it('finds first and all matches', async () => {
    expect(await find.execute({ auth: noAuth, props: { text: 'the cat sat', pattern: 'at' } })).toEqual({
      found: true,
      index: 5,
      match: 'at',
    });
    expect(await find.execute({ auth: noAuth, props: { text: 'abc', pattern: 'z' } })).toEqual({
      found: false,
      index: -1,
      match: null,
    });
    expect(
      await findAll.execute({ auth: noAuth, props: { text: 'a1b2c3', pattern: '\\d', useRegex: true } }),
    ).toEqual({ matches: ['1', '2', '3'], count: 3 });
  });

  it('slugifies text (diacritics + punctuation)', async () => {
    expect(await slugify.execute({ auth: noAuth, props: { text: 'Héllo, World!' } })).toEqual({
      slug: 'hello-world',
    });
  });

  it('falls back to a default when input is empty', async () => {
    expect(await defaultValue.execute({ auth: noAuth, props: { text: '  ', default: 'fallback' } })).toEqual({
      result: 'fallback',
    });
    expect(await defaultValue.execute({ auth: noAuth, props: { text: 'kept', default: 'x' } })).toEqual({
      result: 'kept',
    });
  });

  it('strips html tags and decodes entities', async () => {
    const out = await stripHtml.execute({
      auth: noAuth,
      props: { html: '<p>Hello&nbsp;<b>World</b> &amp; more</p><script>evil()</script>' },
    });
    expect(out.text).toBe('Hello World & more');
  });

  it('renders a JSON array of objects as an ascii table', async () => {
    const out = await jsonToAsciiTable.execute({
      auth: noAuth,
      props: {
        data: [
          { name: 'Ann', age: 30 },
          { name: 'Bob', age: 5 },
        ],
      },
    });
    expect(out.table).toContain('name');
    expect(out.table).toContain('Ann');
    expect(out.table.split('\n').length).toBeGreaterThanOrEqual(5);
  });

  it('converts markdown to HTML honouring options', async () => {
    const out = await markdownToHtml.execute({
      auth: noAuth,
      props: { markdown: '# Title\n\nHello **world**' },
    });
    expect(out.html).toContain('<h1');
    expect(out.html).toContain('<strong>world</strong>');
  });

  it('shifts the minimum header level and rejects out-of-range levels', async () => {
    const out = await markdownToHtml.execute({
      auth: noAuth,
      props: { markdown: '# Title', headerLevelStart: 3 },
    });
    expect(out.html).toContain('<h3');
    await expect(
      markdownToHtml.execute({ auth: noAuth, props: { markdown: '# x', headerLevelStart: 9 } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('converts HTML to markdown and strips scripts', async () => {
    const out = await htmlToMarkdown.execute({
      auth: noAuth,
      props: { html: '<h1>Title</h1><p>Hello <strong>world</strong></p><script>alert(1)</script>' },
    });
    expect(out.markdown).toContain('Title');
    expect(out.markdown).toContain('**world**');
    expect(out.markdown).not.toContain('alert(1)');
  });

  it('round-trips markdown → HTML → markdown', async () => {
    const markdown = '# Heading\n\nA paragraph with **bold** text.';
    const html = (await markdownToHtml.execute({ auth: noAuth, props: { markdown } })).html;
    const back = (await htmlToMarkdown.execute({ auth: noAuth, props: { html } })).markdown;
    expect(back).toContain('Heading');
    expect(back).toContain('**bold**');
  });

  it('extracts the title, links, and headings from HTML', async () => {
    const html =
      '<html><head><title>Doc</title></head><body>' +
      '<a href="/a">A</a><a href="/b">B</a><h1>H1</h1><h2>H2</h2></body></html>';
    const title = await extractFromHtml.execute({ auth: noAuth, props: { html, target: 'title' } });
    expect(title.result).toBe('Doc');

    const links = await extractFromHtml.execute({
      auth: noAuth,
      props: {
        html,
        target: 'links',
        extractionType: 'attribute',
        attributeName: 'href',
        returnMultiple: true,
      },
    });
    expect(links.result).toEqual(['/a', '/b']);

    const headings = await extractFromHtml.execute({
      auth: noAuth,
      props: { html, target: 'headings', returnMultiple: true },
    });
    expect(headings.result).toEqual(['H1', 'H2']);
  });

  it('supports a custom selector and returns null on no match', async () => {
    const html = '<div class="price">$9.99</div>';
    const hit = await extractFromHtml.execute({
      auth: noAuth,
      props: { html, target: 'custom', selector: '.price' },
    });
    expect(hit.result).toBe('$9.99');

    const miss = await extractFromHtml.execute({
      auth: noAuth,
      props: { html, target: 'custom', selector: '.missing' },
    });
    expect(miss.result).toBeNull();
  });

  it('rejects a custom target with no selector and an attribute type with no name', async () => {
    await expect(
      extractFromHtml.execute({ auth: noAuth, props: { html: '<p>x</p>', target: 'custom' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      extractFromHtml.execute({
        auth: noAuth,
        props: { html: '<a href="/x">y</a>', target: 'links', extractionType: 'attribute' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('exposes twelve actions, all text.* typed', () => {
    expect(textActions).toHaveLength(12);
    for (const action of textActions) expect(action.type.startsWith('text.')).toBe(true);
  });
});
