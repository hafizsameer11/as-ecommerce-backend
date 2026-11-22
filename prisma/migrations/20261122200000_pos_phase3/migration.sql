-- POS Phase 3: gift cards, promotions, alterations, transfers, counts, GRN, layaway, concierge-from-till

ALTER TABLE `ConciergeRequest` MODIFY `source` ENUM('form', 'catalog', 'store') NOT NULL DEFAULT 'form';
ALTER TABLE `ConciergeRequest` ADD COLUMN `originLocationId` VARCHAR(191) NULL;
ALTER TABLE `ConciergeRequest` ADD COLUMN `createdByStaffId` VARCHAR(191) NULL;
CREATE INDEX `ConciergeRequest_originLocationId_idx` ON `ConciergeRequest`(`originLocationId`);

CREATE TABLE `GiftCard` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `initial` INTEGER NOT NULL,
    `balance` INTEGER NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `locationId` VARCHAR(191) NULL,
    `customerId` VARCHAR(191) NULL,
    `orderId` VARCHAR(191) NULL,

    UNIQUE INDEX `GiftCard_code_key`(`code`),
    INDEX `GiftCard_status_idx`(`status`),
    INDEX `GiftCard_customerId_idx`(`customerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `GiftCardEvent` (
    `id` VARCHAR(191) NOT NULL,
    `giftCardId` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `kind` VARCHAR(16) NOT NULL,
    `amount` INTEGER NOT NULL,
    `ref` VARCHAR(64) NULL,
    `staffId` VARCHAR(191) NULL,

    INDEX `GiftCardEvent_giftCardId_at_idx`(`giftCardId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `GiftCardEvent` ADD CONSTRAINT `GiftCardEvent_giftCardId_fkey` FOREIGN KEY (`giftCardId`) REFERENCES `GiftCard`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `PosPromotion` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `buy` INTEGER NULL,
    `get` INTEGER NULL,
    `value` INTEGER NOT NULL,
    `minSpend` INTEGER NULL,
    `scope` JSON NOT NULL,
    `channels` JSON NOT NULL,
    `stores` JSON NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PosPromotion_active_startsAt_endsAt_idx`(`active`, `startsAt`, `endsAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PosAlteration` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `customerName` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(30) NOT NULL,
    `orderNumber` VARCHAR(191) NULL,
    `item` VARCHAR(191) NOT NULL,
    `work` JSON NOT NULL,
    `notes` TEXT NULL,
    `fee` INTEGER NOT NULL DEFAULT 0,
    `locationId` VARCHAR(191) NOT NULL,
    `staffId` VARCHAR(191) NOT NULL,
    `tailor` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `readyBy` DATETIME(3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'received',
    `collectedAt` DATETIME(3) NULL,

    UNIQUE INDEX `PosAlteration_number_key`(`number`),
    INDEX `PosAlteration_locationId_status_idx`(`locationId`, `status`),
    INDEX `PosAlteration_status_readyBy_idx`(`status`, `readyBy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PosStockTransfer` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `fromWarehouseId` VARCHAR(191) NOT NULL,
    `toWarehouseId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NOT NULL,
    `qty` INTEGER NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'requested',
    `requestedById` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(300) NULL,
    `steps` JSON NOT NULL,

    UNIQUE INDEX `PosStockTransfer_number_key`(`number`),
    INDEX `PosStockTransfer_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `PosStockTransfer_fromWarehouseId_idx`(`fromWarehouseId`),
    INDEX `PosStockTransfer_toWarehouseId_idx`(`toWarehouseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PosStockCount` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `warehouseId` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `staffId` VARCHAR(191) NOT NULL,
    `approvedById` VARCHAR(191) NULL,
    `scope` VARCHAR(120) NOT NULL,
    `lines` JSON NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'open',

    UNIQUE INDEX `PosStockCount_number_key`(`number`),
    INDEX `PosStockCount_warehouseId_at_idx`(`warehouseId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PosGoodsReceipt` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `supplier` VARCHAR(191) NOT NULL,
    `warehouseId` VARCHAR(191) NOT NULL,
    `expectedAt` DATETIME(3) NOT NULL,
    `lines` JSON NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'expected',
    `receivedAt` DATETIME(3) NULL,
    `receivedById` VARCHAR(191) NULL,

    UNIQUE INDEX `PosGoodsReceipt_number_key`(`number`),
    INDEX `PosGoodsReceipt_warehouseId_status_idx`(`warehouseId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PosLayaway` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `deposit` INTEGER NOT NULL,
    `balance` INTEGER NOT NULL,
    `until` DATETIME(3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'open',
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PosLayaway_orderId_key`(`orderId`),
    INDEX `PosLayaway_status_until_idx`(`status`, `until`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
