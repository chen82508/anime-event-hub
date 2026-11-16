import { loadEnv } from './env';
import { logger } from './logger';

// TODO(T9): 以 node-cron 註冊排程（每日；年度大展每週）、30 天快照清理；單一 process 序列執行（C11）
const env = loadEnv();
logger.info({ tz: env.TZ }, 'scheduler 尚未實作（tech-spec T9）');
