import type { OAuth2Scheme } from '../../core/auth';

/**
 * Shared Google Slides (API v1) building blocks: the `/v1/presentations`
 * endpoints, OAuth2 Bearer auth, the `presentations.create` `{ title }` body, and
 * the `slides[]` shape. JSON throughout — no multipart.
 */

export const SLIDES_API_BASE = 'https://slides.googleapis.com/v1/presentations';

/** Slides authenticates with an OAuth2 bearer access token, attached by the transport. */
export const slidesAuth: OAuth2Scheme = {
  type: 'oauth2',
  scopes: ['https://www.googleapis.com/auth/presentations'],
};

/** A presentation, trimmed to what reads summarise (the raw pages are large). */
export interface Presentation {
  presentationId: string;
  title?: string;
  revisionId?: string;
  slides?: Array<{ objectId?: string }>;
}
