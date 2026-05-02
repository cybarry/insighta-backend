import axios from 'axios';
import { uuidv7 } from 'uuidv7';
import { db } from '../lib/db.js';
import { signAccessToken, createRefreshToken, rotateRefreshToken } from '../lib/tokens.js';
import { authenticate } from '../lib/middleware.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;

export async function authRoutes(fastify) {

    // GET /auth/github — redirect to GitHub
    fastify.get('/auth/github', async (request, reply) => {
        const state = uuidv7();
        const params = new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            redirect_uri: GITHUB_CALLBACK_URL,
            scope: 'read:user user:email',
            state,
        });

        return reply.redirect(
            `https://github.com/login/oauth/authorize?${params.toString()}`
        );
    });

    // GET /auth/github/callback — handle OAuth callback
    fastify.get('/auth/github/callback', async (request, reply) => {
        const { code, state } = request.query;

        if (!code) {
            return reply.status(400).send({ status: 'error', message: 'Missing code' });
        }

        try {
            // Exchange code for access token
            const tokenRes = await axios.post(
                'https://github.com/login/oauth/access_token',
                {
                    client_id: GITHUB_CLIENT_ID,
                    client_secret: GITHUB_CLIENT_SECRET,
                    code,
                    redirect_uri: GITHUB_CALLBACK_URL,
                },
                { headers: { Accept: 'application/json' } }
            );

            const githubToken = tokenRes.data.access_token;
            if (!githubToken) {
                return reply.status(502).send({ status: 'error', message: 'GitHub token exchange failed' });
            }

            // Get GitHub user info
            const [userRes, emailRes] = await Promise.all([
                axios.get('https://api.github.com/user', {
                    headers: { Authorization: `Bearer ${githubToken}` },
                }),
                axios.get('https://api.github.com/user/emails', {
                    headers: { Authorization: `Bearer ${githubToken}` },
                }),
            ]);

            const githubUser = userRes.data;
            const primaryEmail = emailRes.data.find((e) => e.primary)?.email || null;

            // Upsert user
            let user = await db('users').where({ github_id: String(githubUser.id) }).first();

            if (!user) {
                const id = uuidv7();
                await db('users').insert({
                    id,
                    github_id: String(githubUser.id),
                    username: githubUser.login,
                    email: primaryEmail,
                    avatar_url: githubUser.avatar_url,
                    role: 'analyst',
                    is_active: true,
                    last_login_at: new Date(),
                });
                user = await db('users').where({ id }).first();
            } else {
                await db('users').where({ id: user.id }).update({
                    username: githubUser.login,
                    email: primaryEmail,
                    avatar_url: githubUser.avatar_url,
                    last_login_at: new Date(),
                });
                user = await db('users').where({ id: user.id }).first();
            }

            if (!user.is_active) {
                return reply.status(403).send({ status: 'error', message: 'Account is inactive' });
            }

            const accessToken = signAccessToken(user);
            const refreshToken = await createRefreshToken(user.id);

            // Check if CLI flow (has state param from CLI)
            const isCLI = request.query.cli === '1';

            if (isCLI) {
                // CLI: redirect to localhost callback
                const port = request.query.port || 9876;
                return reply.redirect(
                    `http://localhost:${port}/callback?access_token=${accessToken}&refresh_token=${refreshToken}&username=${user.username}`
                );
            }

            // Web: set HTTP-only cookies
            reply
                .setCookie('access_token', accessToken, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: 'lax',
                    path: '/',
                    maxAge: 3 * 60,
                })
                .setCookie('refresh_token', refreshToken, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: 'lax',
                    path: '/',
                    maxAge: 5 * 60,
                });
            // Web: redirect with tokens in URL, let frontend store them
            return reply.redirect(
                `${FRONTEND_URL}/dashboard.html?access_token=${accessToken}&refresh_token=${refreshToken}`
            );
        } catch (err) {
            fastify.log.error(err);
            return reply.status(502).send({ status: 'error', message: 'Authentication failed' });
        }
    });

    // POST /auth/refresh
    fastify.post('/auth/refresh', async (request, reply) => {
        const refreshToken =
            request.body?.refresh_token ||
            request.cookies?.refresh_token;

        if (!refreshToken) {
            return reply.status(400).send({ status: 'error', message: 'Missing refresh token' });
        }

        try {
            const { accessToken, refreshToken: newRefreshToken, user } = await rotateRefreshToken(refreshToken);

            // Update cookie if web
            if (request.cookies?.refresh_token) {
                reply
                    .setCookie('access_token', accessToken, {
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production',
                        sameSite: 'lax',
                        path: '/',
                        maxAge: 3 * 60,
                    })
                    .setCookie('refresh_token', newRefreshToken, {
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production',
                        sameSite: 'lax',
                        path: '/',
                        maxAge: 5 * 60,
                    });
            }

            return reply.send({
                status: 'success',
                access_token: accessToken,
                refresh_token: newRefreshToken,
            });
        } catch (err) {
            return reply.status(err.code || 401).send({
                status: 'error',
                message: err.message || 'Token refresh failed',
            });
        }
    });

    // POST /auth/logout
    fastify.post('/auth/logout', async (request, reply) => {
        const refreshToken =
            request.body?.refresh_token ||
            request.cookies?.refresh_token;

        if (refreshToken) {
            await db('refresh_tokens').where({ token: refreshToken }).update({ used: true });
        }

        reply
            .clearCookie('access_token')
            .clearCookie('refresh_token');

        return reply.send({ status: 'success', message: 'Logged out' });
    });

    // GET /auth/me
    fastify.get('/auth/me', { preHandler: authenticate }, async (request, reply) => {
        return reply.send({ status: 'success', data: request.user });
    });
}