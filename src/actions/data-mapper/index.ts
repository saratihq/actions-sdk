export { ADVANCED_MAPPING_TYPE, advancedMapping, type AdvancedMappingResult } from './data-mapper';

import { advancedMapping } from './data-mapper';

/** Every Data-mapper action, for catalog builds and registration. */
export const dataMapperActions = [advancedMapping] as const;
