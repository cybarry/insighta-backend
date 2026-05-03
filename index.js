import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './routes/auth.js';
import { profileRoutes } from './routes/profiles.js';

const fastify = Fastify({ logger: true });
const PORT = parseInt(process.env.PORT) || 3000;

// Allowed origins — comma-separated in env for flexibility
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5500')
    .split(',')
    .map(o => o.trim());

// CORS — open to all origins; auth is via Authorization header, not cookies
await fastify.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Version'],
});

// Cookies
await fastify.register(cookie);

// Rate limiting global plugin (individual scopes set below)
await fastify.register(rateLimit, {
    global: false,
});

// Health check
fastify.get('/health', async () => ({ status: 'ok' }));

// Auth routes — rate limited at 10 req/min
await fastify.register(async (instance) => {
    await instance.register(rateLimit, {
        max: 10,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({
            status: 'error',
            message: 'Too many requests',
        }),
    });
    await instance.register(authRoutes);
}, { prefix: '' });

// Profile routes — rate limited at 60 req/min per user
await fastify.register(async (instance) => {
    await instance.register(rateLimit, {
        max: 60,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({
            status: 'error',
            message: 'Too many requests',
        }),
    });
    await instance.register(profileRoutes);
}, { prefix: '/api' });

// Request logging hook
fastify.addHook('onResponse', (request, reply, done) => {
    fastify.log.info({
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        responseTime: reply.elapsedTime?.toFixed(2) + 'ms',
    });
    done();
});

// Start
try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Server running on port ${PORT}`);
} catch (err) {
    fastify.log.error(err);
    process.exit(1);
}