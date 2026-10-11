-- DropForeignKey
ALTER TABLE `CouponRedemption` DROP FOREIGN KEY `CouponRedemption_orderId_fkey`;

-- DropIndex
DROP INDEX `CouponRedemption_orderId_key` ON `CouponRedemption`;

-- AlterTable
ALTER TABLE `CheckoutSession` ADD COLUMN `giftMessage` VARCHAR(500) NULL,
    ADD COLUMN `shippingRateId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `CouponRedemption` ADD COLUMN `customerCouponId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Order` ADD COLUMN `giftMessage` VARCHAR(500) NULL,
    ADD COLUMN `shippingRateName` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `weightGrams` INTEGER NULL;

-- CreateIndex
CREATE UNIQUE INDEX `CouponRedemption_orderId_code_key` ON `CouponRedemption`(`orderId`, `code`);

-- CreateIndex
CREATE INDEX `CheckoutSession_customerId_idx` ON `CheckoutSession`(`customerId`);

-- AddForeignKey (re-created after its index changed)
ALTER TABLE `CouponRedemption` ADD CONSTRAINT `CouponRedemption_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
