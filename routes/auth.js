import axios from 'axios';
import { uuidv7 } from 'uuidv7';
import { db } from '../lib/db.js';
import { signAccessToken, createRefreshToken, rotateRefreshToken } from '../lib/tokens.js';
import { authenticate } from '../lib/middleware.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;

/**
 * Cookie options — SameSite=none + Secure=true required for cross-origin
 * deployments (Railway backend ↔ Railway web on different subdomains).
 */
function cookieOpts(maxAge) {
    const isProd = process.env.NODE_ENV === 'production';
    return {
        httpOnly: true,
        secure: isProd,              // SameSite=none requires Secure
        sameSite: isProd ? 'none' : 'lax',
        path: '/',
        maxAge,                      // seconds
    };
}

export async function authRoutes(fastify) {

    // GET /auth/github — redirect user to GitHub OAuth consent screen
    fastify.get('/auth/github', async (request, reply) => {
        // Encode cli/port into state so they survive the GitHub round-trip.
        // GitHub only passes back `code` and `state` — all other query params are lost.
        const statePayload = {
            nonce: uuidv7(),
            cli: request.query.cli || null,
            port: request.query.port || null,
        };
        const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

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

    // GET /auth/github/callback — GitHub sends the user back here with a code
    fastify.get('/auth/github/callback', async (request, reply) => {
        const { code, state: rawState } = request.query;

        if (!code) {
            return reply.status(400).send({ status: 'error', message: 'Missing code' });
        }

        // Decode cli/port from state (encoded in /auth/github above)
        let cli = null;
        let port = null;
        try {
            const statePayload = JSON.parse(Buffer.from(rawState, 'base64url').toString());
            cli = statePayload.cli;
            port = statePayload.port;
        } catch {
            // state was not base64-encoded (e.g. direct browser hit) — that's fine
        }

        try {
            // 1. Exchange code for GitHub access token
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

            // 2. Fetch GitHub user profile + primary email
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

            // 3. Upsert user in DB
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

            // 4. Issue token pair
            const accessToken = signAccessToken(user);
            const refreshToken = await createRefreshToken(user.id);

            // CLI flow: redirect tokens to the local callback server
            if (cli === '1') {
                const callbackPort = port || 9876;
                return reply.redirect(
                    `http://localhost:${callbackPort}/callback?access_token=${accessToken}&refresh_token=${refreshToken}&username=${user.username}`
                );
            }

            // Web flow: set HTTP-only cookies ONLY — no tokens exposed in URL
            reply
                .setCookie('access_token', accessToken, cookieOpts(3 * 60))
                .setCookie('refresh_token', refreshToken, cookieOpts(5 * 60));

            return reply.redirect(`${FRONTEND_URL}/dashboard.html`);

        } catch (err) {
            fastify.log.error(err);
            return reply.status(502).send({ status: 'error', message: 'Authentication failed' });
        }
    });

    // POST /auth/refresh — rotate access + refresh token pair
    fastify.post('/auth/refresh', async (request, reply) => {
        // Accept token from body (CLI) or cookie (web)
        const refreshToken =
            request.body?.refresh_token ||
            request.cookies?.refresh_token;

        if (!refreshToken) {
            return reply.status(400).send({ status: 'error', message: 'Missing refresh token' });
        }

        try {
            const { accessToken, refreshToken: newRefreshToken } = await rotateRefreshToken(refreshToken);

            // Always refresh cookies (harmless for CLI, essential for web)
            reply
                .setCookie('access_token', accessToken, cookieOpts(3 * 60))
                .setCookie('refresh_token', newRefreshToken, cookieOpts(5 * 60));

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

    // POST /auth/logout — invalidate refresh token server-side + clear cookies
    fastify.post('/auth/logout', async (request, reply) => {
        const refreshToken =
            request.body?.refresh_token ||
            request.cookies?.refresh_token;

        if (refreshToken) {
            await db('refresh_tokens').where({ token: refreshToken }).update({ used: true });
        }

        reply
            .clearCookie('access_token', { path: '/' })
            .clearCookie('refresh_token', { path: '/' });

        return reply.send({ status: 'success', message: 'Logged out' });
    });

    // GET /auth/me — return current authenticated user (no X-API-Version required)
    fastify.get('/auth/me', { preHandler: authenticate }, async (request, reply) => {
        const { id, github_id, username, email, avatar_url, role, is_active, last_login_at, created_at } = request.user;
        return reply.send({
            status: 'success',
            data: { id, github_id, username, email, avatar_url, role, is_active, last_login_at, created_at },
        });
    });
}