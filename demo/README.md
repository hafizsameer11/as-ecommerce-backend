# Demo seed assets

Product, category, and merchandising images used by `npm run db:seed`.

| Location | Purpose |
|---|---|
| `prisma/seed/assets/` | **Primary** — seeder reads these first |
| `demo/seed-assets/` | Same WebPs (kept in sync for GitHub / discoverability) |

`catalog.json` references them as `asset:p-sneaker.webp` (etc.). On seed they are uploaded into the media library.

## Fresh setup

```bash
npm install
npm run db:deploy
npm run db:seed
```

## Sync both folders

```bash
npm run db:seed:sync-assets           # prisma/seed/assets → demo/seed-assets
npm run db:seed:sync-assets -- --pull # demo → seed
```

Runtime uploads go to `uploads/` (gitignored). Re-seed on a fresh DB to recreate media from these assets.
