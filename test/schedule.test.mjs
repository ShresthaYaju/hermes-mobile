// The cron humaniser. Its one hard rule is that it must never describe a
// schedule wrongly -- an expression it cannot read has to fall through to the
// raw text, not to a plausible guess.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The module is browser-only ES; import it directly, it has no DOM dependency
// at load time.
const { describeCron, timezoneNote, scheduleText } = await import(
  new URL('../public/lib/ui.js', import.meta.url)
);

// Locale-independent: assert on structure, not on "9:00 AM" vs "09:00".
const at = (hour, minute) =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

test('describes the schedules this host actually runs', () => {
  // Verbatim from GET /api/cron/jobs on 2026-07-28.
  assert.equal(describeCron('0 9 * * *'), `Every day at ${at(9, 0)}`);
  assert.equal(describeCron('15 */4 * * *'), 'Every 4 hours, at :15');
  assert.equal(describeCron('45 */4 * * *'), 'Every 4 hours, at :45');
  assert.equal(describeCron('20 */2 * * *'), 'Every 2 hours, at :20');
  // Same cadence as */4, merely offset -- saying "every 4 hours" beats listing
  // six clock times on a phone.
  assert.equal(describeCron('10 1,5,9,13,17,21 * * *'), `Every 4 hours from ${at(1, 10)}`);
  assert.equal(describeCron('35 3,7,11,15,19,23 * * *'), `Every 4 hours from ${at(3, 35)}`);
});

test('describes the other common shapes', () => {
  assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(describeCron('0 * * * *'), 'Every hour at :00');
  assert.equal(describeCron('30 9 * * 1-5'), `Weekdays at ${at(9, 30)}`);
  assert.equal(describeCron('0 10 * * 0,6'), `Weekends at ${at(10, 0)}`);
  assert.equal(describeCron('0 8 * * 1'), `Every Monday at ${at(8, 0)}`);
  // Cron accepts 7 for Sunday as well as 0.
  assert.equal(describeCron('0 8 * * 7'), `Every Sunday at ${at(8, 0)}`);
  assert.equal(describeCron('0 0 1 * *'), `On the 1st at ${at(0, 0)}`);
  assert.equal(describeCron('0 0 1,15 * *'), `On the 1st and 15th at ${at(0, 0)}`);
  assert.equal(describeCron('0 9,17 * * *'), `Every day at ${at(9, 0)} and ${at(17, 0)}`);
  assert.equal(describeCron('0 0 1 1 *'), `On the 1st in January at ${at(0, 0)}`);
  assert.equal(describeCron('* * * * *'), 'Every minute');
});

test('unreadable expressions fall through rather than being guessed at', () => {
  for (const expression of [
    '', // empty
    '0 9 * *', // four fields
    '0 9 * * * *', // six fields (seconds-precision variant)
    '0 9 * * MON', // named weekdays
    '0 9 * * 1#2', // nth weekday
    '0 9 L * *', // last day of month
    '0 9 * * 1-5,7-9', // out of range
    '0 25 * * *', // impossible hour
    '0 9-5 * * *', // inverted range
    '0 */0 * * *', // zero step
    'not a cron',
  ]) {
    assert.equal(
      describeCron(expression),
      null,
      `${expression || '(empty)'} must not be described`,
    );
  }
});

test('an hour list too long to read stays raw', () => {
  // Five irregular hours: not an interval, and too many to list on a phone.
  assert.equal(describeCron('0 1,2,5,9,14 * * *'), null);
});

test('the timezone is named only when it differs from this device', () => {
  const offsetMinutes = -new Date('2026-07-28T09:00:00Z').getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = `${sign}${pad(offsetMinutes / 60)}:${pad(Math.abs(offsetMinutes) % 60)}`;

  assert.equal(timezoneNote(`2026-07-28T09:00:00${local}`), '', 'same offset needs no note');

  // An offset this device certainly is not in.
  const foreign = offsetMinutes === 330 ? '+09:00' : '+05:30';
  assert.match(timezoneNote(`2026-07-28T09:00:00${foreign}`), /^UTC[+−]\d/);
  assert.equal(timezoneNote('2026-07-28T09:00:00'), '', 'no offset means nothing to say');
  assert.equal(timezoneNote(null), '');
});

test('an interval names its start time when it will be timezone-qualified', () => {
  // ":15" is useless next to a UTC offset; a real clock time is not.
  assert.equal(describeCron('15 */4 * * *', { anchored: true }), `Every 4 hours from ${at(0, 15)}`);
  assert.equal(describeCron('15 */4 * * *'), 'Every 4 hours, at :15');
  // Already anchored, so the flag changes nothing.
  assert.equal(
    describeCron('10 1,5,9,13,17,21 * * *', { anchored: true }),
    `Every 4 hours from ${at(1, 10)}`,
  );
});

test('a schedule in another timezone is qualified, and only where that means something', () => {
  const job = (expr) => ({
    schedule: { kind: 'cron', expr },
    // An offset no test machine is plausibly in.
    next_run_at: '2026-07-28T09:00:00-05:00',
  });
  const deviceOffset = -new Date('2026-07-28T09:00:00Z').getTimezoneOffset();
  if (deviceOffset === -300) return; // this host is already at UTC-5

  assert.match(scheduleText(job('0 9 * * *')).text, / · UTC−5$/);
  assert.match(scheduleText(job('15 */4 * * *')).text, /^Every 4 hours from .* · UTC−5$/);
  // No clock time in the phrase, so nothing to qualify.
  assert.equal(scheduleText(job('*/15 * * * *')).text, 'Every 15 minutes');
});

test('scheduleText keeps the expression alongside its reading', () => {
  const readable = scheduleText({
    schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
  });
  assert.equal(readable.humanised, true);
  assert.equal(readable.raw, '0 9 * * *');
  assert.match(readable.text, /^Every day at /);

  const unreadable = scheduleText({ schedule: { kind: 'cron', expr: '0 9 * * MON' } });
  assert.equal(unreadable.humanised, false);
  assert.equal(unreadable.text, '0 9 * * MON');

  // Non-cron kinds are the backend's to phrase, not ours.
  const interval = scheduleText({ schedule: { kind: 'interval', display: 'every 30m' } });
  assert.equal(interval.humanised, false);
  assert.equal(interval.text, 'every 30m');
});

test('no view renders a raw schedule field directly any more', () => {
  for (const name of ['work.js', 'job.js']) {
    const source = readFileSync(new URL(`../public/views/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /schedule_display|schedule\?\.display/,
      `${name} should go through scheduleText()`,
    );
  }
});
