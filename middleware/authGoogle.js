// middleware/authGoogle.js
const { OAuth2Client } = require('google-auth-library');


// Load your Google OAuth Client ID from .env
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!CLIENT_ID) {
    console.error('GOOGLE_CLIENT_ID is not set in environment variables.');
    process.exit(1); // stop the app if missing
}

// Allow multiple comma-separated Client IDs (optional)
const AUDIENCES = CLIENT_ID.split(',').map(id => id.trim()).filter(Boolean);

// Create reusable OAuth2 client
const client = new OAuth2Client();

// Allowed Google token issuers per docs
const ALLOWED_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * Verify a Google ID Token (RS256 signature check)
 */
async function verifyGoogleIdToken(idToken) {
    const ticket = await client.verifyIdToken({
        idToken,
        audience: AUDIENCES, // enforce audience match
    });

    const payload = ticket.getPayload();

    // Defense-in-depth: verify issuer
    if (!ALLOWED_ISSUERS.has(payload.iss)) {
        const err = new Error('invalid_issuer');
        err.code = 'INVALID_ISSUER';
        throw err;
    }

    return payload;
}

/**
 * Express middleware to verify Authorization: Bearer <id_token>
 */
module.exports = async function requireAuth(req, res, next) {
    const authHeader = req.header('Authorization') || '';
    const match = authHeader.match(/^Bearer (.+)$/);

    if (!match) {
        return res
            .status(401)
            .json({ error: 'missing_authorization', message: 'Authorization: Bearer <token> required' });
    }

    const token = match[1];

    try {
        const payload = await verifyGoogleIdToken(token);

        // Attach minimal user info to request
        req.user = {
            sub: payload.sub,
            email: payload.email,
            name: payload.name,
            picture: payload.picture,
            claims: payload,
        };

        next(); // token valid → continue to controller
    } catch (err) {
        console.error('Token verification failed:', err.message);
        return res
            .status(401)
            .json({ error: 'invalid_token', message: 'Google ID token verification failed' });
    }
};
