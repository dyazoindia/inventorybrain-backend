// routes/products.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Product = require('../models/Product');

router.get('/', protect, async (req, res) => {
  try {
    const filter = {};
    if (req.query.supplier) filter.supplier = req.query.supplier.toUpperCase();
    const products = await Product.find(filter).sort({ supplier: 1, sku: 1 });
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
