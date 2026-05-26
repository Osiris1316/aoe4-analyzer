-- Migration 008: Patch-Aware Data Versioning (Schema Only)
--
-- Creates new tables for patch-versioned unit/building/tech attributes
-- and a patch registry. Adds build_number_analyzed_with tracking columns
-- to battles and battle_search.
--
-- This migration is pure DDL — no data inserts, updates, or renames.
-- Data population is handled by scripts/migrate-to-patch-versioning.ts
-- for existing databases, and by fetch-static.ts for new setups.

-- ── Patch Registry ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS patch_registry (
  build_number       TEXT PRIMARY KEY,
  aoe4world_patch_id INTEGER,
  effective_at       TEXT NOT NULL,
  announced_at       TEXT,
  data_commit        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  notes              TEXT
);

-- ── Unit Identity (stable resolution data) ─────────────────────────────

CREATE TABLE IF NOT EXISTS unit_identity (
  unit_id         TEXT PRIMARY KEY,
  base_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  pbgid           INTEGER,
  age             INTEGER,
  classes         TEXT NOT NULL,
  display_classes TEXT,
  civs            TEXT NOT NULL,
  icon            TEXT,
  unique_unit     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_unit_identity_base ON unit_identity(base_id);
CREATE INDEX IF NOT EXISTS idx_unit_identity_pbgid ON unit_identity(pbgid);

-- ── Unit Attributes (patch-versioned stats) ────────────────────────────

CREATE TABLE IF NOT EXISTS unit_attributes (
  build_number TEXT NOT NULL,
  unit_id      TEXT NOT NULL,
  costs        TEXT NOT NULL,
  hitpoints    INTEGER,
  weapons      TEXT,
  armor        TEXT,
  sight        TEXT,
  description  TEXT,
  PRIMARY KEY (build_number, unit_id),
  FOREIGN KEY (build_number) REFERENCES patch_registry(build_number),
  FOREIGN KEY (unit_id)      REFERENCES unit_identity(unit_id)
);

CREATE INDEX IF NOT EXISTS idx_unit_attributes_unit ON unit_attributes(unit_id);

-- ── Building Attributes (schema only, unpopulated) ─────────────────────

CREATE TABLE IF NOT EXISTS building_attributes (
  build_number   TEXT NOT NULL,
  building_id    TEXT NOT NULL,
  costs          TEXT,
  hitpoints      INTEGER,
  weapons        TEXT,
  armor          TEXT,
  garrison_slots INTEGER,
  sight          TEXT,
  description    TEXT,
  PRIMARY KEY (build_number, building_id),
  FOREIGN KEY (build_number) REFERENCES patch_registry(build_number)
);

-- ── Technology Attributes (schema only, unpopulated) ───────────────────

CREATE TABLE IF NOT EXISTS technology_attributes (
  build_number   TEXT NOT NULL,
  technology_id  TEXT NOT NULL,
  costs          TEXT,
  research_time  REAL,
  effects        TEXT,
  description    TEXT,
  PRIMARY KEY (build_number, technology_id),
  FOREIGN KEY (build_number) REFERENCES patch_registry(build_number)
);

-- ── Tracking columns on analysis tables ────────────────────────────────

ALTER TABLE battles ADD COLUMN build_number_analyzed_with TEXT;
ALTER TABLE battle_search ADD COLUMN build_number_analyzed_with TEXT;
