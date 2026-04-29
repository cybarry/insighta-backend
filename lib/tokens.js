import jwt from 'jsonwebtoken';
import { uuidv7 } from 'uuidv7';
import { db } from './db.js';

const ACCESS_EXPIRY = 3 * 60;       // 3 minutes in seconds
const REFRESH_EXPIRY = 5 * 60;      // 5 minutes in seconds

export function signAccessToken(user) {
    return jwt.sign(
        { sub: user.id, username: user.username, role: user.role },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: ACCESS_EXPIRY }
    );
}

export async function createRefreshToken(userId) {
    const token = jwt.sign(
        { sub: userId, jti: uuidv7() },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: REFRESH_EXPIRY }
    );

    const expiresAt = new Date(Date.now() + REFRESH_EXPIRY * 1000);

    await db('refresh_tokens').insert({
        id: uuidv7(),
        user_id: userId,
        token,
        used: false,
        expires_at: expiresAt,
    });

    return token;
}

export async function rotateRefreshToken(oldToken) {
    // Find token in DB
    const record = await db('refresh_tokens').where({ token: oldToken }).first();

    if (!record) throw { code: 401, message: 'Invalid refresh token' };
    if (record.used) throw { code: 401, message: 'Refresh token already used' };
    if (new Date(record.expires_at) < new Date()) {
        throw { code: 401, message: 'Refresh token expired' };
    }

    // Verify JWT signature
    let payload;
    try {
        payload = jwt.verify(oldToken, process.env.JWT_REFRESH_SECRET);
    } catch {
        throw { code: 401, message: 'Invalid refresh token' };
    }

    // Mark old token as used immediately
    await db('refresh_tokens').where({ id: record.id }).update({ used: true });

    // Get user
    const user = await db('users').where({ id: payload.sub }).first();
    if (!user) throw { code: 401, message: 'User not found' };
    if (!user.is_active) throw { code: 403, message: 'Account is inactive' };

    // Issue new pair
    const accessToken = signAccessToken(user);
    const newRefreshToken = await createRefreshToken(user.id);

    return { accessToken, refreshToken: newRefreshToken, user };
}

export function verifyAccessToken(token) {
    return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}