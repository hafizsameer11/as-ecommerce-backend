-- test database used by `npm test`
CREATE DATABASE IF NOT EXISTS asl_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON asl_test.* TO 'asl'@'%';
-- prisma migrate dev needs to create a shadow database
GRANT CREATE, DROP, ALTER, INDEX, REFERENCES ON *.* TO 'asl'@'%';
FLUSH PRIVILEGES;
