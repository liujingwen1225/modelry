import { describe, expect, it } from 'vitest';
import { nextCronOccurrence } from './cron';

describe('UTC Cron preview', () => {
  it('previews the next weekday slot using named days and UTC', () => {
    expect(nextCronOccurrence('0 9 * * MON-FRI', new Date('2026-09-25T10:00:00.000Z'))?.toISOString())
      .toBe('2026-09-28T09:00:00.000Z');
  });

  it('uses standard day-of-month or day-of-week matching and rejects non-five-field input', () => {
    expect(nextCronOccurrence('0 9 26 * MON', new Date('2026-09-26T08:59:00.000Z'))?.toISOString())
      .toBe('2026-09-26T09:00:00.000Z');
    expect(nextCronOccurrence('TZ=America/Los_Angeles 0 9 * * *', new Date('2026-09-25T00:00:00.000Z'))).toBeUndefined();
    expect(nextCronOccurrence('* * * * * *', new Date('2026-09-25T00:00:00.000Z'))).toBeUndefined();
  });
});
