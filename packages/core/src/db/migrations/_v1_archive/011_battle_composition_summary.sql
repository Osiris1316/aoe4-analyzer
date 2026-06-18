-- Migration 011: Pre-computed composition summary columns
--
-- Adds military value and category breakdown columns to both battle_search
-- and battles tables. These allow collapsed battle cards to render
-- eco/mil split and category composition donuts from flat row data,
-- eliminating the need to fetch battle_compositions for list endpoints.
--
-- military_value: total resource cost of non-economy units pre-battle
-- category_values: JSON object of category → resource value, e.g.:
--   {"melee_infantry": 1200, "ranged": 800, "melee_cavalry": 400, "siege": 200}
--
-- Economic value is derived at render time: army_value - military_value
--
-- Data populated by backfill script (existing battles) and pipeline
-- (new battles going forward).

-- battle_search table (used by /api/battles global search)
ALTER TABLE battle_search ADD COLUMN p0_military_value INTEGER;
ALTER TABLE battle_search ADD COLUMN p1_military_value INTEGER;
ALTER TABLE battle_search ADD COLUMN p0_category_values TEXT;
ALTER TABLE battle_search ADD COLUMN p1_category_values TEXT;

-- battles table (used by /api/players/:profileId/battles)
ALTER TABLE battles ADD COLUMN p0_military_value INTEGER;
ALTER TABLE battles ADD COLUMN p1_military_value INTEGER;
ALTER TABLE battles ADD COLUMN p0_category_values TEXT;
ALTER TABLE battles ADD COLUMN p1_category_values TEXT;
