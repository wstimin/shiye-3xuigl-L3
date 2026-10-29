-- Keep the original panel table and foreign keys; both engines now share resource ownership.
ALTER TABLE `xui_servers` ADD COLUMN `provider` VARCHAR(12) NOT NULL DEFAULT 'xui';
INSERT INTO `xui_servers` (`id`, `provider`, `name`, `baseUrl`, `tokenEnc`, `enabled`, `remark`, `createdAt`, `updatedAt`)
SELECT `id`, 'sui', `name`, `baseUrl`, `tokenEnc`, `enabled`, `remark`, `createdAt`, `updatedAt` FROM `sui_servers`;
-- Retain the legacy table so the automatic updater can roll back safely.
