-- 持仓管家 · 微信云托管 MySQL 建表脚本
-- 先创建/选择一个独立数据库（例如 CREATE DATABASE chicang DEFAULT CHARSET utf8mb4;）
-- 再在该库中执行本文件。字段类型与 Supabase 版设计一致：数值以文本存储，日期为 YYYY-MM-DD。

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(64) NOT NULL UNIQUE,
  created_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS positions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(64) NOT NULL,
  asset_type VARCHAR(10) NOT NULL,
  quantity VARCHAR(32) NOT NULL,
  cost_price VARCHAR(32) NOT NULL,
  opened_date VARCHAR(10) NOT NULL,
  overrides JSON NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_positions_user_code (user_id, code),
  KEY idx_positions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trades (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  position_id CHAR(36) NOT NULL,
  side VARCHAR(6) NOT NULL,
  price VARCHAR(32) NOT NULL,
  quantity VARCHAR(32) NOT NULL,
  trade_date VARCHAR(10) NOT NULL,
  source VARCHAR(12) NOT NULL DEFAULT 'manual',
  created_at VARCHAR(40) NOT NULL,
  KEY idx_trades_user_date (user_id, trade_date),
  KEY idx_trades_position (position_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dca_plans (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  position_id CHAR(36) NOT NULL,
  amount VARCHAR(32) NOT NULL,
  freq VARCHAR(8) NOT NULL,
  wday VARCHAR(1) NULL,
  mday VARCHAR(2) NULL,
  status VARCHAR(8) NOT NULL,
  start_date VARCHAR(10) NOT NULL,
  last_billed_date VARCHAR(10) NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_dca_position (position_id),
  KEY idx_dca_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS snapshots (
  id CHAR(36) PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  snapshot_date VARCHAR(10) NOT NULL,
  price VARCHAR(32) NOT NULL,
  source VARCHAR(32) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_snapshots_code_date (code, snapshot_date),
  KEY idx_snapshots_code (code, snapshot_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS advices (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  code VARCHAR(20) NULL,
  name VARCHAR(64) NULL,
  asset_type VARCHAR(12) NULL,
  action VARCHAR(12) NOT NULL,
  rule_id VARCHAR(8) NOT NULL,
  severity VARCHAR(12) NOT NULL,
  reason VARCHAR(512) NOT NULL,
  detail JSON NULL,
  advice_date VARCHAR(10) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  KEY idx_advices_user_date (user_id, advice_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL UNIQUE,
  data JSON NOT NULL,
  updated_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS run_state (
  id CHAR(36) PRIMARY KEY,
  `key` VARCHAR(128) NOT NULL UNIQUE,
  value JSON NOT NULL,
  updated_at VARCHAR(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
