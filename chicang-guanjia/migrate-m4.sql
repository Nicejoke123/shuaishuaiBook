-- M4 增量升级（在已有 guanjia 库上执行；与 schema.sql 对齐）
-- 1) 交易流水区分手工/定投
ALTER TABLE trades ADD COLUMN source VARCHAR(12) NOT NULL DEFAULT 'manual';

-- 2) 场外基金定投计划表
CREATE TABLE IF NOT EXISTS dca_plans (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  position_id CHAR(36) NOT NULL,
  amount VARCHAR(32) NOT NULL,
  freq VARCHAR(8) NOT NULL COMMENT 'daily|weekly|monthly',
  wday VARCHAR(1) NULL COMMENT 'weekly: 0日..6六',
  mday VARCHAR(2) NULL COMMENT 'monthly: 1-28',
  status VARCHAR(8) NOT NULL COMMENT 'active|paused',
  start_date VARCHAR(10) NOT NULL,
  last_billed_date VARCHAR(10) NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_dca_position (position_id),
  KEY idx_dca_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
