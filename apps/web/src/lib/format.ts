import { TIMEZONE } from '@aeh/core';

const dateFmt = new Intl.DateTimeFormat('zh-TW', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const isoDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 顯示用：2026/12/12（六） 19:00；全天活動不顯示時刻 */
export function formatWhen(at: Date | null, allDay: boolean): string {
  if (!at) return '—';
  return allDay ? dateFmt.format(at) : `${dateFmt.format(at)} ${timeFmt.format(at)}`;
}

/** 表單預設值：台灣日期 YYYY-MM-DD */
export function inputDate(at: Date | null): string {
  return at ? isoDayFmt.format(at) : '';
}

/** 表單預設值：台灣時刻 HH:mm */
export function inputTime(at: Date | null, allDay = false): string {
  return at && !allDay ? timeFmt.format(at) : '';
}
