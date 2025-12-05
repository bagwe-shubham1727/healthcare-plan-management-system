// services/planService.js
const redisClient = require('../models/redisClient');
const { computeETag, canonicalize } = require('../utils/etag');
const rabbitmqService = require('./rabbitmqService');

// Keys are prefixed by objectType (e.g., plan:, memberCostShare:, planService:, service:)
function typeKeyFor(objectType, objectId) { return `${objectType}:${objectId}`; }

/**
 * Enhanced recursive deep merge with array merge support by objectId
 */
function deepMerge(target, patch) {
    if (patch === null || typeof patch !== 'object') return patch;

    if (Array.isArray(patch)) {
        // Smart array merge: merge by objectId if both are arrays with objectId items
        if (Array.isArray(target) && patch.length > 0 && patch[0] && patch[0].objectId) {
            const targetMap = new Map();
            target.forEach(item => {
                if (item && item.objectId) {
                    targetMap.set(item.objectId, item);
                }
            });

            patch.forEach(patchItem => {
                if (patchItem && patchItem.objectId) {
                    const existing = targetMap.get(patchItem.objectId);
                    if (existing) {
                        targetMap.set(patchItem.objectId, deepMerge(existing, patchItem));
                    } else {
                        targetMap.set(patchItem.objectId, patchItem);
                    }
                }
            });

            return Array.from(targetMap.values());
        }
        return patch.slice();
    }

    const out = Object.assign({}, target || {});
    for (const k of Object.keys(patch)) {
        if (patch[k] && typeof patch[k] === 'object') {
            out[k] = deepMerge(out[k], patch[k]);
        } else {
            out[k] = patch[k];
        }
    }
    return out;
}

/**
 * Extract all objectIds from a plan document (for cascaded operations)
 */
function extractAllObjectIds(document) {
    const objectIds = [];

    function traverse(obj, parentId = null) {
        if (!obj || typeof obj !== 'object') return;

        if (obj.objectId) {
            objectIds.push({
                objectId: obj.objectId,
                objectType: obj.objectType,
                parentId
            });
        }

        const currentId = obj.objectId || parentId;

        for (const key of Object.keys(obj)) {
            if (Array.isArray(obj[key])) {
                obj[key].forEach(item => traverse(item, currentId));
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                traverse(obj[key], currentId);
            }
        }
    }

    traverse(document);
    return objectIds;
}

/**
 * Store individual objects in Redis (for granular access)
 * Keys are prefixed by objectType (e.g., plan:, memberCostShare:, planService:, service:)
 * Stores only flat properties, not nested children
 * For the root plan object, also stores etag and timestamps
 */
function addObjectsToMulti(document, multi, metadata = {}) {
    const objects = extractAllObjectIds(document);
    const { etag, createdAt, lastModified } = metadata;

    function findObjectById(doc, targetId) {
        if (!doc || typeof doc !== 'object') return null;
        if (doc.objectId === targetId) return doc;

        for (const key of Object.keys(doc)) {
            if (Array.isArray(doc[key])) {
                for (const item of doc[key]) {
                    const found = findObjectById(item, targetId);
                    if (found) return found;
                }
            } else if (typeof doc[key] === 'object' && doc[key] !== null) {
                const found = findObjectById(doc[key], targetId);
                if (found) return found;
            }
        }
        return null;
    }

    // Flatten object - remove nested objects/arrays that have objectId
    function flattenObject(obj) {
        const flat = {};
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (Array.isArray(val)) {
                // Skip arrays of objects with objectId (these are children)
                if (val.length > 0 && val[0] && val[0].objectId) {
                    continue;
                }
                flat[key] = val;
            } else if (val && typeof val === 'object' && val.objectId) {
                // Skip nested objects with objectId (these are children)
                continue;
            } else {
                flat[key] = val;
            }
        }
        return flat;
    }

    for (const obj of objects) {
        const actualObj = findObjectById(document, obj.objectId);
        if (actualObj) {
            // Key is objectType:objectId (e.g., plan:12345, memberCostShare:67890)
            const key = typeKeyFor(obj.objectType, obj.objectId);

            const storedObj = {
                data: flattenObject(actualObj),
                parentId: obj.parentId,
                objectType: obj.objectType
            };

            // For root plan object, add metadata (etag, timestamps)
            if (obj.objectType === 'plan' && obj.parentId === null) {
                if (etag) storedObj.etag = etag;
                if (createdAt) storedObj.createdAt = createdAt;
                if (lastModified) storedObj.lastModified = lastModified;
            }

            multi.set(key, JSON.stringify(storedObj));
        }
    }
}

/**
 * Delete all objects associated with a plan from Redis
 */
function addDeleteObjectsToMulti(document, multi) {
    const objects = extractAllObjectIds(document);
    for (const obj of objects) {
        multi.del(typeKeyFor(obj.objectType, obj.objectId));
    }
}

/**
 * Reconstruct full plan document from individual objects in Redis
 * Keys are prefixed by objectType (e.g., plan:, memberCostShare:, planService:, service:)
 */
async function reconstructPlanFromObjects(planId) {
    try {
        // Get the root plan object first
        const planKey = typeKeyFor('plan', planId);
        const planRaw = await redisClient.get(planKey);
        if (!planRaw) return null;

        // Get all keys that match the pattern objectType:objectId
        const keys = await redisClient.keys('*');
        if (!keys || keys.length === 0) return null;

        // Filter to only keys with colon (objectType:objectId format)
        const validKeys = keys.filter(k => k.includes(':'));
        if (validKeys.length === 0) return null;

        // Fetch all objects
        const values = await redisClient.mGet(validKeys);

        // Build object map
        const objectMap = new Map();
        const childrenMap = new Map(); // parentId -> children

        for (let i = 0; i < validKeys.length; i++) {
            const raw = values[i];
            if (!raw) continue;

            try {
                const stored = JSON.parse(raw);
                if (!stored.data || !stored.data.objectId) continue;

                const objectId = stored.data.objectId;
                objectMap.set(objectId, stored);

                if (stored.parentId) {
                    if (!childrenMap.has(stored.parentId)) {
                        childrenMap.set(stored.parentId, []);
                    }
                    childrenMap.get(stored.parentId).push(stored);
                }
            } catch (parseErr) {
                // Skip non-JSON values
                continue;
            }
        }

        // Find root plan object
        const rootStored = objectMap.get(planId);
        if (!rootStored) return null;

        // Recursively build document
        function buildDocument(stored) {
            const data = { ...stored.data };
            const children = childrenMap.get(data.objectId) || [];

            for (const child of children) {
                const childDoc = buildDocument(child);
                const childType = child.objectType;

                // Determine field name based on objectType
                let fieldName;
                if (childType === 'membercostshare') {
                    // Check if this is planCostShares or planserviceCostShares based on parent
                    if (stored.objectType === 'plan') {
                        fieldName = 'planCostShares';
                    } else {
                        fieldName = 'planserviceCostShares';
                    }
                } else if (childType === 'planservice') {
                    fieldName = 'linkedPlanServices';
                } else if (childType === 'service') {
                    fieldName = 'linkedService';
                } else {
                    fieldName = childType;
                }

                // Handle arrays vs single objects
                if (fieldName === 'linkedPlanServices') {
                    if (!data[fieldName]) data[fieldName] = [];
                    data[fieldName].push(childDoc);
                } else {
                    data[fieldName] = childDoc;
                }
            }

            return data;
        }

        return buildDocument(rootStored);
    } catch (err) {
        console.error('Error reconstructing plan:', err);
        throw err;
    }
}

/**
 * Create plan (fail if exists)
 * Stores individual objects in Redis with objectType:objectId keys
 * Publishes to queue for Elasticsearch indexing
 */
async function createPlan(document) {
    if (!document || !document.objectId) {
        const err = new Error('missing objectId');
        err.code = 'E_BAD_REQUEST';
        throw err;
    }

    const id = document.objectId;
    const planKey = typeKeyFor('plan', id);

    const canonicalDoc = canonicalize(document);
    const etag = computeETag(canonicalDoc);
    const nowIso = new Date().toISOString();

    // Atomic create with WATCH/MULTI
    await redisClient.watch(planKey);
    try {
        const exists = await redisClient.get(planKey);
        if (exists) {
            await redisClient.unwatch();
            const err = new Error('resource exists');
            err.code = 'E_CONFLICT';
            err.objectId = id;
            throw err;
        }

        const multi = redisClient.multi();
        // Store individual objects with metadata for root plan
        addObjectsToMulti(document, multi, { etag, createdAt: nowIso, lastModified: nowIso });

        const execResult = await multi.exec();
        if (execResult === null) {
            const err = new Error('resource exists');
            err.code = 'E_CONFLICT';
            err.objectId = id;
            throw err;
        }
    } finally {
        try { await redisClient.unwatch(); } catch (e) { /* ignore */ }
    }

    // Publish to queue for Elasticsearch indexing
    try {
        await rabbitmqService.publishIndexOperation(document);
    } catch (queueError) {
        console.error('Failed to publish to queue:', queueError.message);
    }

    return { id, document, etag, lastModified: new Date(nowIso).toUTCString() };
}

/**
 * Get plan by ID - reconstructs from individual objects
 */
async function getPlan(id) {
    const planKey = typeKeyFor('plan', id);
    const planRaw = await redisClient.get(planKey);
    if (!planRaw) return null;

    const planStored = JSON.parse(planRaw);

    // Reconstruct document from individual objects
    const document = await reconstructPlanFromObjects(id);
    if (!document) return null;

    return {
        document,
        etag: planStored.etag || '"unknown"',
        lastModified: planStored.lastModified
            ? new Date(planStored.lastModified).toUTCString()
            : new Date().toUTCString()
    };
}

/**
 * Cascaded delete - removes plan and all child objects from Redis and Elasticsearch
 */
async function deletePlan(id, ifMatch) {
    const planKey = typeKeyFor('plan', id);

    const planRaw = await redisClient.get(planKey);
    if (!planRaw) {
        const err = new Error('not found');
        err.code = 'E_NOT_FOUND';
        throw err;
    }
    const planStored = JSON.parse(planRaw);
    const currentEtag = planStored.etag;

    if (!ifMatch) {
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

    // Reconstruct document to get all object IDs for deletion
    const document = await reconstructPlanFromObjects(id);
    if (!document) {
        const err = new Error('not found');
        err.code = 'E_NOT_FOUND';
        throw err;
    }

    // Atomic cascaded delete with WATCH/MULTI/EXEC
    for (let attempt = 0; attempt < 3; attempt++) {
        await redisClient.watch(planKey);
        try {
            const currentPlanRaw = await redisClient.get(planKey);
            if (!currentPlanRaw) {
                await redisClient.unwatch();
                const err = new Error('not found');
                err.code = 'E_NOT_FOUND';
                throw err;
            }

            const afterPlan = JSON.parse(currentPlanRaw);
            if (afterPlan.etag !== currentEtag) {
                await redisClient.unwatch();
                const err = new Error('precondition failed');
                err.code = 'E_PRECONDITION';
                err.currentEtag = afterPlan.etag;
                throw err;
            }

            const multi = redisClient.multi();
            addDeleteObjectsToMulti(document, multi);

            const execResult = await multi.exec();
            if (execResult === null) {
                continue;
            }

            // Publish delete to queue for Elasticsearch
            try {
                await rabbitmqService.publishDeleteOperation(id);
            } catch (queueError) {
                console.error('Failed to publish delete to queue:', queueError.message);
            }

            return true;
        } finally {
            try { await redisClient.unwatch(); } catch (e) { /* ignore */ }
        }
    }

    const err = new Error('precondition failed');
    err.code = 'E_PRECONDITION';
    throw err;
}

/**
 * Patch plan with merge support
 * Deep merges patch into document, updates Redis, publishes to queue for ES update
 */
async function patchPlan(id, patch, ifMatch) {
    const planKey = typeKeyFor('plan', id);

    for (let attempt = 0; attempt < 3; attempt++) {
        const planRaw = await redisClient.get(planKey);
        if (!planRaw) {
            const err = new Error('not found');
            err.code = 'E_NOT_FOUND';
            throw err;
        }

        const planStored = JSON.parse(planRaw);
        const currentEtag = planStored.etag;

        // Reconstruct current document from individual objects
        const currentDoc = await reconstructPlanFromObjects(id);
        if (!currentDoc) {
            const err = new Error('not found');
            err.code = 'E_NOT_FOUND';
            throw err;
        }

        if (ifMatch && ifMatch !== currentEtag) {
            const err = new Error('precondition failed');
            err.code = 'E_PRECONDITION';
            err.currentEtag = currentEtag;
            throw err;
        }

        // Deep merge patch into current document
        const updatedDoc = deepMerge(currentDoc, patch);
        updatedDoc.objectId = id;

        const nowIso = new Date().toISOString();
        const canonicalDoc = canonicalize(updatedDoc);
        const newEtag = computeETag(canonicalDoc);

        await redisClient.watch(planKey);
        try {
            const currentPlanRaw = await redisClient.get(planKey);
            if (!currentPlanRaw) {
                await redisClient.unwatch();
                const err = new Error('not found');
                err.code = 'E_NOT_FOUND';
                throw err;
            }

            const afterPlan = JSON.parse(currentPlanRaw);
            if (afterPlan.etag !== currentEtag) {
                await redisClient.unwatch();
                continue;
            }

            const multi = redisClient.multi();
            // Update individual objects with new metadata
            addObjectsToMulti(updatedDoc, multi, {
                etag: newEtag,
                createdAt: planStored.createdAt || nowIso,
                lastModified: nowIso
            });

            const execResult = await multi.exec();
            if (execResult === null) {
                continue;
            }

            // Publish update to queue for Elasticsearch
            try {
                await rabbitmqService.publishUpdateOperation(updatedDoc);
            } catch (queueError) {
                console.error('Failed to publish update to queue:', queueError.message);
            }

            return {
                id,
                document: updatedDoc,
                etag: newEtag,
                lastModified: new Date(nowIso).toUTCString()
            };
        } finally {
            try { await redisClient.unwatch(); } catch (e) { /* ignore */ }
        }
    }

    const err = new Error('precondition failed');
    err.code = 'E_PRECONDITION';
    throw err;
}

/**
 * Get a specific nested object by objectId
 * Searches across all objectType prefixes
 */
async function getObject(objectId) {
    // Search across known objectTypes
    const types = ['plan', 'membercostshare', 'planservice', 'service'];
    for (const type of types) {
        const raw = await redisClient.get(typeKeyFor(type, objectId));
        if (raw) return JSON.parse(raw);
    }
    return null;
}

module.exports = {
    createPlan,
    getPlan,
    deletePlan,
    patchPlan,
    getObject,
    extractAllObjectIds
};