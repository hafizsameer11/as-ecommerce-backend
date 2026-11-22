-- Storefront checkout: apply a gift card code like a coupon (balance reduces amount due)
ALTER TABLE `CheckoutSession` ADD COLUMN `giftCardCode` VARCHAR(32) NULL;