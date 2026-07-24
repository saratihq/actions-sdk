import { FakeTransport, stubAuth } from '../testing/fakes';
import { defineAction } from './action';
import { ActionError } from './errors';
import { HttpClient } from './http/client';
import { checkbox, dropdown, longText, number, shortText } from './props';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

describe('defineAction', () => {
  it('rejects a malformed public type at definition time', () => {
    expect(() =>
      defineAction({
        type: 'NotAValidType',
        name: 'x',
        description: 'x',
        auth: { type: 'none' },
        props: {},
        run: () => Promise.resolve(null),
      }),
    ).toThrow(/invalid action type/);
  });

  const echo = defineAction({
    type: 'demo.echo',
    name: 'Echo',
    description: 'Echoes its props.',
    auth: { type: 'none' },
    props: {
      text: shortText({ label: 'Text', required: true }),
      count: number({ label: 'Count', required: false, defaultValue: 1 }),
    },
    run: ({ props }) => Promise.resolve({ text: props.text, count: props.count }),
  });

  it('validates props before running', async () => {
    await expect(echo.execute({ auth: noAuth, props: {} })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('runs with coerced/typed props', async () => {
    const out = await echo.execute({ auth: noAuth, props: { text: 'hi', count: '3' } });
    expect(out).toEqual({ text: 'hi', count: 3 });
  });

  it('normalises anything run() throws into an ActionError', async () => {
    const boom = defineAction({
      type: 'demo.boom',
      name: 'Boom',
      description: 'Throws a raw error.',
      auth: { type: 'none' },
      props: {},
      run: () => Promise.reject(new Error('kaboom')),
    });
    await expect(boom.execute({ auth: noAuth, props: {} })).rejects.toBeInstanceOf(ActionError);
  });

  it('drives http through the provided client', async () => {
    const transport = new FakeTransport(() => ({ status: 200, headers: {}, data: { pong: true } }));
    const action = defineAction({
      type: 'demo.ping',
      name: 'Ping',
      description: 'Calls an endpoint.',
      auth: { type: 'none' },
      props: {},
      run: async ({ auth, http }) => {
        const res = await http.get<{ pong: boolean }>('https://api.test/ping', { auth });
        return res.data;
      },
    });
    const out = await action.execute({ auth: stubAuth(transport), props: {}, http: new HttpClient() });
    expect(out).toEqual({ pong: true });
  });
});

describe('loadOptions', () => {
  const action = defineAction({
    type: 'demo.pick',
    name: 'Pick',
    description: 'Has a static dropdown.',
    auth: { type: 'none' },
    props: {
      color: dropdown<string, true>({
        label: 'Color',
        required: true,
        options: [
          { label: 'Red', value: 'r' },
          { label: 'Blue', value: 'b' },
        ],
      }),
      note: shortText({ label: 'Note', required: false }),
    },
    run: ({ props }) => Promise.resolve(props.color),
  });

  it('resolves static options', async () => {
    const result = await action.loadOptions('color', {});
    expect(result.options).toHaveLength(2);
    expect(result.disabled).toBe(false);
  });

  it('throws for a non-dropdown prop', async () => {
    await expect(action.loadOptions('note', {})).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('toManifest — UPPERCASE prop mapping', () => {
  const action = defineAction({
    type: 'demo.kinds',
    name: 'Kinds',
    description: 'One of each mapped kind.',
    auth: { type: 'oauth2' },
    props: {
      a: shortText({ label: 'A', required: true }),
      b: longText({ label: 'B', required: false }),
      c: number({ label: 'C', required: false }),
      d: checkbox({ label: 'D', required: false }),
      dynamic: dropdown<string, false>({ label: 'Dyn', required: false, options: () => Promise.resolve([]) }),
      static: dropdown<string, false>({
        label: 'Stat',
        required: false,
        options: [{ label: 'X', value: 'x' }],
      }),
    },
    run: () => Promise.resolve(null),
  });

  it('maps kinds to the catalog tags the inspector renders', () => {
    const manifest = action.toManifest();
    expect(manifest.type).toBe('demo.kinds');
    expect(manifest.authType).toBe('oauth2');
    expect(manifest.props.a?.type).toBe('SHORT_TEXT');
    expect(manifest.props.b?.type).toBe('LONG_TEXT');
    expect(manifest.props.c?.type).toBe('NUMBER');
    expect(manifest.props.d?.type).toBe('CHECKBOX');
    expect(manifest.props.dynamic?.type).toBe('DROPDOWN');
    expect(manifest.props.static?.type).toBe('STATIC_DROPDOWN');
    // Static options inline for the client; dynamic ones load at runtime.
    expect(manifest.props.static?.options).toHaveLength(1);
    expect(manifest.props.dynamic?.options).toBeUndefined();
  });
});
