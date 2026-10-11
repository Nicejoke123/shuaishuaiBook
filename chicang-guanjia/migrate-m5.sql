-- M5 增量升级（在已有 guanjia 库上执行；与 schema.sql 对齐）
-- 场外基金手续费：流水记录费用与到账/实付净额
ALTER TABLE trades ADD COLUMN fee VARCHAR(32) NULL;
ALTER TABLE trades ADD COLUMN net_amount VARCHAR(32) NULL;
