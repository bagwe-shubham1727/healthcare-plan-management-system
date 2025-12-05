// routes/search.js
const express = require('express');
const router = express.Router();
const searchController = require('../controllers/searchController');
const requireAuth = require('../middleware/authGoogle');

// Apply authentication middleware to all search routes
router.use(requireAuth);

// GET /v1/search?q=<query> - Simple search
router.get('/', searchController.searchPlans);

// POST /v1/search - Advanced search with Elasticsearch query body
router.post('/', searchController.searchPlans);

// GET /v1/search/plan/:id - Get plan with all children (parent-child view)
router.get('/plan/:id', searchController.getPlanWithChildren);

// GET /v1/search/parent-child - Search using parent-child relationships
router.get('/parent-child', searchController.searchParentChild);

// GET /v1/search/children/:parentType/:parentId - Get children by parent
router.get('/children/:parentType/:parentId', searchController.searchByParent);

module.exports = router;
