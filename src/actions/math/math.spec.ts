import { FakeTransport, stubAuth } from '../../testing/fakes';
import {
  addition,
  division,
  generateRandom,
  mathActions,
  modulo,
  multiplication,
  subtraction,
} from './index';

// Pure actions ignore auth/http, but `execute` still requires an auth handle.
const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

describe('math actions', () => {
  it('adds, subtracts, multiplies', async () => {
    expect(await addition.execute({ auth: noAuth, props: { first_number: 2, second_number: 3 } })).toEqual({
      result: 5,
    });
    expect(await subtraction.execute({ auth: noAuth, props: { first_number: 7, second_number: 4 } })).toEqual(
      {
        result: 3,
      },
    );
    expect(
      await multiplication.execute({ auth: noAuth, props: { first_number: 6, second_number: 7 } }),
    ).toEqual({ result: 42 });
  });

  it('coerces string numbers before computing (the boundary contract)', async () => {
    expect(
      await addition.execute({ auth: noAuth, props: { first_number: '10', second_number: '5' } }),
    ).toEqual({
      result: 15,
    });
  });

  it('divides and takes modulo', async () => {
    expect(await division.execute({ auth: noAuth, props: { first_number: 9, second_number: 2 } })).toEqual({
      result: 4.5,
    });
    expect(await modulo.execute({ auth: noAuth, props: { first_number: 9, second_number: 2 } })).toEqual({
      result: 1,
    });
  });

  it('rejects divide/modulo by zero', async () => {
    await expect(
      division.execute({ auth: noAuth, props: { first_number: 1, second_number: 0 } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      modulo.execute({ auth: noAuth, props: { first_number: 1, second_number: 0 } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('generates a random integer within the inclusive range', async () => {
    for (let i = 0; i < 200; i++) {
      const out = await generateRandom.execute({ auth: noAuth, props: { min: 5, max: 7 } });
      expect(out.result).toBeGreaterThanOrEqual(5);
      expect(out.result).toBeLessThanOrEqual(7);
      expect(Number.isInteger(out.result)).toBe(true);
    }
  });

  it('rejects a random range where min > max', async () => {
    await expect(generateRandom.execute({ auth: noAuth, props: { min: 10, max: 1 } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('exposes exactly six actions, all math.* typed', () => {
    expect(mathActions).toHaveLength(6);
    for (const action of mathActions) expect(action.type.startsWith('math.')).toBe(true);
  });
});
