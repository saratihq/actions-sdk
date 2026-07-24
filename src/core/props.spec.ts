import { ActionError } from './errors';
import {
  checkbox,
  dateTime,
  dropdown,
  file,
  json,
  longText,
  multiSelect,
  number,
  parseProps,
  type PropsValue,
  resolveOptions,
  shortText,
} from './props';

describe('parseProps', () => {
  const schemas = {
    name: shortText({ label: 'Name', required: true }),
    count: number({ label: 'Count', required: false, defaultValue: 5 }),
    active: checkbox({ label: 'Active', required: false }),
    when: dateTime({ label: 'When', required: false }),
    tags: multiSelect<string, false>({ label: 'Tags', required: false, options: [] }),
  };

  it('accepts a valid record and applies defaults', () => {
    const out = parseProps(schemas, { name: 'a' });
    expect(out).toEqual({ name: 'a', count: 5 });
  });

  it('throws a non-retryable invalid_input naming the missing required field', () => {
    try {
      parseProps(schemas, {});
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      const e = err as ActionError;
      expect(e.code).toBe('invalid_input');
      expect(e.retryable).toBe(false);
      expect(e.detail).toEqual({ field: 'name' });
    }
  });

  it('coerces numeric strings and boolean strings', () => {
    const out = parseProps(schemas, { name: 'a', count: '42', active: 'true' });
    expect(out.count).toBe(42);
    expect(out.active).toBe(true);
  });

  it('rejects a non-numeric string for a number prop', () => {
    expect(() => parseProps(schemas, { name: 'a', count: 'abc' })).toThrow(/must be a number/);
  });

  it('rejects a malformed date-time', () => {
    expect(() => parseProps(schemas, { name: 'a', when: 'not-a-date' })).toThrow(/ISO-8601/);
  });

  it('rejects a non-array for a multiSelect prop', () => {
    expect(() => parseProps(schemas, { name: 'a', tags: 'x' })).toThrow(/must be an array/);
  });

  it('validates file shape', () => {
    const withFile = { doc: file({ label: 'Doc', required: true }) };
    expect(() => parseProps(withFile, { doc: { filename: 'a.txt' } })).toThrow(/must be a file/);
    const ok = parseProps(withFile, { doc: { filename: 'a.txt', data: Buffer.from('hi') } });
    expect(ok.doc.filename).toBe('a.txt');
  });

  it('passes JSON values through untouched', () => {
    const withJson = { payload: json({ label: 'Payload', required: true }) };
    const out = parseProps(withJson, { payload: { a: [1, 2, 3] } });
    expect(out.payload).toEqual({ a: [1, 2, 3] });
  });
});

describe('PropsValue typing', () => {
  it('makes required props non-optional and optional props possibly-undefined', () => {
    const schemas = {
      req: shortText({ label: 'R', required: true }),
      opt: longText({ label: 'O', required: false }),
    };
    expect(schemas.req.required).toBe(true);
    // Compile-time assertion: this only type-checks if inference is correct.
    const value: PropsValue<typeof schemas> = { req: 'x', opt: undefined };
    expect(value.req).toBe('x');
    // @ts-expect-error required prop cannot be undefined
    const bad: PropsValue<typeof schemas> = { req: undefined, opt: 'y' };
    expect(bad).toBeDefined();
  });
});

describe('resolveOptions', () => {
  it('returns static options directly', async () => {
    const schema = dropdown<string, true>({
      label: 'X',
      required: true,
      options: [{ label: 'A', value: 'a' }],
    });
    const result = await resolveOptions(schema, {});
    expect(result).toEqual({ options: [{ label: 'A', value: 'a' }], disabled: false });
  });

  it('returns a disabled result for a dynamic loader without a connection', async () => {
    const schema = dropdown<string, true>({
      label: 'X',
      required: true,
      options: () => Promise.resolve([{ label: 'A', value: 'a' }]),
    });
    const result = await resolveOptions(schema, {});
    expect(result.disabled).toBe(true);
    expect(result.options).toEqual([]);
  });
});
