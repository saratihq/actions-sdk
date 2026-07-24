export { GRAPHQL_SEND_TYPE, type GraphqlResult, sendRequest } from './graphql';

import { sendRequest } from './graphql';

/** Every GraphQL action, for catalog builds and registration. */
export const graphqlActions = [sendRequest] as const;
