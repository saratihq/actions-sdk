import { FakeTransport, stubAuth } from '../../testing/fakes';
import {
  addSubtractDate,
  dateActions,
  dateDifference,
  extractDateParts,
  firstDayOfPreviousMonth,
  formatDate,
  getCurrentDate,
  lastDayOfPreviousMonth,
  nextDayOfWeek,
  nextDayOfYear,
} from './index';

const noAuth = stubAuth(new FakeTransport(() => ({ status: 200, headers: {}, data: {} })));

describe('date actions', () => {
  it('returns the current date as ISO by default', async () => {
    const out = await getCurrentDate.execute({ auth: noAuth, props: {} });
    expect(out.result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('formats a date with dayjs-style tokens (UTC)', async () => {
    const out = await formatDate.execute({
      auth: noAuth,
      props: { inputDate: '2026-03-05T09:07:02Z', outputFormat: 'YYYY/MM/DD HH:mm:ss' },
    });
    expect(out.result).toBe('2026/03/05 09:07:02');
  });

  it('formats month/weekday names and am/pm', async () => {
    const out = await formatDate.execute({
      auth: noAuth,
      props: { inputDate: '2026-03-05T13:00:00Z', outputFormat: 'dddd, MMMM D, YYYY h:mm A' },
    });
    expect(out.result).toBe('Thursday, March 5, 2026 1:00 PM');
  });

  it('honours the time zone when formatting', async () => {
    const out = await formatDate.execute({
      auth: noAuth,
      props: {
        inputDate: '2026-03-05T02:00:00Z',
        outputFormat: 'YYYY-MM-DD HH:mm',
        timeZone: 'America/New_York',
      },
    });
    // 02:00 UTC on Mar 5 is 21:00 the previous day in New York (EST, UTC-5).
    expect(out.result).toBe('2026-03-04 21:00');
  });

  it('rejects an unparseable date', async () => {
    await expect(
      formatDate.execute({ auth: noAuth, props: { inputDate: 'not-a-date', outputFormat: 'YYYY' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('extracts date parts (UTC)', async () => {
    const out = await extractDateParts.execute({
      auth: noAuth,
      props: { inputDate: '2026-03-05T09:07:02Z' },
    });
    expect(out).toMatchObject({
      year: 2026,
      month: 3,
      day: 5,
      hour: 9,
      minute: 7,
      second: 2,
      dayOfWeek: 'Thursday',
    });
  });

  it('computes date differences in the chosen unit', async () => {
    expect(
      await dateDifference.execute({
        auth: noAuth,
        props: { startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-04T00:00:00Z', unit: 'days' },
      }),
    ).toEqual({ result: 3 });
    expect(
      await dateDifference.execute({
        auth: noAuth,
        props: { startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-01T01:00:00Z', unit: 'minutes' },
      }),
    ).toEqual({ result: 60 });
  });

  it('adds and subtracts time', async () => {
    expect(
      await addSubtractDate.execute({
        auth: noAuth,
        props: { inputDate: '2026-01-01T00:00:00Z', operation: 'add', amount: 2, unit: 'days' },
      }),
    ).toEqual({ result: '2026-01-03T00:00:00.000Z' });
    expect(
      await addSubtractDate.execute({
        auth: noAuth,
        props: { inputDate: '2026-03-15T00:00:00Z', operation: 'subtract', amount: 1, unit: 'months' },
      }),
    ).toEqual({ result: '2026-02-15T00:00:00.000Z' });
  });

  it('finds the next weekday and next month/day (future, UTC)', async () => {
    const dow = await nextDayOfWeek.execute({ auth: noAuth, props: { dayOfWeek: 1 } }); // Monday
    expect(new Date(`${dow.result}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${dow.result}T00:00:00Z`).getTime()).toBeGreaterThan(Date.now() - 86_400_000);

    const doy = await nextDayOfYear.execute({ auth: noAuth, props: { month: 12, day: 25 } });
    expect(doy.result).toMatch(/-12-25$/);
  });

  it('computes previous-month boundaries', async () => {
    const first = await firstDayOfPreviousMonth.execute({ auth: noAuth, props: {} });
    const last = await lastDayOfPreviousMonth.execute({ auth: noAuth, props: {} });
    expect(first.result).toMatch(/-01$/);
    expect(new Date(`${last.result}T00:00:00Z`).getTime()).toBeGreaterThan(
      new Date(`${first.result}T00:00:00Z`).getTime(),
    );
  });

  it('exposes nine actions, all date.* typed', () => {
    expect(dateActions).toHaveLength(9);
    for (const action of dateActions) expect(action.type.startsWith('date.')).toBe(true);
  });
});
