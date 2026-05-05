# Scaling Insighta Labs+: System Design Under Growth
**Stage 4a — Backend Engineering Track**
**Author:** cybarry
**Date:** May 2026

---

## 1. Requirements

### Functional Requirements
- Accept structured filter queries (gender, age, country, age group) and return matching profiles
- Support combined filter + aggregation queries
- Support natural language inputs mapped to structured filters via rule-based parsing
- Authenticate all requests via GitHub OAuth with short-lived JWT tokens
- Enforce role-based access control (admin vs analyst)
- Serve data through three interfaces: REST API, CLI, Web Portal
- Support CSV export of filtered results
- Handle periodic profile ingestion without disrupting query availability

### Non-Functional Requirements

| Requirement | Target |
|---|---|
| P50 query latency | < 500ms |
| P95 query latency | < 2 seconds |
| Dataset size | Tens of millions of profiles |
| Query load | Hundreds to low thousands per minute |
| Availability | High — daily usage by multiple teams |
| Read/Write ratio | Read-heavy (~95% reads, ~5% writes) |
| Deployment | Single-region, managed services |

---

## 2. Architecture

### High-Level Diagram

```mermaid
graph TD
    Client[Clients: Web Portal, CLI, Direct API] --> |HTTPS| Proxy[Nginx Reverse Proxy + Rate Limiter]
    Proxy --> API[Fastify API Server Node.js]
    API --> |Read Queries| Cache[(Redis Cache)]
    API --> |Write Path / Ingest| DBMaster[(PostgreSQL Master)]
    API --> |Read Cache Miss| DBSlave[(PostgreSQL Slave)]
    DBMaster --> |Async Replication| DBSlave
```

### Core Components

**Nginx (Reverse Proxy):** Sits in front of everything. Clients never talk directly to the API server — they talk to Nginx. Nginx handles SSL termination, rate limiting, and forwards requests to the API server. This hides the backend from direct exposure to the internet.

**API Server (Fastify):** Handles auth verification, role checks, API versioning, and routes requests to the correct handler. Stateless — holds no data, only processes requests.

**Redis Cache:** Stores results of frequent read queries in memory (RAM). Serving from RAM is orders of magnitude faster than querying the database on disk. Used as a server-side cache sitting in front of the read replica.

**PostgreSQL Master:** Handles all write operations (INSERT, UPDATE, DELETE). Admin-only profile creation goes here. Only one master is needed — write volume is low.

**PostgreSQL Slave (Read Replica):** Handles all read queries. Receives data from the master via asynchronous replication. All analyst queries — filter, search, export — go here. Separating reads and writes is the master-slave architecture pattern.

---

## 3. Consistency Model (CAP Theorem)

The system is read-heavy and not real-time. Applying CAP theorem:

- **Partition Tolerance** is always required in distributed systems — network issues will happen.
- Between **Consistency** and **Availability**, this system chooses **Availability (AP)**.

Reason: Analysts querying demographic profiles do not need the absolute latest data at every millisecond. If a profile was just created by an admin, it is acceptable for it to appear in search results within a few seconds (replication lag) or up to 60 seconds (cache TTL). The system must remain available and fast for all analyst users regardless of what the admin is doing.

This is eventual consistency — all replicas will have the same data eventually, just not instantly.

This would be the wrong choice for a banking system where a transferred balance must be immediately visible. For demographic analytics, it is the right tradeoff.

---

## 4. Data Flow

### Read Path (Query Flow)

```mermaid
sequenceDiagram
    participant C as Analyst
    participant N as Nginx Proxy
    participant A as API Server Fastify
    participant R as Redis Cache
    participant DB as DB Slave (Read Replica)

    C->>N: Request (GET /api/profiles)
    N->>A: Forward Request
    A->>A: Verify Auth, Role, Headers
    A->>A: Parse Filters & Build Cache Key
    A->>R: Check Cache
    alt Cache Hit
        R-->>A: Return Result
    else Cache Miss
        A->>DB: Execute Query (with indexes)
        DB-->>A: Return Data
        A->>R: Store Result (TTL: 60s)
    end
    A-->>C: Return response to client
```

### Write Path (Ingest Flow)

```mermaid
sequenceDiagram
    participant C as Admin
    participant A as API Server
    participant DB as DB Master
    participant DBS as DB Slave
    participant R as Redis Cache

    C->>A: POST /api/profiles
    A->>A: Verify Admin Role & duplicates
    A->>A: Parallel external API calls
    A->>DB: INSERT profile record
    DB--)DBS: Async replication
    A->>R: Invalidate affected cache keys
    A-->>C: Return 201
```

### Natural Language Query Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant P as Rule-based Parser (NLP)
    participant RP as Standard Read Path

    C->>P: GET /api/profiles/search?q=...
    P->>P: Tokenize & match keywords
    P->>P: Map to structured filters
    P->>RP: Forward to Standard Read Path
```

---

## 5. Design Decisions

### Decision 1 — Vertical Scaling First, Then Master-Slave

**Requirement:** Handle hundreds to thousands of queries per minute with P95 < 2s.

**Reasoning:** The first step when a database becomes slow is always vertical scaling — increase the RAM and CPU of the existing server. It is the simplest option and has no application-level changes. Only after hitting that limit does it make sense to add complexity.

For this system, the bottleneck will be read traffic — analysts constantly querying the same dataset. The master-slave architecture is the correct next step: one master handles all writes, one or more slaves handle all reads. This directly reduces contention because read and write traffic no longer compete for the same database connections.

Sharding is not needed here. The resource says: "When you have write-heavy traffic, do sharding." This system has write-light traffic (admin-only, occasional profile creation). Sharding would be overengineering and would introduce the join complexity the resource explicitly warns against.

**Trade-off:** Asynchronous replication means the slave may lag behind the master by milliseconds to seconds. A profile created right now may not appear in search results immediately. This is acceptable for an analytics system and is the definition of eventual consistency.

---

### Decision 2 — Redis as Server-Side Cache

**Requirement:** P50 < 500ms, reduced database load.

**Reasoning:** The resource explains that Redis stores data in RAM, which is dramatically faster than reading from disk (where the database lives). A query that takes 200ms against the database returns in under 10ms from Redis.

Analyst queries follow predictable patterns — "show me adult males from Nigeria" will be run many times per day. Without caching, every single request hits the read replica. With a 60-second TTL cache, the first request pays the database cost and every subsequent identical request is served from memory.

The cache key is built from the full combination of query parameters (filters + sort + page + limit). An exact match returns cached data. A miss falls through to the read replica.

**On write:** When an admin creates or deletes a profile, cache entries that would be affected by that change are invalidated immediately. This prevents stale results from being served after a data change.

**Trade-off:** Up to 60 seconds of staleness after a write. Acceptable for analytics. A shorter TTL (e.g., 10 seconds) reduces staleness but increases database load. 60 seconds is the practical balance for this use case.

---

### Decision 3 — Composite Database Indexes

**Requirement:** Query performance at tens of millions of rows.

**Reasoning:** The resource explains that without indexing, a database performs a full table scan — checking every row — which is O(N). With an index, the database uses a B-tree structure and can find results in O(log N). At tens of millions of rows the difference between these is the difference between a 5-second query and a 50ms query.

The current schema has individual indexes on `gender`, `age_group`, `country_id`, and `age`. When a query filters on multiple columns simultaneously, PostgreSQL can only use one index and must filter the rest in memory. Composite indexes solve this for the most common filter combinations:

```sql
CREATE INDEX idx_gender_country ON profiles(gender, country_id);
CREATE INDEX idx_gender_age_group ON profiles(gender, age_group);
CREATE INDEX idx_country_age_group ON profiles(country_id, age_group);
CREATE INDEX idx_gender_country_age_group ON profiles(gender, country_id, age_group);
```

**Trade-off:** Each additional index slightly slows down writes because every INSERT must update all relevant indexes. Since writes are low-volume and admin-only, this cost is negligible.

---

### Decision 4 — Nginx as Reverse Proxy

**Requirement:** Security, rate limiting, single entry point.

**Reasoning:** The resource defines a reverse proxy as a server that sits in front of the backend — clients talk to the reverse proxy, not directly to the application server. The backend is never directly exposed to the internet. Nginx provides SSL termination (handling HTTPS so the application server only sees plain HTTP internally), rate limiting, and request routing.

This is already partially handled in Fastify's rate limiting plugin. Moving the outer layer to Nginx is a standard production pattern that adds no application complexity and provides a hardened perimeter.

**Trade-off:** One additional network hop per request. The latency cost is under 1ms and is far outweighed by the security and operational benefits.

---

### Decision 5 — No Microservices, No Message Queues

**Requirement:** Simplicity and maintainability.

**Reasoning:** The resource is explicit: "Most startups start with a monolith... When to use Microservice? When we want to avoid single-point failure [and] when no. of teams increases." This system has one backend team, one database, and one set of features. Breaking it into microservices would add network hops, distributed tracing complexity, and deployment overhead with no benefit.

Similarly, message brokers are appropriate for "non-critical tasks that can be done asynchronously" and "tasks that take a long time to compute." Profile creation (calling three external APIs and inserting one row) completes in under 2 seconds synchronously. There is no long-running job that needs to be queued. Adding a message broker here would be adding infrastructure to solve a problem that does not exist.

---

## 6. Trade-offs and Limitations

### What this design handles well
- Read-heavy workloads with repeated analyst query patterns
- Growing dataset up to tens of millions of rows with proper indexing
- Concurrent analyst sessions without database contention (read replica)
- Low write volume with fast synchronous response (admin-only creation)
- Cache hit rate reduces database load significantly for common queries

### What this design does not handle well

**High-volume writes:** If profile ingestion ever becomes high-volume (thousands per minute), the synchronous write path to a single master becomes a bottleneck. The resource recommends sharding for write-heavy traffic. At that point, a write queue (simple async job) would decouple the external API calls from the database insert. This is not needed now.

**Aggregation queries at scale:** "Count of all adult males grouped by country" across tens of millions of rows is expensive even with indexes. At that scale, a materialized view refreshed on a schedule would pre-compute common aggregations. This adds complexity not justified by current query patterns.

**Master failure:** A single master is a single point of failure for writes. If the master goes down, writes fail until failover completes. Railway's managed PostgreSQL handles failover automatically but with potential downtime of 30–60 seconds. A hot standby with synchronous replication would reduce this but adds cost. Acceptable at this stage.

**Cache stampede:** If many requests arrive simultaneously for the same uncached query (e.g., after cache expiry), all of them hit the database at once. A simple mutex or probabilistic early expiration can prevent this. Intentionally excluded for simplicity — it is an edge case at current traffic levels.

---

## 7. Bonus — Future Evolution

### Real-Time Analytics
If the product needed real-time dashboards (e.g., "how many profiles created today, live"), the addition would be an event stream pattern. Each write event (profile created, deleted) would be published to a lightweight queue. A consumer worker would update pre-computed counters in Redis. The dashboard would read counters from Redis rather than running COUNT queries against the database on every page load.

The resource describes this as event-driven architecture — the producer (ingest layer) emits an event, and consumers (counter workers) process it asynchronously. The database layer does not change. This only makes sense when write volume is high enough to make live COUNT queries expensive.

### True Natural Language Query System
The current rule-based parser maps a fixed vocabulary to structured filters. To evolve:

**Step 1 — Near-term:** Expand keyword coverage and add fuzzy matching for country names and synonyms. No infrastructure change required.

**Step 2 — Medium-term:** Replace the parser with a small classification model deployed as a sidecar service. The API sends the raw query string, receives a structured filter object back, and proceeds with the existing query pipeline unchanged. The database layer is untouched.

**Step 3 — Long-term:** If semantic similarity search is needed (find profiles similar to a description), the pgvector PostgreSQL extension would add vector search capability to the existing database without a separate vector store. This is only justified if structured filters genuinely cannot serve the use case.

The core principle: the query pipeline and database stay constant. Only the input parsing layer evolves.
