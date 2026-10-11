-- AlterTable
ALTER TABLE `DraftOrder` ADD COLUMN `expiresAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `Order` ADD COLUMN `taxIncluded` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `ReturnRequest` ADD COLUMN `refundedAt` DATETIME(3) NULL,
    ADD COLUMN `restocked` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `JournalEntry_reference_idx` ON `JournalEntry`(`reference`);
