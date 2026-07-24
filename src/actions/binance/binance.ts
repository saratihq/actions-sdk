import { defineAction } from '../../core/action';
import { shortText } from '../../core/props';

/**
 * Binance utility — a no-auth (`none` scheme) action. Reads the public
 * spot-price ticker (`api.binance.com/api/v3/ticker/price`), which needs no API key.
 */

const BINANCE_BASE = 'https://api.binance.com/api/v3';

export const FETCH_PAIR_PRICE_TYPE = 'binance.fetch_crypto_pair_price';
export interface PairPriceResult {
  symbol: string;
  price: string;
}
export const fetchPairPrice = defineAction({
  type: FETCH_PAIR_PRICE_TYPE,
  name: 'Fetch Pair Price',
  description: 'Fetch the current spot price for a trading pair (e.g. BTCUSDT).',
  auth: { type: 'none' },
  props: {
    symbol: shortText({ label: 'Symbol', description: 'A trading pair such as BTCUSDT.', required: true }),
  },
  async run({ auth, props, http }): Promise<PairPriceResult> {
    const symbol = props.symbol.trim().toUpperCase();
    const res = await http.get<{ symbol: string; price: string }>(`${BINANCE_BASE}/ticker/price`, {
      auth,
      query: { symbol },
    });
    return { symbol: res.data.symbol, price: res.data.price };
  },
});
