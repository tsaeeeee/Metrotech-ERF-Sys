BEGIN;
CREATE TABLE IF NOT EXISTS cash_access (
  employee_email text PRIMARY KEY REFERENCES employees(email),
  access text NOT NULL CHECK (access IN ('NONE','VIEW','MANAGE')),
  updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cash_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text NOT NULL,
  year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),
  opening_balance numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  source_document text, source_sheet text,
  UNIQUE(source_document,source_sheet)
);
CREATE TABLE IF NOT EXISTS cash_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_document text NOT NULL,
  checksum text NOT NULL UNIQUE, snapshot jsonb NOT NULL, report jsonb NOT NULL,
  state text NOT NULL DEFAULT 'PREVIEW' CHECK(state IN ('PREVIEW','IMPORTED')),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), imported_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_one_source_import ON cash_imports(source_document) WHERE state='IMPORTED';
CREATE TABLE IF NOT EXISTS cash_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), book_id uuid NOT NULL REFERENCES cash_books(id),
  entry_date date NOT NULL, category text NOT NULL, activity text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  income numeric(18,2) NOT NULL DEFAULT 0 CHECK(income>=0),
  outcome numeric(18,2) NOT NULL DEFAULT 0 CHECK(outcome>=0),
  kind text NOT NULL DEFAULT 'TRANSACTION' CHECK(kind IN ('TRANSACTION','OPENING')),
  origin text NOT NULL DEFAULT 'EMS' CHECK(origin IN ('EMS','LEGACY')),
  source_row integer, import_id uuid REFERENCES cash_imports(id),
  version integer NOT NULL DEFAULT 1, voided boolean NOT NULL DEFAULT false,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(income>0 OR outcome>0), UNIQUE(import_id,book_id,source_row)
);
CREATE INDEX IF NOT EXISTS cash_entries_book_date ON cash_entries(book_id,entry_date,id);
CREATE TABLE IF NOT EXISTS cash_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_email text NOT NULL,
  action text NOT NULL, entry_id uuid REFERENCES cash_entries(id), reason text NOT NULL DEFAULT '',
  before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cash_backup_settings (
  id integer PRIMARY KEY CHECK(id=1), spreadsheet_id text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false, hour_wib integer NOT NULL DEFAULT 2 CHECK(hour_wib BETWEEN 0 AND 23),
  updated_by text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cash_backup_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS cash_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), backup_day date NOT NULL,
  state text NOT NULL CHECK(state IN ('RUNNING','OK','FAILED')),
  spreadsheet_id text NOT NULL, row_count integer, checksum text, error text,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
COMMIT;
