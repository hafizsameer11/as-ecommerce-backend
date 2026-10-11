import { execSync } from "node:child_process";
import mariadb from "mariadb";

/** Creates the test database once and applies all migrations. */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "mysql://asl:asl@localhost:3306/asl_test");
  const db = url.pathname.slice(1);
  const conn = await mariadb.createConnection({
    host: url.hostname, port: Number(url.port || 3306), user: url.username, password: url.password, allowPublicKeyRetrieval: true,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await conn.end();
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: "pipe" });
}
