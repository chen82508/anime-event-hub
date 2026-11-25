/** 前台顯示格式（純函式；時區固定台灣）。共用格式在 @aeh/core（推播模板也用），這裡只放前台專屬的部分。 */
import { formatMonthDay, formatTime } from '@aeh/core';

export {
  formatEventWhen,
  formatFullDate,
  formatMonthDay,
  formatPlace,
  formatPrice,
  formatTime,
  hasEnded,
} from '@aeh/core';

export type SaleState =
  | { state: 'on_sale'; label: string }
  | { state: 'upcoming'; label: string; at: Date }
  | { state: 'unknown'; label: string };

/** 開賣狀態；開賣時間未提供時不猜測 */
export function saleState(saleStartAt: Date | null, now: Date): SaleState {
  if (!saleStartAt) return { state: 'unknown', label: '開賣時間請見官方公告' };
  if (saleStartAt.getTime() <= now.getTime()) return { state: 'on_sale', label: '已開賣' };
  return {
    state: 'upcoming',
    label: `${formatMonthDay(saleStartAt)} ${formatTime(saleStartAt)} 開賣`,
    at: saleStartAt,
  };
}
