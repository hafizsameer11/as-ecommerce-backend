/**
 * MySQL backup → gzip file in BACKUP_DIR, keeping BACKUP_RETENTION_DAYS days of files.
 *
 *   npm run db:backup                         (reads DATABASE_URL from .env)
 *   BACKUP_DIR=/backups BACKUP_RETENTION_DAYS=30 node --env-file=.env --import tsx scripts/backup-db.ts
 *
 * Uses a local `mysqldump` when one is installed, otherwise `docker exec <BACKUP_DOCKER_CONTAINER> mysqldump`
 * (default container: asl-mysql). Force one with BACKUP_MODE=local|docker.
 * --single-transaction: a consistent snapshot of InnoDB tables without locking the shop.
 * The password goes through MYSQL_PWD (never on the command line / process list).
 * Restore: gunzip -c asl-….sql.gz | mysql -h HOST -u USER -p DBNAME   (see the Operations notes)
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!/^mysql|mariadb/.test(url.protocol)) {
  console.error("DATABASE_URL must be a mysql:// URL");
  process.exit(1);
}
const db = decodeURIComponent(url.pathname.slice(1));
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const dir = path.resolve(process.env.BACKUP_DIR ?? "./backups");
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
const container = process.env.BACKUP_DOCKER_CONTAINER ?? "asl-mysql";

const hasLocal = spawnSync("mysqldump", ["--version"], { stdio: "ignore" }).status === 0;
const mode = process.env.BACKUP_MODE ?? (hasLocal ? "local" : "docker");

const dumpArgs = ["--single-transaction", "--quick", "--routines", "--triggers", "--events", "--hex-blob", "--default-character-set=utf8mb4", "--no-tablespaces", "-u", user];
const [cmd, args] =
  mode === "local"
    ? ["mysqldump", [...dumpArgs, "-h", url.hostname, "-P", url.port || "3306", db]]
    : // inside the MySQL container the server is on 127.0.0.1:3306 whatever the host-side URL says
      ["docker", ["exec", "-e", "MYSQL_PWD", container, "mysqldump", ...dumpArgs, "-h", "127.0.0.1", "-P", "3306", db]];

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const file = path.join(dir, `${db}-${stamp}.sql.gz`);
const tmp = `${file}.partial`;

async function main() {
  await fsp.mkdir(dir, { recursive: true });
  const started = Date.now();
  const child = spawn(cmd, args as string[], { env: { ...process.env, MYSQL_PWD: password }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));

  // mysqldump writes "-- Dump completed" last: a dump without it was cut off
  let tail = "";
  const watch = new Transform({
    transform(chunk, _enc, cb) {
      tail = (tail + chunk.toString("utf8")).slice(-200);
      cb(null, chunk);
    },
  });
  await pipeline(child.stdout, watch, zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp, { mode: 0o600 }));
  const code = await exited;
  if (code !== 0 || !tail.includes("-- Dump completed")) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`mysqldump failed (exit ${code}, mode ${mode}): ${stderr.replace(/Using a password.*\n?/g, "").trim() || "dump incomplete"}`);
  }
  await fsp.rename(tmp, file);
  const size = (await fsp.stat(file)).size;
  console.log(`backup written: ${file} (${(size / 1024 / 1024).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s, ${mode})`);

  // retention: only our own files for this database
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const name of await fsp.readdir(dir)) {
    if (!name.startsWith(`${db}-`) || !(name.endsWith(".sql.gz") || name.endsWith(".sql.gz.partial"))) continue;
    const p = path.join(dir, name);
    const st = await fsp.stat(p);
    if (st.mtimeMs < cutoff) {
      await fsp.rm(p, { force: true });
      console.log(`removed old backup: ${name}`);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
