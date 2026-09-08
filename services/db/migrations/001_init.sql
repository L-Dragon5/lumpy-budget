-- Money is always BIGINT cents. Dates are always DATE, and always read back
-- through DATE_FORMAT so a timezone can never move a pay date by a day.

CREATE TABLE categories (
  id       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name     VARCHAR(80) NOT NULL UNIQUE,
  -- Which side of the budget a transaction lands on. Only `discretionary`
  -- spending reduces "available to spend"; the rest is a planned outflow
  -- being reconciled, not a new one.
  bucket   ENUM('discretionary','fixed','lumpy','savings','transfer') NOT NULL DEFAULT 'discretionary',
  color    CHAR(7) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE income_streams (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  amount_cents  BIGINT NOT NULL,
  frequency     ENUM('weekly','biweekly','semimonthly','monthly','annual') NOT NULL,
  anchor_date   DATE NULL,          -- a known pay date; drives weekly/biweekly/annual
  day_1         TINYINT UNSIGNED NULL,  -- semimonthly; 0 means last day of month
  day_2         TINYINT UNSIGNED NULL,
  day_of_month  TINYINT UNSIGNED NULL,  -- monthly; 0 means last day of month
  active        BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE fixed_costs (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(120) NOT NULL,
  amount_cents BIGINT NOT NULL,
  due_day      TINYINT UNSIGNED NOT NULL,   -- 0 means last day of month
  lead_days    TINYINT UNSIGNED NOT NULL DEFAULT 3,
  category_id  INT UNSIGNED NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_fixed_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lumpy_items (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(120) NOT NULL,
  amount_cents     BIGINT NOT NULL,
  frequency_months TINYINT UNSIGNED NOT NULL,
  next_due_date    DATE NOT NULL,
  category_id      INT UNSIGNED NULL,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_lumpy_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE savings_goals (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(120) NOT NULL,
  mode         ENUM('fixed','percent') NOT NULL,
  amount_cents BIGINT NULL,
  percent      DECIMAL(5,2) NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE import_profiles (
  id      INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name    VARCHAR(120) NOT NULL UNIQUE,
  mapping JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE import_batches (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  filename   VARCHAR(255) NOT NULL,
  profile_id INT UNSIGNED NULL,
  row_count  INT NOT NULL DEFAULT 0,
  inserted   INT NOT NULL DEFAULT 0,
  skipped    INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_batch_profile FOREIGN KEY (profile_id) REFERENCES import_profiles(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE expenses (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  txn_date        DATE NOT NULL,
  amount_cents    BIGINT NOT NULL,       -- positive is money out; a refund is negative
  merchant        VARCHAR(200) NOT NULL,
  description     VARCHAR(500) NOT NULL DEFAULT '',
  category_id     INT UNSIGNED NULL,
  source          VARCHAR(80) NOT NULL DEFAULT 'manual',
  import_batch_id INT UNSIGNED NULL,
  -- Re-importing an overlapping statement must be a no-op, so the same
  -- transaction can only ever land once.
  dedupe_hash     CHAR(64) NOT NULL UNIQUE,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_expenses_date (txn_date),
  KEY idx_expenses_category (category_id),
  CONSTRAINT fk_expense_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT fk_expense_batch FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE category_rules (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pattern     VARCHAR(160) NOT NULL,
  category_id INT UNSIGNED NOT NULL,
  priority    INT NOT NULL DEFAULT 100,
  KEY idx_rules_priority (priority),
  CONSTRAINT fk_rule_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settings (
  name  VARCHAR(60) NOT NULL PRIMARY KEY,
  value VARCHAR(500) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The lumpy fund's real bank balance, so the 12-month runway starts from truth.
INSERT INTO settings (name, value) VALUES ('lumpy_opening_balance_cents', '0');
