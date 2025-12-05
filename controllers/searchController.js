// controllers/searchController.js
const elasticsearchService = require('../services/elasticsearchService');

/**
 * Search plans using Elasticsearch
 * Supports parent-child queries
 * 
 * GET /v1/search?q=<query>
 * POST /v1/search (with query body)
 */
const searchPlans = async (req, res) => {
    try {
        let query;

        if (req.method === 'GET') {
            // Simple query string search
            const q = req.query.q;
            if (!q) {
                return res.status(400).json({
                    error: 'missing_query',
                    message: 'Query parameter "q" is required'
                });
            }

            query = {
                query: {
                    bool: {
                        should: [
                            { match: { name: q } },
                            { match: { planType: q } },
                            { match: { objectType: q } },
                            { term: { _org: q } }
                        ]
                    }
                },
                size: req.query.size ? parseInt(req.query.size) : 20
            };
        } else {
            // POST with full Elasticsearch query
            query = req.body;

            if (!query || !query.query) {
                return res.status(400).json({
                    error: 'invalid_query',
                    message: 'Request body must contain a valid Elasticsearch query'
                });
            }
        }

        const results = await elasticsearchService.searchPlans(query);

        return res.status(200).json({
            total: results.total,
            hits: results.hits
        });
    } catch (err) {
        console.error('Search error:', err);

        if (err.meta && err.meta.body) {
            return res.status(400).json({
                error: 'search_failed',
                message: err.meta.body.error.reason || 'Search query failed'
            });
        }

        return res.status(500).json({ error: 'server_error' });
    }
};

/**
 * Get a plan with all its children from Elasticsearch
 * Shows parent-child relationships
 * 
 * GET /v1/search/plan/:id
 */
const getPlanWithChildren = async (req, res) => {
    try {
        const planId = req.params.id;
        const results = await elasticsearchService.getPlanWithChildren(planId);

        if (!results || results.length === 0) {
            return res.status(404).json({ error: 'not_found' });
        }

        return res.status(200).json({
            planId,
            documents: results
        });
    } catch (err) {
        console.error('Get plan with children error:', err);
        return res.status(500).json({ error: 'server_error' });
    }
};

/**
 * Search for plans that have children matching criteria
 * Example: Find plans with services having high deductibles
 * 
 * GET /v1/search/parent-child
 */
const searchParentChild = async (req, res) => {
    try {
        const { parentType, childType, childQuery, minDeductible, maxCopay, serviceName } = req.query;

        // Build has_child query dynamically
        let childQueryBody = { match_all: {} };

        if (minDeductible) {
            childQueryBody = {
                range: { deductible: { gte: parseInt(minDeductible) } }
            };
        } else if (maxCopay) {
            childQueryBody = {
                range: { copay: { lte: parseInt(maxCopay) } }
            };
        } else if (serviceName) {
            childQueryBody = {
                match: { name: serviceName }
            };
        } else if (childQuery) {
            childQueryBody = JSON.parse(childQuery);
        }

        const query = {
            query: {
                has_child: {
                    type: childType || 'planCostShares',
                    query: childQueryBody,
                    inner_hits: {
                        size: 10
                    }
                }
            },
            size: 20
        };

        const results = await elasticsearchService.searchPlans(query);

        return res.status(200).json({
            total: results.total,
            hits: results.hits
        });
    } catch (err) {
        console.error('Parent-child search error:', err);
        return res.status(500).json({ error: 'server_error' });
    }
};

/**
 * Search for child documents by their parent
 * 
 * GET /v1/search/children/:parentType/:parentId
 */
const searchByParent = async (req, res) => {
    try {
        const { parentType, parentId } = req.params;

        const query = {
            query: {
                has_parent: {
                    parent_type: parentType,
                    query: {
                        term: { objectId: parentId }
                    },
                    inner_hits: {}
                }
            },
            size: 50
        };

        const results = await elasticsearchService.searchPlans(query);

        return res.status(200).json({
            parentType,
            parentId,
            total: results.total,
            children: results.hits
        });
    } catch (err) {
        console.error('Search by parent error:', err);
        return res.status(500).json({ error: 'server_error' });
    }
};

module.exports = {
    searchPlans,
    getPlanWithChildren,
    searchParentChild,
    searchByParent
};
