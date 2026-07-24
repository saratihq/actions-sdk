export { type Presentation, SLIDES_API_BASE, slidesAuth } from './common';
export {
  CREATE_PRESENTATION_TYPE,
  createPresentation,
  type CreatedPresentation,
  GET_PRESENTATION_TYPE,
  getPresentation,
  type PresentationSummary,
} from './presentations';

import { createPresentation, getPresentation } from './presentations';

/** Every Google Slides action, for catalog builds and registration. */
export const slidesActions = [createPresentation, getPresentation] as const;
