// services/planService.js
const redisClient = require('../models/redisClient');
const { computeETag, canonicalize } = require('../utils/etag');

const KEY_PREFIX = 'plan:';
function keyFor(id) { return `${KEY_PREFIX}${id}`; }

/**
 * Simple recursive deep merge:
 * - merges plain objects recursively
 * - arrays are replaced (not concatenated)
 * - other values overwrite
 */
function deepMerge(target, patch) {
    if (patch === null || typeof patch !== 'object') return patch;
    if (Array.isArray(patch)) return patch.slice();
    const out = Object.assign({}, target || {});
    for (const k of Object.keys(patch)) {
        if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
            out[k] = deepMerge(out[k], patch[k]);
        } else {
            out[k] = patch[k];
        }
    }
    return out;
}

/**
 * Create plan (fail if exists)
 * Stores a Redis string value containing { document, etag, createdAt, lastModified }
 * Use SET NX to avoid races.
 */
async function createPlan(document) {
    if (!document || !document.objectId) {
        const err = new Error('missing objectId');
        err.code = 'E_BAD_REQUEST';
        throw err;
    }

    const id = document.objectId;
    const key = keyFor(id);

    // Canonicalize document before hashing
    const canonicalDoc = canonicalize(document);
    const etag = computeETag(canonicalDoc); // should return quoted ETag like: "\"hex\""
    const nowIso = new Date().toISOString();

    const payload = {
        document,
        etag,
        createdAt: nowIso,
        lastModified: nowIso
    };

    // Use SET NX to ensure create-if-not-exist atomic
    const setResult = await redisClient.set(key, JSON.stringify(payload), { NX: true });
    if (setResult === null) {
        const err = new Error('resource exists');
        err.code = 'E_CONFLICT';
        err.objectId = id;
        throw err;
    }

    return { id, document, etag, lastModified: new Date(nowIso).toUTCString() };
}

async function getPlan(id) {
    const key = keyFor(id);
    const raw = await redisClient.get(key);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return {
        document: stored.document,
        etag: stored.etag,
        lastModified: new Date(stored.lastModified).toUTCString()
    };
}

/**
 * deletePlan(id, ifMatch)
 * - ifMatch required by controller; function enforces conditional delete and throws E_PRECONDITION on mismatch
 * - returns true when deleted
 */
async function deletePlan(id, ifMatch) {
    const key = keyFor(id);

    // Read current
    const raw = await redisClient.get(key);
    if (!raw) {
        const err = new Error('not found');
        err.code = 'E_NOT_FOUND';
        throw err;
    }
    const stored = JSON.parse(raw);
    const currentEtag = stored.etag;

    if (!ifMatch) {
        // If controller required If-Match, this branch shouldn't be hit. Keep guard for safety.
        const err = new Error('precondition required');
        err.code = 'E_PRECONDITION_REQUIRED';
        throw err;
    }

    if (ifMatch !== currentEtag) {
        const err = new Error('precondition failed');
        err.code = 'E_PRECONDITION';
        err.currentEtag = currentEtag;
        throw err;
    }

    // perform atomic delete using WATCH/MULTI/EXEC
    for (let attempt = 0; attempt < 3; attempt++) {
        await redisClient.watch(key);
        try {
            const currentRaw = await redisClient.get(key);
            if (!currentRaw) {
                await redisClient.unwatch();
                const err = new Error('not found');
                err.code = 'E_NOT_FOUND';
                throw err;
            }
            const after = JSON.parse(currentRaw);
            if (after.etag !== currentEtag) {
                await redisClient.unwatch();
                const err = new Error('precondition failed');
                err.code = 'E_PRECONDITION';
                err.currentEtag = after.etag;
                throw err;
            }

            const multi = redisClient.multi();
            multi.del(key);
            const execResult = await multi.exec();
            if (execResult === null) {
                // concurrent modification, retry
                continue;
            }
            // deleted
            return true;
        } finally {
            // ensure unwatch when we aborted or completed; if exec succeeded, unwatch is implicit but safe to call
            try { await redisClient.unwatch(); } catch (e) { /* ignore */ }
        }
    }

    // if retries exhausted
    const err = new Error('precondition failed');
    err.code = 'E_PRECONDITION';
    throw err;
}

/**
 * replacePlan(id, document, ifMatch)
 * - full replace
 * - if ifMatch provided and mismatches -> throw E_PRECONDITION
 * - if resource missing -> throw E_NOT_FOUND
 * NOTE: controller enforces presence of If-Match for updates (precondition required).
 */
async function replacePlan(id, document, ifMatch) {
    const key = keyFor(id);

    // Read current
    const raw = await redisClient.get(key);
    if (!raw) {
        const err = new Error('not found');
        err.code = 'E_NOT_FOUND';
        throw err;
    }

    const stored = JSON.parse(raw);
    const currentEtag = stored.etag;

    if (ifMatch && ifMatch !== currentEtag) {
        const err = new Error('precondition failed');
        err.code = 'E_PRECONDITION';
        err.currentEtag = currentEtag;
        throw err;
    }

    // prepare new payload
    const nowIso = new Date().toISOString();
    const canonicalDoc = canonicalize(document);
    const newEtag = computeETag(canonicalDoc);

    const payload = {
        document,
        etag: newEtag,
        createdAt: stored.createdAt || nowIso,
        lastModified: nowIso
    };

    // atomic replace with WATCH/MULTI/EXEC (retry loop)
    for (let attempt = 0; attempt < 3; attempt++) {
        await redisClient.watch(key);
        try {
            const currentRaw = await redisClient.get(key);
            if (!currentRaw) {
                await redisClient.unwatch();
                const err = new Error('not found');
                err.code = 'E_NOT_FOUND';
                throw err;
            }
            const after = JSON.parse(currentRaw);
            if (after.etag !== currentEtag) {
                await redisClient.unwatch();
                // another writer changed it — either retry or fail based on attempts
                // refresh currentEtag and retry
                // update currentEtag for next attempt:
                // but we'll re-read above at start of loop
                continue;
            }

            const multi = redisClient.multi();
            multi.set(key, JSON.stringify(payload));
            const execResult = await multi.exec();
            if (execResult === null) {
                // aborted due to concurrent change, retry
                continue;
            }
            // success
            return { id, document, etag: newEtag, lastModified: new Date(nowIso).toUTCString(), created: false };
        } finally {
            try { await redisClient.unwatch(); } catch (e) { /* ignore */ }
        }
    }

    const err = new Error('precondition failed');
    err.code = 'E_PRECONDITION';
    throw err;
}

/**
 * patchPlan(id, patch, ifMatch)
 * - merges stored.document with patch (recursive deep merge)
 * - enforces If-Match precondition if provided (controller requires it)
 * - returns updated document + metadata
 */
async function patchPlan(id, patch, ifMatch) {
    const key = keyFor(id);

    for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await redisClient.get(key);
        if (!raw) {
            const err = new Error('not found');
            err.code = 'E_NOT_FOUND';
            throw err;
        }

        const stored = JSON.parse(raw);
        const currentEtag = stored.etag;
        const currentDoc = stored.document;

        if (ifMatch && ifMatch !== currentEtag) {
            const err = new Error('precondition failed');
            err.code = 'E_PRECONDITION';
            err.currentEtag = currentEtag;
            throw err;
        }

        // merge recursively
        const updatedDoc = deepMerge(currentDoc, patch);
        // ensure objectId stable
        updatedDoc.objectId = id;

        const nowIso = new Date().toISOString();
        const canonicalDoc = canonicalize(updatedDoc);
        const newEtag = computeETag(canonicalDoc);

        const payload = {
            document: updatedDoc,
            etag: newEtag,
            createdAt: stored.createdAt || nowIso,
            lastModified: nowIso
        };

        // WATCH/MULTI/EXEC to ensure we apply only if currentEtag unchanged
        await redisClient.watch(key);
        try {
            const currentRaw = await redisClient.get(key);
            if (!currentRaw) {
                await redisClient.unwatch();
                const err = new Error('not found');
                err.code = 'E_NOT_FOUND';
                throw err;
            }
            const after = JSON.parse(currentRaw);
            if (after.etag !== currentEtag) {
                await redisClient.unwatch();
                // concurrent update: retry
                continue;
            }

            const multi = redisClient.multi();
            multi.set(key, JSON.stringify(payload));
            const execResult = await multi.exec();
            if (execResult === null) {
                // concurrent change - retry
                continue;
            }

            return { id, document: updatedDoc, etag: newEtag, lastModified: new Date(nowIso).toUTCString() };
        } finally {
            try { await redisClient.unwatch(); } catch (e) { /* ignore */ }
        }
    }

    const err = new Error('precondition failed');
    err.code = 'E_PRECONDITION';
    throw err;
}

module.exports = { createPlan, getPlan, deletePlan, replacePlan, patchPlan };
