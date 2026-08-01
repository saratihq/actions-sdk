import { defineAction } from '../../core/action';
import { ActionError } from '../../core/errors';
import { dropdown, number, shortText } from '../../core/props';

/**
 * Date utilities — no-auth, dependency-free actions: `Intl.DateTimeFormat` for calendar parts,
 * epoch/UTC for arithmetic, and a dayjs-style token subset for formatting.
 */

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0=Sunday
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Parse an input date string, throwing a clear boundary error when unparseable. */
function parseDate(input: string): Date {
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) {
    throw new ActionError({
      code: 'invalid_input',
      message: `could not parse date: "${input}"`,
      retryable: false,
    });
  }
  return new Date(ms);
}

/** Break a date into calendar parts as observed in `timeZone` (defaults to UTC). */
function partsInZone(date: Date, timeZone?: string): DateParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone && timeZone.length > 0 ? timeZone : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) map[part.type] = part.value;
  const hour = Number(map.hour) % 24;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: DAYS_SHORT.indexOf(map.weekday ?? 'Sun'),
  };
}

/** Format calendar parts with a dayjs-style token pattern. */
function formatParts(parts: DateParts, pattern: string): string {
  const h12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  const tokens: Record<string, string> = {
    YYYY: String(parts.year).padStart(4, '0'),
    YY: String(parts.year % 100).padStart(2, '0'),
    MMMM: MONTHS_LONG[parts.month - 1] ?? '',
    MMM: MONTHS_SHORT[parts.month - 1] ?? '',
    MM: pad(parts.month),
    M: String(parts.month),
    DD: pad(parts.day),
    D: String(parts.day),
    dddd: DAYS_LONG[parts.weekday] ?? '',
    ddd: DAYS_SHORT[parts.weekday] ?? '',
    HH: pad(parts.hour),
    H: String(parts.hour),
    hh: pad(h12),
    h: String(h12),
    mm: pad(parts.minute),
    m: String(parts.minute),
    ss: pad(parts.second),
    s: String(parts.second),
    A: parts.hour < 12 ? 'AM' : 'PM',
    a: parts.hour < 12 ? 'am' : 'pm',
  };
  return pattern.replace(
    /YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g,
    (t) => tokens[t] ?? t,
  );
}

/** A UTC date-only ISO string (`YYYY-MM-DD`) at midnight. */
function utcDateIso(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

const timeZoneProp = shortText({
  label: 'Time zone',
  description: 'IANA time zone, e.g. America/New_York. Defaults to UTC.',
  required: false,
});

const unitOptions = [
  { label: 'Milliseconds', value: 'milliseconds' },
  { label: 'Seconds', value: 'seconds' },
  { label: 'Minutes', value: 'minutes' },
  { label: 'Hours', value: 'hours' },
  { label: 'Days', value: 'days' },
];

const UNIT_MS: Record<string, number> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

export const GET_CURRENT_DATE_TYPE = 'date.get_current_date';
export interface CurrentDateResult {
  result: string;
}
export const getCurrentDate = defineAction({
  type: GET_CURRENT_DATE_TYPE,
  name: 'Get Current Date',
  description: 'The current date/time, ISO by default or a custom format.',
  auth: { type: 'none' },
  props: {
    format: shortText({ label: 'Output format', required: false }),
    timeZone: timeZoneProp,
  },
  run: ({ props }): Promise<CurrentDateResult> => {
    const now = new Date();
    if (!props.format) return Promise.resolve({ result: now.toISOString() });
    return Promise.resolve({ result: formatParts(partsInZone(now, props.timeZone), props.format) });
  },
});

export const FORMAT_DATE_TYPE = 'date.format_date';
export interface FormatDateResult {
  result: string;
}
export const formatDate = defineAction({
  type: FORMAT_DATE_TYPE,
  name: 'Format Date',
  description: 'Reformat a date into a custom output format.',
  auth: { type: 'none' },
  props: {
    inputDate: shortText({ label: 'Input date', required: true }),
    outputFormat: shortText({ label: 'Output format', required: true, defaultValue: 'YYYY-MM-DD HH:mm:ss' }),
    timeZone: timeZoneProp,
  },
  run: ({ props }): Promise<FormatDateResult> => {
    const parts = partsInZone(parseDate(props.inputDate), props.timeZone);
    return Promise.resolve({ result: formatParts(parts, props.outputFormat) });
  },
});

export const EXTRACT_PARTS_TYPE = 'date.extract_date_parts';
export type ExtractPartsResult = DateParts & { dayOfWeek: string };
export const extractDateParts = defineAction({
  type: EXTRACT_PARTS_TYPE,
  name: 'Extract Date Units',
  description: 'Break a date into its year, month, day, time and weekday.',
  auth: { type: 'none' },
  props: {
    inputDate: shortText({ label: 'Input date', required: true }),
    timeZone: timeZoneProp,
  },
  run: ({ props }): Promise<ExtractPartsResult> => {
    const parts = partsInZone(parseDate(props.inputDate), props.timeZone);
    return Promise.resolve({ ...parts, dayOfWeek: DAYS_LONG[parts.weekday] ?? '' });
  },
});

export const DATE_DIFFERENCE_TYPE = 'date.date_difference';
export interface DateDifferenceResult {
  result: number;
}
export const dateDifference = defineAction({
  type: DATE_DIFFERENCE_TYPE,
  name: 'Date Difference',
  description: 'The difference between two dates in the chosen unit.',
  auth: { type: 'none' },
  props: {
    startDate: shortText({ label: 'Start date', required: true }),
    endDate: shortText({ label: 'End date', required: true }),
    unit: dropdown<string, false>({
      label: 'Unit',
      required: false,
      defaultValue: 'days',
      options: unitOptions,
    }),
  },
  run: ({ props }): Promise<DateDifferenceResult> => {
    const deltaMs = parseDate(props.endDate).getTime() - parseDate(props.startDate).getTime();
    const divisor = UNIT_MS[props.unit ?? 'days'] ?? UNIT_MS.days ?? 1;
    return Promise.resolve({ result: deltaMs / divisor });
  },
});

export const ADD_SUBTRACT_TYPE = 'date.add_subtract_date';
export interface AddSubtractResult {
  result: string;
}
export const addSubtractDate = defineAction({
  type: ADD_SUBTRACT_TYPE,
  name: 'Add/Subtract Time',
  description: 'Add or subtract an amount of time from a date (returns ISO).',
  auth: { type: 'none' },
  props: {
    inputDate: shortText({ label: 'Input date', required: true }),
    operation: dropdown<string, false>({
      label: 'Operation',
      required: false,
      defaultValue: 'add',
      options: [
        { label: 'Add', value: 'add' },
        { label: 'Subtract', value: 'subtract' },
      ],
    }),
    amount: number({ label: 'Amount', required: true }),
    unit: dropdown<string, false>({
      label: 'Unit',
      required: false,
      defaultValue: 'days',
      options: [
        ...unitOptions.filter((o) => o.value !== 'milliseconds'),
        { label: 'Weeks', value: 'weeks' },
        { label: 'Months', value: 'months' },
        { label: 'Years', value: 'years' },
      ],
    }),
  },
  run: ({ props }): Promise<AddSubtractResult> => {
    const date = parseDate(props.inputDate);
    const sign = (props.operation ?? 'add') === 'subtract' ? -1 : 1;
    const amount = sign * props.amount;
    const unit = props.unit ?? 'days';
    if (unit === 'months') {
      date.setUTCMonth(date.getUTCMonth() + amount);
    } else if (unit === 'years') {
      date.setUTCFullYear(date.getUTCFullYear() + amount);
    } else {
      const factor = UNIT_MS[unit] ?? UNIT_MS.days ?? 1;
      date.setTime(date.getTime() + amount * factor);
    }
    return Promise.resolve({ result: date.toISOString() });
  },
});

export const NEXT_DAY_OF_WEEK_TYPE = 'date.next_day_of_week';
export interface NextDateResult {
  result: string;
}
export const nextDayOfWeek = defineAction({
  type: NEXT_DAY_OF_WEEK_TYPE,
  name: 'Next Day of Week',
  description: 'The next date (after today, UTC) that falls on the given weekday.',
  auth: { type: 'none' },
  props: {
    dayOfWeek: dropdown<number, true>({
      label: 'Day of week',
      required: true,
      options: DAYS_LONG.map((label, value) => ({ label, value })),
    }),
  },
  run: ({ props }): Promise<NextDateResult> => {
    const today = new Date();
    const target = ((props.dayOfWeek % 7) + 7) % 7;
    const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    do {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } while (cursor.getUTCDay() !== target);
    return Promise.resolve({ result: utcDateIso(cursor) });
  },
});

export const NEXT_DAY_OF_YEAR_TYPE = 'date.next_day_of_year';
export const nextDayOfYear = defineAction({
  type: NEXT_DAY_OF_YEAR_TYPE,
  name: 'Next Day of Year',
  description: 'The next occurrence (after today, UTC) of a given month/day.',
  auth: { type: 'none' },
  props: {
    month: number({ label: 'Month (1-12)', required: true }),
    day: number({ label: 'Day (1-31)', required: true }),
  },
  run: ({ props }): Promise<NextDateResult> => {
    const month = Math.floor(props.month);
    const day = Math.floor(props.day);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new ActionError({
        code: 'invalid_input',
        message: 'month must be 1-12 and day 1-31',
        retryable: false,
      });
    }
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    let year = today.getUTCFullYear();
    let candidate = Date.UTC(year, month - 1, day);
    if (candidate <= todayUtc) {
      year += 1;
      candidate = Date.UTC(year, month - 1, day);
    }
    return Promise.resolve({ result: utcDateIso(new Date(candidate)) });
  },
});

export const FIRST_DAY_PREV_MONTH_TYPE = 'date.first_day_of_previous_month';
export const firstDayOfPreviousMonth = defineAction({
  type: FIRST_DAY_PREV_MONTH_TYPE,
  name: 'First Day of Previous Month',
  description: 'The first day of the previous month (UTC).',
  auth: { type: 'none' },
  props: {},
  run: (): Promise<NextDateResult> => {
    const now = new Date();
    return Promise.resolve({
      result: utcDateIso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))),
    });
  },
});

export const LAST_DAY_PREV_MONTH_TYPE = 'date.last_day_of_previous_month';
export const lastDayOfPreviousMonth = defineAction({
  type: LAST_DAY_PREV_MONTH_TYPE,
  name: 'Last Day of Previous Month',
  description: 'The last day of the previous month (UTC).',
  auth: { type: 'none' },
  props: {},
  run: (): Promise<NextDateResult> => {
    const now = new Date();
    // Day 0 of the current month is the last day of the previous month.
    return Promise.resolve({
      result: utcDateIso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))),
    });
  },
});
