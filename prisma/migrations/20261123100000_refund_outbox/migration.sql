-- AlterTable
ALTER TABLE `Refund` ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `nextAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `sentAt` DATETIME(3) NULL,
    ADD COLUMN `lastError` VARCHAR(500) NULL;

-- CreateIndex
CREATE INDEX `Refund_status_nextAttemptAt_idx` ON `Refund`(`status`, `nextAttemptAt`);