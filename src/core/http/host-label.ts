import { ActionError } from '../errors';

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Validate input that becomes one label of a provider hostname, so it can never escape the host template. */
export function hostLabel(value: string, field: string): string {
  const label = value.trim().toLowerCase();
  if (!DNS_LABEL.test(label)) {
    throw new ActionError({
      code: 'invalid_input',
      message: `${field} must be a single DNS label (letters, digits and hyphens), e.g. "acme"`,
      retryable: false,
      detail: { field },
    });
  }
  return label;
}
