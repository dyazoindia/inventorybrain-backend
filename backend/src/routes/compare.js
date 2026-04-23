const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const InventorySnapshot = require('../models/InventorySnapshot');
const { compareSnapshots } = require('../utils/calculations');

// GET /api/compare/latest  — compare last 2 snapshots
router.get('/latest', protect, async (req, res) => {
  try {
    const snapshots = await InventorySnapshot.find()
      .sort({ createdAt: -1 })
      .limit(2);

    if (snapshots.length < 2) {
      return res.json({
        available: false,
        message: 'Need at least 2 uploads to compare. Upload another Excel file.',
        snapshotCount: snapshots.length
      });
    }

    const [latest, previous] = snapshots;
    const comparison = compareSnapshots(previous, latest);

    res.json({
      available:   true,
      latestDate:  latest.createdAt,
      previousDate: previous.createdAt,
      latestFile:  latest.fileName,
      previousFile: previous.fileName,
      comparison
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/compare/:id1/:id2  — compare two specific snapshots
router.get('/:id1/:id2', protect, async (req, res) => {
  try {
    const [s1, s2] = await Promise.all([
      InventorySnapshot.findById(req.params.id1),
      InventorySnapshot.findById(req.params.id2)
    ]);
    if (!s1 || !s2) return res.status(404).json({ error: 'One or both snapshots not found' });

    // s2 is "previous", s1 is "latest"
    const comparison = compareSnapshots(s2, s1);
    res.json({
      available:    true,
      latestDate:   s1.createdAt,
      previousDate: s2.createdAt,
      comparison
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
