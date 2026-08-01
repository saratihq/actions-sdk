import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import type { JsonValue } from '../../core/http/types';
import { checkbox, json, longText, shortText } from '../../core/props';

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Coerce a JSON key into a valid XML element name. */
function tagName(key: string): string {
  const cleaned = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Serialise one value under `key`; arrays repeat the tag, objects nest, scalars become text. */
function serialize(value: JsonValue, key: string, indent: string): string {
  if (Array.isArray(value)) {
    return value.map((item) => serialize(item, key, indent)).join('\n');
  }
  const name = tagName(key);
  if (value === null) return `${indent}<${name}/>`;
  if (typeof value === 'object') {
    const children = Object.entries(value)
      .map(([k, v]) => serialize(v, k, `${indent}  `))
      .join('\n');
    return children.length > 0
      ? `${indent}<${name}>\n${children}\n${indent}</${name}>`
      : `${indent}<${name}/>`;
  }
  return `${indent}<${name}>${escapeXml(String(value))}</${name}>`;
}

export const JSON_TO_XML_TYPE = 'xml.convert_json_to_xml';
export interface JsonToXmlResult {
  result: string;
}
export const convertJsonToXml = defineAction({
  type: JSON_TO_XML_TYPE,
  name: 'Convert JSON to XML',
  description: 'Serialise a JSON value into an XML document.',
  auth: { type: 'none' },
  props: {
    data: json({ label: 'JSON', required: true }),
    rootName: shortText({ label: 'Root element name', required: false, defaultValue: 'root' }),
  },
  run: ({ props }): Promise<JsonToXmlResult> => {
    const root = tagName(props.rootName && props.rootName.length > 0 ? props.rootName : 'root');
    const data = props.data;
    let body: string;
    if (Array.isArray(data)) {
      body = data.map((item) => serialize(item, 'item', '  ')).join('\n');
    } else if (typeof data === 'object' && data !== null) {
      body = Object.entries(data)
        .map(([k, v]) => serialize(v, k, '  '))
        .join('\n');
    } else {
      body = `  ${escapeXml(String(data ?? ''))}`;
    }
    const result = `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n${body}\n</${root}>`;
    return Promise.resolve({ result });
  },
});

export const XML_TO_JSON_TYPE = 'xml.convert_xml_to_json';
export interface XmlToJsonResult {
  result: JsonValue;
}
export const convertXmlToJson = defineAction({
  type: XML_TO_JSON_TYPE,
  name: 'Convert XML to JSON',
  description: 'Parse an XML document into a JSON value.',
  auth: { type: 'none' },
  props: {
    xml: longText({ label: 'XML', description: 'The XML string to convert.', required: true }),
    ignoreAttributes: checkbox({
      label: 'Ignore Attributes',
      description: 'When off, attributes are included with an "@_" prefix (e.g. id="42" → {"@_id": "42"}).',
      required: false,
      defaultValue: false,
    }),
  },
  run: ({ props }): Promise<XmlToJsonResult> => {
    const validation = XMLValidator.validate(props.xml);
    if (validation !== true) {
      throw new ActionError({
        code: 'invalid_input',
        message: `Invalid XML: ${validation.err.msg}`,
        retryable: false,
      });
    }
    const parser = new XMLParser({
      ignoreAttributes: props.ignoreAttributes ?? false,
      ignoreDeclaration: true,
    });
    return Promise.resolve({ result: parser.parse(props.xml) as JsonValue });
  },
});
