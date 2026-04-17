/**
 * Unit Resolver
 *
 * Maps build order entries to canonical unit identities.
 *
 * Resolution priority:
 * 1. Icon path → icon_key → units table (by unit_id)
 * 2. Icon path → icon_key → unit_lines table (by icon_key)
 * 3. Pbgid → units table (direct match)
 * 4. Pbgid → pbgid_aliases → units table or custom token
 * 5. Unresolved (icon_key used as fallback identity)
 *
 * Why icon-first: The build order icon path (e.g. 'icons/races/common/units/archer_2')
 * is stable across all civs. Pbgids vary wildly — a scout can have 10+ different
 * pbgids depending on the civ. Icon is the reliable identifier.
 */

// ── Types ──────────────────────────────────────────────────────────────

/** A row from the `units` table, indexed by pbgid. */
export interface UnitRecord {
  unitId: string;     // e.g. 'spearman-2'
  unitName: string;   // e.g. 'Early Spearman'
  pbgid: number;
}

/** A row from the `pbgid_aliases` table. */
export interface PbgidAlias {
  observedPbgid: number;
  canonicalCatalog: string;    // 'units' | 'custom'
  canonicalPbgid: number | null;
  customToken: string | null;
}

/** A row from the `unit_lines` table. */
export interface UnitLineRecord {
  iconKey: string;    // e.g. 'archer_2'
  lineKey: string;    // e.g. 'archer'
  label: string;      // e.g. 'Archer'
}

/** Resolution result. */
export interface ResolvedUnit {
  resolved: boolean;
  unitKey: string;     // the unit_id, custom token, or icon_key fallback
  unitId: string;      // e.g. 'spearman-2' (empty if not found in units table)
  unitName: string;    // e.g. 'Early Spearman' (falls back to icon_key)
  lineKey: string;     // e.g. 'spearman' (for grouping across tiers)
  resolvedVia: string; // 'icon-units' | 'icon-lines' | 'pbgid' | 'alias' | 'unresolved'
}

// ── Index Builders ─────────────────────────────────────────────────────

/** Build a Map<unitId, UnitRecord> from the units table. */
export function buildUnitIdIndex(
  rows: { unitId: string; unitName: string; pbgid: number | null }[]
): Map<string, UnitRecord> {
  const idx = new Map<string, UnitRecord>();
  for (const r of rows) {
    idx.set(r.unitId, {
      unitId: r.unitId,
      unitName: r.unitName,
      pbgid: r.pbgid ?? 0,
    });
  }
  return idx;
}

/** Build a Map<pbgid, UnitRecord> from the units table. */
export function buildUnitPbgidIndex(
  rows: { unitId: string; unitName: string; pbgid: number | null }[]
): Map<number, UnitRecord> {
  const idx = new Map<number, UnitRecord>();
  for (const r of rows) {
    if (r.pbgid != null && Number.isFinite(r.pbgid)) {
      idx.set(r.pbgid, {
        unitId: r.unitId,
        unitName: r.unitName,
        pbgid: r.pbgid,
      });
    }
  }
  return idx;
}

/** Build a Map<iconKey, UnitLineRecord> from the unit_lines table. */
export function buildUnitLineIndex(
  rows: { iconKey: string; lineKey: string; label: string }[]
): Map<string, UnitLineRecord> {
  const idx = new Map<string, UnitLineRecord>();
  for (const r of rows) {
    idx.set(r.iconKey, {
      iconKey: r.iconKey,
      lineKey: r.lineKey,
      label: r.label,
    });
  }
  return idx;
}

/** Build a Map<observedPbgid, PbgidAlias> from the pbgid_aliases table. */
export function buildAliasIndex(
  rows: { observedPbgid: number; canonicalCatalog: string; canonicalPbgid: number | null; customToken: string | null }[]
): Map<number, PbgidAlias> {
  const idx = new Map<number, PbgidAlias>();
  for (const r of rows) {
    idx.set(r.observedPbgid, {
      observedPbgid: r.observedPbgid,
      canonicalCatalog: r.canonicalCatalog,
      canonicalPbgid: r.canonicalPbgid,
      customToken: r.customToken,
    });
  }
  return idx;
}

/** All resolution indexes bundled together. */
export interface ResolutionIndexes {
  unitById: Map<string, UnitRecord>;
  unitByPbgid: Map<number, UnitRecord>;
  unitLines: Map<string, UnitLineRecord>;
  aliases: Map<number, PbgidAlias>;
  lineKeySet: Set<string>;  // all known line_keys, for bare-icon matching
}

/**
 * Build order icons sometimes use abbreviated names that differ from
 * the aoe4world data repo names. This maps build-order icon_keys to
 * the canonical line_key used in unit_lines.
 *
 * Only needed for names where the mismatch isn't a simple suffix strip.
 * Entries here are build-order conventions — they're stable and game-defined,
 * not something that changes with new civs.
 */
const ICON_ABBREVIATIONS: Record<string, string> = {
  // Shortened names
  manatarms: 'man_at_arms',
  gilded_manatarms: 'gilded_man_at_arms',
  ram: 'battering_ram',
  scorpion: 'springald',
  handcannon: 'handcannoneer',
  trebuchet_cw: 'counterweight_trebuchet',
  trebuchet: 'counterweight_trebuchet',
  horsearcher: 'horse_archer',
  landskrecht: 'landsknecht',

  // Dropped words
  lord_lancaster: 'lord_of_lancaster',

  // Build-order typos / alternate spellings
  jannisary: 'janissary',
  ghazi_rider: 'ghazi_raider',
  desert_rider: 'desert_raider',
  chierosiphon: 'cheirosiphon',
  elephant_raider: 'raider_elephant',

  // English
  crown_king: 'king',

  // Naval — build order uses generic icon names for all civ variants
  // war_galley = arrow ship (Galley / Junk / Lodya Galley)
  // general_ship = springald ship (Hulk / War Junk / Lodya Attack Ship)
  // fireship = demolition ship (Demolition Ship / Explosive Junk / Lodya Demolition Ship)
  war_galley: 'galley',
  general_ship: 'attack_ship',
  fireship: 'demolition_ship',

  // Different naming conventions
  repeater_crossbowman: 'zhuge_nu',
  unit_khan: 'khan',
  mameluke: 'camel_rider',
  trade_cart: 'trader',
  camel_trader: 'trade_caravan',
  ikko_ikki: 'ikko_ikki_monk',
  musofadi: 'musofadi_warrior',
  musofadi_mansa: 'mansa_musofadi_warrior',
  varangian: 'varangian_guard',
  atgeir: 'atgeirmadr',
  champion: 'jeannes_champion',
  kanabo: 'kanabo_samurai',
  bannermen_siege: 'uma_bannerman',
  bannermen_melee: 'katana_bannerman',
  bannermen_ranged: 'yumi_bannerman',
  deployed_handcannon: 'handcannon_ashigaru',
  deployed_ozutsu: 'ozutsu',
  deployed_bombard: 'bombard',
  heavy_spearman: 'heavy_spearman',
  hospitaller_knight: 'hospitaller_knight',
  templar_brother: 'templar_brother',
  chevalier_confrere: 'chevalier_confrere',
  serjeant: 'serjeant',
};

/**
 * Icon keys that the build order tags as type 'Unit' but are actually
 * buildings or non-units. These are excluded from extraction entirely.
 */
export const EXCLUDED_ICONS: Set<string> = new Set([
  'fortress',  // Knights Templar Keep equivalent — classified as Unit due to trebuchet emplacement
]);

// ── Resolver ───────────────────────────────────────────────────────────

/**
 * Extract icon_key from a full icon path.
 * "icons/races/common/units/archer_2" → "archer_2"
 */
export function iconKeyFromPath(iconPath: string): string {
  const parts = iconPath.split('/');
  return parts[parts.length - 1] ?? iconPath;
}

/**
 * Resolve a build order entry to a canonical unit identity.
 *
 * Resolution chain:
 * 1. icon_key → unit_id in units table
 * 2. icon_key → icon_key in unit_lines table
 * 3. icon_key matches a known line_key directly (handles bare names like 'scout')
 * 4. Abbreviation map → remapped name, retry steps 1-3
 * 5. Strip _ageN / _N suffix → try as line_key (handles 'hobelar_age2' → 'hobelar')
 * 6. Pbgid → units table
 * 7. Pbgid → alias → units table or custom token
 * 8. Fallback: icon_key as readable identity
 *
 * @param iconPath  The icon field from the build order entry
 * @param pbgids    All observed pbgids for this entry (from shadow stream merging)
 * @param indexes   All resolution indexes
 */
export function resolveUnit(
  iconPath: string,
  pbgids: number[],
  indexes: ResolutionIndexes,
): ResolvedUnit {
  const iconKey = iconKeyFromPath(iconPath);

  // Try icon-based resolution (steps 1-5)
  const iconResult = resolveByIcon(iconKey, indexes);
  if (iconResult) return iconResult;

  // Try abbreviation map → remap and retry icon-based resolution
  const abbrevKey = lookupAbbreviation(iconKey);
  if (abbrevKey) {
    const abbrevResult = resolveByIcon(abbrevKey, indexes);
    if (abbrevResult) {
      abbrevResult.resolvedVia = 'abbreviation';
      return abbrevResult;
    }
  }

  // Try suffix stripping: 'hobelar_age2' → 'hobelar', 'manatarms_3' → 'manatarms'
  const stripped = stripSuffix(iconKey);
  if (stripped && stripped !== iconKey) {
    // Try the stripped version as a line_key
    if (indexes.lineKeySet.has(stripped)) {
      return {
        resolved: true,
        unitKey: iconKey,
        unitId: '',
        unitName: stripped,
        lineKey: stripped,
        resolvedVia: 'suffix-strip',
      };
    }
    // Try abbreviation of the stripped version
    const strippedAbbrev = lookupAbbreviation(stripped);
    if (strippedAbbrev && indexes.lineKeySet.has(strippedAbbrev)) {
      return {
        resolved: true,
        unitKey: iconKey,
        unitId: '',
        unitName: strippedAbbrev,
        lineKey: strippedAbbrev,
        resolvedVia: 'abbreviation',
      };
    }
  }

  // 6. Pbgid → units table (direct)
  for (const raw of pbgids) {
    if (!Number.isFinite(raw)) continue;
    const direct = indexes.unitByPbgid.get(raw);
    if (direct) {
      const directLine = indexes.unitLines.get(direct.unitId.replace(/-/g, '_'));
      return {
        resolved: true,
        unitKey: direct.unitId,
        unitId: direct.unitId,
        unitName: direct.unitName,
        lineKey: directLine?.lineKey ?? direct.unitId.replace(/-/g, '_'),
        resolvedVia: 'pbgid',
      };
    }
  }

  // 7. Pbgid → alias → units table or custom token
  for (const raw of pbgids) {
    if (!Number.isFinite(raw)) continue;
    const ali = indexes.aliases.get(raw);
    if (!ali) continue;

    if (ali.canonicalCatalog === 'units' && ali.canonicalPbgid != null && Number.isFinite(ali.canonicalPbgid)) {
      const canon = indexes.unitByPbgid.get(ali.canonicalPbgid);
      if (canon) {
        const aliasLine = indexes.unitLines.get(canon.unitId.replace(/-/g, '_'));
        return {
          resolved: true,
          unitKey: canon.unitId,
          unitId: canon.unitId,
          unitName: canon.unitName,
          lineKey: aliasLine?.lineKey ?? canon.unitId.replace(/-/g, '_'),
          resolvedVia: 'alias',
        };
      }
    }
    if (ali.canonicalCatalog === 'custom' && ali.customToken) {
      return {
        resolved: true,
        unitKey: `custom:${ali.customToken}`,
        unitId: '',
        unitName: ali.customToken,
        lineKey: ali.customToken,
        resolvedVia: 'alias',
      };
    }
  }

  // 8. Fallback: use icon_key as identity. Still useful for display —
  //    'archer_2' is a readable name even without full metadata.
  return {
    resolved: false,
    unitKey: iconKey,
    unitId: '',
    unitName: iconKey,
    lineKey: stripped ?? iconKey,
    resolvedVia: 'unresolved',
  };
}

// ── Internal Helpers ───────────────────────────────────────────────────

/**
 * Try to resolve an icon_key through icon-based paths (steps 1-3).
 * Returns null if none match.
 */
function resolveByIcon(
  iconKey: string,
  indexes: ResolutionIndexes,
): ResolvedUnit | null {
  // 1. icon_key → unit_id in units table
  const unitId = iconKey.replace(/_/g, '-');
  const byId = indexes.unitById.get(unitId);
  if (byId) {
    const line = indexes.unitLines.get(iconKey);
    return {
      resolved: true,
      unitKey: byId.unitId,
      unitId: byId.unitId,
      unitName: byId.unitName,
      lineKey: line?.lineKey ?? iconKey,
      resolvedVia: 'icon-units',
    };
  }

  // 2. icon_key → unit_lines table
  const line = indexes.unitLines.get(iconKey);
  if (line) {
    return {
      resolved: true,
      unitKey: iconKey,
      unitId: '',
      unitName: line.label,
      lineKey: line.lineKey,
      resolvedVia: 'icon-lines',
    };
  }

  // 3. icon_key matches a known line_key directly (bare names: 'scout', 'villager')
  if (indexes.lineKeySet.has(iconKey)) {
    return {
      resolved: true,
      unitKey: iconKey,
      unitId: '',
      unitName: iconKey,
      lineKey: iconKey,
      resolvedVia: 'line-key',
    };
  }

  return null;
}

/**
 * Look up an icon_key in the abbreviation map.
 * Also tries with suffix stripped: 'manatarms_3' → strip → 'manatarms' → map → 'man_at_arms'.
 */
function lookupAbbreviation(iconKey: string): string | null {
  if (ICON_ABBREVIATIONS[iconKey]) return ICON_ABBREVIATIONS[iconKey];
  const stripped = stripSuffix(iconKey);
  if (stripped && ICON_ABBREVIATIONS[stripped]) return ICON_ABBREVIATIONS[stripped];
  return null;
}

/**
 * Strip trailing tier/age suffixes from an icon_key.
 * Patterns handled:
 *   'archer_2'               → 'archer'         (_N)
 *   'hobelar_age2'           → 'hobelar'         (_ageN)
 *   'templar_brother_age_3'  → 'templar_brother' (_age_N)
 *   'unit_khan_1_mon'        → 'unit_khan'       (_N_xxx civ suffix)
 */
function stripSuffix(iconKey: string): string {
  return iconKey
    .replace(/_\d+_[a-z]+$/, '')   // _1_mon, _2_chi (civ-suffixed tiers)
    .replace(/_age_?\d+$/, '')      // _age2, _age_3
    .replace(/_\d+$/, '');          // _1, _2, _3
}
