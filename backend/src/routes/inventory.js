var express = require('express');
var router = express.Router();
var protect = require('../middleware/auth').protect;
var supplierFilter = require('../middleware/auth').supplierFilter;
var InventorySnapshot = require('../models/InventorySnapshot');
var PurchaseOrder = require('../models/PurchaseOrder');

// ─── Merge live PO data into a snapshot row ──────────────────
function mergeRowWithPO(row, po) {
  var r = {};
  // Copy all row fields
  var keys = Object.keys(row);
  for (var i = 0; i < keys.length; i++) { r[keys[i]] = row[keys[i]]; }

  if (!po) return r;

  // ── Stage: admin_approved → Final Qty set, but supplier hasn't confirmed yet
  // No inventory change yet, just show finalQty

  // ── Stage: supplier_confirmed → Confirmed Qty moves to Manufacturing
  if (po.status === 'supplier_confirmed') {
    r.mfgQty = (r.mfgQty || 0) + (po.confirmedQty || 0);
    r.actionType = 'supplier_po_inprogress';
    r.actionDetails = 'Manufacturing: ' + (po.confirmedQty || 0) + ' units confirmed by supplier';
  }

  // ── Stage: shipped → Move from Manufacturing to In Transit
  if (po.status === 'shipped') {
    var shipped = po.shippedQty || 0;
    var confirmed = po.confirmedQty || 0;
    r.inTransit = (r.inTransit || 0) + shipped;
    r.mfgQty = (r.mfgQty || 0) + (confirmed - shipped); // remaining in mfg
    r.actionType = 'supplier_po_inprogress';
    r.actionDetails = 'In Transit: ' + shipped + ' units | Manufacturing: ' + (confirmed - shipped);
  }

  // ── Stage: delivered → Add to Warehouse, clear mfg/transit
  if (po.status === 'delivered') {
    r.whInv = (r.whInv || 0) + (po.deliveredQty || 0);
    // Don't add inTransit for delivered — already counted in whInv now
    r.actionType = 'no_action';
    r.actionDetails = 'Delivered: ' + (po.deliveredQty || 0) + ' units added to warehouse';
  }

  // ── Recalculate all DOC/totals after PO merge ──────────────
  var tDRR = (r.amzDRR || 0) + (r.flkDRR || 0) + (r.zptDRR || 0) + (r.blkDRR || 0);
  var tInv = (r.whInv || 0) + (r.amzInv || 0) + (r.flkInv || 0) + (r.zptInv || 0) + (r.blkInv || 0)
           + (r.openPO || 0) + (r.mfgQty || 0) + (r.inTransit || 0);

  r.totalInv   = tInv;
  r.totalDRR   = tDRR;
  r.companyDOC = tDRR > 0 ? tInv / tDRR : null;
  r.whDOC      = tDRR > 0 ? ((r.whInv || 0) + (r.openPO || 0) + (r.mfgQty || 0) + (r.inTransit || 0)) / tDRR : null;

  // ── Recalculate suggestQty — once PO confirmed, suggest drops ──
  var targetDOC = r.supplier === 'CHINA' ? 120 : 60;
  if (po.status === 'supplier_confirmed' || po.status === 'shipped' || po.status === 'delivered') {
    // With confirmed qty in inventory, suggestQty should recalculate
    if (r.companyDOC !== null && tDRR > 0 && r.companyDOC < targetDOC) {
      r.suggestQty = Math.max(0, Math.ceil((targetDOC - r.companyDOC) * tDRR));
    } else {
      r.suggestQty = 0; // no longer needed
    }
  }

  // ── Recalculate health ──────────────────────────────────────
  var doc = r.companyDOC;
  if (doc === null) r.healthStatus = 'unknown';
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

    // Get ALL active POs (not just pending)
    var allPOs = await PurchaseOrder.find({
      status: { $in: ['admin_approved', 'supplier_confirmed', 'shipped', 'delivered'] }
    });

    // Build PO map by asin
    var poMap = {};
    allPOs.forEach(function(po) { poMap[po.asin] = po; });

    var rows = snapshot.rows;

    // Apply supplier filter
    if (req.supplierFilter) {
      rows = rows.filter(function(r) { return r.supplier === req.supplierFilter; });
    }
    if (req.query.supplier) {
      rows = rows.filter(function(r) { return r.supplier === req.query.supplier.toUpperCase(); });
    }

    // Merge PO data into each row
    var mergedRows = rows.map(function(row) {
      var r = row.toObject ? row.toObject() : Object.assign({}, row._doc || row);
      var po = poMap[r.asin];
      return mergeRowWithPO(r, po);
    });

    res.json({
      rows: mergedRows,
      uploadedAt: snapshot.createdAt,
      fileName: snapshot.fileName,
      rowCount: mergedRows.length
    });
  } catch (err) {
    console.error('inventory/latest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/stats — dashboard numbers
router.get('/stats', protect, async function(req, res) {
  try {
    var snapshot = await InventorySnapshot.findOne().sort({ createdAt: -1 });
    if (!snapshot) return res.json({ totalSKUs: 0 });

    var allPOs = await PurchaseOrder.find({
      status: { $in: ['admin_approved', 'supplier_confirmed', 'shipped', 'delivered'] }
    });
    var poMap = {};
    allPOs.forEach(function(po) { poMap[po.asin] = po; });

    var rawRows = snapshot.rows;
    var totalInv = 0, totalDRR = 0;
    var alerts = { critical: 0, urgent: 0, po_required: 0, ok: 0 };
    var health = { healthy: 0, unhealthy: 0, very_unhealthy: 0, dead_inventory: 0, unknown: 0 };
    var supplierStats = {
      CHINA: { needPO: 0, stockOk: 0, total: 0 },
      MD:    { needPO: 0, stockOk: 0, total: 0 }
    };
    var pDocs = { AMZ: [], FLK: [], ZPT: [], BLK: [] };
    var pOOS  = { AMZ: 0, FLK: 0, ZPT: 0, BLK: 0 };
    var pUrg  = { AMZ: 0, FLK: 0, ZPT: 0, BLK: 0 };

    var mergedRows = rawRows.map(function(row) {
      var r = row.toObject ? row.toObject() : Object.assign({}, row._doc || row);
      return mergeRowWithPO(r, poMap[r.asin]);
    });

    mergedRows.forEach(function(r) {
      var tDRR = r.totalDRR || 0;
      var tInv = r.totalInv || 0;
      var cDOC = r.companyDOC;

      totalInv += tInv;
      totalDRR += tDRR;

      // Alerts
      if (cDOC !== null) {
        if (cDOC < 7) alerts.critical++;
        else if (cDOC < 15) alerts.urgent++;
        else if (cDOC < 30) alerts.po_required++;
        else alerts.ok++;
      }

      // Health
      var hs = r.healthStatus || 'unknown';
      if (health[hs] !== undefined) health[hs]++;

      // Supplier
      var sup = r.supplier;
      if (sup === 'CHINA' || sup === 'MD') {
        supplierStats[sup].total++;
        var threshold = sup === 'CHINA' ? 120 : 60;
        var inProg = r.actionType === 'supplier_po_inprogress';
        if (!inProg && (r.whInv === 0 || (cDOC !== null && cDOC < threshold))) {
          supplierStats[sup].needPO++;
        } else {
          supplierStats[sup].stockOk++;
        }
      }

      // Platform DOC
      var portals = ['AMZ', 'FLK', 'ZPT', 'BLK'];
      portals.forEach(function(p) {
        var drr = r[p.toLowerCase() + 'DRR'] || 0;
        var inv = r[p.toLowerCase() + 'Inv'] || 0;
        var doc = drr > 0 ? inv / drr : null;
        if (doc !== null) {
          pDocs[p].push(doc);
          if (doc < 7) pOOS[p]++;
          else if (doc < 15) pUrg[p]++;
        }
      });
    });

    var platformStats = {};
    ['AMZ', 'FLK', 'ZPT', 'BLK'].forEach(function(p) {
      var docs = pDocs[p];
      platformStats[p] = {
        avgDOC: docs.length > 0 ? docs.reduce(function(a,b){return a+b;},0) / docs.length : null,
        oosRisk: pOOS[p], urgent: pUrg[p]
      };
    });

    var companyDOC = totalDRR > 0 ? Math.round(totalInv / totalDRR * 10) / 10 : 0;

    res.json({
      totalSKUs: rawRows.length, totalInv: totalInv,
      totalDRR: Math.round(totalDRR * 10) / 10,
      companyDOC: companyDOC,
      health: health, alerts: alerts,
      platformStats: platformStats, supplierStats: supplierStats,
      uploadedAt: snapshot.createdAt, fileName: snapshot.fileName,
      rows: mergedRows
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
