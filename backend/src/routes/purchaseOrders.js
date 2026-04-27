var express = require('express');
var router  = express.Router();
var protect = require('../middleware/auth').protect;
var authorize = require('../middleware/auth').authorize;
var supplierFilter = require('../middleware/auth').supplierFilter;
var PurchaseOrder = require('../models/PurchaseOrder');
var InventorySnapshot = require('../models/InventorySnapshot');

// ── GET /api/purchase-orders ─────────────────────────────────
router.get('/', protect, supplierFilter, async function(req, res) {
  try {
    var filter = {};
    if (req.supplierFilter) filter.supplier = req.supplierFilter;
    if (req.query.status)   filter.status   = req.query.status;
    if (req.query.supplier) filter.supplier  = req.query.supplier.toUpperCase();

    var pos = await PurchaseOrder.find(filter)
      .populate('finalQtySetBy', 'name')
      .populate('confirmedBy',   'name')
      .populate('shippedBy',     'name')
      .populate('deliveredBy',   'name')
      .sort({ createdAt: -1 })
      .limit(500);

    res.json({ purchaseOrders: pos, total: pos.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/purchase-orders — Admin sets Final Qty ─────────
router.post('/', protect, authorize('admin'), async function(req, res) {
  try {
    var asin = req.body.asin;
    var finalQty = req.body.finalQty;
    var adminNotes = req.body.adminNotes;

    if (!asin || finalQty === undefined) {
      return res.status(400).json({ error: 'asin and finalQty required' });
    }

    // Get context from latest snapshot
    var snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
    var ctx = { supplier: 'CHINA' };
    if (snapshot) {
      var row = snapshot.rows.find(function(r) { return r.asin === asin; });
      if (row) {
        ctx = {
          companyDocAtCreation: row.companyDOC,
          whDocAtCreation:      row.whDOC,
          drrAtCreation:        row.totalDRR,
          suggestQty:           row.suggestQty,
          ean:                  row.ean,
          sku:                  row.sku,
          title:                row.title,
          supplier:             row.supplier
        };
      }
    }

    // Upsert draft/admin_approved PO
    var po = await PurchaseOrder.findOne({
      asin: asin,
      status: { $in: ['draft', 'admin_approved'] }
    });

    if (po) {
      po.finalQty      = finalQty;
      po.finalQtySetAt = new Date();
      po.finalQtySetBy = req.user._id;
      po.status        = 'admin_approved';
      if (adminNotes) po.adminNotes = adminNotes;
      po.statusHistory.push({
        status: 'admin_approved', changedBy: req.user._id,
        qty: finalQty, note: 'Final qty set to ' + finalQty
      });
    } else {
      po = new PurchaseOrder(Object.assign({}, ctx, {
        asin:           asin,
        finalQty:       finalQty,
        adminNotes:     adminNotes,
        status:         'admin_approved',
        finalQtySetAt:  new Date(),
        finalQtySetBy:  req.user._id,
        statusHistory: [{
          status: 'admin_approved', changedBy: req.user._id,
          qty: finalQty, note: 'Final qty set to ' + finalQty
        }]
      }));
    }
    await po.save();
    res.status(201).json({ purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /:id/confirm — Supplier confirms PO ────────────────
router.patch('/:id/confirm', protect, authorize('admin', 'china_supplier', 'md_supplier'), async function(req, res) {
  try {
    var po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (req.user.role === 'china_supplier' && po.supplier !== 'CHINA')
      return res.status(403).json({ error: 'Access denied' });
    if (req.user.role === 'md_supplier' && po.supplier !== 'MD')
      return res.status(403).json({ error: 'Access denied' });
    if (po.status !== 'admin_approved')
      return res.status(400).json({ error: 'PO must be admin approved first' });

    var poConfirmType = req.body.poConfirmType || 'full';
    var confirmedQty = poConfirmType === 'full'
      ? po.finalQty
      : (parseInt(req.body.confirmedQty) || 0);

    po.poConfirmType  = poConfirmType;
    po.confirmedQty   = confirmedQty;
    po.confirmedAt    = new Date();
    po.confirmedBy    = req.user._id;
    po.status         = 'supplier_confirmed';
    if (req.body.supplierNotes) po.supplierNotes = req.body.supplierNotes;
    po.statusHistory.push({
      status: 'supplier_confirmed', changedBy: req.user._id,
      qty: confirmedQty, note: poConfirmType + ' confirmation — ' + confirmedQty + ' units'
    });
    await po.save();

    res.json({ purchaseOrder: po, message: confirmedQty + ' units moved to Manufacturing Inventory' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /:id/ship — Supplier ships ─────────────────────────
router.patch('/:id/ship', protect, authorize('admin', 'china_supplier', 'md_supplier'), async function(req, res) {
  try {
    var po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status !== 'supplier_confirmed')
      return res.status(400).json({ error: 'PO must be confirmed before shipping' });

    var shippedQty = parseInt(req.body.shippedQty) || 0;
    po.shippedQty    = shippedQty;
    po.shippedAt     = new Date();
    po.shippedBy     = req.user._id;
    po.status        = 'shipped';
    if (req.body.supplierNotes) po.supplierNotes = req.body.supplierNotes;
    po.statusHistory.push({
      status: 'shipped', changedBy: req.user._id,
      qty: shippedQty, note: 'Shipped ' + shippedQty + ' units — in transit to warehouse'
    });
    await po.save();

    res.json({ purchaseOrder: po, message: shippedQty + ' units now in transit' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /:id/deliver — Admin marks delivered ───────────────
// This automatically adds qty to warehouse inventory in the snapshot
router.patch('/:id/deliver', protect, authorize('admin'), async function(req, res) {
  try {
    var po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status !== 'shipped')
      return res.status(400).json({ error: 'PO must be shipped before delivery' });

    var deliveredQty = parseInt(req.body.deliveredQty) || po.shippedQty;
    po.deliveredQty     = deliveredQty;
    po.deliveredAt      = new Date();
    po.deliveredBy      = req.user._id;
    po.discrepancyNotes = req.body.discrepancyNotes || '';
    po.status           = 'delivered';
    po.statusHistory.push({
      status: 'delivered', changedBy: req.user._id,
      qty: deliveredQty, note: 'Delivered ' + deliveredQty + ' units to warehouse'
    });
    await po.save();

    // ── AUTO-UPDATE WAREHOUSE INVENTORY IN SNAPSHOT ──────────
    try {
      var snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
      if (snapshot) {
        var rowIndex = -1;
        for (var i = 0; i < snapshot.rows.length; i++) {
          if (snapshot.rows[i].asin === po.asin) { rowIndex = i; break; }
        }
        if (rowIndex >= 0) {
          // Add delivered qty to warehouse
          snapshot.rows[rowIndex].whInv = (snapshot.rows[rowIndex].whInv || 0) + deliveredQty;

          // Recalculate totals
          var r = snapshot.rows[rowIndex];
          var tDRR = (r.amzDRR||0) + (r.flkDRR||0) + (r.zptDRR||0) + (r.blkDRR||0);
          var tInv = (r.whInv||0) + (r.amzInv||0) + (r.flkInv||0) + (r.zptInv||0) + (r.blkInv||0) + (r.openPO||0) + (r.mfgQty||0);
          snapshot.rows[rowIndex].totalInv   = tInv;
          snapshot.rows[rowIndex].totalDRR   = tDRR;
          snapshot.rows[rowIndex].companyDOC = tDRR > 0 ? tInv / tDRR : null;
          snapshot.rows[rowIndex].whDOC      = tDRR > 0 ? ((r.whInv||0) + (r.openPO||0)) / tDRR : null;
          snapshot.rows[rowIndex].suggestQty = 0;
          snapshot.rows[rowIndex].actionType = 'no_action';
          snapshot.rows[rowIndex].actionDetails = 'Delivered ' + deliveredQty + ' units to warehouse';

          snapshot.markModified('rows');
          await snapshot.save();
        }
      }
    } catch (snapErr) {
      console.error('Snapshot update error (non-fatal):', snapErr.message);
    }

    res.json({
      purchaseOrder: po,
      message: deliveredQty + ' units added to warehouse inventory automatically'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /:id/reject ────────────────────────────────────────
router.patch('/:id/reject', protect, authorize('admin'), async function(req, res) {
  try {
    var po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    po.status = 'rejected';
    po.adminNotes = req.body.reason || 'Rejected by admin';
    po.statusHistory.push({
      status: 'rejected', changedBy: req.user._id, note: req.body.reason
    });
    await po.save();
    res.json({ purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /stats ────────────────────────────────────────────────
router.get('/stats', protect, supplierFilter, async function(req, res) {
  try {
    var matchFilter = req.supplierFilter ? { supplier: req.supplierFilter } : {};
    var stats = await PurchaseOrder.aggregate([
      { $match: matchFilter },
      { $group: {
        _id: { status: '$status', supplier: '$supplier' },
        count: { $sum: 1 },
        totalConfirmed: { $sum: '$confirmedQty' },
        totalShipped:   { $sum: '$shippedQty' },
        totalDelivered: { $sum: '$deliveredQty' }
      }}
    ]);
    res.json({ stats: stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
