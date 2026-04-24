const express = require('express');
const router = express.Router();
const { protect, authorize, supplierFilter } = require('../middleware/auth');
const PurchaseOrder = require('../models/PurchaseOrder');
const InventorySnapshot = require('../models/InventorySnapshot');

// ── GET /api/purchase-orders ─────────────────────────────────
router.get('/', protect, supplierFilter, async (req, res) => {
  try {
    const filter = {};
    if (req.supplierFilter) filter.supplier = req.supplierFilter;
    if (req.query.status)   filter.status   = req.query.status;
    if (req.query.supplier) filter.supplier  = req.query.supplier.toUpperCase();
    if (req.query.asin)     filter.asin      = req.query.asin;

    const pos = await PurchaseOrder.find(filter)
      .populate('finalQtySetBy', 'name')
      .populate('confirmedBy',   'name')
      .populate('shippedBy',     'name')
      .populate('deliveredBy',   'name')
      .sort({ createdAt: -1 })
      .limit(500);

    res.json({ purchaseOrders: pos, total: pos.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/purchase-orders — Admin creates/updates Final Qty ──
router.post('/', protect, authorize('admin'), async (req, res) => {
  try {
    const { asin, finalQty, adminNotes } = req.body;
    if (!asin || finalQty === undefined) return res.status(400).json({ error: 'asin and finalQty required' });

    // Get context from latest snapshot
    const snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
    let ctx = {};
    if (snapshot) {
      const row = snapshot.rows.find(r => r.asin === asin);
      if (row) ctx = { companyDocAtCreation: row.companyDOC, whDocAtCreation: row.whDOC, drrAtCreation: row.totalDRR, suggestQty: row.suggestQty, ean: row.ean, sku: row.sku, title: row.title, supplier: row.supplier };
    }

    // Upsert: if draft PO exists for this ASIN, update it
    let po = await PurchaseOrder.findOne({ asin, status: { $in: ['draft', 'admin_approved'] } });
    if (po) {
      po.finalQty = finalQty;
      po.finalQtySetAt = new Date();
      po.finalQtySetBy = req.user._id;
      po.status = 'admin_approved';
      po.adminNotes = adminNotes || po.adminNotes;
      po.statusHistory.push({ status: 'admin_approved', changedBy: req.user._id, qty: finalQty, note: `Final qty set to ${finalQty}` });
    } else {
      po = new PurchaseOrder({
        asin, finalQty, adminNotes, ...ctx,
        status: 'admin_approved',
        finalQtySetAt: new Date(),
        finalQtySetBy: req.user._id,
        statusHistory: [{ status: 'admin_approved', changedBy: req.user._id, qty: finalQty, note: `Final qty set to ${finalQty}` }]
      });
    }
    await po.save();
    res.status(201).json({ purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /:id/confirm — Supplier confirms ───────────────────
router.patch('/:id/confirm', protect, authorize('admin', 'china_supplier', 'md_supplier'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (req.user.role === 'china_supplier' && po.supplier !== 'CHINA') return res.status(403).json({ error: 'Access denied' });
    if (req.user.role === 'md_supplier'    && po.supplier !== 'MD')    return res.status(403).json({ error: 'Access denied' });
    if (po.status !== 'admin_approved') return res.status(400).json({ error: `Cannot confirm PO with status: ${po.status}` });

    const { poConfirmType, confirmedQty, supplierNotes } = req.body;
    po.poConfirmType = poConfirmType || 'full';
    po.confirmedQty  = poConfirmType === 'full' ? po.finalQty : (parseInt(confirmedQty) || 0);
    po.confirmedAt   = new Date();
    po.confirmedBy   = req.user._id;
    po.status        = 'supplier_confirmed';
    po.supplierNotes = supplierNotes || '';
    po.statusHistory.push({ status: 'supplier_confirmed', changedBy: req.user._id, qty: po.confirmedQty, note: `${po.poConfirmType} confirmation` });
    await po.save();
    res.json({ purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /:id/ship — Supplier ships ─────────────────────────
router.patch('/:id/ship', protect, authorize('admin', 'china_supplier', 'md_supplier'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status !== 'supplier_confirmed') return res.status(400).json({ error: 'PO must be confirmed before shipping' });
    const { shippedQty, supplierNotes } = req.body;
    po.shippedQty  = parseInt(shippedQty) || 0;
    po.shippedAt   = new Date();
    po.shippedBy   = req.user._id;
    po.status      = 'shipped';
    if (supplierNotes) po.supplierNotes = supplierNotes;
    po.statusHistory.push({ status: 'shipped', changedBy: req.user._id, qty: po.shippedQty, note: `Shipped ${po.shippedQty} units` });
    await po.save();
    res.json({ purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /:id/deliver — Admin marks delivered ───────────────
router.patch('/:id/deliver', protect, authorize('admin'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status !== 'shipped') return res.status(400).json({ error: 'PO must be shipped before delivery' });
    const { deliveredQty, discrepancyNotes } = req.body;
    po.deliveredQty      = parseInt(deliveredQty) || po.shippedQty;
    po.deliveredAt       = new Date();
    po.deliveredBy       = req.user._id;
    po.discrepancyNotes  = discrepancyNotes || '';
    po.status            = 'delivered';
    po.statusHistory.push({ status: 'delivered', changedBy: req.user._id, qty: po.deliveredQty, note: discrepancyNotes || 'Delivered to warehouse' });
    await po.save();
    res.json({ purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /:id/reject — Admin rejects ────────────────────────
router.patch('/:id/reject', protect, authorize('admin'), async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    po.status = 'rejected';
    po.adminNotes = req.body.reason || 'Rejected by admin';
    po.statusHistory.push({ status: 'rejected', changedBy: req.user._id, note: req.body.reason });
    await po.save();
    res.json({ purchaseOrder: po });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /stats ────────────────────────────────────────────────
router.get('/stats', protect, supplierFilter, async (req, res) => {
  try {
    const matchFilter = req.supplierFilter ? { supplier: req.supplierFilter } : {};
    const stats = await PurchaseOrder.aggregate([
      { $match: matchFilter },
      { $group: { _id: { status: '$status', supplier: '$supplier' }, count: { $sum: 1 }, totalQty: { $sum: '$finalQty' } } }
    ]);
    res.json({ stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
