export { FETCH_PAIR_PRICE_TYPE, fetchPairPrice, type PairPriceResult } from './binance';

import { fetchPairPrice } from './binance';

/** Every Binance action, for catalog builds and registration. */
export const binanceActions = [fetchPairPrice] as const;
