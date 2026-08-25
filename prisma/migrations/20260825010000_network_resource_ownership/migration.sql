-- Make remote ownership explicit while preserving existing managed inbounds.
ALTER TABLE `service_nodes`
  ADD COLUMN `ownership` ENUM('managed', 'referenced', 'shared') NOT NULL DEFAULT 'referenced';

UPDATE `service_nodes`
SET `ownership` = 'managed'
WHERE JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.remoteManaged')) = 'true';

ALTER TABLE `customer_nodes`
  ADD COLUMN `remoteControl` ENUM('reference', 'subscription_managed', 'fully_managed') NOT NULL DEFAULT 'reference';

CREATE TABLE `network_outbounds` (
  `id` VARCHAR(191) NOT NULL,
  `serverId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `tag` VARCHAR(160) NOT NULL,
  `protocol` VARCHAR(40) NOT NULL,
  `ownership` ENUM('managed', 'referenced', 'shared') NOT NULL DEFAULT 'referenced',
  `sourceFormat` VARCHAR(40) NULL,
  `sourceServerId` VARCHAR(191) NULL,
  `rawInput` JSON NULL,
  `normalizedConfig` JSON NOT NULL,
  `remoteFingerprint` VARCHAR(64) NULL,
  `lastSyncedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `network_outbounds_serverId_tag_key` (`serverId`, `tag`),
  INDEX `network_outbounds_serverId_ownership_idx` (`serverId`, `ownership`),
  PRIMARY KEY (`id`),
  CONSTRAINT `network_outbounds_serverId_fkey` FOREIGN KEY (`serverId`) REFERENCES `xui_servers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `network_routes` (
  `id` VARCHAR(191) NOT NULL,
  `serverId` VARCHAR(191) NOT NULL,
  `serviceNodeId` VARCHAR(191) NULL,
  `outboundId` VARCHAR(191) NULL,
  `name` VARCHAR(120) NOT NULL,
  `remoteKey` VARCHAR(191) NOT NULL,
  `remoteOrder` INTEGER NULL,
  `ownership` ENUM('managed', 'referenced', 'shared') NOT NULL DEFAULT 'referenced',
  `matchConfig` JSON NULL,
  `normalizedConfig` JSON NOT NULL,
  `remoteFingerprint` VARCHAR(64) NULL,
  `lastSyncedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `network_routes_serverId_remoteKey_key` (`serverId`, `remoteKey`),
  INDEX `network_routes_serverId_ownership_idx` (`serverId`, `ownership`),
  INDEX `network_routes_serviceNodeId_idx` (`serviceNodeId`),
  INDEX `network_routes_outboundId_idx` (`outboundId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `network_routes_serverId_fkey` FOREIGN KEY (`serverId`) REFERENCES `xui_servers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `network_routes_serviceNodeId_fkey` FOREIGN KEY (`serviceNodeId`) REFERENCES `service_nodes` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `network_routes_outboundId_fkey` FOREIGN KEY (`outboundId`) REFERENCES `network_outbounds` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
