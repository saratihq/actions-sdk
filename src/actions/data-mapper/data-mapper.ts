import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import { json } from '../../core/props';

/**
 * Data-mapper — a no-auth (`none` scheme) action. "Advanced mapping" builds
 * an output object from a mapping spec: the host runtime resolves any field
 * interpolation BEFORE the action runs, so at execution time the action simply
 * returns the fully-resolved object as its output. The app slug is `data_mapper`
 * for the SDK namespace.
 */

export const ADVANCED_MAPPING_TYPE = 'data_mapper.advanced_mapping';
export type AdvancedMappingResult = { [k: string]: JsonValue };
export const advancedMapping = defineAction({
  type: ADVANCED_MAPPING_TYPE,
  name: 'Advanced Mapping',
  description: 'Return the provided (already-resolved) mapping object as the step output.',
  auth: { type: 'none' },
  props: {
    mapping: json({ label: 'Mapping', description: 'The output object to produce.', required: true }),
  },
  run: ({ props }): Promise<AdvancedMappingResult> => {
    if (typeof props.mapping !== 'object' || props.mapping === null || Array.isArray(props.mapping)) {
      throw new ActionError({
        code: 'invalid_input',
        message: '"mapping" must be a JSON object',
        retryable: false,
      });
    }
    return Promise.resolve(props.mapping);
  },
});
