import type { Database } from '../client';

/** Database 或 transaction 皆可（repository 函式兩者通用） */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;
