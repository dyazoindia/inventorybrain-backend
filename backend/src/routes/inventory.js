var express = require('express');
var router = express.Router();
var protect = require('../middleware/auth').protect;
var supplierFilter = require('../middleware/auth').supplierFilter;
var InventorySnapshot = require('../models/InventorySnapshot');
var PurchaseOrder = require('../models/PurchaseOrder');

// ─── Merge live PO data into snapshot row ────────────────────
// IMPORTANT: We only merge ACTIVE stages (confirmed, shipped)
// Delivered POs are already written to the snapshot by purchaseOrders.js
function mergeRowWithPO(row, po) {
  var r = {};
  var keys = Object.keys(row);
  for (var i = 0; i < keys.length; i++) { r[keys[i]] = row[keys[i]]; }
  if (!po) return r;

  // Stage: admin_approved → Final Qty set, nothing moves yet
  if (po.status === 'admin_approved') {
    r.actionType    = 'supplier_po_inprogress';
    r.actionDetails = 'Awaiting supplier confirmation of ' + (po.finalQty || 0) + ' units';
  }

  // Stage: supplier_confirmed → Confirmed Qty is in Manufacturing
  if (po.status === 'supplier_confirmed') {
    r.mfgQty        = (r.mfgQty || 0) + (po.confirmedQty || 0);
    r.actionType    = 'supplier_po_inprogress';
    r.actionDetails = 'Manufacturing: ' + (po.confirmedQty || 0) + ' units in production';
  }

  // Stage: shipped → In Transit (removed from Mfg, added to inTransit)
  if (po.status === 'shipped') {
    var shipped   = po.shippedQty   || 0;
    var confirmed = po.confirmedQty || 0;
    var remaining = Math.max(0, confirmed - shipped);
    r.mfgQty     = (r.mfgQty     || 0) + remaining; // any unshipped still in mfg
    r.inTransit  = (r.inTransit  || 0) + shipped;
    r.actionType = 'supplier_po_inprogress';
    r.actionDetails = 'In Transit: ' + shipped + ' units'
      + (remaining > 0 ? ' | Manufacturing: ' + remaining : '');
  }

  // Stage: delivered → already written to snapshot by purchaseOrders.js
  // DO NOT add to whInv again here — would cause double counting
  if (po.status === 'delivered') {
    r.actionType    = 'no_action';
    r.actionDetails = 'Delivered: ' + (po.deliveredQty || 0) + ' units added to warehouse';
  }

  // Recalculate totals including mfgQty and inTransit
  var tDRR = (r.amzDRR||0) + (r.flkDRR||0) + (r.zptDRR||0) + (r.blkDRR||0);
  var tInv = (r.whInv||0) + (r.amzInv||0) + (r.flkInv||0)
           + (r.zptInv||0) + (r.blkInv||0)
           + (r.openPO||0) + (r.mfgQty||0) + (r.inTransit||0);

  r.totalInv   = tInv;
  r.totalDRR   = tDRR;
  r.companyDOC = tDRR > 0 ? tInv / tDRR : null;
  r.whDOC      = tDRR > 0
    ? ((r.whInv||0) + (r.openPO||0) + (r.mfgQty||0) + (r.inTransit||0)) / tDRR
    : null;

  // Recalculate suggestQty — once confirmed, suggest drops
  var targetDOC = r.supplier === 'CHINA' ? 120 : 60;
  if (po.status === 'supplier_confirmed' || po.status === 'shipped' || po.status === 'delivered') {
    if (r.companyDOC !== null && tDRR > 0 && r.companyDOC < targetDOC) {
      r.suggestQty = Math.max(0, Math.ceil((targetDOC - r.companyDOC) * tDRR));
    } else {
      r.suggestQty = 0;
    }
  }

  // Recalculate health
  var doc = r.companyDOC;
  if (doc === null)  r.healthStatus = 'unknown';
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
    var alerts = { critical: 0, urgent: 0, po_required: 0, ok: 0 };
    var health = { healthy: 0, unhealthy: 0, very_unhealthy: 0, dead_inventory: 0, unknown: 0 };
    var supplierStats = {
      CHINA: { needPO: 0, stockOk: 0, total: 0 },
      MD:    { needPO: 0, stockOk: 0, total: 0 }
    };
    var pDocs = { AMZ: [], FLK: [], ZPT: [], BLK: [] };
    var pOOS  = { AMZ: 0, FLK: 0, ZPT: 0, BLK: 0 };
    var pUrg  = { AMZ: 0, FLK: 0, ZPT: 0, BLK: 0 };

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

      if (cDOC !== null) {
        if      (cDOC < 7)  alerts.critical++;
        else if (cDOC < 15) alerts.urgent++;
        else if (cDOC < 30) alerts.po_required++;
        else                alerts.ok++;
      }

      var hs = r.healthStatus || 'unknown';
      if (health[hs] !== undefined) health[hs]++;

      var sup = r.supplier;
      if (sup === 'CHINA' || sup === 'MD') {
        supplierStats[sup].total++;
        var inProg = r.actionType === 'supplier_po_inprogress';
        var threshold = sup === 'CHINA' ? 120 : 60;
        if (!inProg && (cDOC !== null && cDOC < threshold)) {
          supplierStats[sup].needPO++;
        } else {
          supplierStats[sup].stockOk++;
        }
      }

      ['AMZ','FLK','ZPT','BLK'].forEach(function(p) {
        var drr = r[p.toLowerCase()+'DRR'] || 0;
        var inv = r[p.toLowerCase()+'Inv'] || 0;
        var doc = drr > 0 ? inv / drr : null;
        if (doc !== null) {
          pDocs[p].push(doc);
          if (doc < 7) pOOS[p]++; else if (doc < 15) pUrg[p]++;
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
      health, alerts, platformStats, supplierStats,
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
