import { verifyAccessToken } from './tokens.js';
import { db } from './db.js';

export async function authenticate(request, reply) {
    try {
        const authHeader = request.headers['authorization'];
        const cookieToken = request.cookies?.access_token;

        let token = cookieToken;

        if (authHeader?.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }

        if (!token) {
            return reply.status(401).send({ status: 'error', message: 'Unauthorized' });
        }

        const payload = verifyAccessToken(token);

        // Get fresh user from DB
        const user = await db('users').where({ id: payload.sub }).first();
        if (!user) {
            return reply.status(401).send({ status: 'error', message: 'Unauthorized' });
        }

        if (!user.is_active) {
            return reply.status(403).send({ status: 'error', message: 'Account is inactive' });
        }

        request.user = user;
    } catch {
        return reply.status(401).send({ status: 'error', message: 'Unauthorized' });
    }
}

export function requireRole(...roles) {
    return async function (request, reply) {
        if (!request.user) {
            return reply.status(401).send({ status: 'error', message: 'Unauthorized' });
        }
        if (!roles.includes(request.user.role)) {
            return reply.status(403).send({ status: 'error', message: 'Forbidden' });
        }
    };
}

export function requireApiVersion(request, reply, done) {
    const version = request.headers['x-api-version'];
    if (!version || version !== '1') {
        return reply.status(400).send({
            status: 'error',
            message: 'API version header required',
        });
    }
    done();
}