-- POS Phase 2: pickup codes, cash refunds, outbound message queue

ALTER TABLE `PickupBooking` ADD COLUMN `pickupCode` VARCHAR(8) NULL;
CREATE INDEX `PickupBooking_locationId_status_idx` ON `PickupBooking`(`locationId`, `status`);
CREATE INDEX `PickupBooking_pickupCode_idx` ON `PickupBooking`(`pickupCode`);

ALTER TABLE `ReturnRequest` MODIFY `refundTo` ENUM('original', 'wallet', 'cash') NOT NULL DEFAULT 'original';

CREATE TABLE `PosOutboundMessage` (
    `id` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `channel` VARCHAR(16) NOT NULL,
    `template` VARCHAR(64) NOT NULL,
    `to` VARCHAR(190) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `orderId` VARCHAR(191) NULL,
    `returnId` VARCHAR(191) NULL,
    `bookingId` VARCHAR(191) NULL,
    `staffId` VARCHAR(191) NULL,
    `payload` JSON NOT NULL,
    `error` TEXT NULL,
    `sentAt` DATETIME(3) NULL,

    INDEX `PosOutboundMessage_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `PosOutboundMessage_orderId_idx`(`orderId`),
    INDEX `PosOutboundMessage_template_createdAt_idx`(`template`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
