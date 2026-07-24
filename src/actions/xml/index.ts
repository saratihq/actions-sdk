export {
  convertJsonToXml,
  convertXmlToJson,
  JSON_TO_XML_TYPE,
  type JsonToXmlResult,
  XML_TO_JSON_TYPE,
  type XmlToJsonResult,
} from './xml';

import { convertJsonToXml, convertXmlToJson } from './xml';

/** Every XML action, for catalog builds and registration. */
export const xmlActions = [convertJsonToXml, convertXmlToJson] as const;
