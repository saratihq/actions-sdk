import { FakeTransport, stubAuth } from '../../testing/fakes';
import { binanceActions, fetchPairPrice } from './index';

describe('binance.fetch_crypto_pair_price', () => {
  it('normalises the symbol and returns the price', async () => {
    const transport = new FakeTransport(() => ({
      status: 200,
      headers: {},
      data: { symbol: 'BTCUSDT', price: '64000.10' },
    }));
    const out = await fetchPairPrice.execute({ auth: stubAuth(transport), props: { symbol: ' btcusdt ' } });
    expect(out).toEqual({ symbol: 'BTCUSDT', price: '64000.10' });
    expect(transport.requests[0]!.url).toContain('symbol=BTCUSDT');
  });

  it('exposes one action, binance.* typed', () => {
    expect(binanceActions).toHaveLength(1);
    for (const action of binanceActions) expect(action.type.startsWith('binance.')).toBe(true);
  });
});
