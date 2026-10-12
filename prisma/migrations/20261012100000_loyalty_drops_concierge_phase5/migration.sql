-- AlterTable
ALTER TABLE `ConciergeQuote` ADD COLUMN `amountPaid` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `declineReason` VARCHAR(500) NULL,
    ADD COLUMN `taxIncluded` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `ConciergeRequest` ADD COLUMN `deliveryAddress` JSON NULL,
    ADD COLUMN `slaState` VARCHAR(16) NOT NULL DEFAULT 'ok';

-- AlterTable
ALTER TABLE `Reservation` ADD COLUMN `cancelReason` VARCHAR(500) NULL,
    ADD COLUMN `color` VARCHAR(191) NULL,
    ADD COLUMN `depositOutcome` VARCHAR(20) NULL,
    ADD COLUMN `depositPaidAt` DATETIME(3) NULL,
    ADD COLUMN `depositRefunded` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `expiredAt` DATETIME(3) NULL,
    ADD COLUMN `holdExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `shippingAddress` JSON NULL,
    ADD COLUMN `variantId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Reservation_status_holdExpiresAt_idx` ON `Reservation`(`status`, `holdExpiresAt`);
