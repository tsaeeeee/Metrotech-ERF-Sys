CREATE TABLE IF NOT EXISTS app_settings(
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  is_secret boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE INDEX IF NOT EXISTS app_settings_updated_at_idx
  ON app_settings(updated_at);
