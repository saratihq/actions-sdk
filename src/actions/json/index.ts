export {
  convertJsonToText,
  convertTextToJson,
  JSON_TO_TEXT_TYPE,
  type JsonToTextResult,
  MERGE_JSON_TYPE,
  mergeJson,
  type MergeJsonResult,
  RUN_JSONATA_TYPE,
  runJsonataQuery,
  type RunJsonataResult,
  TEXT_TO_JSON_TYPE,
  type TextToJsonResult,
} from './json';

import { convertJsonToText, convertTextToJson, mergeJson, runJsonataQuery } from './json';

/** Every JSON action, for catalog builds and registration. */
export const jsonActions = [convertJsonToText, convertTextToJson, mergeJson, runJsonataQuery] as const;
