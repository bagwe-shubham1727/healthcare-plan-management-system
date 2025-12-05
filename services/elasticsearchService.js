// services/elasticsearchService.js
const { Client } = require('@elastic/elasticsearch');

const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const INDEX_NAME = process.env.ES_INDEX_NAME || 'healthcare_plans';

let client = null;

/**
 * Initialize Elasticsearch client
 */
function getClient() {
    if (!client) {
        client = new Client({
            node: ELASTICSEARCH_URL,
            maxRetries: 5,
            requestTimeout: 60000,
            sniffOnStart: false,
        });
    }
    return client;
}

/**
 * Create index with parent-child (join field) mapping
 * This enables parent-child relationships in Elasticsearch
 */
async function createIndexWithMapping() {
    const esClient = getClient();

    const indexExists = await esClient.indices.exists({ index: INDEX_NAME });

    if (indexExists) {
        console.log(`Index '${INDEX_NAME}' already exists`);
        return;
    }

    // Parent-Child mapping using join field
    // Hierarchy: plan -> planCostShares, linkedPlanServices -> linkedService, planserviceCostShares
    const mapping = {
        settings: {
            number_of_shards: 1,
            number_of_replicas: 0,
            index: {
                max_result_window: 50000
            }
        },
        mappings: {
            properties: {
                // Join field for parent-child relationship
                plan_join: {
                    type: 'join',
                    relations: {
                        plan: ['planCostShares', 'linkedPlanServices'],
                        linkedPlanServices: ['linkedService', 'planserviceCostShares']
                    }
                },
                // Common fields
                objectId: { type: 'keyword' },
                objectType: { type: 'keyword' },
                _org: { type: 'keyword' },

                // Plan specific fields
                planType: { type: 'keyword' },
                creationDate: { type: 'keyword' },

                // Cost share fields (for planCostShares and planserviceCostShares)
                deductible: { type: 'integer' },
                copay: { type: 'integer' },

                // Service fields
                name: { type: 'text', fields: { keyword: { type: 'keyword' } } }
            }
        }
    };

    await esClient.indices.create({
        index: INDEX_NAME,
        body: mapping
    });

    console.log(`Index '${INDEX_NAME}' created with parent-child mapping`);
}

/**
 * Index a plan document with all its children
 * Uses bulk API for efficiency
 */
async function indexPlan(planDocument) {
    const esClient = getClient();
    const operations = [];
    const planId = planDocument.objectId;

    // 1. Index the parent plan document
    operations.push({
        index: {
            _index: INDEX_NAME,
            _id: planId,
            routing: planId // All children will use same routing
        }
    });
    operations.push({
        objectId: planDocument.objectId,
        objectType: planDocument.objectType,
        _org: planDocument._org,
        planType: planDocument.planType,
        creationDate: planDocument.creationDate,
        plan_join: {
            name: 'plan'
        }
    });

    // 2. Index planCostShares as child of plan
    if (planDocument.planCostShares) {
        const costShare = planDocument.planCostShares;
        operations.push({
            index: {
                _index: INDEX_NAME,
                _id: costShare.objectId,
                routing: planId
            }
        });
        operations.push({
            objectId: costShare.objectId,
            objectType: costShare.objectType,
            _org: costShare._org,
            deductible: costShare.deductible,
            copay: costShare.copay,
            plan_join: {
                name: 'planCostShares',
                parent: planId
            }
        });
    }

    // 3. Index linkedPlanServices and their children
    if (planDocument.linkedPlanServices && Array.isArray(planDocument.linkedPlanServices)) {
        for (const planService of planDocument.linkedPlanServices) {
            const planServiceId = planService.objectId;

            // Index planService as child of plan
            operations.push({
                index: {
                    _index: INDEX_NAME,
                    _id: planServiceId,
                    routing: planId
                }
            });
            operations.push({
                objectId: planService.objectId,
                objectType: planService.objectType,
                _org: planService._org,
                plan_join: {
                    name: 'linkedPlanServices',
                    parent: planId
                }
            });

            // Index linkedService as child of planService
            if (planService.linkedService) {
                const service = planService.linkedService;
                operations.push({
                    index: {
                        _index: INDEX_NAME,
                        _id: service.objectId,
                        routing: planId
                    }
                });
                operations.push({
                    objectId: service.objectId,
                    objectType: service.objectType,
                    _org: service._org,
                    name: service.name,
                    plan_join: {
                        name: 'linkedService',
                        parent: planServiceId
                    }
                });
            }

            // Index planserviceCostShares as child of planService
            if (planService.planserviceCostShares) {
                const serviceCostShare = planService.planserviceCostShares;
                operations.push({
                    index: {
                        _index: INDEX_NAME,
                        _id: serviceCostShare.objectId,
                        routing: planId
                    }
                });
                operations.push({
                    objectId: serviceCostShare.objectId,
                    objectType: serviceCostShare.objectType,
                    _org: serviceCostShare._org,
                    deductible: serviceCostShare.deductible,
                    copay: serviceCostShare.copay,
                    plan_join: {
                        name: 'planserviceCostShares',
                        parent: planServiceId
                    }
                });
            }
        }
    }

    // Execute bulk operation
    if (operations.length > 0) {
        const bulkResponse = await esClient.bulk({
            refresh: true,
            operations
        });

        if (bulkResponse.errors) {
            const erroredDocuments = [];
            bulkResponse.items.forEach((action, i) => {
                const operation = Object.keys(action)[0];
                if (action[operation].error) {
                    erroredDocuments.push({
                        status: action[operation].status,
                        error: action[operation].error,
                        operation: operations[i * 2],
                        document: operations[i * 2 + 1]
                    });
                }
            });
            console.error('Bulk indexing errors:', erroredDocuments);
            throw new Error('Bulk indexing failed');
        }

        console.log(`Indexed plan ${planId} with ${operations.length / 2} documents`);
    }

    return { indexed: operations.length / 2, planId };
}

/**
 * Delete a plan and all its children from the index
 * All documents for a plan share the same routing key (planId)
 * So we can delete all documents with that routing
 */
async function deletePlan(planId) {
    const esClient = getClient();

    // Delete ALL documents with this routing (plan and all children share same routing)
    const response = await esClient.deleteByQuery({
        index: INDEX_NAME,
        routing: planId,
        refresh: true,
        conflicts: 'proceed',
        body: {
            query: {
                match_all: {}
            }
        }
    });

    console.log(`Deleted ${response.deleted} documents for plan ${planId}`);
    return { deleted: response.deleted, planId };
}

/**
 * Update/re-index a plan (used after PATCH operations)
 * Deletes existing and re-indexes with new data
 */
async function updatePlan(planDocument) {
    const planId = planDocument.objectId;

    // Delete existing documents for this plan
    await deletePlan(planId);

    // Re-index with updated data
    return await indexPlan(planDocument);
}

/**
 * Search plans with support for parent-child queries
 */
async function searchPlans(query) {
    const esClient = getClient();

    const response = await esClient.search({
        index: INDEX_NAME,
        body: query
    });

    return {
        total: response.hits.total.value,
        hits: response.hits.hits.map(hit => ({
            id: hit._id,
            score: hit._score,
            source: hit._source,
            innerHits: hit.inner_hits
        }))
    };
}

/**
 * Get all children of a plan
 */
async function getPlanWithChildren(planId) {
    const esClient = getClient();

    const response = await esClient.search({
        index: INDEX_NAME,
        routing: planId,
        body: {
            query: {
                bool: {
                    should: [
                        { term: { objectId: planId } },
                        {
                            has_parent: {
                                parent_type: 'plan',
                                query: { term: { objectId: planId } },
                                inner_hits: {}
                            }
                        }
                    ]
                }
            },
            size: 100
        }
    });

    return response.hits.hits.map(hit => ({
        id: hit._id,
        source: hit._source
    }));
}

/**
 * Health check for Elasticsearch
 */
async function healthCheck() {
    try {
        const esClient = getClient();
        const health = await esClient.cluster.health();
        return { status: 'connected', cluster: health };
    } catch (error) {
        return { status: 'disconnected', error: error.message };
    }
}

/**
 * Initialize the service - create index if not exists
 */
async function initialize() {
    try {
        await createIndexWithMapping();
        console.log('Elasticsearch service initialized');
    } catch (error) {
        console.error('Failed to initialize Elasticsearch:', error.message);
        // Don't throw - allow app to start even if ES is not available
    }
}

module.exports = {
    getClient,
    createIndexWithMapping,
    indexPlan,
    deletePlan,
    updatePlan,
    searchPlans,
    getPlanWithChildren,
    healthCheck,
    initialize,
    INDEX_NAME
};
