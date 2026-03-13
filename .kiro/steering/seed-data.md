---
inclusion: auto
---

# Seed Data Policy

The files `src/db/seed-trails.ts` and `src/db/seed.ts` are strictly for bootstrapping the system. Do not read, reference, or modify them when working on features, bug fixes, or configuration changes.

Trail configuration (drying rates, max drying days, station assignments, etc.) lives in the database at runtime. Query the `trails` table directly if you need current trail properties.
