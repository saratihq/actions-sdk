import type { AuthHandle } from './auth';
import { ActionError } from './errors';
import type { HttpClient } from './http/client';
import type { JsonValue } from './http/types';

export type PropKind =
  | 'shortText'
  | 'longText'
  | 'number'
  | 'checkbox'
  | 'dropdown'
  | 'multiSelect'
  | 'json'
  | 'file'
  | 'dateTime';

/** A file passed to/from an action. Binary rides as a Buffer, never a mangled string. */
export interface FileInput {
  filename: string;
  data: Buffer;
  mimeType?: string;
}

/** One selectable option in a dropdown/multiSelect. */
export interface DropdownOption<V> {
  label: string;
  value: V;
}

/** Normalised result of resolving a dropdown's options. */
export interface DropdownResult<V> {
  options: DropdownOption<V>[];
  /** True when options can't be loaded yet (e.g. no connection) — the picker is inert. */
  disabled: boolean;
  placeholder?: string;
}

/** Context handed to an async options loader — the same seam `run` gets. */
export interface OptionsContext {
  auth: AuthHandle;
  http: HttpClient;
  /** Optional client-side search term to filter/scope the fetch. */
  search?: string;
}

/** Static options array, or a live loader. The loader is what makes config native. */
export type OptionsSource<V> = DropdownOption<V>[] | ((ctx: OptionsContext) => Promise<DropdownOption<V>[]>);

interface CommonOptions<TRequired extends boolean> {
  label: string;
  description?: string;
  required: TRequired;
}

/** Base fields every schema shares. `__value` is a phantom for value-type inference only. */
export interface BasePropSchema<TKind extends PropKind, TValue, TRequired extends boolean> {
  readonly kind: TKind;
  readonly label: string;
  readonly description?: string;
  readonly required: TRequired;
  readonly defaultValue?: TValue;
  /** Phantom — carries TValue for {@link PropValue}; never populated at runtime. */
  readonly __value?: TValue;
}

export type ShortTextSchema<R extends boolean> = BasePropSchema<'shortText', string, R>;
export type LongTextSchema<R extends boolean> = BasePropSchema<'longText', string, R>;
export type NumberSchema<R extends boolean> = BasePropSchema<'number', number, R>;
export type CheckboxSchema<R extends boolean> = BasePropSchema<'checkbox', boolean, R>;
export type JsonSchema<R extends boolean> = BasePropSchema<'json', JsonValue, R>;
export type FileSchema<R extends boolean> = BasePropSchema<'file', FileInput, R>;
export type DateTimeSchema<R extends boolean> = BasePropSchema<'dateTime', string, R>;

export interface DropdownSchema<V, R extends boolean> extends BasePropSchema<'dropdown', V, R> {
  readonly options: OptionsSource<V>;
  /** Whether options are loaded live (async) vs static — drives the catalog kind. */
  readonly dynamic: boolean;
  /** Prop names this loader depends on; changing them re-runs the loader. */
  readonly refreshers?: string[];
}

export interface MultiSelectSchema<V, R extends boolean> extends BasePropSchema<'multiSelect', V[], R> {
  readonly options: OptionsSource<V>;
  readonly dynamic: boolean;
  readonly refreshers?: string[];
}

/** Any prop schema. */
export type AnyPropSchema =
  | ShortTextSchema<boolean>
  | LongTextSchema<boolean>
  | NumberSchema<boolean>
  | CheckboxSchema<boolean>
  | JsonSchema<boolean>
  | FileSchema<boolean>
  | DateTimeSchema<boolean>
  | DropdownSchema<unknown, boolean>
  | MultiSelectSchema<unknown, boolean>;

export type PropsSchema = Record<string, AnyPropSchema>;

/** Extract the runtime value type of a single prop, honouring `required`. */
export type PropValue<P> = P extends { required: true; __value?: infer V }
  ? V
  : P extends { required: false; __value?: infer V }
    ? V | undefined
    : never;

/** The fully-typed `props` object an action's `run` receives. */
export type PropsValue<TProps extends PropsSchema> = {
  [K in keyof TProps]: PropValue<TProps[K]>;
};

// ─── factories ───

export function shortText<const R extends boolean = false>(o: CommonOptions<R> & { defaultValue?: string }) {
  return schema<'shortText', string, R>('shortText', o);
}
export function longText<const R extends boolean = false>(o: CommonOptions<R> & { defaultValue?: string }) {
  return schema<'longText', string, R>('longText', o);
}
export function number<const R extends boolean = false>(o: CommonOptions<R> & { defaultValue?: number }) {
  return schema<'number', number, R>('number', o);
}
export function checkbox<const R extends boolean = false>(o: CommonOptions<R> & { defaultValue?: boolean }) {
  return schema<'checkbox', boolean, R>('checkbox', o);
}
export function json<const R extends boolean = false>(o: CommonOptions<R> & { defaultValue?: JsonValue }) {
  return schema<'json', JsonValue, R>('json', o);
}
export function file<const R extends boolean = false>(o: CommonOptions<R>) {
  return schema<'file', FileInput, R>('file', o);
}
/** An ISO-8601 date-time string (validated on parse). */
export function dateTime<const R extends boolean = false>(o: CommonOptions<R> & { defaultValue?: string }) {
  return schema<'dateTime', string, R>('dateTime', o);
}

export function dropdown<V, const R extends boolean = false>(
  o: CommonOptions<R> & { options: OptionsSource<V>; refreshers?: string[]; defaultValue?: V },
): DropdownSchema<V, R> {
  return {
    kind: 'dropdown',
    label: o.label,
    ...(o.description !== undefined ? { description: o.description } : {}),
    required: o.required,
    ...(o.defaultValue !== undefined ? { defaultValue: o.defaultValue } : {}),
    options: o.options,
    dynamic: typeof o.options === 'function',
    ...(o.refreshers !== undefined ? { refreshers: o.refreshers } : {}),
  };
}

export function multiSelect<V, const R extends boolean = false>(
  o: CommonOptions<R> & { options: OptionsSource<V>; refreshers?: string[]; defaultValue?: V[] },
): MultiSelectSchema<V, R> {
  return {
    kind: 'multiSelect',
    label: o.label,
    ...(o.description !== undefined ? { description: o.description } : {}),
    required: o.required,
    ...(o.defaultValue !== undefined ? { defaultValue: o.defaultValue } : {}),
    options: o.options,
    dynamic: typeof o.options === 'function',
    ...(o.refreshers !== undefined ? { refreshers: o.refreshers } : {}),
  };
}

function schema<TKind extends PropKind, TValue, R extends boolean>(
  kind: TKind,
  o: CommonOptions<R> & { defaultValue?: TValue },
): BasePropSchema<TKind, TValue, R> {
  return {
    kind,
    label: o.label,
    ...(o.description !== undefined ? { description: o.description } : {}),
    required: o.required,
    ...(o.defaultValue !== undefined ? { defaultValue: o.defaultValue } : {}),
  };
}

// ─── validation / coercion at the trust boundary ───

/** Validate/coerce untrusted input into typed props; throws non-retryable `invalid_input` naming the field. */
export function parseProps<TProps extends PropsSchema>(
  schemas: TProps,
  input: Record<string, unknown>,
): PropsValue<TProps> {
  const out: Record<string, unknown> = {};
  for (const [name, propSchema] of Object.entries(schemas)) {
    const raw = input[name];
    const present = raw !== undefined && raw !== null;

    if (!present) {
      if (propSchema.required) {
        throw invalidInput(name, `required prop "${name}" is missing`);
      }
      if (propSchema.defaultValue !== undefined) out[name] = propSchema.defaultValue;
      continue;
    }
    out[name] = coerce(name, propSchema, raw);
  }
  return out as PropsValue<TProps>;
}

function coerce(name: string, propSchema: AnyPropSchema, raw: unknown): unknown {
  switch (propSchema.kind) {
    case 'shortText':
    case 'longText':
      if (typeof raw !== 'string') throw invalidInput(name, `"${name}" must be a string`);
      return raw;
    case 'dateTime': {
      if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
        throw invalidInput(name, `"${name}" must be an ISO-8601 date-time string`);
      }
      return raw;
    }
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
      throw invalidInput(name, `"${name}" must be a number`);
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw invalidInput(name, `"${name}" must be a boolean`);
    }
    case 'multiSelect':
      if (!Array.isArray(raw)) throw invalidInput(name, `"${name}" must be an array`);
      return raw;
    case 'file':
      if (!isFileInput(raw)) throw invalidInput(name, `"${name}" must be a file { filename, data }`);
      return raw;
    case 'dropdown':
    case 'json':
      // Dropdown values can be primitives or objects; JSON is any JSON value.
      return raw;
    default: {
      const _exhaustive: never = propSchema;
      throw invalidInput(name, `unknown prop kind for "${name}": ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function isFileInput(value: unknown): value is FileInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FileInput).filename === 'string' &&
    Buffer.isBuffer((value as FileInput).data)
  );
}

function invalidInput(field: string, message: string): ActionError {
  return new ActionError({ code: 'invalid_input', message, status: 0, retryable: false, detail: { field } });
}

/** Resolve a dropdown/multiSelect's options (static or live); a missing connection yields a disabled result, not an error. */
export async function resolveOptions<V>(
  propSchema: DropdownSchema<V, boolean> | MultiSelectSchema<V, boolean>,
  ctx: Partial<OptionsContext> & { http?: HttpClient },
): Promise<DropdownResult<V>> {
  const source = propSchema.options;
  if (Array.isArray(source)) return { options: source, disabled: false };
  if (!ctx.auth || !ctx.http) {
    return { options: [], disabled: true, placeholder: 'Connect an account to load options' };
  }
  const options = await source({
    auth: ctx.auth,
    http: ctx.http,
    ...(ctx.search ? { search: ctx.search } : {}),
  });
  return { options, disabled: false };
}
