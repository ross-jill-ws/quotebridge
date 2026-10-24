-- Database schema before API-key scopes were renamed. Keep this historical fixture independent of current migrations.
CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp);
INSERT INTO schema_version (version) VALUES (6);
CREATE TABLE clock_rules (
  broker_server VARCHAR PRIMARY KEY,
  winter_offset_minutes INTEGER NOT NULL,
  dst VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  last_observed_offset INTEGER,
  last_observed_at BIGINT
);
CREATE SEQUENCE market_ids START 1;
CREATE TABLE markets (
  id INTEGER PRIMARY KEY DEFAULT nextval('market_ids'),
  broker_server VARCHAR NOT NULL,
  symbol VARCHAR NOT NULL,
  digits INTEGER,
  recording BOOLEAN NOT NULL DEFAULT false,
  recording_since BIGINT,
  UNIQUE (broker_server, symbol)
);
CREATE TABLE samples (
  market_id INTEGER NOT NULL,
  utc_ms BIGINT NOT NULL,
  broker_seconds BIGINT NOT NULL,
  bid DOUBLE NOT NULL,
  ask DOUBLE NOT NULL,
  received_ms BIGINT NOT NULL
);
CREATE TABLE saved_bars (
  market_id INTEGER NOT NULL,
  period VARCHAR NOT NULL,
  utc_seconds BIGINT NOT NULL,
  broker_seconds BIGINT NOT NULL,
  open DOUBLE NOT NULL,
  high DOUBLE NOT NULL,
  low DOUBLE NOT NULL,
  close DOUBLE NOT NULL,
  tick_volume BIGINT NOT NULL,
  spread INTEGER NOT NULL,
  real_volume BIGINT NOT NULL,
  PRIMARY KEY (market_id, period, broker_seconds)
);
CREATE TABLE api_keys (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  scope VARCHAR NOT NULL,
  prefix VARCHAR NOT NULL,
  hash VARCHAR NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);
CREATE TABLE indicator_packages (
  id VARCHAR PRIMARY KEY,
  version VARCHAR NOT NULL,
  hash VARCHAR NOT NULL,
  manifest VARCHAR NOT NULL,
  calculate VARCHAR NOT NULL,
  readme VARCHAR NOT NULL,
  licence VARCHAR NOT NULL,
  enabled BOOLEAN NOT NULL,
  installed_at BIGINT NOT NULL
);
