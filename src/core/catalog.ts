import type { AuthScheme } from './auth';
import type { AnyPropSchema, DropdownOption, PropsSchema } from './props';

/** Prop tags the client inspector renders by — must stay in lockstep with the client's renderer. */
export type ManifestPropType =
  | 'SHORT_TEXT'
  | 'LONG_TEXT'
  | 'NUMBER'
  | 'CHECKBOX'
  | 'DROPDOWN'
  | 'STATIC_DROPDOWN'
  | 'MULTI_SELECT_DROPDOWN'
  | 'STATIC_MULTI_SELECT_DROPDOWN'
  | 'JSON'
  | 'FILE'
  | 'DATE_TIME';

export interface ManifestProp {
  type: ManifestPropType;
  displayName: string;
  description?: string;
  required: boolean;
  defaultValue?: unknown;
  /** Present only for static dropdowns; dynamic pickers load at runtime. */
  options?: Array<DropdownOption<unknown>>;
}

export interface ManifestEntry {
  /** Public `<slug>.<action>` namespace — a stable public catalog id. */
  type: string;
  displayName: string;
  description: string;
  authType: AuthScheme['type'];
  props: Record<string, ManifestProp>;
}

/** The minimal shape a catalog entry is built from (an action or a trigger). */
export interface ManifestSource {
  type: string;
  name: string;
  description: string;
  auth: AuthScheme;
  props: PropsSchema;
}

export function toManifestEntry(source: ManifestSource): ManifestEntry {
  const props: Record<string, ManifestProp> = {};
  for (const [name, schema] of Object.entries(source.props)) {
    props[name] = propToManifest(schema);
  }
  return {
    type: source.type,
    displayName: source.name,
    description: source.description,
    authType: source.auth.type,
    props,
  };
}

function propToManifest(schema: AnyPropSchema): ManifestProp {
  const base: ManifestProp = {
    type: manifestType(schema),
    displayName: schema.label,
    required: schema.required,
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    ...(schema.defaultValue !== undefined ? { defaultValue: schema.defaultValue } : {}),
  };
  // Inline static options so the client can render the picker without a fetch.
  if ((schema.kind === 'dropdown' || schema.kind === 'multiSelect') && Array.isArray(schema.options)) {
    base.options = schema.options;
  }
  return base;
}

function manifestType(schema: AnyPropSchema): ManifestPropType {
  switch (schema.kind) {
    case 'shortText':
      return 'SHORT_TEXT';
    case 'longText':
      return 'LONG_TEXT';
    case 'number':
      return 'NUMBER';
    case 'checkbox':
      return 'CHECKBOX';
    case 'json':
      return 'JSON';
    case 'file':
      return 'FILE';
    case 'dateTime':
      return 'DATE_TIME';
    case 'dropdown':
      return schema.dynamic ? 'DROPDOWN' : 'STATIC_DROPDOWN';
    case 'multiSelect':
      return schema.dynamic ? 'MULTI_SELECT_DROPDOWN' : 'STATIC_MULTI_SELECT_DROPDOWN';
    default: {
      const _exhaustive: never = schema;
      throw new Error(`unmapped prop kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
