# Database seed

Seeds reference data, admin user, **~65 products with real images**, merchandising slots, and CMS content.

## Images (tracked in git)

Product / category / hero WebPs:

- **`prisma/seed/assets/`** — primary (required for `npm run db:seed`)
- **`demo/seed-assets/`** — same files at repo root of this package

`catalog.json` references them as `asset:p-….webp`. On seed they are uploaded through the media library.

```bash
npm run db:seed
npm run db:seed:sync-assets           # seed → demo/seed-assets
npm run db:seed:sync-assets -- --pull # demo → seed
```
