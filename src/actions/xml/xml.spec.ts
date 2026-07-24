import { FakeTransport, stubAuth } from '../../testing/fakes';
import { convertJsonToXml, convertXmlToJson, xmlActions } from './index';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

describe('xml actions', () => {
  it('serialises a nested object', async () => {
    const out = await convertJsonToXml.execute({
      auth: noAuth,
      props: { data: { user: { name: 'Ann', age: 30 } }, rootName: 'doc' },
    });
    expect(out.result).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<doc>\n  <user>\n    <name>Ann</name>\n    <age>30</age>\n  </user>\n</doc>',
    );
  });

  it('repeats a tag for array elements', async () => {
    const out = await convertJsonToXml.execute({
      auth: noAuth,
      props: { data: { item: ['a', 'b'] }, rootName: 'list' },
    });
    expect(out.result).toContain('<item>a</item>');
    expect(out.result).toContain('<item>b</item>');
  });

  it('escapes special characters', async () => {
    const out = await convertJsonToXml.execute({
      auth: noAuth,
      props: { data: { note: 'a < b & c > d' } },
    });
    expect(out.result).toContain('<note>a &lt; b &amp; c &gt; d</note>');
  });

  it('sanitises invalid element names', async () => {
    const out = await convertJsonToXml.execute({
      auth: noAuth,
      props: { data: { '1bad key': 'x' } },
    });
    expect(out.result).toContain('<_1bad_key>x</_1bad_key>');
  });

  it('parses XML into JSON, including attributes', async () => {
    const out = await convertXmlToJson.execute({
      auth: noAuth,
      props: { xml: '<root><a id="1">x</a><b>y</b></root>' },
    });
    expect(out.result).toEqual({ root: { a: { '#text': 'x', '@_id': '1' }, b: 'y' } });
  });

  it('drops attributes when ignoreAttributes is on', async () => {
    const out = await convertXmlToJson.execute({
      auth: noAuth,
      props: { xml: '<root><a id="1">x</a></root>', ignoreAttributes: true },
    });
    expect(out.result).toEqual({ root: { a: 'x' } });
  });

  it('rejects malformed XML', async () => {
    await expect(
      convertXmlToJson.execute({ auth: noAuth, props: { xml: '<root><unclosed></root>' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('exposes two actions, xml.* typed', () => {
    expect(xmlActions).toHaveLength(2);
    for (const action of xmlActions) expect(action.type.startsWith('xml.')).toBe(true);
  });
});
