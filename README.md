# Nassau County party enrollment map

A standalone, client-facing interactive map of New York State Board of Elections party enrollment in Nassau County, as of **November 1, 2026**. Neon-on-black design for [Who Runs NY](https://whorunsny.org).

**Live:** https://nassau-enrollment.pages.dev

## What is on the page

- Full-county map of election districts (MapLibre GL, no basemap by default, optional CARTO dark streets)
- Choropleth modes: D−R margin, Democratic share, Republican share, blank share, total registration, inactive share
- Toggleable boundaries: Congressional, State Senate, Assembly, County Legislature (Local Law 1 of 2025), town/city
- District picker zooms and shows official NYSBOE Nassau totals
- Hover/click an ED for the full party breakdown, active vs inactive, and its CD / SD / AD / LD / town
- Search, reset view, hero statistics, the blank-outnumbers-Republican finding, sortable tables and diverging margin charts, an explorer of all 1,085 EDs, and methodology with caveats

## Data

Built only from the official NYSVoter November 2026 workbooks (reconciled to the county totals) and:

- NYS ITS / NYSBOE election-district GIS, June 12, 2025
- Census TIGER/Line 2025 119th Congress and NY State Senate (largest-area overlap for CD/SD; Assembly from the official ED code)
- Nassau County Local Law 1 of 2025 legislative maps (official PDFs printed March 13, 2025)

Rebuild map data after updating the enrollment extracts:

```bash
python3 scripts/build_data.py
```

The builder expects the enrollment CSVs at `/workspace/nassau-enrollment/clean/`, the June 2025 ED GeoJSON at `/tmp/nassau-ld/gis/nys_nassau_election_districts.geojson`, and the TIGER shapefiles under `/tmp/tiger/tl_2025_36_cd119/` and `/tmp/tiger/tl_2025_36_sldu/`. Official district tables are copied into `public/data/summaries.json`; they are not recomputed from polygons, so missing geometry cannot shrink a published total.

## Deploy

Static files live in `public/`. GitHub Actions deploys to Cloudflare Pages project `nassau-enrollment` on push to `main`, using `CLOUDFLARE_API_TOKEN` (repo secret) and account `69e84452e69fcd90dfa533795190f95f`.

```bash
npx wrangler@4 pages deploy public --project-name=nassau-enrollment --branch=main
```

## License

Enrollment figures are public records of the New York State Board of Elections. Geometry is from NYS ITS/NYSBOE and the U.S. Census Bureau (public domain). Presentation © Who Runs NY.
