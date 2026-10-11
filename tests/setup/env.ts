process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "mysql://asl:asl@localhost:3306/asl_test";
process.env.REDIS_URL = "";
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-0123456789-abcdefghij";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-0123456789-abcdefghij";
process.env.UPLOAD_DIR = "./.test-uploads";
process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
process.env.APP_URL = "http://localhost:4000";
