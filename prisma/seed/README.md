# Database seed

Seeds reference data, admin user, **~65 products with real images**, merchandising slots, and CMS content.

## Images

Product / category / hero WebPs live in:

- `prisma/seed/assets/` (this package)
- `../../../demo/seed-assets/` (monorepo root — commit this for GitHub)

`catalog.json` references them as `asset:p-….webp`. On seed they are uploaded through the media library.

```bash
npm run db:seed
npm run db:seed:sync-assets        # push assets → ../../demo/seed-assets
npm run db:seed:sync-assets -- --pull  # pull demo → local assets
```

See [`demo/README.md`](../../../demo/README.md) at the repo root.
