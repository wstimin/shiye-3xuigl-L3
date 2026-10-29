CREATE TABLE `external_card_redemptions` (
  `id` VARCHAR(191) NOT NULL,
  `codeHash` VARCHAR(64) NOT NULL,
  `codeEnc` TEXT NOT NULL,
  `codePreview` VARCHAR(80) NOT NULL,
  `customerId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'processing',
  `amount` DECIMAL(12,2) NULL,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `external_card_redemptions_codeHash_key` (`codeHash`),
  INDEX `external_card_redemptions_status_updatedAt_idx` (`status`, `updatedAt`),
  INDEX `external_card_redemptions_customerId_idx` (`customerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
