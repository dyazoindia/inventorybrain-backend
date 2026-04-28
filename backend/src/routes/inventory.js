var express = require('express');
var router = express.Router();
var protect = require('../middleware/auth').protect;
var supplierFilter = require('../middleware/auth').supplierFilter;
var InventorySnapshot = require('../models/InventorySnapshot');
var PurchaseOrder = require('../models/PurchaseOrder');

function mergeRowWithPO(row, po) {
  // Copy row
  var r = {};
  var keys = Object.keys(row);
  for (var i = 0; i < keys.length; i++) { r[keys[i]] = row[keys[i]]; }

  if (!po) return r;

  // ── STAGE 1: admin_approved ───────────────────────────────
  // Final qty set by admin — nothing moves yet
  if (po.status === 'admin_approved') {
    r.actionType    = 'supplier_po_inprogress';
    r.actionDetails = 'Final Qty set: ' + (po.finalQty || 0) + ' units — awaiting supplier confirmation';
    // suggestQty stays as-is until confirmed
  }

  // ── STAGE 2: supplier_confirmed ──────────────────────────
  // Confirmed qty MOVES to Mfg Qty — THIS IS THE KEY FIX
  if (po.status === 'supplier_confirmed') {
    var confirmed = po.confirmedQty || 0;
    r.mfgQty     = (r.mfgQty || 0) + confirmed;
    r.actionType = 'supplier_po_inprogress';
    r.actionDetails = 'In Manufacturing: ' + confirmed + ' units confirmed';
  }

  // ── STAGE 3: shipped ─────────────────────────────────────
  // Shipped qty moves from Mfg → In Transit
  if (po.status === 'shipped') {
    var shipped    = po.shippedQty   || 0;
    var confirmed2 = po.confirmedQty || 0;
    var inMfg      = Math.max(0, confirmed2 - shipped);
    r.mfgQty     = (r.mfgQty || 0) + inMfg;    // remaining in mfg
    r.inTransit  = (r.inTransit || 0) + shipped; // shipped to transit
    r.actionType = 'supplier_po_inprogress';
    r.actionDetails = 'In Transit: ' + shipped + ' units' + (inMfg > 0 ? ' | Manufacturing: ' + inMfg : '');
  }

  // ── STAGE 4: delivered ────────────────────────────────────
  // Already written to snapshot by purchaseOrders.js deliver endpoint
  // DO NOT add again here — just update action
  if (po.status === 'delivered') {
    r.actionType    = 'no_action';
    r.actionDetails = 'Delivered: ' + (po.deliveredQty || 0) + ' units added to warehouse';
    r.suggestQty    = 0;
  }

  // ── RECALCULATE TOTALS after mfgQty/inTransit added ──────
  var tDRR = (r.amzDRR || 0) + (r.flkDRR || 0) + (r.zptDRR || 0) + (r.blkDRR || 0);
  var tInv = (r.whInv     || 0)
           + (r.amzInv    || 0)
           + (r.flkInv    || 0)
           + (r.zptInv    || 0)
           + (r.blkInv    || 0)
           + (r.openPO    || 0)
           + (r.mfgQty    || 0)  // ← confirmed qty now included
           + (r.inTransit || 0); // ← shipped qty now included

  r.totalInv   = tInv;
  r.totalDRR   = tDRR;
  r.companyDOC = tDRR > 0 ? tInv / tDRR : null;
  r.whDOC      = tDRR > 0
    ? ((r.whInv || 0) + (r.openPO || 0) + (r.mfgQty || 0) + (r.inTransit || 0)) / tDRR
    : null;

  // ── RECALCULATE SUGGEST QTY ───────────────────────────────
  // Once supplier confirms, mfgQty is included in company inv
  // so suggestQty MUST drop to 0 or near 0 — no repeat orders
  var targetDOC = r.supplier === 'CHINA' ? 120 : 60;

  if (po.status === 'supplier_confirmed' || po.status === 'shipped' || po.status === 'delivered') {
    // With mfgQty included, recalculate suggest
    if (r.companyDOC !== null && tDRR > 0 && r.companyDOC < targetDOC) {
      r.suggestQty = Math.max(0, Math.ceil((targetDOC - r.companyDOC) * tDRR));
    } else {
      r.suggestQty = 0; // company DOC now sufficient — no need to order
    }
  }

  // ── RECALCULATE HEALTH ────────────────────────────────────
  var doc = r.companyDOC;
  if (doc === null || doc === undefined) r.healthStatus = 'unknown';
  else if (doc > 180) r.healthStatus = 'dead_inventory';
  else if (doc > 150) r.healthStatus = 'very_unhealthy';
  else if (doc > 120) r.healthStatus = 'unhealthy';
  else r.healthStatus = 'healthy';

  return r;
}

// GET /api/inventory/latest
router.get('/latest', protect, supplierFilter, async function(req, res) {
  try {
    var snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
    if (!snapshot) return res.json({ rows: [], uploadedAt: null, rowCount: 0 });

    var allPOs = await PurchaseOrder.find({
      status: { $in: ['admin_approved', 'supplier_confirmed', 'shipped', 'delivered'] }
    });

    var poMap = {};
    allPOs.forEach(function(po) { poMap[po.asin] = po; });

    var rows = snapshot.rows;
    if (req.supplierFilter) {
      rows = rows.filter(function(r) { return r.supplier === req.supplierFilter; });
    }
    if (req.query.supplier) {
      rows = rows.filter(function(r) { return r.supplier === req.query.supplier.toUpperCase(); });
    }

    var mergedRows = rows.map(function(row) {
      var r = row.toObject ? row.toObject() : Object.assign({}, row._doc || row);
      return mergeRowWithPO(r, poMap[r.asin]);
    });

    res.json({
      rows:       mergedRows,
      uploadedAt: snapshot.createdAt,
      fileName:   snapshot.fileName,
      rowCount:   mergedRows.length
    });
  } catch (err) {
    console.error('inventory/latest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/stats
router.get('/stats', protect, async function(req, res) {
  try {
    var snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
    if (!snapshot) return res.json({ totalSKUs: 0 });

    var allPOs = await PurchaseOrder.find({
      status: { $in: ['admin_approved', 'supplier_confirmed', 'shipped', 'delivered'] }
    });
    var poMap = {};
    allPOs.forEach(function(po) { poMap[po.asin] = po; });

    var totalInv = 0, totalDRR = 0;
    var alerts   = { critical:0, urgent:0, po_required:0, ok:0 };
    var health   = { healthy:0, unhealthy:0, very_unhealthy:0, dead_inventory:0, unknown:0 };
    var supStats = { CHINA:{ needPO:0, stockOk:0, total:0 }, MD:{ needPO:0, stockOk:0, total:0 } };
    var pDocs    = { AMZ:[], FLK:[], ZPT:[], BLK:[] };
    var pOOS     = { AMZ:0, FLK:0, ZPT:0, BLK:0 };
    var pUrg     = { AMZ:0, FLK:0, ZPT:0, BLK:0 };

    var mergedRows = snapshot.rows.map(function(row) {
      var r = row.toObject ? row.toObject() : Object.assign({}, row._doc || row);
      return mergeRowWithPO(r, poMap[r.asin]);
    });

    mergedRows.forEach(function(r) {
      var tDRR = r.totalDRR || 0;
      var tInv = r.totalInv || 0;
      var cDOC = r.companyDOC;
      totalInv += tInv;
      totalDRR += tDRR;

      if (cDOC !== null && cDOC !== undefined) {
        if      (cDOC < 7)  alerts.critical++;
        else if (cDOC < 15) alerts.urgent++;
        else if (cDOC < 30) alerts.po_required++;
        else                alerts.ok++;
      }

      var hs = r.healthStatus || 'unknown';
      if (health[hs] !== undefined) health[hs]++;

      var sup = r.supplier;
      if (sup === 'CHINA' || sup === 'MD') {
        supStats[sup].total++;
        if (r.actionType === 'supplier_po_required') supStats[sup].needPO++;
        else supStats[sup].stockOk++;
      }

      ['AMZ','FLK','ZPT','BLK'].forEach(function(p) {
        var drr = r[p.toLowerCase()+'DRR'] || 0;
        var inv = r[p.toLowerCase()+'Inv'] || 0;
        var d   = drr > 0 ? inv / drr : null;
        if (d !== null) {
          pDocs[p].push(d);
          if (d < 7) pOOS[p]++; else if (d < 15) pUrg[p]++;
        }
      });
    });

    var platformStats = {};
    ['AMZ','FLK','ZPT','BLK'].forEach(function(p) {
      var docs = pDocs[p];
      platformStats[p] = {
        avgDOC:  docs.length > 0 ? docs.reduce(function(a,b){return a+b;},0)/docs.length : null,
        oosRisk: pOOS[p], urgent: pUrg[p]
      };
    });

    res.json({
      totalSKUs:    snapshot.rows.length,
      totalInv:     totalInv,
      totalDRR:     Math.round(totalDRR * 10) / 10,
      companyDOC:   totalDRR > 0 ? Math.round(totalInv / totalDRR * 10) / 10 : 0,
      health, alerts, platformStats, supStats,
      supplierStats: supStats,
      uploadedAt:   snapshot.createdAt,
      fileName:     snapshot.fileName,
      rows:         mergedRows
    });
  } catch (err) {
    console.error('inventory/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/snapshots
router.get('/snapshots', protect, async function(req, res) {
  try {
    var snapshots = await InventorySnapshot.find()
      .select('fileName rowCount createdAt uploadedBy')
      .populate('uploadedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json({ snapshots: snapshots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
