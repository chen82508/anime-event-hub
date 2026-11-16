-- 僅在 volume 首次初始化時執行（docker-entrypoint-initdb.d）。
-- migration 0000 仍須自行 CREATE EXTENSION IF NOT EXISTS pg_trgm，不可只依賴本檔。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE DATABASE anime_event_hub_test;
\connect anime_event_hub_test
CREATE EXTENSION IF NOT EXISTS pg_trgm;
