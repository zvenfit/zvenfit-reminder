-- Migration ledger. This bootstrap is safe to run before every migration pass.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version Uint32 NOT NULL,
  name Utf8 NOT NULL,
  checksum Utf8 NOT NULL,
  applied_at Timestamp NOT NULL,
  PRIMARY KEY (version)
);
