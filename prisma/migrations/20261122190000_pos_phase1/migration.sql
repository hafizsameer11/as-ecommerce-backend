-- POS Phase 1: store channel, till registers/sessions, staff PIN, order POS fields

-- SalesChannel.store
ALTER TABLE `Order` MODIFY `channel` ENUM('web', 'mobile', 'pwa', 'concierge', 'draft', 'store') NOT NULL DEFAULT 'web';
ALTER TABLE `Cart` MODIFY `channel` ENUM('web', 'mobile', 'pwa', 'concierge', 'draft', 'store') NOT NULL DEFAULT 'web';

-- DeliveryMethod.instore
ALTER TABLE `Order` MODIFY `deliveryMethod` ENUM('ship', 'pickup', 'instore') NOT NULL DEFAULT 'ship';

-- AdminRole store roles
ALTER TABLE `AdminUser` MODIFY `role` ENUM('super_admin', 'ops_manager', 'catalog_manager', 'concierge_agent', 'support', 'marketing', 'finance', 'content_editor', 'analyst', 'store_manager', 'store_supervisor', 'store_cashier') NOT NULL;
ALTER TABLE `RolePermissionOverride` MODIFY `role` ENUM('super_admin', 'ops_manager', 'catalog_manager', 'concierge_agent', 'support', 'marketing', 'finance', 'content_editor', 'analyst', 'store_manager', 'store_supervisor', 'store_cashier') NOT NULL;

ALTER TABLE `AdminUser` ADD COLUMN `pinHash` VARCHAR(191) NULL;
ALTER TABLE `AdminUser` ADD COLUMN `locationIds` JSON NULL;

ALTER TABLE `Warehouse` ADD COLUMN `pickupLocationId` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `Warehouse_pickupLocationId_key` ON `Warehouse`(`pickupLocationId`);

ALTER TABLE `Order` ADD COLUMN `registerId` VARCHAR(191) NULL;
ALTER TABLE `Order` ADD COLUMN `registerSessionId` VARCHAR(191) NULL;
ALTER TABLE `Order` ADD COLUMN `cashierId` VARCHAR(191) NULL;
ALTER TABLE `Order` ADD COLUMN `changeGiven` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `Order` ADD COLUMN `posClientKey` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `Order_posClientKey_key` ON `Order`(`posClientKey`);
CREATE INDEX `Order_channel_placedAt_idx` ON `Order`(`channel`, `placedAt`);
CREATE INDEX `Order_registerSessionId_idx` ON `Order`(`registerSessionId`);
CREATE INDEX `Order_cashierId_idx` ON `Order`(`cashierId`);

ALTER TABLE `OrderItem` ADD COLUMN `lineDiscount` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `OrderItem` ADD COLUMN `soldById` VARCHAR(191) NULL;

CREATE TABLE `PosRegister` (
    `id` VARCHAR(191) NOT NULL,
    `locationId` VARCHAR(191) NOT NULL,
    `warehouseId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `device` VARCHAR(120) NULL,
    `printer` VARCHAR(120) NULL,
    `terminalId` VARCHAR(80) NULL,
    `drawer` BOOLEAN NOT NULL DEFAULT true,
    `scanner` VARCHAR(120) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `online` BOOLEAN NOT NULL DEFAULT true,
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PosRegister_locationId_active_idx`(`locationId`, `active`),
    INDEX `PosRegister_warehouseId_idx`(`warehouseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PosRegisterSession` (
    `id` VARCHAR(191) NOT NULL,
    `registerId` VARCHAR(191) NOT NULL,
    `openedById` VARCHAR(191) NOT NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `float` INTEGER NOT NULL,
    `closedAt` DATETIME(3) NULL,
    `closedById` VARCHAR(191) NULL,
    `counted` INTEGER NULL,
    `expected` INTEGER NULL,
    `note` VARCHAR(500) NULL,

    INDEX `PosRegisterSession_registerId_openedAt_idx`(`registerId`, `openedAt`),
    INDEX `PosRegisterSession_openedById_idx`(`openedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PosCashMove` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(8) NOT NULL,
    `amount` INTEGER NOT NULL,
    `reason` VARCHAR(200) NOT NULL,
    `staffId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PosCashMove_sessionId_createdAt_idx`(`sessionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PosAuditEvent` (
    `id` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locationId` VARCHAR(191) NULL,
    `registerId` VARCHAR(191) NULL,
    `sessionId` VARCHAR(191) NULL,
    `staffId` VARCHAR(191) NOT NULL,
    `approvedById` VARCHAR(191) NULL,
    `action` VARCHAR(32) NOT NULL,
    `text` TEXT NOT NULL,
    `amount` INTEGER NULL,
    `ref` VARCHAR(64) NULL,

    INDEX `PosAuditEvent_at_idx`(`at`),
    INDEX `PosAuditEvent_registerId_at_idx`(`registerId`, `at`),
    INDEX `PosAuditEvent_staffId_at_idx`(`staffId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PosRegister` ADD CONSTRAINT `PosRegister_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PosRegisterSession` ADD CONSTRAINT `PosRegisterSession_registerId_fkey` FOREIGN KEY (`registerId`) REFERENCES `PosRegister`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PosCashMove` ADD CONSTRAINT `PosCashMove_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `PosRegisterSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
