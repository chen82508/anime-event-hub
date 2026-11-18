// @aeh/dedup — 去重鍵、候選判定、合併規則（純函式，見 tech-spec T8）
// DB 端的 pg_trgm 候選查詢在 @aeh/db（findDedupCandidates），本套件不碰 DB。
export * from './candidates';
export * from './key';
export * from './merge';
export * from './trigram';
