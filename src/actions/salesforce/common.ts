import type { OAuth2Scheme } from '../../core/auth';
import { shortText } from '../../core/props';

/**
 * Shared Salesforce building blocks: the REST data API
 * (`/services/data/v{ver}/…`), OAuth2 Bearer auth, and the SOQL/`sobjects`
 * shapes are Salesforce's public contract. JSON throughout, so writes work.
 *
 * Salesforce is **instance-scoped**: every call is rooted at the org's own
 * `instance_url`. On a managed connection that comes from account metadata; here,
 * on the direct transport, it rides as a required `instanceUrl` prop (it is config,
 * not a secret, and the opaque auth handle can't carry it). An `sobject` picker
 * therefore needs that prop value — blocked until the loader contract can pass
 * set-prop values.
 */

/** Salesforce authenticates with an OAuth2 bearer access token, attached by the transport. */
export const salesforceAuth: OAuth2Scheme = { type: 'oauth2' };

/** Root a REST data-API call at the org's instance + api version. */
export function salesforceBaseUrl(instanceUrl: string, apiVersion: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}/services/data/${apiVersion}`;
}

/** The required "which org" prop every action shares. */
export function instanceUrlProp() {
  return shortText<true>({
    label: 'Instance URL',
    description: 'Your Salesforce instance, e.g. https://your-org.my.salesforce.com',
    required: true,
  });
}

/** The REST API version; defaults to a broadly-available release. */
export function apiVersionProp() {
  return shortText({
    label: 'API version',
    description: 'REST data API version, e.g. v58.0.',
    required: false,
    defaultValue: 'v58.0',
  });
}

/** The result of a SOQL `/query`. */
export interface SalesforceQueryResult<T = Record<string, unknown>> {
  totalSize: number;
  done: boolean;
  records: T[];
  nextRecordsUrl?: string;
}

/** The result of a create/update/delete write. */
export interface SalesforceWriteResult {
  id: string;
  success: boolean;
  errors?: unknown[];
}
