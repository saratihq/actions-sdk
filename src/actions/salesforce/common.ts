import type { OAuth2Scheme } from '../../core/auth';
import { shortText } from '../../core/props';

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
