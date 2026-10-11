/**
 * Recreates the LOCAL development database from migrations + seed.
 * Works on Windows, macOS and Linux. Refuses to run against anything but localhost.
 */
import { execSync } from "node:child_process";
import mariadb from "mariadb";

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
const url = new URL(raw);
if (!["localhost", "127.0.0.1", "mysql"].includes(url.hostname) || process.env.NODE_ENV === "production") {
  throw new Error(`Refusing to reset a non-local database (${url.hostname}).`);
}
const db = url.pathname.slice(1);
console.log(`Dropping and recreating local database '${db}'…`);
const conn = await mariadb.createConnection({
  host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password), allowPublicKeyRetrieval: true,
});
await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
await conn.end();
execSync("npx prisma migrate deploy", { stdio: "inherit" });
execSync("npx tsx --env-file=.env prisma/seed/index.ts", { stdio: "inherit" });
