const express = require('express');
const router = express.Router();
const { protect, supplierFilter } = require('../middleware/auth');
const InventorySnapshot = require('../models/InventorySnapshot');

// GET /api/inventory/latest  — latest snapshot rows (role-filtered)
router.get('/latest', protect, supplierFilter, async (req, res) => {
  try {
    const snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
    if (!snapshot) return res.json({ rows: [], snapshot: null });

    let rows = snapshot.rows;
    if (req.supplierFilter) {
      rows = rows.filter(r => r.supplier === req.supplierFilter);
    }

    // Apply query filters
    const { supplier, category, alert, health, search } = req.query;
    if (supplier)  rows = rows.filter(r => r.supplier === supplier.toUpperCase());
    if (category)  rows = rows.filter(r => r.category === category);
    if (alert)     rows = rows.filter(r => r.alertLevel === alert);
    if (health)    rows = rows.filter(r => r.healthStatus === health);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.asin?.toLowerCase().includes(q) ||
        r.sku?.toLowerCase().includes(q)  ||
        r.title?.toLowerCase().includes(q)||
        r.ean?.toLowerCase().includes(q)
      );
    }

    res.json({
      rows,
      snapshotId:  snapshot._id,
      uploadedAt:  snapshot.createdAt,
      fileName:    snapshot.fileName,
      totalRows:   snapshot.rows.length,
      filteredRows: rows.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/snapshots  — list all uploads (admin only)
router.get('/snapshots', protect, async (req, res) => {
  try {
    const snapshots = await InventorySnapshot.find()
      .select('fileName rowCount createdAt uploadedBy')
      .populate('uploadedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json({ snapshots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/snapshot/:id  — specific snapshot
router.get('/snapshot/:id', protect, supplierFilter, async (req, res) => {
  try {
    const snapshot = await InventorySnapshot.findById(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
    let rows = snapshot.rows;
    if (req.supplierFilter) rows = rows.filter(r => r.supplier === req.supplierFilter);
    res.json({ rows, snapshotId: snapshot._id, uploadedAt: snapshot.createdAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/dashboard-stats  — KPI summary
router.get('/dashboard-stats', protect, supplierFilter, async (req, res) => {
  try {
    const snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
    if (!snapshot) return res.json({ stats: null });

    let rows = snapshot.rows;
    if (req.supplierFilter) rows = rows.filter(r => r.supplier === req.supplierFilter);

    const totalInv    = rows.reduce((s, r) => s + (r.totalInv || 0), 0);
    const totalDRR    = rows.reduce((s, r) => s + (r.totalDRR || 0), 0);
    const companyDOC  = totalDRR > 0 ? totalInv / totalDRR : 0;

    const health = { healthy: 0, slow_moving: 0, overstock: 0, dead_inventory: 0 };
    rows.forEach(r => { if (health[r.healthStatus] !== undefined) health[r.healthStatus]++; });

    const alerts = {
      critical:    rows.filter(r => r.alertLevel === 'critical').length,
      urgent:      rows.filter(r => r.alertLevel === 'urgent').length,
      po_required: rows.filter(r => r.alertLevel === 'po_required').length,
      ok:          rows.filter(r => r.alertLevel === 'ok').length
    };

    const platforms = ['AMZ', 'FLK', 'ZPT', 'BLK'];
    const platformStats = {};
    platforms.forEach(p => {
      const key = p.toLowerCase() + 'DOC';
      const valid = rows.filter(r => r[key] !== null);
      const avg   = valid.length ? valid.reduce((s, r) => s + r[key], 0) / valid.length : null;
      platformStats[p] = {
        avgDOC: avg,
        oosRisk: rows.filter(r => r[key] !== null && r[key] < 7).length,
        urgent:  rows.filter(r => r[key] !== null && r[key] >= 7 && r[key] < 15).length
      };
    });

    const supplierStats = {};
    ['CHINA', 'MD'].forEach(sup => {
      const sr = rows.filter(r => r.supplier === sup);
      supplierStats[sup] = {
        total:   sr.length,
        needPO:  sr.filter(r => r.actionRequired === 'need_po').length,
        stockOk: sr.filter(r => r.actionRequired === 'stock_ok' || r.actionRequired === 'no_need').length
      };
    });

    res.json({
      totalSKUs: rows.length,
      totalInv,
      totalDRR: parseFloat(totalDRR.toFixed(1)),
      companyDOC: parseFloat(companyDOC.toFixed(1)),
      health,
      alerts,
      platformStats,
      supplierStats,
      uploadedAt: snapshot.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
