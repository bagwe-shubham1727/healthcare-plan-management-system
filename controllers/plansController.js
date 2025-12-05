// controllers/planController.js
const planService = require('../services/planService');
const validator = require('../validators/planValidator');

/**
 * Helper to format AJV errors into friendlier shape
 */
function formatAjvErrors(errors) {
    if (!errors) return [];
    return errors.map(e => ({
        field: e.instancePath || e.schemaPath || '',
        message: e.message || ''
    }));
}

/**
 * POST /v1/plans
 * Create a plan. Validation enforced. 201 Created with Location, ETag, Last-Modified.
 */
const createPlan = async (req, res) => {
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'unsupported_media_type', message: 'Expected application/json' });
    }

    const payload = req.body;
    const valid = validator.validate(payload);
    if (!valid) {
        return res.status(400).json({
            error: 'validation_failed',
            details: formatAjvErrors(validator.errors())
        });
    }

    try {
        const result = await planService.createPlan(payload);
        // result: { id, document, etag, lastModified }
        return res.status(201)
            .location(`/v1/plans/${encodeURIComponent(result.id)}`)
            .set('ETag', result.etag)
            .set('Last-Modified', result.lastModified)
            .json(result.document);
    } catch (err) {
        if (err && err.code === 'E_CONFLICT') {
            return res.status(409).json({ error: 'resource_exists', objectId: err.objectId });
        }
        console.error('createPlan error:', err);
        return res.status(500).json({ error: 'server_error' });
    }
};

/**
 * GET /v1/plans/:id
 * Conditional read:
 *  - If-Match           => 412 if ETag mismatch
 *  - If-None-Match      => 304 Not Modified
 *  - If-Modified-Since  => 304 (fallback)
 * Otherwise return 200 with ETag + Last-Modified
 */
const getPlan = async (req, res) => {
    const id = req.params.id;

    try {
        const data = await planService.getPlan(id);
        if (!data) return res.status(404).json({ error: 'not_found' });

        const { document, etag, lastModified } = data;

        //If-Match (read precondition)
        const ifMatch = req.header('If-Match');
        console.log("etag:", etag);
        console.log("ifmatch:", ifMatch);
        if (ifMatch && ifMatch !== etag) {
            return res
                .status(412) // Precondition Failed
                .set('ETag', etag)
                .set('Last-Modified', lastModified)
                .json({
                    error: 'etag_mismatch',
                    message: 'Resource has changed since the version you have.',
                });
        }

        //If-None-Match (cache optimization)
        const ifNoneMatch = req.header('If-None-Match');
        if (ifNoneMatch && ifNoneMatch === etag) {
            return res.status(304).set('ETag', etag).set('Last-Modified', lastModified).end();
        }

        //If-Modified-Since (fallback check)
        const ifModifiedSince = req.header('If-Modified-Since');
        if (ifModifiedSince) {
            const imsDate = new Date(ifModifiedSince);
            const lmDate = new Date(lastModified);
            if (!isNaN(imsDate.getTime()) && lmDate <= imsDate) {
                return res.status(304).set('ETag', etag).set('Last-Modified', lastModified).end();
            }
        }

        //Full response (no preconditions triggered)
        return res.status(200).set('ETag', etag).set('Last-Modified', lastModified).json(document);
    } catch (err) {
        console.error('getPlan error:', err);
        return res.status(500).json({ error: 'server_error' });
    }
};


/**
 * DELETE /v1/plans/:id
 * Require If-Match header to perform conditional delete (prevent blind deletes).
 * If you want to allow unconditional delete, remove the If-Match requirement.
 */
const deletePlan = async (req, res) => {
    const id = req.params.id;
    // Require If-Match to avoid accidental deletes (change this policy if you prefer)
    const ifMatch = req.header('If-Match');
    if (!ifMatch) {
        return res.status(428).json({ error: 'precondition_required', message: 'If-Match header required for delete' });
    }

    try {
        const removed = await planService.deletePlan(id, ifMatch);
        // removed === true when deleted
        if (!removed) return res.status(404).json({ error: 'not_found' });
        return res.status(204).end();
    } catch (err) {
        if (err && err.code === 'E_PRECONDITION') {
            // ETag mismatch
            return res.status(412).json({ error: 'etag_mismatch', message: 'Resource has been modified', currentEtag: err.currentEtag });
        }
        if (err && err.code === 'E_NOT_FOUND') {
            return res.status(404).json({ error: 'not_found' });
        }
        console.error('deletePlan error:', err);
        return res.status(500).json({ error: 'server_error' });
    }
};

/**
 * PUT /v1/plans/:id
 * Full replace. Validation enforced. Requires If-Match header (conditional write).
 * If resource does not exist and server policy allows create, controller will respond 201.
 */
const updatePlan = async (req, res) => {
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'unsupported_media_type', message: 'Expected application/json' });
    }

    const id = req.params.id;
    const payload = req.body;

    // Ensure payload.objectId (if present) matches URL id
    if (payload.objectId && payload.objectId !== id) {
        return res.status(400).json({ error: 'objectId_mismatch', message: 'objectId in body must match URL id' });
    }
    payload.objectId = id;

    const valid = validator.validate(payload);
    if (!valid) {
        return res.status(400).json({
            error: 'validation_failed',
            details: formatAjvErrors(validator.errors())
        });
    }

    // Enforce conditional write for safety
    const ifMatch = req.header('If-Match');
    if (!ifMatch) {
        return res.status(428).json({ error: 'precondition_required', message: 'If-Match header required for update' });
    }

    try {
        // replacePlan should atomically check If-Match and update (throws E_PRECONDITION on mismatch)
        const result = await planService.replacePlan(id, payload, ifMatch);
        // result: { id, document, etag, lastModified, created }
        const status = result.created ? 201 : 200;
        return res.status(status)
            .set('ETag', result.etag)
            .set('Last-Modified', result.lastModified)
            .json(result.document);
    } catch (err) {
        if (err && err.code === 'E_PRECONDITION') {
            return res.status(412).json({ error: 'etag_mismatch', message: 'Resource has been modified', currentEtag: err.currentEtag });
        }
        if (err && err.code === 'E_NOT_FOUND') {
            return res.status(404).json({ error: 'not_found' });
        }
        console.error('updatePlan error:', err);
        return res.status(500).json({ error: 'server_error' });
    }
};

/**
 * PATCH /v1/plans/:id
 * Partial merge / JSON Merge Patch support. Requires If-Match header (conditional patch).
 * Uses planService.patchPlan which must do an atomic CAS.
 */
const patchPlan = async (req, res) => {
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'unsupported_media_type', message: 'Expected application/json' });
    }

    const payload = req.body;
    const valid = validator.validate(payload);
    if (!valid) {
        return res.status(400).json({
            error: 'validation_failed',
            details: formatAjvErrors(validator.errors())
        });
    }

    const id = req.params.id;
    const patch = req.body;

    // Prevent changing objectId
    if (patch.objectId && patch.objectId !== id) {
        return res.status(400).json({ error: 'objectId_mismatch', message: 'Cannot change objectId via patch' });
    }

    // Require If-Match for conditional patch
    const ifMatch = req.header('If-Match');
    if (!ifMatch) {
        return res.status(428).json({ error: 'precondition_required', message: 'If-Match header required for patch' });
    }

    try {
        const result = await planService.patchPlan(id, patch, ifMatch);
        if (!result) return res.status(404).json({ error: 'not_found' });

        return res.status(200)
            .set('ETag', result.etag)
            .set('Last-Modified', result.lastModified)
            .json(result.document);
    } catch (err) {
        if (err && err.code === 'E_PRECONDITION') {
            return res.status(412).json({ error: 'etag_mismatch', message: 'Resource has been modified', currentEtag: err.currentEtag });
        }
        if (err && err.code === 'E_NOT_FOUND') {
            return res.status(404).json({ error: 'not_found' });
        }
        console.error('patchPlan error:', err);
        return res.status(500).json({ error: 'server_error' });
    }
};

module.exports = {
    createPlan,
    getPlan,
    deletePlan,
    updatePlan,
    patchPlan
};
