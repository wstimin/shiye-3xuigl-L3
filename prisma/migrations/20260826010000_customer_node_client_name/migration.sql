ALTER TABLE `customer_nodes`
  ADD COLUMN `clientName` VARCHAR(120) NULL AFTER `serviceNodeId`;

UPDATE `customer_nodes`
SET `clientName` = LEFT(`xuiEmail`, 120)
WHERE `clientName` IS NULL;
