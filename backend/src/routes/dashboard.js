// routes/dashboard.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const InventorySnapshot = require('../models/InventorySnapshot');
const PurchaseOrder = require('../models/PurchaseOrder');

// GET /api/dashboard/summary
router.get('/summary', protect, async (req, res) => {
  try {
    const snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
    const poStats  = await PurchaseOrder.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const poMap = {};
    poStats.forEach(p => { poMap[p._id] = p.count; });

    if (!snapshot) return res.json({ snapshot: null, poStats: poMap });

    const rows = snapshot.rows;
    const totalInv = rows.reduce((s, r) => s + (r.totalInv || 0), 0);
    const totalDRR = rows.reduce((s, r) => s + (r.totalDRR || 0), 0);

    res.json({
      skuCount:    rows.length,
      totalInv,
      companyDOC:  totalDRR > 0 ? parseFloat((totalInv / totalDRR).toFixed(1)) : 0,
      alerts: {
        critical:    rows.filter(r => r.alertLevel === 'critical').length,
        urgent:      rows.filter(r => r.alertLevel === 'urgent').length,
        po_required: rows.filter(r => r.alertLevel === 'po_required').length
      },
      poStats:  poMap,
      uploadedAt: snapshot.createdAt,
      fileName:   snapshot.fileName
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
