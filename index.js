import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './routes/auth.js';
import { profileRoutes } from './routes/profiles.js';

const fastify = Fastify({ logger: true });
const PORT = parseInt(process.env.PORT) || 3000;

// CORS
await fastify.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
});

// Cookies
await fastify.register(cookie);

// Rate limiting
await fastify.register(rateLimit, {
    global: false,
});

// Health check
fastify.get('/health', async () => ({ status: 'ok' }));

// Auth routes — rate limited at 10/min
fastify.register(async (instance) => {
    await instance.register(rateLimit, {
        max: 10,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({
            status: 'error',
            message: 'Too many requests',
        }),
    });
    instance.register(authRoutes);
}, { prefix: '' });

// Profile routes — rate limited at 60/min
fastify.register(async (instance) => {
    await instance.register(rateLimit, {
        max: 60,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({
            status: 'error',
            message: 'Too many requests',
        }),
    });
    instance.register(profileRoutes);
}, { prefix: '/api' });

// Request logging
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