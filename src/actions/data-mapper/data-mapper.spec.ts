import { FakeTransport, stubAuth } from '../../testing/fakes';
import { advancedMapping, dataMapperActions } from './index';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

describe('data-mapper actions', () => {
  it('returns the resolved mapping object verbatim', async () => {
    const mapping = { fullName: 'Ann Lee', age: 30, tags: ['a', 'b'] };
    expect(await advancedMapping.execute({ auth: noAuth, props: { mapping } })).toEqual(mapping);
  });

  it('rejects a non-object mapping', async () => {
    await expect(
      advancedMapping.execute({ auth: noAuth, props: { mapping: [1, 2, 3] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('exposes one action, data_mapper.* typed', () => {
    expect(dataMapperActions).toHaveLength(1);
    for (const action of dataMapperActions) expect(action.type.startsWith('data_mapper.')).toBe(true);
  });
});
