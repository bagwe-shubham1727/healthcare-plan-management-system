
const crypto = require('crypto');

/**
 * canonicalize - recursively sort object keys so JSON.stringify is stable
 */
function canonicalize(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        return obj.map(canonicalize);
    }
    const keys = Object.keys(obj).sort();
    const out = {};
    for (const k of keys) {
        out[k] = canonicalize(obj[k]);
    }
    return out;
}

/**
 * computeETag - sha256 hash of canonical JSON
 * returns a strong ETag (no W/). Quoted string recommended by RFC.
 */
function computeETag(obj) {
    const json = JSON.stringify(obj);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    return `"${hash}"`;
}

module.exports = { canonicalize, computeETag };
