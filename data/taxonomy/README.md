# Taxonomy reference data

Generated, reviewable reference metadata for the species Jninty authors in
`data/plants/*.json`. This directory is **build-time tooling + generated
reference data only**: no runtime application code reads it, nothing here
changes Jninty-owned knowledge identity, and no network request is ever made
by the app because of it.

## Files

| File | Origin | Purpose |
|---|---|---|
| `taxonomy.json` | **generated** — do not edit by hand | one row per authored species: WFO match, Dyntaxa match, Swedish names, review status |
| `overrides.json` | **human-authored** | explicit, reviewable decisions where automation must not decide (e.g. `Salvia rosmarinus` vs Dyntaxa's `Rosmarinus officinalis`) |
| `sources.json` | **authored/refresh-updated** | pinned source snapshots: release/URL/sha256/retrieval date/license |
| `README.md` | hand-written | this file |

## Sources, licenses, attribution

| Source | Used for | License | Attribution |
|---|---|---|---|
| [World Flora Online Plant List](https://wfoplantlist.org), release **2026-06** ([DOI 10.5281/zenodo.20782718](https://doi.org/10.5281/zenodo.20782718), published 2026-06-21; file `_DwC_backbone_R.zip`) | WFO IDs, accepted names, synonyms, ranks | **CC0 1.0** — the Zenodo release record declares `license id: cc-zero` | "WFO (2026): World Flora Online Plant List June 2026. Version 2026-06. DOI 10.5281/zenodo.20782718" |
| [Dyntaxa — Svensk taxonomisk databas](https://www.slu.se/artdatabanken) (SLU Artdatabanken), DwC-A as published through GBIF (dataset `de8934f4-a136-481c-a87a-b0b202b80a31`, DOI 10.15468/j43wfc, published 2026-09-10) | Dyntaxa taxon IDs, scientific names, recommended Swedish names | **CC0 1.0** (GBIF dataset license field: `http://creativecommons.org/publicdomain/zero/1.0/legalcode`) | GBIF's own citation text: "Backlund M (2026). Dyntaxa. Svensk taxonomisk databas. SLU Artdatabanken. Checklist dataset https://doi.org/10.15468/j43wfc accessed via GBIF.org." |

Both licenses permit redistribution in this repository with no share-alike
obligation. Attribution is not legally required for CC0 but is given anyway.
License verification: the WFO statement comes from the release record's own
metadata (Zenodo `license: cc-zero`), and the Dyntaxa statement from the GBIF
dataset's license field — not from website footers or general WFO material.

## Refresh workflow

```bash
npm run taxonomy:refresh   # re-download pinned snapshots (network), regenerate, check
npm run taxonomy:generate  # regenerate offline from .taxonomy-cache/ snapshots
npm run taxonomy:check     # validate the committed artifact (CI-style)
```

`taxonomy:refresh` re-downloads the pinned snapshot files into
`.taxonomy-cache/` (gitignored), verifies them against the sha256 in
`sources.json`, regenerates `taxonomy.json`, and runs the checks. To advance a
pin to a newer release, update `sources.json` (URL + sha256 + retrieval date)
and re-run `taxonomy:refresh`. The same pinned snapshots always produce
semantically identical output; only `generatedAt` differs between runs
(`taxonomy:check` excludes it when comparing).

## Review statuses

- `clean` — automatic resolution was unambiguous on both axes.
- `needs-review` — something requires human attention: synonym resolutions,
  accepted-name disagreements between authorities, aggregate names resolved
  only at genus rank, absences from Dyntaxa, WFO ambiguities left unresolved.
- `manual-override` — an explicit decision from `overrides.json` was applied;
  the automatic/live result is preserved alongside it.
- `stale-override` — an override's pinned identifier or expected accepted name
  no longer matches the pinned snapshot. The pipeline **fails** on this status;
  the override must be re-confirmed or updated by a human.

## Relationship to Jninty knowledge identity

- Jninty knowledge identity (and knowledge IDs, where introduced) remains
  **Jninty-owned**; external identifiers in `taxonomy.json` are reference
  metadata only.
- Multiple knowledge entries (e.g. several tomato cultivar rows) may map to
  **one** taxon row — external taxon IDs identify taxa, never Jninty entries.
- A taxonomy refresh never changes a knowledge ID and never rewrites
  `data/plants/*.json`.
- Cultivars and horticultural knowledge are out of scope for this artifact.
