/* Nassau County party enrollment map — Who Runs NY
   All enrollment figures come from public/data/summaries.json and eds.json,
   which were built from the official NYSBOE November 1, 2026 files. */
(() => {
  const DEM = "#3d7eff";
  const REP = "#ff2d6a";
  const BLANK = "#c8ff00";
  const MODES = [
    { id: "margin", label: "D−R margin (share)", legend: "Republican lead ← → Democratic lead" },
    { id: "dem", label: "Democratic share", legend: "Share of registered voters who are Democrats" },
    { id: "rep", label: "Republican share", legend: "Share of registered voters who are Republicans" },
    { id: "blank", label: "Blank / unaffiliated share", legend: "Share enrolled with no party" },
    { id: "total", label: "Total registration", legend: "Registered voters in the election district" },
    { id: "inactive", label: "Inactive share", legend: "Share of the ED roll marked inactive" },
  ];
  const TOWN_NAME = {
    GC: "City of Glen Cove",
    LB: "City of Long Beach",
    HEM: "Town of Hempstead",
    NH: "Town of North Hempstead",
    OB: "Town of Oyster Bay",
  };
  const SORTS = [
    { id: "id", label: "ED ID" },
    { id: "totDesc", label: "Total, high to low" },
    { id: "demDesc", label: "Democrats, high to low" },
    { id: "repDesc", label: "Republicans, high to low" },
    { id: "blankDesc", label: "Blank, high to low" },
    { id: "demLead", label: "Largest Democratic margin" },
    { id: "repLead", label: "Largest Republican margin" },
  ];

  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const fmtPct = (x, digits = 1) =>
    x == null || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(digits)}%`;
  const signed = (n) => {
    if (n == null) return "—";
    const v = Number(n);
    return (v > 0 ? "D+" : v < 0 ? "R+" : "") + Math.abs(v).toLocaleString("en-US");
  };
  const share = (part, tot) => (tot ? part / tot : 0);
  const el = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  let S, EDS, map, pinned = null, hoverId = null, bboxes = new Map(), startBounds;

  function paintFor(mode) {
    const nodata = [
      "case",
      ["==", ["get", "enr"], false],
      "#141418",
      null,
    ];
    const schemes = {
      margin: [
        "interpolate",
        ["linear"],
        ["get", "ms"],
        -0.5, REP,
        -0.2, "#ff6b8f",
        -0.02, "#3a1020",
        0, "#16161c",
        0.02, "#0d1a3a",
        0.2, "#6b9bff",
        0.5, DEM,
      ],
      dem: [
        "interpolate",
        ["linear"],
        ["get", "ds"],
        0.15, "#07070c",
        0.28, "#12204a",
        0.37, DEM,
        0.5, "#8eb6ff",
        0.7, "#d6e6ff",
      ],
      rep: [
        "interpolate",
        ["linear"],
        ["get", "rs"],
        0.12, "#07070c",
        0.25, "#3a101c",
        0.32, REP,
        0.45, "#ff7aa0",
        0.65, "#ffd0de",
      ],
      blank: [
        "interpolate",
        ["linear"],
        ["get", "bs"],
        0.15, "#07070c",
        0.25, "#1c2600",
        0.31, "#8aa800",
        0.38, BLANK,
        0.5, "#f6ff9a",
      ],
      total: [
        "interpolate",
        ["linear"],
        ["get", "tot"],
        0, "#07070c",
        400, "#10203a",
        800, DEM,
        1400, "#9ec2ff",
        2200, "#e8f0ff",
      ],
      inactive: [
        "interpolate",
        ["linear"],
        ["get", "is"],
        0, "#07070c",
        0.03, "#1a1000",
        0.06, "#ff8c00",
        0.12, "#ffd27a",
        0.2, "#fff4d0",
      ],
    };
    return ["case", ["==", ["get", "enr"], false], "#141418", schemes[mode]];
  }

  function legendGradient(mode) {
    const g = {
      margin: `linear-gradient(90deg, ${REP}, #3a1020, #16161c, #0d1a3a, ${DEM})`,
      dem: `linear-gradient(90deg, #07070c, #12204a, ${DEM}, #d6e6ff)`,
      rep: `linear-gradient(90deg, #07070c, #3a101c, ${REP}, #ffd0de)`,
      blank: `linear-gradient(90deg, #07070c, #8aa800, ${BLANK})`,
      total: `linear-gradient(90deg, #07070c, ${DEM}, #e8f0ff)`,
      inactive: `linear-gradient(90deg, #07070c, #ff8c00, #fff4d0)`,
    };
    const labels = {
      margin: ["R+50 pts", "Even", "D+50 pts"],
      dem: ["15%", "37%", "70%"],
      rep: ["12%", "32%", "65%"],
      blank: ["15%", "31%", "50%"],
      total: ["0", "800", "2,200"],
      inactive: ["0%", "6%", "20%"],
    };
    return { gradient: g[mode], labels: labels[mode] };
  }

  function setMode(mode) {
    if (!map.getLayer("eds-fill")) return;
    map.setPaintProperty("eds-fill", "fill-color", paintFor(mode));
    const meta = MODES.find((m) => m.id === mode);
    const lg = legendGradient(mode);
    el("legend").innerHTML = `
      <h3>Legend</h3>
      <div class="legend-bar" style="background:${lg.gradient}"></div>
      <div class="legend-scale"><span>${lg.labels[0]}</span><span>${lg.labels[1]}</span><span>${lg.labels[2]}</span></div>
      <p style="margin-top:8px">${escapeHtml(meta.legend)}. Election districts with no November 2026 enrollment (GIS-only, usually 700-series) are shown in dark gray. Thirteen current EDs have no polygon and are listed under Sources.</p>`;
  }

  function dimExpression(filter) {
    if (!filter) return 0.86;
    const [kind, id] = filter;
    const prop = { cd: "cd", sd: "sd", ad: "ad", ld: "ld", town: "t" }[kind];
    const value = kind === "town" ? id : Number(id);
    return ["case", ["==", ["get", prop], value], 0.92, 0.12];
  }

  function applyHighlight(filter) {
    if (!map.getLayer("eds-fill")) return;
    map.setPaintProperty("eds-fill", "fill-opacity", dimExpression(filter));
    const vis = (kind, on) => {
      if (map.getLayer(`overlay-${kind}-line`)) {
        map.setLayoutProperty(`overlay-${kind}-line`, "visibility", on ? "visible" : "none");
      }
      if (map.getLayer(`overlay-${kind}-hi`)) {
        map.setLayoutProperty(`overlay-${kind}-hi`, "visibility", on ? "visible" : "none");
        if (on && filter && filter[0] === kind) {
          const value = kind === "town" ? filter[1] : Number(filter[1]);
          map.setFilter(`overlay-${kind}-hi`, ["==", ["get", "id"], value]);
        } else if (on) {
          map.setFilter(`overlay-${kind}-hi`, ["==", ["get", "id"], ""]);
        }
      }
    };
    const checked = new Set(
      [...document.querySelectorAll('input[name="overlay"]:checked')].map((i) => i.value)
    );
    ["cd", "sd", "ad", "ld", "town"].forEach((k) => {
      const on = checked.has(k) || (filter && filter[0] === k);
      vis(k, on);
    });
  }

  function fitTo(bounds, pad = 48) {
    if (!bounds) return;
    map.fitBounds(bounds, { padding: pad, duration: 800, maxZoom: 13 });
  }

  function collectBboxes(gj) {
    const out = new Map();
    const walk = (coords, acc) => {
      if (typeof coords[0] === "number") {
        acc[0] = Math.min(acc[0], coords[0]);
        acc[1] = Math.min(acc[1], coords[1]);
        acc[2] = Math.max(acc[2], coords[0]);
        acc[3] = Math.max(acc[3], coords[1]);
      } else coords.forEach((c) => walk(c, acc));
    };
    for (const ft of gj.features) {
      const acc = [180, 90, -180, -90];
      if (ft.geometry) walk(ft.geometry.coordinates, acc);
      out.set(ft.properties.id, acc);
    }
    return out;
  }

  function unionBounds(ids, source) {
    let acc = null;
    for (const id of ids) {
      const b = source.get(id);
      if (!b) continue;
      acc = acc
        ? [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])]
        : b.slice();
    }
    return acc;
  }

  function partyRows(p, which) {
    const mapKeys = {
      total: ["d", "r", "c", "w", "o", "b", "tot"],
      active: ["da", "ra", "ca", "wa", "oa", "ba", "ta"],
      inactive: ["di", "ri", "ci", "wi", "oi", "bi", "ti"],
    };
    const [d, r, c, w, o, b, t] = mapKeys[which].map((k) => p[k] || 0);
    const rows = [
      ["Democratic", d, "dem"],
      ["Republican", r, "rep"],
      ["Blank", b, "blank"],
      ["Conservative", c, ""],
      ["Working Families", w, ""],
      ["Other", o, ""],
      ["Total", t, "total"],
    ];
    return rows
      .map(
        ([lab, n, cls]) =>
          `<tr class="${cls}"><th>${lab}</th><td>${fmt(n)}</td><td>${t ? fmtPct(n / t) : "—"}</td></tr>`
      )
      .join("");
  }

  function cardHTML(p, officialPanel) {
    if (!p) return `<p class="hint">Hover or tap an election district.</p>`;
    const noEnroll = p.tot === 0 && p.geom === false || p.enr === false;
    // packed records have .geom and .tn; map features have .enr and no tn
    const packed = EDS.find((e) => e.id === p.id) || p;
    const town = packed.tn || TOWN_NAME[p.t] || p.t;
    const missingGeom = packed.geom === false;
    const gisOnly = packed.tot === 0 && packed.geom !== false && p.enr === false;
    const tags = [
      packed.cd ? `CD ${packed.cd}` : "CD —",
      packed.sd ? `SD ${packed.sd}` : "SD —",
      `AD ${packed.ad}`,
      packed.ld ? `LD ${packed.ld}` : "LD unassigned",
      town,
    ]
      .map((t) => `<span class="tag">${escapeHtml(String(t))}</span>`)
      .join("");
    let flags = "";
    if (missingGeom)
      flags += `<p class="mini-note">No polygon in the June 2025 NYS election-district GIS — this ED is not drawn on the map.</p>`;
    if (gisOnly)
      flags += `<p class="mini-note">Present in the June 2025 GIS layer but not in the November 1, 2026 enrollment file (often a 700-series district).</p>`;
    if (packed.split)
      flags += `<p class="mini-note split">Flagged as a possible split on the 2025 county legislative map.</p>`;
    if (packed.imputed)
      flags += `<p class="mini-note">Inactive row was missing in the official extract and imputed as zero (Active equaled Total).</p>`;
    if (packed.cd == null && packed.geom)
      flags += `<p class="mini-note">Could not assign a congressional or senate district from the Census overlap.</p>`;
    const off = officialPanel
      ? `<div class="mini-note" style="border-top:1px solid #1a1a22;padding-top:10px;margin-top:12px">${officialPanel}</div>`
      : "";
    return `
      <p class="ed-id">${escapeHtml(packed.id)}</p>
      <h3 class="ed-name" style="font-family:var(--serif);font-size:24px;font-weight:400;margin:0 0 8px">${escapeHtml(town)} · AD ${packed.ad} ED ${packed.edn}</h3>
      <div class="tags">${tags}</div>
      <h3>Total registration</h3>
      <table class="kv"><thead><tr><th></th><th>Voters</th><th>Share</th></tr></thead><tbody>${partyRows(packed, "total")}</tbody></table>
      <p class="mini-note">D−R margin ${signed(packed.m)} · inactive ${fmt(packed.ti)} (${fmtPct(share(packed.ti, packed.tot))})</p>
      <h3 style="margin-top:14px">Active</h3>
      <table class="kv"><tbody>${partyRows(packed, "active")}</tbody></table>
      <h3 style="margin-top:14px">Inactive</h3>
      <table class="kv"><tbody>${partyRows(packed, "inactive")}</tbody></table>
      ${flags}${off}`;
  }

  function officialBlurb(kind, id) {
    const key = kind === "town" ? "town" : kind;
    const rows = S[key] || [];
    const row = rows.find((r) => String(r.id) === String(id));
    if (!row) return "";
    const name =
      kind === "town"
        ? row.name
        : kind === "ld"
        ? `Legislative District ${row.id}${row.legislator ? " · " + row.legislator : ""}`
        : kind === "cd"
        ? `Congressional District ${row.id}`
        : kind === "sd"
        ? `State Senate District ${row.id}`
        : `Assembly District ${row.id}`;
    const scope = row.nassau_only
      ? "Nassau only"
      : `Nassau portion${row.counties ? " of " + row.counties : ""}`;
    return `<strong style="color:var(--ink)">${escapeHtml(name)}</strong> · ${escapeHtml(scope)}<br>
      Official NYSBOE Nassau total ${fmt(row.total)} · DEM ${fmt(row.dem)} · REP ${fmt(row.rep)} · blank ${fmt(row.blank)} · margin ${signed(row.margin)}`;
  }

  function showCard(p, extra) {
    el("hover-card").innerHTML = cardHTML(p, extra);
  }

  function renderHero() {
    const t = S.county.total;
    const a = S.county.active;
    el("as-of-label").textContent = S.as_of_label;
    el("hero-stats").innerHTML = `
      <div class="stat"><span class="n">${fmt(t.total)}</span><span class="l">Registered voters</span></div>
      <div class="stat dem"><span class="n">${fmt(t.dem)}</span><span class="l">Democratic · ${fmtPct(t.dem_share)}</span></div>
      <div class="stat blank"><span class="n">${fmt(t.blank)}</span><span class="l">Blank · ${fmtPct(t.blank_share)}</span></div>
      <div class="stat rep"><span class="n">${fmt(t.rep)}</span><span class="l">Republican · ${fmtPct(t.rep_share)}</span></div>
      <div class="stat margin"><span class="n">${signed(t.margin)}</span><span class="l">Democratic margin</span></div>`;
    el("finding-copy").innerHTML = `On the <em>active</em> roll, <strong class="blank">${fmt(a.blank)}</strong> voters are enrolled with no party — more than the <strong class="rep">${fmt(a.rep)}</strong> active Republicans. Democrats remain the largest group at <strong class="dem">${fmt(a.dem)}</strong> active. Across the full roll (active plus inactive) blank is still second: ${fmt(t.blank)} to ${fmt(t.rep)}. Conservative, Working Families, and other parties together are ${fmt(t.other)} voters, ${fmtPct(share(t.other, t.total))} of the county.`;
  }

  function dataTable(rows, kind) {
    const head = `<thead><tr>
      <th class="left">${kind === "town" ? "Town / city" : kind === "ld" ? "District / legislator" : "District"}</th>
      <th>DEM</th><th>REP</th><th>Blank</th><th>Other</th><th>Total</th><th>D−R</th><th>DEM %</th><th>REP %</th><th>Blank %</th>
      ${kind === "ld" ? "<th>EDs</th>" : "<th></th>"}
    </tr></thead>`;
    const body = rows
      .map((r) => {
        const label =
          kind === "town"
            ? r.name
            : kind === "ld"
            ? `LD ${r.id}${r.legislator ? " · " + r.legislator : r.id === "UNASSIGNED" ? " · Unassigned" : ""}`
            : `${kind.toUpperCase()} ${r.id}`;
        const note = r.nassau_only === false ? "Split" : "";
        const mcls = r.margin >= 0 ? "d" : "r";
        return `<tr data-kind="${kind}" data-id="${escapeHtml(String(r.id))}">
          <td class="left">${escapeHtml(label)}${note ? ` <span class="tag">${note}</span>` : ""}</td>
          <td class="d">${fmt(r.dem)}</td>
          <td class="r">${fmt(r.rep)}</td>
          <td class="b">${fmt(r.blank)}</td>
          <td>${fmt(r.other)}</td>
          <td>${fmt(r.total)}</td>
          <td class="${mcls}">${signed(r.margin)}</td>
          <td>${fmtPct(r.dem_share)}</td>
          <td>${fmtPct(r.rep_share)}</td>
          <td>${fmtPct(r.blank_share)}</td>
          <td>${r.eds != null ? fmt(r.eds) : r.nassau_only === false ? (r.counties || "") : ""}</td>
        </tr>`;
      })
      .join("");
    return `<table class="data">${head}<tbody>${body}</tbody></table>`;
  }

  function chart(rows, kind) {
    const max = Math.max(...rows.map((r) => Math.abs(r.margin)), 1);
    return rows
      .map((r) => {
        const pct = (Math.abs(r.margin) / max) * 50;
        const lab =
          kind === "town" ? r.name.replace("Town of ", "").replace("City of ", "") : `${kind.toUpperCase()} ${r.id}`;
        const cls = r.margin >= 0 ? "d" : "r";
        const dStyle = r.margin > 0 ? `width:${pct}%;right:50%` : "width:0";
        const rStyle = r.margin < 0 ? `width:${pct}%;left:50%` : "width:0";
        return `<div class="divbar">
          <button type="button" data-kind="${kind}" data-id="${escapeHtml(String(r.id))}">${escapeHtml(lab)}</button>
          <div class="track" aria-hidden="true"><span class="zero"></span><span class="bar-d" style="${dStyle}"></span><span class="bar-r" style="${rStyle}"></span></div>
          <div class="val ${cls}">${signed(r.margin)}</div>
        </div>`;
      })
      .join("");
  }

  function wireJumps(root) {
    root.querySelectorAll("[data-kind][data-id]").forEach((node) => {
      node.addEventListener("click", () => {
        const kind = node.getAttribute("data-kind");
        const id = node.getAttribute("data-id");
        const sel = `${kind}:${id}`;
        const pick = el("district-pick");
        if ([...pick.options].some((o) => o.value === sel)) pick.value = sel;
        document.querySelector(`input[name="overlay"][value="${kind}"]`)?.setAttribute("checked", "checked");
        const box = document.querySelector(`input[name="overlay"][value="${kind}"]`);
        if (box) box.checked = true;
        selectDistrict(kind, id);
        document.getElementById("map-stage").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function renderTables() {
    const blocks = [
      ["cd", "Congressional"],
      ["sd", "Senate"],
      ["ad", "Assembly"],
      ["ld", "Legislative"],
      ["town", "Town"],
    ];
    for (const [k] of blocks) {
      el(`chart-${k}`).innerHTML = chart(S[k], k);
      el(`table-${k}`).innerHTML = dataTable(S[k], k);
      wireJumps(el(`chart-${k}`));
      wireJumps(el(`table-${k}`));
    }
  }

  function fillDistrictSelect() {
    const pick = el("district-pick");
    const groups = [
      ["Congressional", "cd", S.cd, (r) => `CD ${r.id}`],
      ["State Senate", "sd", S.sd, (r) => `SD ${r.id}`],
      ["Assembly", "ad", S.ad, (r) => `AD ${r.id}`],
      ["County Legislature", "ld", S.ld, (r) => (r.id === "UNASSIGNED" ? "LD unassigned" : `LD ${r.id}${r.legislator ? " · " + r.legislator : ""}`)],
      ["Town / city", "town", S.town, (r) => r.name],
    ];
    for (const [label, kind, rows, name] of groups) {
      const g = document.createElement("optgroup");
      g.label = label;
      for (const r of rows) {
        if (kind === "ld" && r.id === "UNASSIGNED") continue;
        const o = document.createElement("option");
        o.value = `${kind}:${r.id}`;
        o.textContent = `${name(r)} · ${signed(r.margin)} · ${fmt(r.total)}`;
        g.appendChild(o);
      }
      pick.appendChild(g);
    }
  }

  function selectDistrict(kind, id) {
    const filter = kind && id ? [kind, id] : null;
    applyHighlight(filter);
    showCard(null, officialBlurb(kind, id));
    el("hover-card").innerHTML =
      `<h3>District totals</h3><p class="hint" style="margin-bottom:12px">${officialBlurb(kind, id)}</p>` +
      `<p class="hint">Hover an election district inside the highlighted area for its full breakdown. Official totals above are the NYS Board of Elections Nassau figures, not a sum of mapped polygons.</p>`;
    if (kind && kind !== "ld" && kind !== "town") {
      // prefer official overlay bbox
      const key = `${kind}:${id}`;
      const b = overlayBounds.get(key) || unionBounds(
        EDS.filter((e) => String(e[kind === "town" ? "t" : kind]) === String(kind === "town" ? id : Number(id) || id) && e.geom).map((e) => e.id),
        bboxes
      );
      fitTo(b);
    } else if (kind) {
      const ids = EDS.filter((e) => {
        if (kind === "town") return e.t === id && e.geom;
        if (kind === "ld") return String(e.ld) === String(id) && e.geom;
        return false;
      }).map((e) => e.id);
      fitTo(unionBounds(ids, bboxes));
    }
  }

  const overlayBounds = new Map();

  function renderMethodology() {
    const miss = S.eds_without_geometry || [];
    const missList = miss
      .map(
        (e) =>
          `<li><strong>${escapeHtml(e.id)}</strong> — ${escapeHtml(e.town)}, AD ${e.ad}${e.ld ? ", LD " + e.ld : ", LD unassigned"} · ${fmt(e.total)} voters (DEM ${fmt(e.dem)}, REP ${fmt(e.rep)}, blank ${fmt(e.blank)})</li>`
      )
      .join("");
    const splits = (S.split_eds || [])
      .map((e) => `<li><strong>${escapeHtml(e.id)}</strong> · assigned LD ${e.ld} · ${fmt(e.total)} voters${e.note ? " — " + escapeHtml(e.note) : ""}</li>`)
      .join("");
    const unassigned = (S.unassigned_ld_eds || []).map((id) => `<code>${escapeHtml(id)}</code>`).join(", ");
    const imputed = (S.imputed_inactive_eds || []).map((id) => `<code>${escapeHtml(id)}</code>`).join(", ");
    const audit = S.assignment_audit || {};
    const cdLines = (audit.cd || [])
      .map((r) => `CD ${r.district}: official ${fmt(r.official)}, mapped polygons ${fmt(r.mapped)} (diff ${r.diff > 0 ? "+" : ""}${fmt(r.diff)})`)
      .join("; ");
    el("method-body").innerHTML = `
      <p>Enrollment is the official New York State Board of Elections NYSVoter snapshot as of <strong style="color:var(--ink)">${escapeHtml(S.as_of_label)}</strong>, published in the November 2026 workbooks for county, congressional, senate, assembly, and Nassau election districts. Direct downloads from elections.ny.gov were blocked by Cloudflare in our pull; figures were parsed from official workbook text extracts and, for the congressional workbook, from the Internet Archive copy, then cross-checked so that every Nassau breakdown sums to the official county totals of <strong style="color:var(--ink)">${fmt(S.county.total.total)}</strong> registered voters.</p>
      <h3>Sources</h3>
      <ul>
        <li><a href="${S.source_urls.county}">Enrollment by county</a>, <a href="${S.source_urls.congress}">congressional district</a>, <a href="${S.source_urls.senate}">senate</a>, <a href="${S.source_urls.assembly}">assembly</a>, and <a href="${S.source_urls.ed}">election district</a> · workbooks under <a href="${S.source_urls.workbooks}">elections.ny.gov/system/files/documents/2026/11/</a></li>
        <li>Election-district geometry: NYS ITS / NYSBOE GIS, layer dated June 12, 2025, <a href="${S.source_urls.gis}">NYS Election Districts FeatureServer (layer 4)</a>. ${fmt(S.counts.gis_eds)} Nassau polygons.</li>
        <li>Congressional and State Senate boundaries used to place each mapped ED: U.S. Census Bureau TIGER/Line 2025 (119th Congress and NY State Senate, legal boundaries as of January 1, 2025), assigned by largest-area overlap. Assembly district on each ED is taken from the official NYSVoter ED code, not from a spatial join.</li>
        <li>County legislative districts: official <a href="${S.source_urls.ld_maps}">Current Legislative Maps</a> for Local Law 1 of 2025 (consent decree January 22, 2025; legislature January 27, 2025; maps printed March 13, 2025). EDs were assigned from labels inside the official PDF district outlines, then flood-fill / largest-area overlap among neighboring LDs for unlabeled GIS districts. The county’s My_Nassau GIS legislature layer was last edited January 13, 2025 — before the decree — and was <em>not</em> used.</li>
      </ul>
      <h3>What the map does and does not show</h3>
      <ul>
        <li><strong style="color:var(--ink)">${fmt(S.counts.mapped_enrolled_eds)}</strong> of <strong style="color:var(--ink)">${fmt(S.counts.enrollment_eds)}</strong> enrollment election districts have a June 2025 polygon and are drawn on the map.</li>
        <li><strong style="color:var(--ink)">${fmt(S.counts.eds_without_geometry)}</strong> enrollment EDs have no polygon. They are in the explorer and in official district totals, but cannot be drawn. Together they account for ${fmt(miss.reduce((s, e) => s + e.total, 0))} voters.</li>
        <li>${fmt(S.counts.gis_only_eds)} GIS polygons (many of them 700-series) have no November 2026 enrollment and are drawn in dark gray as “not on the current roll.”</li>
        <li>District tables, hero statistics, and the panel that appears when you pick a district use the official NYSBOE Nassau figures (and the derived town and 2025 LD rollups). They are not recomputed from mapped polygons, so missing geometry cannot shrink a district’s official total.</li>
      </ul>
      <h3>Election districts missing from the map</h3>
      <ul>${missList}</ul>
      <h3>Legislative-district caveats</h3>
      <p>${fmt(S.counts.unassigned_ld_eds)} EDs could not be assigned from the official 2025 maps, totaling 797 voters (UNASSIGNED in the LD table): ${unassigned}.</p>
      <p>${fmt(S.counts.split_eds)} EDs, ${fmt((S.split_eds || []).reduce((s, e) => s + e.total, 0))} voters (0.6% of the county), are flagged as possible splits because a material share of the GIS area falls in a second LD, or because the official map placed the label in two outlines. Each is assigned to a single LD for the rollup:</p>
      <ul>${splits}</ul>
      <p>Independently georeferenced PDF outlines can overlap slightly, so area shares can exceed 100%. That is a georeferencing artifact, not a claim that an ED’s voters were officially split.</p>
      <h3>Other parse and join caveats</h3>
      <ul>
        <li>${fmt(S.counts.imputed_inactive_eds)} EDs had an Active row equal to Total and a missing Inactive row in the official extract. Inactive was imputed as zero: ${imputed}.</li>
        <li>CD / SD spatial assignment versus official Nassau totals (mapped polygons only; the ${fmt(miss.reduce((s, e) => s + e.total, 0))} unmapped voters explain the net gap): ${escapeHtml(cdLines)}. A ${fmt(141)}-voter residual remains on CD 2 after using TIGER/Line 2025 (CD 2 mapped polygons run ${fmt(141)} above the official Nassau total). That is likely a split or boundary disagreement affecting a small Oyster Bay edge ED, not a problem in the official tables. Hover CD/SD labels on the map are the spatial assignment; treat official district tables as the totals of record.</li>
        <li>Two EDs have an official assembly code that disagrees with the largest-area overlap against Census 2024 assembly cartography (HEM 19071 and HEM 15001). The official ED code is what this site uses.</li>
        <li>Town totals are derived from the ED identifier’s town prefix and sum to the county file. Other = Conservative + Working Families + Other. D−R margin is Democrats minus Republicans. Total = Active + Inactive.</li>
      </ul>
      <p>Legislator names follow the county’s official 2026 Elected Officials List, which does not publish party; party is omitted here. This page is an independent Who Runs NY presentation of official public records.</p>`;
  }

  /* ---------- explorer ---------- */
  const PAGE = 40;
  let exPage = 0;

  function filteredEds() {
    const q = (el("ex-q").value || "").trim().toLowerCase();
    const town = el("ex-town").value;
    const cd = el("ex-cd").value;
    const sd = el("ex-sd").value;
    const ad = el("ex-ad").value;
    const ld = el("ex-ld").value;
    let rows = EDS.slice();
    if (town) rows = rows.filter((e) => e.t === town);
    if (cd) rows = rows.filter((e) => String(e.cd) === cd);
    if (sd) rows = rows.filter((e) => String(e.sd) === sd);
    if (ad) rows = rows.filter((e) => String(e.ad) === ad);
    if (ld === "none") rows = rows.filter((e) => !e.ld);
    else if (ld) rows = rows.filter((e) => String(e.ld) === ld);
    if (q) {
      rows = rows.filter((e) => {
        const blob = `${e.id} ${e.tn} ${e.t} ad${e.ad} ed${e.edn} cd${e.cd || ""} sd${e.sd || ""} ld${e.ld || ""}`.toLowerCase();
        return blob.includes(q) || e.id.replace(/\s+/g, "").toLowerCase().includes(q.replace(/\s+/g, ""));
      });
    }
    const sort = el("ex-sort").value;
    const cmp = {
      id: (a, b) => a.id.localeCompare(b.id),
      totDesc: (a, b) => b.tot - a.tot,
      demDesc: (a, b) => b.d - a.d,
      repDesc: (a, b) => b.r - a.r,
      blankDesc: (a, b) => b.b - a.b,
      demLead: (a, b) => b.m - a.m,
      repLead: (a, b) => a.m - b.m,
    }[sort];
    rows.sort(cmp || cmp.id);
    return rows;
  }

  function renderExplorer() {
    const rows = filteredEds();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (exPage >= pages) exPage = 0;
    const slice = rows.slice(exPage * PAGE, exPage * PAGE + PAGE);
    el("ex-table").innerHTML = `<table class="data">
      <thead><tr>
        <th class="left">Election district</th><th class="left">Town</th>
        <th>CD</th><th>SD</th><th>AD</th><th>LD</th>
        <th>DEM</th><th>REP</th><th>Blank</th><th>Other</th><th>Total</th><th>D−R</th><th></th>
      </tr></thead>
      <tbody>${slice
        .map((e) => {
          const mcls = e.m >= 0 ? "d" : "r";
          const flag = [
            e.geom ? "" : "No map",
            e.split ? "Split LD" : "",
            e.imputed ? "Imputed" : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return `<tr data-ed="${escapeHtml(e.id)}">
            <td class="left">${escapeHtml(e.id)}</td>
            <td class="left">${escapeHtml(e.tn.replace("Town of ", "").replace("City of ", ""))}</td>
            <td>${e.cd || "—"}</td><td>${e.sd || "—"}</td><td>${e.ad}</td><td>${e.ld || "—"}</td>
            <td class="d">${fmt(e.d)}</td><td class="r">${fmt(e.r)}</td><td class="b">${fmt(e.b)}</td>
            <td>${fmt(e.othx)}</td><td>${fmt(e.tot)}</td><td class="${mcls}">${signed(e.m)}</td>
            <td>${flag ? `<span class="tag">${escapeHtml(flag)}</span>` : ""}</td>
          </tr>`;
        })
        .join("")}</tbody></table>`;
    el("ex-pager").innerHTML = `<span>${fmt(rows.length)} election districts · page ${exPage + 1} of ${pages}</span>
      <div class="btns">
        <button class="btn" type="button" id="ex-prev" ${exPage === 0 ? "disabled" : ""}>Previous</button>
        <button class="btn" type="button" id="ex-next" ${exPage >= pages - 1 ? "disabled" : ""}>Next</button>
      </div>`;
    el("ex-prev")?.addEventListener("click", () => {
      exPage = Math.max(0, exPage - 1);
      renderExplorer();
    });
    el("ex-next")?.addEventListener("click", () => {
      exPage += 1;
      renderExplorer();
    });
    el("ex-table").querySelectorAll("tr[data-ed]").forEach((tr) => {
      tr.addEventListener("click", () => focusED(tr.getAttribute("data-ed"), true));
    });
  }

  function setupExplorer() {
    const fill = (id, values, labelFn) => {
      const s = el(id);
      for (const v of values) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = labelFn(v);
        s.appendChild(o);
      }
    };
    fill("ex-town", ["GC", "LB", "HEM", "NH", "OB"], (v) => TOWN_NAME[v]);
    fill("ex-cd", [...new Set(EDS.map((e) => e.cd).filter(Boolean))].sort((a, b) => a - b), (v) => `CD ${v}`);
    fill("ex-sd", [...new Set(EDS.map((e) => e.sd).filter(Boolean))].sort((a, b) => a - b), (v) => `SD ${v}`);
    fill("ex-ad", [...new Set(EDS.map((e) => e.ad))].sort((a, b) => a - b), (v) => `AD ${v}`);
    fill("ex-ld", [...new Set(EDS.map((e) => e.ld).filter(Boolean))].sort((a, b) => a - b), (v) => `LD ${v}`);
    const none = document.createElement("option");
    none.value = "none";
    none.textContent = "Unassigned LD";
    el("ex-ld").appendChild(none);
    for (const s of SORTS) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.label;
      el("ex-sort").appendChild(o);
    }
    ["ex-q", "ex-town", "ex-cd", "ex-sd", "ex-ad", "ex-ld", "ex-sort"].forEach((id) => {
      el(id).addEventListener("input", () => {
        exPage = 0;
        renderExplorer();
      });
      el(id).addEventListener("change", () => {
        exPage = 0;
        renderExplorer();
      });
    });
    renderExplorer();
  }

  function focusED(id, scrollMap) {
    const p = EDS.find((e) => e.id === id);
    if (!p) return;
    pinned = id;
    showCard(p);
    if (p.geom && bboxes.has(id)) {
      if (scrollMap) document.getElementById("map-stage").scrollIntoView({ behavior: "smooth", block: "start" });
      fitTo(bboxes.get(id), 80);
      if (map.getLayer("eds-outline-hi")) {
        map.setFilter("eds-outline-hi", ["==", ["get", "id"], id]);
        map.setLayoutProperty("eds-outline-hi", "visibility", "visible");
      }
    }
  }

  function setupSearch() {
    const box = el("search");
    const results = el("search-results");
    const run = () => {
      const q = (box.value || "").trim().toLowerCase();
      if (q.length < 2) {
        results.hidden = true;
        results.innerHTML = "";
        return;
      }
      const hits = EDS.filter((e) => {
        const blob = `${e.id} ${e.tn} ${e.t}`.toLowerCase();
        return blob.includes(q) || e.id.replace(/\s+/g, "").toLowerCase().includes(q.replace(/\s+/g, ""));
      }).slice(0, 12);
      if (!hits.length) {
        results.hidden = false;
        results.innerHTML = `<button type="button" disabled>No matches</button>`;
        return;
      }
      results.hidden = false;
      results.innerHTML = hits
        .map(
          (e) =>
            `<button type="button" data-ed="${escapeHtml(e.id)}">${escapeHtml(e.id)} · ${escapeHtml(
              e.tn.replace("Town of ", "").replace("City of ", "")
            )} · ${fmt(e.tot)} voters</button>`
        )
        .join("");
      results.querySelectorAll("button[data-ed]").forEach((b) =>
        b.addEventListener("click", () => {
          focusED(b.getAttribute("data-ed"), false);
          results.hidden = true;
        })
      );
    };
    box.addEventListener("input", run);
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        const first = results.querySelector("button[data-ed]");
        if (first) first.click();
      }
    });
  }

  /* ---------- map ---------- */
  function addOverlay(kind, data, color, width) {
    const src = `overlay-${kind}`;
    map.addSource(src, { type: "geojson", data });
    const boxes = collectBboxes(data);
    for (const [id, b] of boxes) overlayBounds.set(`${kind}:${id}`, b);
    map.addLayer({
      id: `${src}-line`,
      type: "line",
      source: src,
      layout: { visibility: "none", "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": color,
        "line-width": width,
        "line-opacity": 0.9,
        "line-blur": 0.2,
      },
    });
    map.addLayer({
      id: `${src}-hi`,
      type: "line",
      source: src,
      layout: { visibility: "none", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": width + 1.5,
        "line-opacity": 0.95,
        "line-blur": 0.4,
      },
    });
  }

  function initMap(edsGj, overlays) {
    startBounds = S.bounds;
    bboxes = collectBboxes(edsGj);
    map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": "#000000" } }],
      },
      bounds: startBounds,
      fitBoundsOptions: { padding: 20 },
      attributionControl: false,
      maxPitch: 0,
      dragRotate: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          "Enrollment © NYS Board of Elections · ED GIS NYS ITS/NYSBOE June 2025 · CD/SD Census TIGER/Line 2025 · LD Local Law 1 of 2025",
      }),
      "bottom-left"
    );
    map.on("load", () => {
      map.addSource("streets", {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        ],
        tileSize: 256,
        attribution: "© CARTO © OSM",
        maxzoom: 19,
      });
      map.addLayer({
        id: "streets",
        type: "raster",
        source: "streets",
        layout: { visibility: "none" },
        paint: { "raster-opacity": 0.28, "raster-brightness-min": 0, "raster-saturation": -0.3 },
      });
      map.addSource("eds", { type: "geojson", data: edsGj, promoteId: "id" });
      map.addLayer({
        id: "eds-fill",
        type: "fill",
        source: "eds",
        paint: {
          "fill-color": paintFor("margin"),
          "fill-opacity": 0.86,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      });
      map.addLayer({
        id: "eds-line",
        type: "line",
        source: "eds",
        paint: {
          "line-color": "#000000",
          "line-width": 0.3,
          "line-opacity": 0.55,
        },
      });
      map.addLayer({
        id: "eds-outline-hi",
        type: "line",
        source: "eds",
        layout: { visibility: "none", "line-join": "round" },
        filter: ["==", ["get", "id"], ""],
        paint: {
          "line-color": BLANK,
          "line-width": 2.2,
          "line-opacity": 1,
          "line-blur": 0.2,
        },
      });
      addOverlay("cd", overlays.cd, "#7eb0ff", 2.2);
      addOverlay("sd", overlays.sd, "#c45cff", 2);
      addOverlay("ad", overlays.ad, "#00ffd0", 1.6);
      addOverlay("ld", overlays.ld, "#ff8c00", 1.8);
      addOverlay("town", overlays.town, "#ffffff", 1.4);
      setMode("margin");

      const onMove = (ev) => {
        const hits = map.queryRenderedFeatures(ev.point, { layers: ["eds-fill"] });
        map.getCanvas().style.cursor = hits.length ? "pointer" : "";
        if (!hits.length) {
          if (!pinned) showCard(null);
          if (hoverId && map.getLayer("eds-outline-hi") && !pinned) {
            map.setFilter("eds-outline-hi", ["==", ["get", "id"], ""]);
          }
          hoverId = null;
          return;
        }
        const props = hits[0].properties;
        // geojson booleans may arrive as strings
        props.enr = props.enr === true || props.enr === "true";
        props.split = props.split === true || props.split === "true";
        hoverId = props.id;
        if (!pinned) {
          showCard(props);
          map.setFilter("eds-outline-hi", ["==", ["get", "id"], props.id]);
          map.setLayoutProperty("eds-outline-hi", "visibility", "visible");
        }
      };
      map.on("mousemove", "eds-fill", onMove);
      map.on("mouseleave", "eds-fill", () => {
        map.getCanvas().style.cursor = "";
        if (!pinned) {
          showCard(null);
          map.setFilter("eds-outline-hi", ["==", ["get", "id"], ""]);
        }
      });
      map.on("click", "eds-fill", (ev) => {
        const hits = map.queryRenderedFeatures(ev.point, { layers: ["eds-fill"] });
        if (!hits.length) return;
        focusED(hits[0].properties.id, false);
        ev.originalEvent.stopPropagation();
      });
      map.on("click", (ev) => {
        const hits = map.queryRenderedFeatures(ev.point, { layers: ["eds-fill"] });
        if (!hits.length) {
          pinned = null;
          map.setFilter("eds-outline-hi", ["==", ["get", "id"], ""]);
        }
      });
    });
  }

  function setupControls() {
    const modeSel = el("mode");
    for (const m of MODES) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      modeSel.appendChild(o);
    }
    modeSel.addEventListener("change", () => setMode(modeSel.value));
    el("district-pick").addEventListener("change", () => {
      const v = el("district-pick").value;
      if (!v) {
        applyHighlight(null);
        fitTo(startBounds, 20);
        pinned = null;
        showCard(null);
        return;
      }
      const [kind, ...rest] = v.split(":");
      selectDistrict(kind, rest.join(":"));
    });
    document.querySelectorAll('input[name="overlay"]').forEach((box) => {
      box.addEventListener("change", () => {
        const v = el("district-pick").value;
        const filter = v ? v.split(":") : null;
        applyHighlight(filter ? [filter[0], filter.slice(1).join(":")] : null);
      });
    });
    el("streets").addEventListener("change", () => {
      if (!map.getLayer("streets")) return;
      map.setLayoutProperty("streets", "visibility", el("streets").checked ? "visible" : "none");
    });
    el("reset").addEventListener("click", () => {
      el("district-pick").value = "";
      el("search").value = "";
      el("search-results").hidden = true;
      document.querySelectorAll('input[name="overlay"]').forEach((b) => (b.checked = false));
      el("streets").checked = false;
      if (map.getLayer("streets")) map.setLayoutProperty("streets", "visibility", "none");
      applyHighlight(null);
      if (map.getLayer("eds-outline-hi")) {
        map.setFilter("eds-outline-hi", ["==", ["get", "id"], ""]);
        map.setLayoutProperty("eds-outline-hi", "visibility", "none");
      }
      pinned = null;
      showCard(null);
      fitTo(startBounds, 20);
    });
  }

  async function main() {
    const [sum, eds, edsGj, cd, sd, ad, ld, town] = await Promise.all([
      fetch("data/summaries.json").then((r) => r.json()),
      fetch("data/eds.json").then((r) => r.json()),
      fetch("data/eds.geojson").then((r) => r.json()),
      fetch("data/overlay-cd.geojson").then((r) => r.json()),
      fetch("data/overlay-sd.geojson").then((r) => r.json()),
      fetch("data/overlay-ad.geojson").then((r) => r.json()),
      fetch("data/overlay-ld.geojson").then((r) => r.json()),
      fetch("data/overlay-town.geojson").then((r) => r.json()),
    ]);
    S = sum;
    EDS = eds;
    renderHero();
    renderTables();
    fillDistrictSelect();
    renderMethodology();
    setupExplorer();
    setupSearch();
    setupControls();
    initMap(edsGj, { cd, sd, ad, ld, town });
  }

  main().catch((err) => {
    console.error(err);
    el("hover-card").innerHTML = `<p class="hint">Could not load map data. Please refresh.</p>`;
  });
})();
