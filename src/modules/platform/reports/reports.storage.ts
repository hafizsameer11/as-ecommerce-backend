/**
 * Report files hold finance and customer data, so they are NOT written where public uploads go.
 * Local: a private folder (REPORTS_DIR, default `<UPLOAD_DIR>-private`) that is not served at /uploads.
 * S3 (STORAGE_DRIVER=s3): S3_PRIVATE_BUCKET (no public access), or S3_BUCKET under `private/`.
 * Either way the only way out is the authenticated download endpoint, which streams the file through the API.
 */
import { createPrivateStorage, type StorageDriver } from "@/providers/storage/storage";

export const reportStorage: StorageDriver = createPrivateStorage();
