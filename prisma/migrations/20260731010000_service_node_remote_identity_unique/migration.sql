-- Preserve the oldest local binding and detach historical duplicates before enforcing identity uniqueness.
UPDATE `service_nodes` AS `duplicate`
INNER JOIN `service_nodes` AS `keeper`
  ON `keeper`.`serverId` = `duplicate`.`serverId`
  AND `keeper`.`inboundId` = `duplicate`.`inboundId`
  AND (
    `keeper`.`createdAt` < `duplicate`.`createdAt`
    OR (`keeper`.`createdAt` = `duplicate`.`createdAt` AND `keeper`.`id` < `duplicate`.`id`)
  )
SET `duplicate`.`inboundId` = NULL
WHERE `duplicate`.`inboundId` IS NOT NULL;

CREATE UNIQUE INDEX `service_nodes_serverId_inboundId_key` ON `service_nodes`(`serverId`, `inboundId`);
