-- Add renewal idempotency, recovery metadata, and an explicit reason for disabled nodes.
ALTER TABLE `customer_nodes`
  ADD COLUMN `disabledReason` ENUM('expired', 'traffic_exceeded', 'admin') NULL;

UPDATE `customer_nodes`
SET `disabledReason` = CASE
  WHEN `expireAt` IS NOT NULL AND `expireAt` <= CURRENT_TIMESTAMP(3) THEN 'expired'
  WHEN `trafficLimitGb` > 0 AND `usedTrafficGb` >= `trafficLimitGb` THEN 'traffic_exceeded'
  ELSE 'admin'
END
WHERE `status` = 'disabled';

ALTER TABLE `renewal_logs`
  ADD COLUMN `idempotencyKey` VARCHAR(160) NULL,
  ADD COLUMN `balanceLogId` VARCHAR(191) NULL,
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD UNIQUE INDEX `renewal_logs_idempotencyKey_key` (`idempotencyKey`),
  ADD INDEX `renewal_logs_status_updatedAt_idx` (`status`, `updatedAt`);

-- Pending records created before this migration do not contain the debit link or
-- the exact remote snapshot required for automatic compensation. Keep the debit
-- untouched and require manual reconciliation instead of guessing and refunding.
UPDATE `renewal_logs`
SET
  `status` = 'failed',
  `detail` = JSON_SET(
    COALESCE(`detail`, JSON_OBJECT()),
    '$.phase', 'legacy-reconciliation-required',
    '$.reconciliationRequired', TRUE,
    '$.refunded', FALSE,
    '$.error', '历史待处理续费缺少自动恢复信息，需要人工核对'
  )
WHERE `status` = 'pending' AND `balanceLogId` IS NULL;
