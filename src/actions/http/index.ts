export {
  PARSE_URL_TYPE,
  type ParseUrlResult,
  parseUrl,
  SEND_REQUEST_TYPE,
  type SendRequestResult,
  sendRequest,
} from './http';
export { HTTP_NEW_ITEM_TYPE, httpItemKey, newItem } from './new-item.polling';

import { parseUrl, sendRequest } from './http';

/** Every HTTP action, for catalog builds and registration. */
export const httpActions = [sendRequest, parseUrl] as const;
