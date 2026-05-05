import axios from 'axios';
import { uuidv7 } from 'uuidv7';
import { db } from '../lib/db.js';
import { authenticate, requireRole, requireApiVersion } from '../lib/middleware.js';
import { parseQuery } from '../lib/nlp.js';
import csv from 'csv-parser';
import { getCached, setCached, clearCache } from '../lib/cache.js';
import { normalizeQuery } from '../lib/normalize.js';

const VALID_SORT = new Set(['age', 'created_at', 'gender_probability']);
const VALID_ORDERS = new Set(['asc', 'desc']);

function getAgeGroup(age) {
    if (age <= 12) return 'child';
    if (age <= 19) return 'teenager';
    if (age <= 59) return 'adult';
    return 'senior';
}

function applyFilters(qb, p) {
    if (p.gender) qb.whereRaw('LOWER(gender) = ?', [p.gender.toLowerCase()]);
    if (p.age_group) qb.whereRaw('LOWER(age_group) = ?', [p.age_group.toLowerCase()]);
    if (p.country_id) qb.whereRaw('LOWER(country_id) = ?', [p.country_id.toLowerCase()]);
    if (p.min_age != null) qb.where('age', '>=', Number(p.min_age));
    if (p.max_age != null) qb.where('age', '<=', Number(p.max_age));
    if (p.min_gender_probability != null) qb.where('gender_probability', '>=', Number(p.min_gender_probability));
    if (p.min_country_probability != null) qb.where('country_probability', '>=', Number(p.min_country_probability));
    return qb;
}

function parsePagination(query) {
    let page = parseInt(query.page) || 1;
    let limit = parseInt(query.limit) || 10;
    if (page < 1) page = 1;
    if (limit < 1) limit = 1;
    if (limit > 50) limit = 50;
    return { page, limit, offset: (page - 1) * limit };
}

function buildLinks(base, page, limit, total) {
    const totalPages = Math.ceil(total / limit);
    return {
        self: `${base}?page=${page}&limit=${limit}`,
        next: page < totalPages ? `${base}?page=${page + 1}&limit=${limit}` : null,
        prev: page > 1 ? `${base}?page=${page - 1}&limit=${limit}` : null,
    };
}

async function fetchExternal(name) {
    const [genderRes, ageRes, nationRes] = await Promise.all([
        axios.get(`https://api.genderize.io?name=${name}`, { timeout: 8000 }),
        axios.get(`https://api.agify.io?name=${name}`, { timeout: 8000 }),
        axios.get(`https://api.nationalize.io?name=${name}`, { timeout: 8000 }),
    ]);

    const g = genderRes.data;
    const a = ageRes.data;
    const n = nationRes.data;

    if (!g.gender || g.count === 0) throw { code: 502, api: 'Genderize' };
    if (a.age === null || a.age === undefined) throw { code: 502, api: 'Agify' };
    if (!n.country || n.country.length === 0) throw { code: 502, api: 'Nationalize' };

    const top = n.country.reduce((a, b) => (a.probability > b.probability ? a : b));

    const countryNames = {
        NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana', ZA: 'South Africa',
        US: 'United States', GB: 'United Kingdom', FR: 'France', DE: 'Germany',
        IN: 'India', BR: 'Brazil', AO: 'Angola', TZ: 'Tanzania', UG: 'Uganda',
        ET: 'Ethiopia', CM: 'Cameroon', SN: 'Senegal', EG: 'Egypt', MA: 'Morocco',
    };

    return {
        gender: g.gender,
        gender_probability: g.probability,
        sample_size: g.count,
        age: a.age,
        age_group: getAgeGroup(a.age),
        country_id: top.country_id,
        country_name: countryNames[top.country_id] || top.country_id,
        country_probability: top.probability,
    };
}

export async function profileRoutes(fastify) {

    // All profile routes need auth + api version
    fastify.addHook('preHandler', authenticate);
    fastify.addHook('preHandler', (req, reply, done) => requireApiVersion(req, reply, done));

    // POST /api/profiles — admin only
    fastify.post('/profiles', {
        preHandler: requireRole('admin'),
    }, async (request, reply) => {
        const { name } = request.body || {};

        if (!name || name === '') {
            return reply.status(400).send({ status: 'error', message: 'Missing or empty name' });
        }
        if (typeof name !== 'string') {
            return reply.status(422).send({ status: 'error', message: 'name must be a string' });
        }

        const cleanName = name.trim().toLowerCase();

        const existing = await db('profiles').where({ name: cleanName }).first();
        if (existing) {
            return reply.send({ status: 'success', message: 'Profile already exists', data: existing });
        }

        let external;
        try {
            external = await fetchExternal(cleanName);
        } catch (err) {
            if (err.code === 502) {
                return reply.status(502).send({
                    status: 'error',
                    message: `${err.api} returned an invalid response`,
                });
            }
            return reply.status(502).send({ status: 'error', message: 'Upstream API error' });
        }

        const id = uuidv7();
        const [profile] = await db('profiles')
            .insert({
                id,
                name: cleanName,
                gender: external.gender,
                gender_probability: external.gender_probability,
                age: external.age,
                age_group: external.age_group,
                country_id: external.country_id,
                country_name: external.country_name,
                country_probability: external.country_probability,
            })
            .returning('*');

        clearCache();
        return reply.status(201).send({ status: 'success', data: profile });
    });

    // POST /api/profiles/upload — admin only
    fastify.post('/profiles/upload', {
        preHandler: requireRole('admin'),
    }, async (request, reply) => {
        const data = await request.file();
        if (!data) {
            return reply.status(400).send({ status: 'error', message: 'Missing file' });
        }

        let total_rows = 0;
        let inserted = 0;
        let skipped = 0;
        const reasons = { duplicate_name: 0, invalid_age: 0, missing_fields: 0, malformed: 0 };
        
        const validGenders = new Set(['male', 'female']);
        let batch = [];
        const BATCH_SIZE = 1000;

        async function processBatch() {
            if (batch.length === 0) return;
            try {
                const results = await db('profiles')
                    .insert(batch)
                    .onConflict('name')
                    .ignore()
                    .returning('id');
                    
                inserted += results.length;
                reasons.duplicate_name += (batch.length - results.length);
                skipped += (batch.length - results.length);
            } catch (err) {
                skipped += batch.length;
                reasons.malformed += batch.length;
                request.log.error('Batch insert error:', err);
            }
            batch = [];
            await new Promise(resolve => setImmediate(resolve));
        }

        const parser = data.file.pipe(csv({ separator: ',' }));
        
        for await (const row of parser) {
            total_rows++;
            
            const name = row.name?.trim();
            const gender = row.gender?.trim().toLowerCase();
            const age = parseInt(row.age, 10);
            const country_id = row.country_id?.trim().toUpperCase();
            const country_name = row.country_name?.trim() || country_id;

            if (!name || !gender || isNaN(age) || !country_id) {
                skipped++;
                reasons.missing_fields++;
                continue;
            }
            if (age < 0) {
                skipped++;
                reasons.invalid_age++;
                continue;
            }
            if (!validGenders.has(gender)) {
                skipped++;
                reasons.malformed++;
                continue;
            }

            const age_group = getAgeGroup(age);

            batch.push({
                id: uuidv7(),
                name: name.toLowerCase(),
                gender: gender,
                gender_probability: parseFloat(row.gender_probability) || 1.0,
                age: age,
                age_group: age_group,
                country_id: country_id,
                country_name: country_name,
                country_probability: parseFloat(row.country_probability) || 1.0
            });

            if (batch.length >= BATCH_SIZE) {
                await processBatch();
            }
        }
        
        await processBatch(); // Final batch
        clearCache(); // Invalidate cache after bulk insert

        return reply.send({
            status: "success",
            total_rows,
            inserted,
            skipped,
            reasons
        });
    });

    // GET /api/profiles
    fastify.get('/profiles', async (request, reply) => {
        const cacheKey = `profiles_${normalizeQuery(request.query)}`;
        const cached = getCached(cacheKey);
        if (cached) return reply.send(cached);

        const { page, limit, offset } = parsePagination(request.query);
        const sortBy = VALID_SORT.has(request.query.sort_by) ? request.query.sort_by : 'created_at';
        const order = VALID_ORDERS.has(request.query.order?.toLowerCase()) ? request.query.order.toLowerCase() : 'desc';

        const base = db('profiles');
        applyFilters(base, request.query);

        const [{ count }] = await base.clone().count('id as count');
        const total = parseInt(count);
        const data = await base.clone().orderBy(sortBy, order).limit(limit).offset(offset);

        const response = {
            status: 'success',
            page,
            limit,
            total,
            total_pages: Math.ceil(total / limit),
            links: buildLinks('/api/profiles', page, limit, total),
            data,
        };
        
        setCached(cacheKey, response);
        return reply.send(response);
    });

    // GET /api/profiles/export
    fastify.get('/profiles/export', async (request, reply) => {
        const sortBy = VALID_SORT.has(request.query.sort_by) ? request.query.sort_by : 'created_at';
        const order = VALID_ORDERS.has(request.query.order?.toLowerCase()) ? request.query.order.toLowerCase() : 'desc';

        const base = db('profiles');
        applyFilters(base, request.query);
        const data = await base.clone().orderBy(sortBy, order);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `profiles_${timestamp}.csv`;

        const headers = ['id', 'name', 'gender', 'gender_probability', 'age', 'age_group',
            'country_id', 'country_name', 'country_probability', 'created_at'];

        const csvString = [
            headers.join(','),
            ...data.map(row => headers.map(h => `"${row[h] ?? ''}"`).join(',')),
        ].join('\n');

        reply
            .header('Content-Type', 'text/csv')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(csvString);
    });

    // GET /api/profiles/search
    fastify.get('/profiles/search', async (request, reply) => {
        const { q } = request.query;

        if (!q || q.trim() === '') {
            return reply.status(400).send({ status: 'error', message: 'Missing or empty query parameter' });
        }

        const filters = parseQuery(q);
        if (!filters) {
            return reply.send({ status: 'error', message: 'Unable to interpret query' });
        }

        const { page, limit, offset } = parsePagination(request.query);
        
        const cacheKey = `search_${normalizeQuery({ ...filters, page, limit })}`;
        const cached = getCached(cacheKey);
        if (cached) return reply.send(cached);

        const base = db('profiles');
        applyFilters(base, filters);

        const [{ count }] = await base.clone().count('id as count');
        const total = parseInt(count);
        const data = await base.clone().orderBy('created_at', 'desc').limit(limit).offset(offset);

        const response = {
            status: 'success',
            page,
            limit,
            total,
            total_pages: Math.ceil(total / limit),
            links: buildLinks('/api/profiles/search', page, limit, total),
            data,
        };
        
        setCached(cacheKey, response);
        return reply.send(response);
    });

    // GET /api/profiles/:id
    fastify.get('/profiles/:id', async (request, reply) => {
        const cacheKey = `profile_${request.params.id}`;
        const cached = getCached(cacheKey);
        if (cached) return reply.send(cached);

        const profile = await db('profiles').where({ id: request.params.id }).first();
        if (!profile) {
            return reply.status(404).send({ status: 'error', message: 'Profile not found' });
        }
        
        const response = { status: 'success', data: profile };
        setCached(cacheKey, response);
        return reply.send(response);
    });

    // DELETE /api/profiles/:id — admin only
    fastify.delete('/profiles/:id', {
        preHandler: requireRole('admin'),
    }, async (request, reply) => {
        const deleted = await db('profiles').where({ id: request.params.id }).delete();
        if (!deleted) {
            return reply.status(404).send({ status: 'error', message: 'Profile not found' });
        }
        clearCache();
        return reply.status(204).send();
    });
}