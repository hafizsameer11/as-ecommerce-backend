/**
 * Dump the MySQL database with mysqldump (.env DATABASE_URL or MYSQL_* vars).
 * Writes ./backups/asl-<timestamp>.sql (optionally gzip if gzip is on PATH).
 *
 *   npm run db:backup
 *   npm run db:backup -- --docker          # via docker compose exec mysql
 *   npm run db:backup -- --output path.sql
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const useDocker = args.includes("--docker");
const outIdx = args.indexOf("--output");
const outArg = outIdx >= 0 ? args[outIdx + 1] : null;

function conn() {
  const urlRaw = process.env.DATABASE_URL;
  if (urlRaw) {
    const u = new URL(urlRaw);
    return {
      host: process.env.MYSQL_HOST ?? u.hostname,
      port: Number(process.env.MYSQL_PORT ?? (u.port || 3306)),
      user: decodeURIComponent(process.env.MYSQL_USER ?? u.username),
      password: decodeURIComponent(process.env.MYSQL_PASSWORD ?? u.password),
      database: process.env.MYSQL_DATABASE ?? u.pathname.slice(1),
    };
  }
  const host = process.env.MYSQL_HOST ?? "localhost";
  const port = Number(process.env.MYSQL_PORT ?? 3306);
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD ?? "";
  const database = process.env.MYSQL_DATABASE;
  if (!user || !database) {
    throw new Error("Set DATABASE_URL or MYSQL_USER + MYSQL_DATABASE (+ host/port/password) in .env");
  }
  return { host, port, user, password, database };
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const outDir = resolve(root, "backups");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outFile = resolve(outArg ? resolve(root, outArg) : resolve(outDir, `asl-${stamp}.sql`));

const c = conn();
console.log(`Backing up '${c.database}' → ${outFile}`);

if (useDocker) {
  const compose = existsSync(resolve(root, "docker-compose.yml")) ? "docker compose" : "docker-compose";
  const dumpArgs = [
    "exec", "-T", "mysql",
    "mysqldump",
    "--single-transaction", "--routines", "--triggers", "--set-gtid-purged=OFF",
    "-u", c.user,
    `-p${c.password}`,
    c.database,
  ];
  const res = spawnSync(compose, dumpArgs, { cwd: root, encoding: "utf-8", shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  writeFileSync(outFile, res.stdout, "utf-8");
} else {
  const dumpArgs = [
    `--host=${c.host}`,
    `--port=${String(c.port)}`,
    `--user=${c.user}`,
    ...(c.password ? [`-p${c.password}`] : []),
    "--single-transaction",
    "--routines",
    "--triggers",
    "--set-gtid-purged=OFF",
    c.database,
  ];
  const res = spawnSync("mysqldump", dumpArgs, { cwd: root, encoding: "utf-8" });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  writeFileSync(outFile, res.stdout, "utf-8");
}

const gz = spawnSync("gzip", ["--version"]);
if (gz.status === 0) {
  try {
    const z = spawnSync("gzip", ["-f", outFile]);
    if (z.status !== 0) throw new Error("gzip failed");
    console.log(`Done (compressed): ${outFile}.gz`);
  } catch {
    console.log(`Done: ${outFile}`);
  }
} else {
  console.log(`Done: ${outFile}`);
}