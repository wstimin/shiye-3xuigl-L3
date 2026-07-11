ALTER TABLE `recharge_orders` ADD COLUMN `expiresAt` DATETIME(3) NULL;

UPDATE `recharge_orders`
SET `expiresAt` = DATE_ADD(`createdAt`, INTERVAL 30 MINUTE)
WHERE `expiresAt` IS NULL;

UPDATE `recharge_orders`
SET `status` = 'closed'
WHERE `status` = 'pending' AND `expiresAt` <= NOW(3);

CREATE INDEX `recharge_orders_status_expiresAt_idx` ON `recharge_orders`(`status`, `expiresAt`);
