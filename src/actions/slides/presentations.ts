import { defineAction } from '../../core/action';
import { shortText } from '../../core/props';
import { type Presentation, SLIDES_API_BASE, slidesAuth } from './common';

/** Public action type ids — stable public catalog ids. */
export const CREATE_PRESENTATION_TYPE = 'slides.create_presentation';
export const GET_PRESENTATION_TYPE = 'slides.get_presentation';

/** The create response (id + title of the new presentation). */
export interface CreatedPresentation {
  presentationId: string;
  title: string;
}

/** A read presentation summary (id, title, revision, slide count + ids). */
export interface PresentationSummary {
  presentationId: string;
  title: string;
  revisionId?: string;
  slideCount: number;
  slideIds: string[];
}

/** Create a new presentation with a title. */
export const createPresentation = defineAction({
  type: CREATE_PRESENTATION_TYPE,
  name: 'Create presentation',
  description: 'Create a new Google Slides presentation with a title.',
  auth: slidesAuth,
  props: {
    title: shortText<true>({ label: 'Title', required: true }),
  },
  async run({ auth, props, http }): Promise<CreatedPresentation> {
    const res = await http.post<Presentation>(SLIDES_API_BASE, { auth, body: { title: props.title } });
    return { presentationId: res.data.presentationId, title: res.data.title ?? props.title };
  },
});

/** Get a presentation — returns an id/title/slide-count summary. */
export const getPresentation = defineAction({
  type: GET_PRESENTATION_TYPE,
  name: 'Get presentation',
  description: 'Get a Google Slides presentation’s title and slide list.',
  auth: slidesAuth,
  props: {
    presentationId: shortText<true>({ label: 'Presentation id', required: true }),
  },
  async run({ auth, props, http }): Promise<PresentationSummary> {
    const res = await http.get<Presentation>(
      `${SLIDES_API_BASE}/${encodeURIComponent(props.presentationId)}`,
      { auth },
    );
    const slides = res.data.slides ?? [];
    return {
      presentationId: res.data.presentationId,
      title: res.data.title ?? '',
      ...(res.data.revisionId !== undefined ? { revisionId: res.data.revisionId } : {}),
      slideCount: slides.length,
      slideIds: slides.map((s) => s.objectId ?? '').filter(Boolean),
    };
  },
});
