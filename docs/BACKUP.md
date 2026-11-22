# MySQL backup & restore — asl-backend

Local stack: `docker compose up -d` (MySQL 8 on host port **3307** by default, or whatever `DATABASE_URL` uses).

## Backup

From `asl-backend` with `.env` in place (same variables as the API):

```bash
npm run db:backup
```

Options:

| Flag | Meaning |
|------|---------|
| `--docker` | Run `mysqldump` inside the `mysql` compose service (no local MySQL client needed) |
| `--output path.sql` | Custom file path (default: `./backups/asl-<timestamp>.sql`) |

The script reads **`DATABASE_URL`** first, else **`MYSQL_HOST`**, **`MYSQL_PORT`**, **`MYSQL_USER`**, **`MYSQL_PASSWORD`**, **`MYSQL_DATABASE`**.

If `gzip` is available, the dump is compressed to `.sql.gz`.

**What to keep:** dated SQL files on disk (or your host’s backup tool). No S3/R2 wiring in this repo.

## Restore (development)

**Warning:** restore **replaces** all data in the target database.

### A) Into docker-compose MySQL

```bash
docker compose up -d mysql
# plain SQL:
docker compose exec -T mysql mysql -u asl -pasl asl < backups/asl-YYYYMMDD-HHMMSS.sql
# or gzip:
gunzip -c backups/asl-YYYYMMDD-HHMMSS.sql.gz | docker compose exec -T mysql mysql -u asl -pasl asl
```

Adjust user/password/database to match `.env` / `docker-compose.yml`.

### B) From host `mysql` client

```bash
mysql -h 127.0.0.1 -P 3307 -u asl -pasl asl < backups/asl-YYYYMMDD-HHMMSS.sql
```

### After restore

- Migrations should already be reflected in the dump. If you restored an **older** dump onto a **newer** schema, run `npm run db:deploy`.
- Redis, uploads, and workers are **not** in the dump — only MySQL data.

## Production notes

1. Schedule `npm run db:backup` (or raw `mysqldump`) off-peak; retain 7–30 daily copies per your policy.
2. Test restore on a staging instance quarterly.
3. Store dumps encrypted at rest; restrict file permissions.
4. For managed MySQL (RDS, PlanetScale, etc.), use the provider’s snapshot/PITR as primary; keep logical dumps as a second line of defence.