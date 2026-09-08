-- A category is picked from a dropdown dozens of times a month; an icon makes
-- that list scannable instead of a wall of similar-length words.
-- The name is one of a curated set (contracts/types.ts); anything unknown falls
-- back to a generic icon rather than breaking the row.
ALTER TABLE categories ADD COLUMN icon VARCHAR(40) NULL AFTER bucket;

UPDATE categories SET icon = 'cart'        WHERE name = 'Groceries';
UPDATE categories SET icon = 'utensils'    WHERE name = 'Dining';
UPDATE categories SET icon = 'fuel'        WHERE name = 'Gas & Fuel';
UPDATE categories SET icon = 'bag'         WHERE name = 'Shopping';
UPDATE categories SET icon = 'film'        WHERE name = 'Entertainment';
UPDATE categories SET icon = 'health'      WHERE name = 'Health';
UPDATE categories SET icon = 'plane'       WHERE name = 'Travel';
UPDATE categories SET icon = 'home'        WHERE name = 'Home';
UPDATE categories SET icon = 'dog'         WHERE name = 'Pets';
UPDATE categories SET icon = 'baby'        WHERE name = 'Kids';
UPDATE categories SET icon = 'scissors'    WHERE name = 'Personal Care';
UPDATE categories SET icon = 'gift'        WHERE name = 'Gifts & Donations';
UPDATE categories SET icon = 'tag'         WHERE name = 'Misc';
UPDATE categories SET icon = 'building'    WHERE name = 'Housing';
UPDATE categories SET icon = 'zap'         WHERE name = 'Utilities';
UPDATE categories SET icon = 'wifi'        WHERE name = 'Internet & Phone';
UPDATE categories SET icon = 'car'         WHERE name = 'Auto Loan';
UPDATE categories SET icon = 'baby'        WHERE name = 'Childcare';
UPDATE categories SET icon = 'repeat'      WHERE name = 'Subscriptions';
UPDATE categories SET icon = 'shield'      WHERE name = 'Insurance';
UPDATE categories SET icon = 'landmark'    WHERE name = 'Taxes & Fees';
UPDATE categories SET icon = 'piggy-bank'  WHERE name = 'Savings Transfer';
UPDATE categories SET icon = 'credit-card' WHERE name = 'Credit Card Payment';
UPDATE categories SET icon = 'banknote'    WHERE name = 'Income';
