import 'dotenv/config';
import knex from 'knex';

const db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

async function migrate() {
    console.log('Running migrations...');

    // profiles table
    if (!(await db.schema.hasTable('profiles'))) {
        await db.schema.createTable('profiles', (t) => {
            t.string('id').primary();
            t.string('name').unique().notNullable();
            t.string('gender').notNullable();
            t.float('gender_probability').notNullable();
            t.integer('age').notNullable();
            t.string('age_group').notNullable();
            t.string('country_id', 2).notNullable();
            t.string('country_name').notNullable();
            t.float('country_probability').notNullable();
            t.timestamp('created_at').defaultTo(db.fn.now());
            t.index(['gender', 'age_group', 'country_id', 'age',
                'gender_probability', 'country_probability', 'created_at']);
        });
        console.log('✅ profiles table created');
    } else {
        console.log('ℹ️  profiles table exists');
    }

    // users table
    if (!(await db.schema.hasTable('users'))) {
        await db.schema.createTable('users', (t) => {
            t.string('id').primary();
            t.string('github_id').unique().notNullable();
            t.string('username').notNullable();
            t.string('email');
            t.string('avatar_url');
            t.string('role').defaultTo('analyst');
            t.boolean('is_active').defaultTo(true);
            t.timestamp('last_login_at');
            t.timestamp('created_at').defaultTo(db.fn.now());
        });
        console.log('✅ users table created');
    } else {
        console.log('ℹ️  users table exists');
    }

    // refresh_tokens table
    if (!(await db.schema.hasTable('refresh_tokens'))) {
        await db.schema.createTable('refresh_tokens', (t) => {
            t.string('id').primary();
            t.string('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
            t.text('token').notNullable().unique();
            t.boolean('used').defaultTo(false);
            t.timestamp('expires_at').notNullable();
            t.timestamp('created_at').defaultTo(db.fn.now());
        });
        console.log('✅ refresh_tokens table created');
    } else {
        console.log('ℹ️  refresh_tokens table exists');
    }

    await db.destroy();
    console.log('Migration complete.');
}

migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});