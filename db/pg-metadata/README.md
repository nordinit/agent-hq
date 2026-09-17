# PostgreSQL schema metadata

These files document deferred schema work and the catalog-derived terminology rename. They are
not migrations and are not read by the migration runner. The executable schema authority lives
only in `db/pg-migrations`.

The old rename mapping and its generator were retired with migration 32. The numbered migration is now the schema authority.
