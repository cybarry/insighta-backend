import 'dotenv/config';
import knex from 'knex';
import { uuidv7 } from 'uuidv7';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function seed() {
    const filePath = path.join(__dirname, 'profiles.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`Seeding ${data.length} profiles...`);

    const BATCH_SIZE = 100;
    let inserted = 0;

    for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE).map((item) => ({
            id: uuidv7(),
            name: item.name,
            gender: item.gender,
            gender_probability: item.gender_probability,
            age: item.age,
            age_group: item.age_group,
            country_id: item.country_id,
            country_name: item.country_name,
            country_probability: item.country_probability,
        }));

        await db('profiles').insert(batch).onConflict('name').ignore();
        inserted += batch.length;
        process.stdout.write(`\r  Inserted ${inserted}/${data.length}`);
    }

    console.log('\n✅ Seeding complete.');
    await db.destroy();
}

seed().catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
});