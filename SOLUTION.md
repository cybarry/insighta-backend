# Insighta Labs+ System Optimization & Data Ingestion
**Stage 4B — Backend Engineering Track**

## 1. Query Performance Optimization
### Approach
To reduce query latency from database overhead to the low tens of milliseconds without introducing new database infrastructure, I implemented three strategies:
1. **In-Memory Caching (`lru-cache`)**: An internal, LRU (Least Recently Used) cache holds the results of frequent queries. This immediately intercepts duplicate searches and pagination lookups, yielding <5ms response times.
2. **Database Connection Pooling**: Configured the Knex PostgreSQL adapter with connection pooling (`min: 2, max: 20`) to manage connection overhead gracefully during high concurrency bursts.
3. **Targeted Composite Indices**: Dropped the overly broad, 7-column index and introduced targeted composite indices based on expected query intersections (`idx_gender_country`, `idx_gender_age_group`, etc.). 

### Performance Comparison (Mock Results)
| Query Scenario | Before (Stage 4A) | After (Stage 4B) | Improvement % |
|---|---|---|---|
| Initial lookup: `?gender=female&country_id=NG` | 380 ms | 120 ms | 68% (Index hit) |
| Repeated lookup: `?gender=female&country_id=NG` | 370 ms | 4 ms | 98% (Cache hit) |
| NLP Parser: `?q=women in nigeria` | 410 ms | 6 ms | 98% (Cache hit) |
| Concurrent connections (100 req/sec) | Spikes > 2000 ms | Avg 80 ms | Stable via Pooling |

---

## 2. Query Normalization
### Approach
To maximize cache hit rates, I implemented a deterministic query normalizer (`lib/normalize.js`).

**Logic:**
When the parser converts a natural language query like `"Nigerian females between ages 20 and 45"` into an object like `{ gender: 'female', min_age: 20, max_age: 45, country_id: 'NG' }`, the normalizer sorts the keys alphabetically and standardizes the values before constructing the cache key string.

**Result:**
If another user asks `"Women aged 20-45 living in Nigeria"`, the natural language parser produces an identical query object, but potentially with properties declared in a different order. The normalizer ensures both resolve to the exact same canonical cache key (e.g., `country_id=ng&gender=female&max_age=45&min_age=20`), ensuring a cache hit.

---

## 3. CSV Data Ingestion
### Approach
To handle CSV files containing up to 500,000 rows without exploding memory or blocking concurrent readers, I implemented a chunked streaming pipeline using `@fastify/multipart` and `csv-parser`.

**Design Decisions:**
- **Streams, not buffers:** `csv-parser` reads the file iteratively via Node.js streams. Only a small chunk of data is in RAM at any moment.
- **Batch Insertion (`knex.batchInsert`)**: Rows are collected into an array of 1,000. When the batch is full, it is inserted into PostgreSQL using a single query.
- **Conflict Handling (`ON CONFLICT (name) DO NOTHING`)**: This allows idempotency. We execute the insertion and tell Postgres to return only the successful `id`s. The difference between batch size and returned IDs tells us exactly how many failed due to duplicate names.
- **Event Loop Yielding**: After every database batch insert, `await new Promise(resolve => setImmediate(resolve))` pauses execution, giving the Node.js event loop a chance to serve concurrent read requests, ensuring the upload process doesn't starve the API.

### Handling Failures & Edge Cases
- **Missing or Invalid Fields:** Validated *during* the stream. If an age is negative or a gender string is unrecognized, the row is discarded and the `skipped` counter increments immediately.
- **Malformed Data / Connection Issues:** If an entire batch fails due to a severe PostgreSQL constraint error, the catch block intercepts it, adds the batch count to the `skipped/malformed` tallies, logs the error, and proceeds to the next batch. The upload does not crash or roll back partial successes.
- **Cache Invalidation:** After the upload completes successfully (even if partial), a global `clearCache()` triggers, ensuring stale data is not served to analysts exploring the newly ingested populations.
