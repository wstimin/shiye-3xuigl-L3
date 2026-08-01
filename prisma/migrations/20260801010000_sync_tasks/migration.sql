CREATE TABLE `sync_tasks` (
  `id` VARCHAR(191) NOT NULL,
  `entityType` VARCHAR(40) NOT NULL,
  `entityId` VARCHAR(80) NOT NULL,
  `action` VARCHAR(80) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `message` TEXT NULL,
  `detail` JSON NULL,
  `attemptCount` INTEGER NOT NULL DEFAULT 0,
  `lastAttemptAt` DATETIME(3) NULL,
  `resolvedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `sync_tasks_entityType_entityId_action_key`(`entityType`, `entityId`, `action`),
  INDEX `sync_tasks_status_updatedAt_idx`(`status`, `updatedAt`),
  INDEX `sync_tasks_entityType_entityId_idx`(`entityType`, `entityId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
