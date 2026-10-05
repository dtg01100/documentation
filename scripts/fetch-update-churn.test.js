const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  analyzeManifestLayers,
  diffReleaseLayers,
  calculateReleaseChurn,
  extractDateFromTag,
  datedTagKey,
  compareTagsByDate,
  selectDatedTags,
  fetchGhcrTagCreatedAt,
  createdAtCachePath,
  loadCreatedAtCache,
  saveCreatedAtCache,
} = require("./fetch-update-churn.js");

test("analyzeManifestLayers: handles empty or invalid layers safely", () => {
  const result = analyzeManifestLayers(null);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.totalLayers, 0);
  assert.equal(result.zstdLayers, 0);
  assert.equal(result.gzipLayers, 0);
  assert.equal(result.compressionFormat, "uncompressed");
});

test("analyzeManifestLayers: correctly identifies zstd-chunked layers via mediaType and annotations", () => {
  const layers = [
    {
      digest: "sha256:aaa",
      size: 1000,
      mediaType: "application/vnd.oci.image.layer.v1.tar+zstd",
    },
    {
      digest: "sha256:bbb",
      size: 2000,
      mediaType: "application/vnd.oci.image.layer.v1.tar",
      annotations: {
        "io.github.containers.zstd-chunked.manifest-checksum": "sha256:xxx",
      },
    },
    {
      digest: "sha256:ccc",
      size: 500,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    },
  ];

  const result = analyzeManifestLayers(layers);
  assert.equal(result.totalBytes, 3500);
  assert.equal(result.totalLayers, 3);
  assert.equal(result.zstdLayers, 2);
  assert.equal(result.zstdBytes, 3000);
  assert.equal(result.gzipLayers, 1);
  assert.equal(result.gzipBytes, 500);
  assert.equal(result.compressionFormat, "mixed");
});

test("analyzeManifestLayers: detects pure zstd-chunked format", () => {
  const layers = [
    {
      digest: "sha256:aaa",
      size: 1000,
      mediaType: "application/vnd.oci.image.layer.v1.tar+zstd",
    },
    {
      digest: "sha256:bbb",
      size: 2000,
      mediaType: "application/vnd.oci.image.layer.v1.tar+zstd",
    },
  ];

  const result = analyzeManifestLayers(layers);
  assert.equal(result.compressionFormat, "zstd-chunked");
  assert.equal(result.zstdLayers, 2);
});

test("diffReleaseLayers: first release is marked as baseline with 0 reuse", () => {
  const currLayers = [
    {
      digest: "sha256:1",
      size: 1048576,
      mediaType: "application/vnd.oci.image.layer.v1.tar+zstd",
    },
    {
      digest: "sha256:2",
      size: 2097152,
      mediaType: "application/vnd.oci.image.layer.v1.tar+zstd",
    },
  ];

  const diff = diffReleaseLayers(null, currLayers);
  assert.equal(diff.isBaseline, true);
  assert.equal(diff.sharedLayers, 0);
  assert.equal(diff.sharedBytes, 0);
  assert.equal(diff.sharedMB, 0);
  assert.equal(diff.newLayers, 2);
  assert.equal(diff.downloadChurnBytes, 3145728);
  assert.equal(diff.downloadChurnMB, 3.0);
  assert.equal(diff.totalMB, 3.0);
  assert.equal(diff.reuseEfficiencyPct, 0);
});

test("diffReleaseLayers: identical releases achieve 100% reuse and 0 download churn", () => {
  const layers = [
    {
      digest: "sha256:1",
      size: 1048576,
      mediaType: "application/vnd.oci.image.layer.v1.tar+zstd",
    },
    {
      digest: "sha256:2",
      size: 2097152,
      mediaType: "application/vnd.oci.image.layer.v1.tar+zstd",
    },
  ];

  const diff = diffReleaseLayers(layers, layers);
  assert.equal(diff.isBaseline, false);
  assert.equal(diff.sharedLayers, 2);
  assert.equal(diff.newLayers, 0);
  assert.equal(diff.sharedBytes, 3145728);
  assert.equal(diff.downloadChurnBytes, 0);
  assert.equal(diff.downloadChurnMB, 0);
  assert.equal(diff.reuseEfficiencyPct, 100);
});

test("diffReleaseLayers: partial overlap correctly partitions shared vs churn bytes", () => {
  const prevLayers = [
    { digest: "sha256:base", size: 5242880 }, // 5 MB base layer
    { digest: "sha256:app-v1", size: 1048576 }, // 1 MB app layer
  ];
  const currLayers = [
    { digest: "sha256:base", size: 5242880 }, // 5 MB reused
    { digest: "sha256:app-v2", size: 2097152 }, // 2 MB new
  ];

  const diff = diffReleaseLayers(prevLayers, currLayers);
  assert.equal(diff.isBaseline, false);
  assert.equal(diff.sharedLayers, 1);
  assert.equal(diff.newLayers, 1);
  assert.equal(diff.totalLayers, 2);
  assert.equal(diff.sharedBytes, 5242880);
  assert.equal(diff.sharedMB, 5.0);
  assert.equal(diff.downloadChurnBytes, 2097152);
  assert.equal(diff.downloadChurnMB, 2.0);
  assert.equal(diff.totalMB, 7.0);
  // 5 / 7 = 71.4%
  assert.equal(diff.reuseEfficiencyPct, 71.4);
});

test("diffReleaseLayers: disjoint layers result in 0% reuse and full download churn", () => {
  const prevLayers = [{ digest: "sha256:old", size: 1048576 }];
  const currLayers = [{ digest: "sha256:new", size: 2097152 }];

  const diff = diffReleaseLayers(prevLayers, currLayers);
  assert.equal(diff.reuseEfficiencyPct, 0);
  assert.equal(diff.sharedMB, 0);
  assert.equal(diff.downloadChurnMB, 2.0);
});

test("calculateReleaseChurn: processes ordered releases and computes sequential diffs", () => {
  const releases = [
    {
      tag: "v1.20260501",
      layers: [
        { digest: "sha256:l1", size: 1048576 },
        { digest: "sha256:l2", size: 1048576 },
      ],
    },
    {
      tag: "v2.20260502",
      layers: [
        { digest: "sha256:l1", size: 1048576 },
        { digest: "sha256:l3", size: 1048576 },
      ],
    },
  ];

  const churn = calculateReleaseChurn(releases);
  assert.equal(churn.length, 2);
  assert.equal(churn[0].isBaseline, true);
  assert.equal(churn[0].previousTag, null);
  assert.equal(churn[0].downloadChurnMB, 2.0);
  assert.equal(churn[0].reuseEfficiencyPct, 0);

  assert.equal(churn[1].isBaseline, false);
  assert.equal(churn[1].previousTag, "v1.20260501");
  assert.equal(churn[1].sharedMB, 1.0);
  assert.equal(churn[1].downloadChurnMB, 1.0);
  assert.equal(churn[1].reuseEfficiencyPct, 50.0);
});

test("extractDateFromTag: parses YYYYMMDD date strings accurately", () => {
  assert.equal(extractDateFromTag("stable-daily-20260606"), "2026-06-06");
  assert.equal(extractDateFromTag("latest.20260114"), "2026-01-14");
  assert.equal(extractDateFromTag("stable-20260531"), "2026-05-31");
});

test("datedTagKey: returns the YYYYMMDD stamp a tag carries", () => {
  assert.equal(datedTagKey("testing-20260927-08286da"), "20260927");
  assert.equal(datedTagKey("stable-daily-20260606"), "20260606");
  assert.equal(datedTagKey("testing"), "");
  assert.equal(datedTagKey(undefined), "");
});

test("compareTagsByDate: orders by date, then build time, then tag text", () => {
  const tags = [
    "testing-20260929-815ea44",
    "testing-20260927-f5f4053",
    "testing-20260929-362ea44",
    "testing-20260926-be64d10",
  ];
  // No timestamps available: the last resort is tag text, so the order is
  // stable across runs even though it is an approximation.
  assert.deepEqual([...tags].sort(compareTagsByDate), [
    "testing-20260926-be64d10",
    "testing-20260927-f5f4053",
    "testing-20260929-362ea44",
    "testing-20260929-815ea44",
  ]);

  // With build times, the same-day pair orders by *when it was built*, not by
  // how its short sha happens to sort. 362ea44 is the newer build even though
  // "3" < "8" — and diffReleaseLayers is directional, so this is the order
  // that decides which numbers the chart reports.
  const createdAt = {
    "testing-20260929-362ea44": "2026-09-29T18:04:11Z",
    "testing-20260929-815ea44": "2026-09-29T09:41:52Z",
  };
  assert.deepEqual(
    [...tags].sort((a, b) => compareTagsByDate(a, b, createdAt)),
    [
      "testing-20260926-be64d10",
      "testing-20260927-f5f4053",
      "testing-20260929-815ea44",
      "testing-20260929-362ea44",
    ],
  );

  // A tie on both date and build time falls back to text rather than
  // depending on the input order.
  assert.equal(
    compareTagsByDate("testing-a", "testing-b", {
      "testing-a": "2026-09-29T00:00:00Z",
      "testing-b": "2026-09-29T00:00:00Z",
    }) < 0,
    true,
  );
});

test("compareTagsByDate: same-day tags without a build time rank after known ones", () => {
  // A cached crawl from before later same-day builds covers only some tags.
  // Unknown tags must rank consistently after known ones (a total order), not
  // be compared by tag text against some and by build time against others.
  const createdAt = {
    "testing-20261003-f7c24b2": "2026-10-03T18:04:11Z",
    "testing-20261003-b0d302a": "2026-10-03T09:41:52Z",
  };
  const tags = [
    "testing-20261003-0000001",
    "testing-20261003-f7c24b2",
    "testing-20261002-zzzzzzz",
    "testing-20261003-b0d302a",
    "testing-20261003-aaaaaaa",
  ];
  const expected = [
    "testing-20261002-zzzzzzz",
    "testing-20261003-b0d302a",
    "testing-20261003-f7c24b2",
    "testing-20261003-0000001",
    "testing-20261003-aaaaaaa",
  ];
  const cmp = (a, b) => compareTagsByDate(a, b, createdAt);
  assert.deepEqual([...tags].sort(cmp), expected);
  assert.deepEqual([...tags].reverse().sort(cmp), expected);
  assert.equal(
    cmp("testing-20261003-0000001", "testing-20261003-f7c24b2") > 0,
    true,
  );
  assert.equal(
    cmp("testing-20261003-f7c24b2", "testing-20261003-0000001") < 0,
    true,
  );
});

test("compareTagsByDate: an undated floating tag sorts last, not first", () => {
  // `stable` is Bluefin's floating tag: it names whatever the newest manifest
  // is, so it is the end of the series. Sorting it first would make it the
  // baseline and turn the first delta into a backwards diff.
  const tags = [
    "stable",
    "stable-daily-20260604",
    "stable-daily-20260530",
    "stable-daily-20260531",
  ];
  assert.deepEqual([...tags].sort(compareTagsByDate), [
    "stable-daily-20260530",
    "stable-daily-20260531",
    "stable-daily-20260604",
    "stable",
  ]);

  // Two undated tags still order deterministically by text.
  assert.equal(compareTagsByDate("stable", "testing") < 0, true);
  assert.equal(compareTagsByDate("stable", "stable"), 0);
});

test("selectDatedTags: keeps only matching dated tags, oldest-first, trimmed to limit", () => {
  const tags = [
    "testing",
    "sha256-abc123.sig",
    "7d4cd58a9d366c1a5510b4632c7510a42665603",
    "testing-20260927-08286da",
    "testing-20260926-be64d10",
    "testing-20260929-815ea44",
    "testing-20260928-ce09ef7",
  ];
  const selected = selectDatedTags(tags, {
    pattern: /^testing-\d{8}-[0-9a-f]{7,40}$/,
    limit: 3,
  });
  assert.deepEqual(selected, [
    "testing-20260927-08286da",
    "testing-20260928-ce09ef7",
    "testing-20260929-815ea44",
  ]);
});

test("selectDatedTags: dedupes, tolerates a short history, and rejects a bad spec", () => {
  const pattern = /^testing-\d{8}-[0-9a-f]{7,40}$/;
  const single = selectDatedTags(
    ["testing-20260927-08286da", "testing-20260927-08286da"],
    {
      pattern,
      limit: 14,
    },
  );
  assert.deepEqual(single, ["testing-20260927-08286da"]);

  assert.deepEqual(
    selectDatedTags(["testing", "stable"], { pattern, limit: 14 }),
    [],
  );

  // A missing pattern or a non-positive limit yields no series rather than the
  // whole tag list.
  assert.deepEqual(selectDatedTags(["testing-20260927-08286da"], {}), []);
  assert.deepEqual(
    selectDatedTags(["testing-20260927-08286da"], { pattern, limit: 0 }),
    [],
  );
  assert.deepEqual(selectDatedTags(null, { pattern, limit: 14 }), []);
});

test("selectDatedTags: a dated series produces a delta, not a lone baseline", () => {
  // The regression this guards: one tag in the series means every chart on
  // /analytics has a baseline and nothing to diff against.
  const series = selectDatedTags(
    [
      "testing-20260927-08286da",
      "testing-20260928-ce09ef7",
      "testing-20260929-815ea44",
    ],
    { pattern: /^testing-\d{8}-[0-9a-f]{7,40}$/, limit: 14 },
  );
  const churn = calculateReleaseChurn(
    series.map((tag, i) => ({
      tag,
      layers: [
        { digest: "sha256:shared", size: 10 * 1024 * 1024 },
        { digest: `sha256:new-${i}`, size: 5 * 1024 * 1024 },
      ],
    })),
  );
  assert.equal(churn.length, 3);
  assert.equal(churn.filter((c) => c.isBaseline).length, 1);
  const delta = churn[churn.length - 1];
  assert.equal(delta.isBaseline, false);
  assert.equal(delta.previousTag, "testing-20260928-ce09ef7");
  assert.equal(delta.date, "2026-09-29");
  assert.equal(delta.downloadChurnMB, 5.0);
  assert.equal(delta.reuseEfficiencyPct, 66.7);
});

test("selectDatedTags: a floating tag never joins a dated series", () => {
  // The regression: the SBOM cache contributes the floating `testing` tag, and
  // it names the same manifest as the newest dated tag. Letting it in appended
  // a duplicate release dated *today* by extractDateFromTag — 0 MB churn, or a
  // backwards delta depending on where it landed.
  const pattern = /^testing-\d{8}-[0-9a-f]{7,40}$/;
  const selected = selectDatedTags(
    [
      "testing",
      "testing-20260928-ce09ef7",
      "testing-20260929-362ea44",
      "latest",
    ],
    { pattern, limit: 14 },
  );
  assert.deepEqual(selected, [
    "testing-20260928-ce09ef7",
    "testing-20260929-362ea44",
  ]);
});

test("selectDatedTags: limit applies to the merged list, seeds included", () => {
  // Seeds are a fallback for a failed listing, not a way to exceed the limit:
  // a seed older than the discovered window must not push the chart past it.
  const pattern = /^testing-\d{8}-[0-9a-f]{7,40}$/;
  const seeds = ["testing-20260926-34c0f13", "testing-20260926-be64d10"];
  const merged = [
    ...new Set([
      ...seeds,
      ...selectDatedTags(
        [
          "testing-20260927-08286da",
          "testing-20260928-ce09ef7",
          "testing-20260929-362ea44",
        ],
        { pattern, limit: 2 },
      ),
    ]),
  ]
    .sort(compareTagsByDate)
    .slice(-2);
  assert.deepEqual(merged, [
    "testing-20260928-ce09ef7",
    "testing-20260929-362ea44",
  ]);
});

test("fetchGhcrTagCreatedAt: warns and returns {} on the no-token path (#1434)", async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  const savedGh = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    let warned = false;
    const origWarn = console.warn;
    console.warn = () => {
      warned = true;
    };
    try {
      const result = await fetchGhcrTagCreatedAt("ublue-os", "bluefin");
      assert.deepEqual(result, {});
      assert.equal(warned, true, "expected a warning on the no-token path");
    } finally {
      console.warn = origWarn;
    }
  } finally {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
    if (savedGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGh;
  }
});

// ── build-time sidecar cache (regression: #1471) ────────────────────────────
// A same-day chain only orders chronologically when build times are available.
// The packages API is rate-limited and all-or-nothing, so a failed run used to
// return {} and the whole chain flapped to non-chronological tag text. The
// sidecar cache keeps the previous complete crawl so ordering stays stable.

function writeTempCache(tags, { ageHours = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-createdat-"));
  const file = path.join(dir, "createdat.json");
  const stamp = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  fs.writeFileSync(
    file,
    JSON.stringify({ generatedAt: stamp, tags }, null, 2) + "\n",
    "utf8",
  );
  return file;
}

const nativeFetch = global.fetch;

function mockFetch(responses) {
  // responses: array of { ok, status, json, link } or a function(url)
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const idx = Math.min(calls.length - 1, responses.length - 1);
    const r = typeof responses === "function" ? responses(url) : responses[idx];
    return {
      ok: r.ok !== false && r.status !== 403 && r.status !== 500,
      status: r.status || 200,
      url,
      headers: {
        get: (h) => (h.toLowerCase() === "link" ? r.link || null : null),
      },
      json: async () => r.body,
    };
  };
  return calls;
}

test("loadCreatedAtCache: returns {} for a missing, undated, or stale file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-createdat-"));
  try {
    assert.deepEqual(
      loadCreatedAtCache(
        "projectbluefin",
        "utah",
        path.join(dir, "missing.json"),
      ),
      {},
    );
    const undated = path.join(dir, "undated.json");
    fs.writeFileSync(undated, JSON.stringify({ tags: { a: "b" } }), "utf8");
    assert.deepEqual(loadCreatedAtCache("projectbluefin", "utah", undated), {});
    const stale = writeTempCache({ a: "b" }, { ageHours: 200 });
    assert.deepEqual(loadCreatedAtCache("projectbluefin", "utah", stale), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCreatedAtCache: a cache older than the 24h churn window is still fresh", () => {
  // Regression anchor for #1472: the sidecar ages on its own 7-day window
  // (CREATED_AT_CACHE_MAX_HOURS), independent of the 24h churn-payload window.
  // A daily cron starts late on rate-limited runs (gaps past 24h observed), so
  // a 100h-old complete crawl must still be used, not treated as stale.
  const file = writeTempCache(
    { "testing-20261003-ccccccc": "2026-10-03T01:00:00Z" },
    { ageHours: 100 },
  );
  try {
    assert.deepEqual(loadCreatedAtCache("projectbluefin", "utah", file), {
      "testing-20261003-ccccccc": "2026-10-03T01:00:00Z",
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("loadCreatedAtCache: returns {} only past the 7-day sidecar window", () => {
  const file = writeTempCache(
    { "testing-20261003-ddddddd": "2026-10-03T01:00:00Z" },
    { ageHours: 200 },
  );
  try {
    assert.deepEqual(loadCreatedAtCache("projectbluefin", "utah", file), {});
  } finally {
    fs.rmSync(file, { force: true });
  }
});
test("loadCreatedAtCache: returns the tags of a fresh cache", () => {
  const file = writeTempCache({
    "testing-20261003-aaaaaaa": "2026-10-03T01:00:00Z",
  });
  try {
    assert.deepEqual(loadCreatedAtCache("projectbluefin", "utah", file), {
      "testing-20261003-aaaaaaa": "2026-10-03T01:00:00Z",
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("saveCreatedAtCache then loadCreatedAtCache round-trips", () => {
  const file = writeTempCache({});
  try {
    const tags = { "testing-20261003-bbbbbbb": "2026-10-03T02:00:00Z" };
    saveCreatedAtCache("projectbluefin", "utah", tags, file);
    assert.deepEqual(loadCreatedAtCache("projectbluefin", "utah", file), tags);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("fetchGhcrTagCreatedAt: keeps the previous crawl when the API fails (#1471)", async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const cached = {
    "testing-20261003-f7c24b2": "2026-10-03T09:41:52Z",
    "testing-20261003-b0d302a": "2026-10-03T18:04:11Z",
  };
  const file = writeTempCache(cached);
  const calls = mockFetch(() => ({ status: 403, body: [] }));
  try {
    const result = await fetchGhcrTagCreatedAt("projectbluefin", "utah", file);
    // Falls back to the cached crawl instead of returning {} — same-day order
    // stays chronological and does not flap to tag text.
    assert.deepEqual(result, cached);
    // A failed crawl is never written, so the cache still holds the good run.
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(after.tags, cached);
    // It still tried the API — this is a fallback, not a skip.
    assert.ok(calls.length > 0);
  } finally {
    global.fetch = nativeFetch;
    fs.rmSync(file, { force: true });
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  }
});

test("fetchGhcrTagCreatedAt: persists a complete crawl to the cache", async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const file = writeTempCache({});
  const calls = mockFetch([
    {
      status: 200,
      link: '<https://api.github.com/next>; rel="next"',
      body: [
        {
          created_at: "2026-10-03T09:41:52Z",
          metadata: { container: { tags: ["testing-20261003-f7c24b2"] } },
        },
      ],
    },
    {
      status: 200,
      link: null,
      body: [
        {
          created_at: "2026-10-03T18:04:11Z",
          metadata: { container: { tags: ["testing-20261003-b0d302a"] } },
        },
      ],
    },
  ]);
  try {
    const result = await fetchGhcrTagCreatedAt("projectbluefin", "utah", file);
    assert.deepEqual(result, {
      "testing-20261003-f7c24b2": "2026-10-03T09:41:52Z",
      "testing-20261003-b0d302a": "2026-10-03T18:04:11Z",
    });
    // Two pages were crawled, and the complete crawl was cached.
    assert.equal(calls.length, 2);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(after.tags, result);
  } finally {
    global.fetch = nativeFetch;
    fs.rmSync(file, { force: true });
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  }
});

// ── regression anchor: #1471 same-day ordering ──────────────────────────────
// The reported bug is that same-day testing tags flip between build-time order
// and tag-text order run-to-run because build times were unavailable. This
// proves the tie-break is build time (not tag text); the cache test above proves
// build times are now reliably returned on a flaky run, so this order holds.

test("selectDatedTags: orders same-day tags by build time, not tag text (#1471)", () => {
  // Tag-text order puts aaaaaaa before bbbbbbb; build-time order is the
  // OPPOSITE, so this can only pass if the tie-break is build time.
  const tags = ["testing-20261003-aaaaaaa", "testing-20261003-bbbbbbb"];
  const series = {
    pattern: /^testing-\d{8}-[0-9a-f]{7}$/,
    limit: 5,
  };
  const createdAt = {
    "testing-20261003-aaaaaaa": "2026-10-03T18:00:00Z",
    "testing-20261003-bbbbbbb": "2026-10-03T09:00:00Z",
  };
  assert.deepEqual(selectDatedTags(tags, series, createdAt), [
    "testing-20261003-bbbbbbb",
    "testing-20261003-aaaaaaa",
  ]);
});

test("fetchGhcrTagCreatedAt: an empty successful crawl keeps the previous cache", async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const cached = { "testing-20261003-f7c24b2": "2026-10-03T09:41:52Z" };
  const file = writeTempCache(cached);
  mockFetch([{ status: 200, link: null, body: [] }]);
  try {
    const result = await fetchGhcrTagCreatedAt("projectbluefin", "utah", file);
    assert.deepEqual(result, cached);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(after.tags, cached);
  } finally {
    global.fetch = nativeFetch;
    fs.rmSync(file, { force: true });
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  }
});

// ── per-package sidecar keying (regression-style finding: #1475) ───────────
// The cache was a single shared path. Only Utah carries a `tagSeries` today,
// but the design lands a global file now and we would have discovered the
// collision the day Blueclair or Dakota added one: each run overwrites the
// other's crawl, and a later failed load returns another package's map. The fix
// keys the cache by `${org}.${pkg}`. These tests assert the keying.

test("createdAtCachePath: derives a per-package filename under static/data", () => {
  // The org/package segment is lowercased and URL-encoded so an odd name
  // (e.g. one with a dot) cannot collide with a sibling's filename or escape
  // the data directory.
  assert.equal(
    createdAtCachePath("projectbluefin", "utah"),
    path.join(
      path.join(__dirname, "..", "static", "data"),
      "update-churn-createdat.projectbluefin.utah.json",
    ),
  );
  assert.equal(
    createdAtCachePath("ublue-os", "bluefin"),
    path.join(
      path.join(__dirname, "..", "static", "data"),
      "update-churn-createdat.ublue-os.bluefin.json",
    ),
  );
  // Different packages must produce different files (no shared key means no
  // overwrite). This is the property #1475 asks the design to have.
  assert.notEqual(
    createdAtCachePath("projectbluefin", "utah"),
    createdAtCachePath("projectbluefin", "dakota"),
    "Utah and Dakota must not share a sidecar file — a second `tagSeries` would otherwise overwrite the other's crawl",
  );
  assert.notEqual(
    createdAtCachePath("ublue-os", "bluefin"),
    createdAtCachePath("projectbluefin", "bluefin"),
    "Cross-org same-package names must not share a sidecar file",
  );
});

test("loadCreatedAtCache + saveCreatedAtCache: per-package files do not collide (#1475)", () => {
  // Two packages, two files, no cross-contamination. The old design would
  // have written both crawls to a single shared file and lost one. The
  // property we assert is independence: Utah's data is in Utah's file, and
  // Bluefin's data is in Bluefin's file, and writing one does not touch the
  // other.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-createdat-"));
  const utahFile = path.join(
    dir,
    "update-churn-createdat.projectbluefin.utah.json",
  );
  const bluefinFile = path.join(
    dir,
    "update-churn-createdat.ublue-os.bluefin.json",
  );
  try {
    const utahTags = {
      "testing-20261003-f7c24b2": "2026-10-03T09:41:52Z",
    };
    const bluefinTags = {
      "stable-daily-20261003-aaaaaaa": "2026-10-03T18:00:00Z",
    };
    // Write in opposite order from the reads so an implementation that
    // accidentally overwrites its peer would surface as a stale-tag failure.
    saveCreatedAtCache("ublue-os", "bluefin", bluefinTags, bluefinFile);
    saveCreatedAtCache("projectbluefin", "utah", utahTags, utahFile);
    // Each file holds its own crawl.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(utahFile, "utf8")).tags,
      utahTags,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(bluefinFile, "utf8")).tags,
      bluefinTags,
    );
    // And the API round-trip on each file returns the right crawl.
    assert.deepEqual(
      loadCreatedAtCache("projectbluefin", "utah", utahFile),
      utahTags,
    );
    assert.deepEqual(
      loadCreatedAtCache("ublue-os", "bluefin", bluefinFile),
      bluefinTags,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchGhcrTagCreatedAt: a Blueclair crawl does not overwrite Utah's cache (#1475)", async () => {
  // Regression-style finding from the #1472 review. The design point is: the
  // same script can fetch multiple `tagSeries` packages in one run, and a
  // single shared sidecar file would have a Blueclair fetch overwrite Utah's
  // yesterday. Here Utah is cached and Blueclair fails; Utah's cache must
  // survive, and Blueclair's own cache (if a successful run had happened
  // before) must not have leaked into this one.
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const utahFile = writeTempCache({
    "testing-20261003-f7c24b2": "2026-10-03T09:41:52Z",
  });
  // Distinct directory so a regression to a shared path is observable.
  const bluefinDir = fs.mkdtempSync(path.join(os.tmpdir(), "churn-bluefin-"));
  const bluefinFile = path.join(
    bluefinDir,
    "update-churn-createdat.ublue-os.bluefin.json",
  );
  mockFetch(() => ({ status: 403, body: [] }));
  try {
    // A failed Blueclair crawl must not touch Utah's file at all.
    await fetchGhcrTagCreatedAt("ublue-os", "bluefin", bluefinFile);
    assert.deepEqual(
      loadCreatedAtCache("projectbluefin", "utah", utahFile),
      { "testing-20261003-f7c24b2": "2026-10-03T09:41:52Z" },
      "Utah's sidecar must survive an unrelated Blueclair API failure",
    );
    // The Blueclair file was not created (no successful crawl to write).
    assert.equal(fs.existsSync(bluefinFile), false);
  } finally {
    global.fetch = nativeFetch;
    fs.rmSync(utahFile, { force: true });
    fs.rmSync(bluefinDir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  }
});
