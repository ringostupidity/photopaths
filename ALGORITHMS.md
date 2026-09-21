# Photopath: Algorithm and Route-Weighting Report

This report describes the current Node.js implementation, including the OSM fallback added to route scoring. It documents implemented behavior, not proposed features from the original project concept. The numerical constants are prototype design choices, not scientifically calibrated lighting standards.

## 1. System overview

Photopath obtains candidate walking routes from an external routing service, divides their geometry into short sections, assigns lighting scores where evidence exists, and ranks the routes according to the user's preference.

The processing sequence is:

```text
Starting point + destination
    → Candidate walking routes
    → Load camera measurements, community reports, and OSM lighting
    → Divide each route into sections no longer than approximately 50 m
    → Prefer recent nighttime camera measurements
    → Otherwise estimate from nearby OSM lighting infrastructure
    → Apply corroborated-report penalties
    → Calculate length-weighted scores and data coverage
    → Combine walking-time cost with darkness/uncertainty cost
    → Recommend the route with the lowest combined cost
```

Photopath does not implement its own street-network shortest-path solver. Its main routing contribution is the lighting analysis and reranking of the alternatives returned by the provider. A better-lit path absent from those alternatives cannot be selected by this algorithm.

There are three different kinds of numerical weighting:

| Weight                                             | Purpose                                | Adjustable by the user? |
| -------------------------------------------------- | -------------------------------------- | ----------------------- |
| Camera score: 70% brightness, 30% non-dark pixels  | Describe the captured image            | No                      |
| Measurement recency: seven-day half-life           | Reduce the influence of older readings | No                      |
| Route preference: time versus darkness/uncertainty | Select among candidate walks           | Yes, through the slider |

The slider does not change camera scores or OSM constants. It changes the route-selection cost.

## 2. Camera image analysis

Implementation: [public/lighting.js](public/lighting.js) and [public/measure.js](public/measure.js).

### 2.1 Capture and preprocessing

The browser requests the rear-facing camera when available. At capture, it obtains a fresh browser location and rejects a reported GPS accuracy greater than 100 m. The captured image is resized to 320 pixels wide, preserving aspect ratio, before pixel analysis.

This is whole-frame analysis: the algorithm does not segment the roadway, identify streetlights in an image, recognize objects, or use a trained computer-vision model. The measurement image remains in the browser; only calculated metrics and coordinates are submitted.

### 2.2 Per-pixel brightness

For each pixel, the code computes:

```text
yᵢ = (0.2126 × Rᵢ + 0.7152 × Gᵢ + 0.0722 × Bᵢ) / 255
```

Each RGB channel is between 0 and 255, so `yᵢ` lies between 0 and 1. Alpha is ignored. The green channel contributes most strongly.

The implementation applies these coefficients directly to browser RGB values. It does not linearize sRGB first, correct camera exposure, or convert the result to physical luminance or lux. “Brightness” therefore means a relative image metric.

For `N` pixels:

```text
mean brightness B = 100 × (Σ yᵢ / N)
```

### 2.3 Dark-pixel fraction

A pixel counts as very dark when `yᵢ < 0.15`.

```text
dark fraction F = number of very dark pixels / N
```

`F` ranges from 0 to 1. The interface displays it as a percentage.

### 2.4 Contrast

Contrast is the population standard deviation of pixel brightness:

```text
contrast = 100 × sqrt(max(0, Σ(yᵢ²)/N − (Σyᵢ/N)²))
```

The `max(0, ...)` avoids a negative value caused by floating-point error. Contrast is displayed and stored, but it does not affect either the camera score or route ranking.

### 2.5 Camera visibility score

```text
image score = round(clamp(0.7 × B + 30 × (1 − F), 0, 100))
```

The brightness term contributes at most 70 points. The proportion of pixels that are not very dark contributes at most 30 points.

For example, if average brightness is 50 and 20% of pixels are very dark:

```text
score = round(0.7 × 50 + 30 × 0.8)
      = round(35 + 24)
      = 59
```

Both terms come from the same image and are correlated; they are not independent sensor readings. A very small bright area can affect the average, although the dark-pixel term also reflects the remaining dark image area.

The server recalculates the score from submitted brightness and dark fraction rather than accepting a submitted score directly. It does not receive the image, so it cannot independently verify those submitted metrics.

## 3. Nighttime classification and measurement validity

Implementation: [src/app.js](src/app.js), [public/measure.js](public/measure.js), and the installed SunCalc dependency.

The server uses SunCalc to calculate solar altitude at the supplied coordinates and the server's current time:

```text
is_night = solar altitude < −6°
```

The boundary is based on civil twilight, not simply a fixed clock time. SunCalc derives solar coordinates from the date, computes the local hour angle, and calculates altitude using latitude, solar declination, and hour angle:

```text
altitude = asin(sin(latitude) × sin(declination)
             + cos(latitude) × cos(declination) × cos(hour angle))
```

SunCalc performs the astronomical calculations; Photopath supplies location/time and applies the threshold. The app does not model artificial lighting changes over the course of the night.

Daytime readings remain in the database but do not contribute to nighttime route scoring. The browser requires a capture to be shared within two minutes. This two-minute check and the GPS-accuracy check are browser checks; the API does not receive a capture timestamp or GPS-accuracy field. The stored timestamp and nighttime classification use submission time.

## 4. Geocoding and candidate route generation

Implementation: [src/providers.js](src/providers.js), [src/app.js](src/app.js), and [public/map.js](public/map.js).

Place search sends the user's explicit query to Nominatim and requests up to five matches. The browser lets the user select a match. Photopath does not calculate its own search relevance score or perform automatic searches on every keystroke.

Walking routes come from:

- OpenRouteService's `foot-walking` endpoint when an API key is configured, requesting a target of three alternatives.
- Otherwise, the FOSSGIS OSRM foot-profile server, with alternatives requested.

The number and geometry of alternatives depend on the provider. The code does not establish which internal graph-search algorithm a hosted provider is currently using; claims that Photopath itself runs A*, Dijkstra, or another network solver would be inaccurate.

The app accepts start/end separation from 20 m through 15 km. It rejects returned route distances over 30 km, geometry other than a LineString, or a route with more than 15,000 geometry points. Provider durations are retained in seconds for ranking. Minutes are rounded for display.

## 5. Geographic distance, retrieval, and route sampling

Implementation: [src/scoring.js](src/scoring.js), [src/app.js](src/app.js), and [src/store.js](src/store.js).

### 5.1 Haversine distance

Distances between geographic points use a spherical Earth approximation with radius `R = 6,371,000 m`. Latitude `φ` and longitude `λ` are converted to radians:

```text
h = sin²((φ₂ − φ₁)/2)
  + cos(φ₁) × cos(φ₂) × sin²((λ₂ − λ₁)/2)

distance = 2R × asin(sqrt(min(1, h)))
```

This is straight-line surface distance, not walking distance. It is used to measure geometry edges and proximity to readings/reports. Walking distance and walking time come from the routing provider.

### 5.2 Retrieving the relevant area

The app combines geometry points from all alternatives, finds the midpoint of their latitude/longitude bounds, and sets a search radius equal to the farthest geometry point from that center plus 100 m.

It concurrently requests nearby measurements, nearby reports, and OSM lighting for that area. Redis `GEOSEARCH` returns records by increasing distance from the area center. Each community collection returns at most 500 records, with a 501st result used to detect truncation. OSM route queries allow 2,000 lamps and 2,000 tagged ways; the optional map overlay allows 500 of each.

Data limits are disclosed. Because the community limit is applied before age filtering, old nearby records can occupy slots otherwise useful for recent data in a dense database. OSM output is not explicitly sorted by distance from the route. Truncated results can therefore reduce coverage.

### 5.3 Section sampling

For each adjacent pair of geometry coordinates, the Haversine edge length `L` determines the number of sections:

```text
sections on edge n = max(1, ceil(L / 50))
section length ℓ = L / n
section midpoint fraction fⱼ = (j + 0.5) / n
```

The midpoint is calculated by linear interpolation of latitude and longitude. Thus each nonzero section represents at most approximately 50 m, and its midpoint is used for evidence matching. This is local linear interpolation, not geodesic interpolation or exact road snapping.

## 6. Combining camera measurements over time

Implementation: [src/scoring.js](src/scoring.js).

A camera reading is eligible when it is marked nighttime and its age is at least zero but strictly less than 30 days. For each section, eligible readings within 60 m of the midpoint are collected.

Each reading receives an exponential recency weight:

```text
wᵢ = 2^(−ageᵢ / 7 days)
```

| Reading age      | Relative weight |
| ---------------- | --------------: |
| Just submitted   |               1 |
| 7 days           |             0.5 |
| 14 days          |            0.25 |
| 21 days          |           0.125 |
| 28 days          |          0.0625 |
| 30 days or older |        Excluded |

The section's initial camera score is:

```text
camera section score = Σ(wᵢ × scoreᵢ) / Σwᵢ
```

Example: a new reading of 80 and a seven-day-old reading of 20 produce `(80 × 1 + 20 × 0.5) / 1.5 = 60`.

There is no additional distance weighting inside the 60 m radius. A reading 5 m away and one 55 m away have the same weight if their ages match. There is also no minimum reading count, outlier rejection, device calibration, or contributor-quality weighting. A single eligible camera reading takes precedence over OSM estimates. Its age reduces its weight relative to other readings, but does not lower its score when it is the only reading.

## 7. OSM lighting estimation

Implementation: [src/osm-estimates.js](src/osm-estimates.js).

OSM is used only when a section has no eligible nearby camera readings. The app reads individual `highway=street_lamp` nodes and highway ways with a `lit` tag.

### 7.1 Fixed infrastructure scores

| OSM evidence                                      | Initial estimate |
| ------------------------------------------------- | ---------------: |
| Matching way with `lit=yes`                       |               70 |
| Matching way with `lit=24/7`                      |               70 |
| Matching way with `lit=no`                        |               20 |
| Matching way with `lit=limited`                   |               50 |
| Matching way with `lit=automatic`                 |               60 |
| No matching supported way, but a lamp within 35 m |               60 |
| No usable evidence                                | Unknown (`null`) |

These are fixed heuristic scores, not values supplied by OSM and not learned from observations. `limited` and `automatic` do not cause the app to evaluate a lighting schedule. Unrecognized `lit` values are skipped during way matching; a nearby lamp may still provide the fallback estimate.

### 7.2 Matching a route section to an OSM way

Each way is decomposed into adjacent coordinate pairs. Coordinates are projected into a local plane around the route-section midpoint:

```text
x metres = longitude difference × 111195 × cos(midpoint latitude)
y metres = latitude difference × 111195
```

The algorithm first rejects a segment whose axis-aligned bounds fall entirely outside a 20 m neighborhood along either coordinate axis. It then checks whether the route edge and OSM segment have compatible directions:

```text
alignment = abs(dot(route direction, OSM direction))
            / (route length × OSM segment length)

accept direction if alignment ≥ 0.7
```

The absolute value permits either direction along a road. The threshold corresponds to an angular difference of at most approximately 45.6° from parallel or antiparallel, reducing matches to perpendicular crossings.

For each remaining segment, with endpoint vectors `a` and `b` measured from the midpoint and `v = b − a`, the closest point is found by projection:

```text
t = clamp(−dot(a, v) / dot(v, v), 0, 1)
closest point = a + t × v
distance to segment = length(closest point)
```

The nearest qualifying segment within 20 m supplies the estimate. Equal-distance matches are resolved by the later segment in iteration order because the comparison uses `<=`. This is geometric matching, not topological matching against the routing service's road IDs.

A matching supported way takes priority over lamp proximity, including a way tagged `lit=no`. If no such way exists, any lamp within 35 m provides 60. Multiple lamps do not raise this score: the current algorithm checks presence, not lamp density, intensity, or distribution.

## 8. Report verification and lighting penalties

Implementation: [src/store.js](src/store.js) and [src/scoring.js](src/scoring.js).

New reports start unverified with zero confirmations and zero repair votes. The verification procedure runs atomically in Redis:

1. Find the report and reject an unknown ID.
2. Reject the report's author.
3. Add the reviewer's anonymous owner ID to a Redis set; reject it if already present.
4. Increment either confirmations or repair votes.
5. At two repair votes, mark the report `community_resolved`; otherwise, at two confirmations, mark it `corroborated`.

One browser identity gets one vote per report across both actions. It cannot confirm and later cast a repair vote for the same report. Resolution takes precedence when both thresholds are met. This verifies distinct browser identities, not distinct people, and does not constitute official repair verification.

For scoring, reports must be unresolved, under 30 days old, and within 60 m of the section midpoint. The code checks the age upper bound for reports; unlike measurement filtering, it does not explicitly reject negative ages, although the submission endpoint assigns timestamps itself.

If `k` nearby active reports have at least two confirmations:

```text
penalty = min(20, 10 × k)
adjusted section score = max(0, initial section score − penalty)
```

This affects either camera-based or OSM-based sections. A report cannot create a lighting score where no other evidence exists. Report type and the number of confirmations beyond two do not change the penalty. There is no report recency decay before the 30-day cutoff.

The displayed report count includes all unique nearby active reports, including unverified ones; it is not the number that actually caused penalties.

## 9. Route aggregation, provenance, and coverage

Implementation: [src/scoring.js](src/scoring.js).

Let `ℓⱼ` be section length and `sⱼ` its adjusted lighting score. Let `K` contain sections with a known score:

```text
total length L = Σ all ℓⱼ
covered length Lₖ = Σ over K ℓⱼ
covered score S = round(Σ over K (ℓⱼ × sⱼ) / Lₖ)
coverage c = Lₖ / L
```

Long sections therefore influence the route score in proportion to their represented distance. More geometry vertices do not, by themselves, give a location more weight.

Camera-covered and OSM-covered lengths are recorded separately. A section belongs to only one source category. The API returns:

| Field               | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `covered_score`     | Rounded average across camera and OSM sections with evidence                     |
| `measured_score`    | Rounded average across camera-based sections only, after report penalties        |
| `coverage`          | Rounded percentage of total length with either source                            |
| `measured_coverage` | Rounded percentage of total length using camera readings                         |
| `osm_coverage`      | Rounded percentage of total length using OSM                                     |
| `score`             | `covered_score` only if the unrounded coverage is at least 60%; otherwise `null` |
| `source`            | `camera`, `osm`, `mixed`, or `unknown`                                           |
| `sample_count`      | Count of unique camera readings used anywhere along the route                    |

If 400 m scores 60, 300 m scores 70, and 300 m is unknown:

```text
coverage = 700 / 1000 = 70%
covered score = round((400 × 60 + 300 × 70) / 700) = 64
overall displayed score = 64, because 70% ≥ 60%
```

Unknown sections are excluded from that average, but are penalized during ranking. A zero score is valid evidence and counts as covered; it is different from `null`.

Aggregation uses unrounded section scores. Individual section scores are rounded in the response for display. The 60% eligibility test uses unrounded coverage, while returned percentages are rounded independently. Consequently, a displayed 60% can occasionally correspond to slightly less than 60% internally, and the two displayed source percentages may not sum exactly to displayed total coverage.

## 10. Exactly how the lighting-weight slider works

Implementation: `rankRoutes` in [src/scoring.js](src/scoring.js), with equivalent current-response ranking in `rankLocally` in [public/map.js](public/map.js).

### 10.1 Inputs

For each candidate route:

- `t` is its provider-reported duration in seconds.
- `t_min` is the shortest duration among the returned routes.
- `S` is its rounded `covered_score`, from 0 to 100.
- `c` is its returned rounded coverage percentage divided by 100.
- `w` is the slider position divided by 100, from 0 to 1; the default is 0.5.

### 10.2 Time cost

```text
T = t / t_min
```

The fastest route has `T = 1`. A route taking 20% longer has `T = 1.2`. This normalization preserves relative additional travel time, not additional minutes.

### 10.3 Darkness and uncertainty cost

```text
D = c × (1 − S / 100) + (1 − c)
```

The first term is the darkness of covered sections, scaled by their proportion of the route. The second term penalizes the fraction with missing data. The same expression simplifies to:

```text
D = 1 − c × S / 100
```

When no covered score exists, `D = 1`. This assigns maximum uncertainty cost without displaying unknown sections as measured darkness. For example, a score of 80 at 100% coverage gives `D = 0.2`; at 50% coverage it gives `D = 0.6`.

Camera and OSM evidence have equal numerical influence once they supply a section score. There is no additional confidence discount specifically for OSM evidence; source coverage is disclosed in the interface.

### 10.4 Combined cost

```text
route cost C = (1 − w) × T + w × D
```

The route with the lowest cost is recommended. Exact cost ties are broken by shorter duration. If both cost and duration match, stable sorting retains the existing order.

| Slider position | Formula             | Effect                                   |
| --------------- | ------------------- | ---------------------------------------- |
| 0, Fastest      | `C = T`             | Select by duration only                  |
| 25              | `C = 0.75T + 0.25D` | More emphasis on travel time             |
| 50, Balanced    | `C = 0.5T + 0.5D`   | Equal coefficients on the two cost terms |
| 75              | `C = 0.25T + 0.75D` | More emphasis on lighting/coverage       |
| 100, Brightest  | `C = D`             | Ignore duration except for ties          |

“Balanced” means equal coefficients; it does not guarantee equal practical influence. `T` starts at 1 and is not upper-bounded, while `D` ranges from 0 to 1. The relative differences among the available routes determine the actual tradeoff.

At the Brightest endpoint, the preferred route maximizes `c × S`, not necessarily `S` alone. Coverage can make a lower-scoring but well-documented route preferable to a high-scoring, poorly documented one.

### 10.5 Worked example and switching threshold

Assume two fully covered routes:

| Route |   Duration | Lighting score |        T |    D |
| ----- | ---------: | -------------: | -------: | ---: |
| A     | 18 minutes |             42 |        1 | 0.58 |
| B     | 21 minutes |             88 | 1.166667 | 0.12 |

Their costs are:

```text
C_A = (1 − w) × 1        + w × 0.58
C_B = (1 − w) × 1.166667 + w × 0.12
```

| Slider | Cost A | Cost B | Recommendation |
| ------ | -----: | -----: | -------------- |
| 0      | 1.0000 | 1.1667 | A              |
| 25     | 0.8950 | 0.9050 | A              |
| 50     | 0.7900 | 0.6433 | B              |
| 100    | 0.5800 | 0.1200 | B              |

For a slower route B with better darkness/coverage cost, define `ΔT = T_B − T_A` and `ΔD = D_A − D_B`. B becomes preferred when:

```text
w > ΔT / (ΔT + ΔD)
```

Here the threshold is approximately `0.265957`, or slider position 26.6. With integer slider positions, A wins at 26 and B wins at 27.

If B instead had only 50% coverage, its darkness/uncertainty cost would be `1 − 0.5 × 0.88 = 0.56`. At the balanced setting, its cost would be approximately `0.8633`, so A would win with `0.7900`.

### 10.6 Recommendation versus badges

The three route flags answer different questions:

- **Recommended:** first after sorting by combined cost.
- **Fastest:** duration equals the minimum returned duration; ties may produce multiple fastest routes.
- **Highest lighting estimate:** maximum non-null overall `score` among routes meeting the 60% threshold; ties may produce multiple flags.

The highest-estimate badge does not account for duration or differences in coverage above the threshold. It can therefore differ from the recommended route even with the slider at Brightest.

Routes under 60% coverage are still ranked using their available `covered_score` and uncertainty penalty; the threshold hides an overall score and prevents the highest-estimate badge, but does not remove them from recommendation.

Moving the slider reranks existing routes in the browser without downloading new route geometry or OSM data. Requesting a new comparison recomputes scores on the server. The server retains a `measured_score` fallback for older route objects; current responses provide `covered_score`, which the browser uses directly.

## 11. Supporting algorithms and controls

### Spatial storage and ownership

Redis stores JSON records in hashes, their locations in geospatial indexes, and their ownership references in sets. Writes use a transaction to update these indexes together. Atomic Lua scripts perform report review and ownership-checked deletion, preventing competing requests from bypassing those checks between separate reads and writes.

New browser identities use 32 cryptographically random bytes represented as 64 hexadecimal characters. The cookie is signed using the application's secret through cookie-parser. The database owner identifier is a SHA-256 hash of that random identity. Record IDs use Node's random UUID generator. Hashing is used for opaque identity linkage, not for lighting analysis. Public record responses omit the owner field.

### Provider throttling and caching

Each upstream service has a scheduling gate. Requests are assigned start slots at least 1,100 ms apart. At eight pending calls, additional calls are rejected. A slow earlier network call can still be active when the next scheduled call begins; the gate spaces starts rather than requiring each request to finish first.

Successful responses use an in-process cache:

| Data                     | Cache duration |
| ------------------------ | -------------- |
| Geocoding                | 24 hours       |
| Candidate route geometry | 5 minutes      |
| OSM lighting             | 1 hour         |

The shared cache stores at most 500 keys and deletes the oldest insertion when full. It is not a true least-recently-used cache: reading an entry does not move it to the end. Search keys are lowercased; OSM cache keys round latitude/longitude to three decimal places and also include radius and result limit. Route keys use endpoint coordinates. Route lighting scores are recalculated from the retrieved evidence; they are not stored in the geometry cache.

There are also in-memory application limits of 90 API requests per minute per client key, plus 12 contribution/deletion requests per minute. Route and geocoding POSTs are excluded from the second limit. These limits and provider gates are per running instance, not shared across all Vercel instances.

### Partial failures

Route scoring fetches measurements, reports, and OSM data with `Promise.allSettled`. Expected provider/database availability errors leave that source empty and add a warning while preserving the other sources. Missing camera data does not discard OSM estimates, and missing OSM data does not discard camera readings. Unknown sections remain unknown.

Upstream fetches have 20-second timeouts, Overpass queries request a 15-second execution timeout, and browser API calls have a 45-second timeout. Partial Overpass responses containing a remark are treated as failures rather than valid empty lighting data.

### Asynchronous interface state

Search, route, and area requests use generation counters. A response is applied only if its generation still matches the most recent request/state. Changing endpoints invalidates older route responses. This prevents a slower earlier response from replacing a newer route. Explicit map-picking state distinguishes selection of a start from selection of a destination; dragging a pin updates only its endpoint and clears stale routes.

### Report-photo preprocessing

Optional report photos are separate from camera measurement frames. The browser scales them to fit within 640 × 640 pixels without enlargement and encodes JPEG at quality 0.65. The server decodes accepted image data with Sharp, limits decoded input to 16 million pixels, resizes to fit 640 × 640, and re-encodes JPEG at quality 70, without preserving metadata. Uploaded report photos do not feed the lighting-score algorithm.

### Display classification and units

Scores 0–20 are labeled Very dark, 21–40 Dark, 41–60 Moderate, 61–80 Well lit, and 81–100 Very well lit. Unknown scores receive a no-data label. The map uses red, orange, yellow, and green; both upper categories use the same green. These boundaries affect labeling and coloring, not numeric ranking.

Distance formatting uses 1 mile = 1,609.344 m. Kilometre mode displays rounded metres below 1,000 m and one decimal place in kilometres above that. These display conversions do not change the ranking calculations.

## 12. Computational cost and limitations

If an image has `N` pixels, pixel analysis takes O(N) time and uses constant-size numeric accumulators in addition to the image buffer.

Let `P` be sampled route sections, `M` retrieved readings, `Q` retrieved reports, `G` OSM line segments, and `J` OSM lamps. Section scoring scans measurements and reports, then scans OSM evidence where needed. Its worst-case work is approximately O(P × (M + Q + G + J)), plus O(G) preprocessing. Sorting `K` candidate routes takes O(K log K). Current dataset caps bound much of this work, although they can also lower coverage.

The implementation does not include a trained prediction model, road-image segmentation, calibrated lux sensing, a continuous streetlight-density model, explicit barrier/occlusion analysis, learned coefficients, or a new lighting-aware road-network search. OSM matching can associate nearby parallel features; lamps can be blocked or broken; camera exposure and repeated contributions can bias readings. Unknown sections receive a conservative ranking penalty but are not proof that the street is dark.

The most accurate description of the implemented algorithm is: **Photopath ranks available walking routes using length-weighted lighting evidence, recent camera readings where available, OSM infrastructure estimates elsewhere, community-report penalties, and a user-controlled tradeoff between travel time and darkness/uncertainty.**

## 13. Source map

| Responsibility                                             | Implementation                               |
| ---------------------------------------------------------- | -------------------------------------------- |
| Pixel metrics, image score, score labels/colors            | [public/lighting.js](public/lighting.js)     |
| Capture, location accuracy, freshness and sharing          | [public/measure.js](public/measure.js)       |
| Solar classification, API validation, route-area retrieval | [src/app.js](src/app.js)                     |
| Distance, sampling, recency, aggregation, route cost       | [src/scoring.js](src/scoring.js)             |
| OSM geometric matching and fixed estimates                 | [src/osm-estimates.js](src/osm-estimates.js) |
| Geocoding, route providers, Overpass, gates and cache      | [src/providers.js](src/providers.js)         |
| Geospatial lookup, atomic verification and deletion        | [src/store.js](src/store.js)                 |
| Slider reranking, map state and stale-response controls    | [public/map.js](public/map.js)               |
| Browser location, photo resizing and unit formatting       | [public/common.js](public/common.js)         |

The report documents the current source; thresholds and formulas should be updated here whenever the implementation changes.
