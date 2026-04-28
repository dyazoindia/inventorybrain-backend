var CHINA_WH_THRESHOLD   = 60;
var CHINA_COMP_THRESHOLD = 120;
var MD_WH_THRESHOLD      = 30;
var MD_COMP_THRESHOLD    = 60;
var CHINA_TARGET_DOC     = 120;
var MD_TARGET_DOC        = 60;

function computeRow(raw) {
  var g = function(v) { return parseFloat(v) || 0; };

  var wh       = g(raw.whInv    || raw['WH Inv']);
  var amzInv   = g(raw.amzInv   || raw['AMZ Inv']);
  var flkInv   = g(raw.flkInv   || raw['FLK Inv']);
  var zptInv   = g(raw.zptInv   || raw['ZPT Inv']);
  var blkInv   = g(raw.blkInv   || raw['BLK Inv']);
  var amzDRR   = g(raw.amzDRR   || raw['AMZ DRR']);
  var flkDRR   = g(raw.flkDRR   || raw['FLK DRR']);
  var zptDRR   = g(raw.zptDRR   || raw['ZPT DRR']);
  var blkDRR   = g(raw.blkDRR   || raw['BLK DRR']);
  var openPO   = g(raw.openPO   || raw['Open PO']);
  // Portal-specific Open PO columns
  var amzOpenPO = g(raw.amzOpenPO || raw['AMZ Open PO'] || raw['AMZ OpenPO'] || 0);
  var flkOpenPO = g(raw.flkOpenPO || raw['FLK Open PO'] || raw['FLK OpenPO'] || 0);
  var zptOpenPO = g(raw.zptOpenPO || raw['ZPT Open PO'] || raw['ZPT OpenPO'] || 0);
  var blkOpenPO = g(raw.blkOpenPO || raw['BLK Open PO'] || raw['BLK OpenPO'] || 0);
  var mfgQty   = g(raw.mfgQty   || raw['Mfg Qty']);
  var inTransit= g(raw.inTransit|| 0);

  var totalInv = wh + amzInv + flkInv + zptInv + blkInv + openPO + mfgQty + inTransit;
  var totalDRR = amzDRR + flkDRR + zptDRR + blkDRR;

  var companyDOC = totalDRR > 0 ? totalInv / totalDRR : null;
  var whDOC      = totalDRR > 0 ? (wh + openPO + mfgQty + inTransit) / totalDRR : null;
  var amzDOC     = amzDRR > 0 ? amzInv / amzDRR : null;
  var flkDOC     = flkDRR > 0 ? flkInv / flkDRR : null;
  var zptDOC     = zptDRR > 0 ? zptInv / zptDRR : null;
  var blkDOC     = blkDRR > 0 ? blkInv / blkDRR : null;

  var supplier = (raw.supplier || raw['Supplier'] || '').toString().toUpperCase();
  var targetDOC = supplier === 'CHINA' ? CHINA_TARGET_DOC : MD_TARGET_DOC;
  var suggestQty = 0;
  if (companyDOC !== null && totalDRR > 0 && companyDOC < targetDOC) {
    suggestQty = Math.max(0, Math.ceil((targetDOC - companyDOC) * totalDRR));
  }

  var actionType    = getActionType(supplier, wh, whDOC, companyDOC, openPO, mfgQty, inTransit);
  var actionDetails = getActionDetails(actionType, supplier, wh, companyDOC, openPO);

  return {
    whInv: wh, amzInv: amzInv, flkInv: flkInv, zptInv: zptInv, blkInv: blkInv,
    amzDRR: amzDRR, flkDRR: flkDRR, zptDRR: zptDRR, blkDRR: blkDRR,
    openPO: openPO, mfgQty: mfgQty, inTransit: inTransit,
    amzOpenPO: amzOpenPO, flkOpenPO: flkOpenPO, zptOpenPO: zptOpenPO, blkOpenPO: blkOpenPO,
    totalInv: totalInv, totalDRR: totalDRR, companyDOC: companyDOC, whDOC: whDOC,
    amzDOC: amzDOC, flkDOC: flkDOC, zptDOC: zptDOC, blkDOC: blkDOC,
    suggestQty: suggestQty,
    healthStatus:   getHealthStatus(companyDOC),
    alertLevel:     getAlertLevel(companyDOC),
    actionRequired: getLegacyAction(supplier, whDOC, companyDOC),
    actionType:     actionType,
    actionDetails:  actionDetails
  };
}

function getActionType(supplier, whInv, whDOC, companyDOC, openPO, mfgQty, inTransit) {
  var hasIncoming = openPO > 0 || mfgQty > 0 || inTransit > 0;
  var threshold = supplier === 'CHINA' ? CHINA_COMP_THRESHOLD : MD_COMP_THRESHOLD;

  // Priority 1: Supplier PO already in progress
  if (hasIncoming) return 'supplier_po_inprogress';

  // If company DOC is ABOVE threshold → stock sufficient, no PO needed
  // This prevents Dead Inventory / Overstock from appearing as "PO Required"
  if (companyDOC !== null && companyDOC >= threshold) return 'no_action';

  // Priority 2: Company DOC below threshold → need to order
  if (companyDOC !== null && companyDOC < threshold) return 'supplier_po_required';

  // Priority 3: No DRR data (DRR=0), but warehouse is empty → flag it
  if (companyDOC === null && whInv === 0) return 'supplier_po_required';

  return 'no_action';
}

function getActionDetails(actionType, supplier, whInv, companyDOC, openPO) {
  var supName = supplier === 'CHINA' ? 'China supplier' : 'MD supplier';
  if (actionType === 'supplier_po_required') {
    if (whInv === 0) return 'Warehouse empty \u2014 order from ' + supName + ' immediately';
    return 'Company DOC ' + (companyDOC ? companyDOC.toFixed(1) : '\u2014') + 'd below threshold \u2014 order from ' + supName;
  }
  if (actionType === 'supplier_po_inprogress') return 'PO/Mfg/Transit already in progress \u2014 monitor stock arrival';
  if (actionType === 'no_action') return 'Stock sufficient \u2014 no supplier order needed';
  return '\u2014';
}

function getHealthStatus(doc) {
  if (doc === null) return 'unknown';
  if (doc > 180) return 'dead_inventory';
  if (doc > 150) return 'very_unhealthy';
  if (doc > 120) return 'unhealthy';
  return 'healthy';
}

function getAlertLevel(doc) {
  if (doc === null) return 'none';
  if (doc < 7)  return 'critical';
  if (doc < 15) return 'urgent';
  if (doc < 30) return 'po_required';
  return 'ok';
}

function getLegacyAction(supplier, whDOC, companyDOC) {
  if (whDOC === null || companyDOC === null) return 'none';
  if (supplier === 'CHINA') {
    if (whDOC < 60 && companyDOC > 120) return 'no_need';
    if (companyDOC < 120) return 'need_po';
    if (whDOC < 60) return 'need_po';
    if (companyDOC > 180) return 'liquidate';
    if (companyDOC > 120) return 'overstock_stop';
    return 'stock_ok';
  }
  if (supplier === 'MD') {
    if (companyDOC > 60) return 'no_need';
    if (whDOC < 30) return 'need_po';
    if (companyDOC < 60) return 'need_po';
    if (companyDOC > 180) return 'liquidate';
    if (companyDOC > 120) return 'overstock_stop';
    return 'stock_ok';
  }
  return 'monitor';
}

function parseExcelRow(raw) {
  var normalize = function(obj) {
    var out = {};
    Object.keys(obj).forEach(function(k) {
      var clean = k.replace(/^['"\s]+|['"\s]+$/g, '').trim();
      out[clean] = obj[k];
    });
    return out;
  };

  var r = normalize(raw);
  var asin = (r['Asin'] || r['ASIN'] || '').toString().trim();
  if (!asin) return null;

  var computed = computeRow(r);

  return {
    asin:        asin,
    ean:         (r['EAN'] || '').toString().trim(),
    sku:         (r['SKU'] || '').toString().trim(),
    title:       (r['Title'] || '').toString().trim(),
    supplier:    (r['Supplier'] || '').toString().trim().toUpperCase(),
    brand:       (r['BRAND'] || r['Brand'] || '').toString().trim(),
    category:    (r['Category'] || '').toString().trim(),
    vendorCode:  (r['Vendor Code'] || '').toString().trim(),
    productLink: (r['Link'] || '').toString().trim(),
    whInv:       computed.whInv, amzInv: computed.amzInv, flkInv: computed.flkInv,
    zptInv:      computed.zptInv, blkInv: computed.blkInv,
    amzDRR:      computed.amzDRR, flkDRR: computed.flkDRR, zptDRR: computed.zptDRR,
    blkDRR:      computed.blkDRR,
    openPO:      computed.openPO, mfgQty: computed.mfgQty, inTransit: computed.inTransit,
    amzOpenPO:   computed.amzOpenPO, flkOpenPO: computed.flkOpenPO,
    zptOpenPO:   computed.zptOpenPO, blkOpenPO: computed.blkOpenPO,
    totalInv:    computed.totalInv, totalDRR: computed.totalDRR,
    companyDOC:  computed.companyDOC, whDOC: computed.whDOC,
    amzDOC:      computed.amzDOC, flkDOC: computed.flkDOC,
    zptDOC:      computed.zptDOC, blkDOC: computed.blkDOC,
    suggestQty:  computed.suggestQty,
    healthStatus:   computed.healthStatus,
    alertLevel:     computed.alertLevel,
    actionRequired: computed.actionRequired,
    actionType:     computed.actionType,
    actionDetails:  computed.actionDetails
  };
}

function compareSnapshots(previous, latest) {
  var prevMap = {};
  previous.rows.forEach(function(r) { prevMap[r.asin] = r; });
  var latestMap = {};
  latest.rows.forEach(function(r) { latestMap[r.asin] = r; });

  var results = {
    summary: { totalLatest: latest.rows.length, totalPrevious: previous.rows.length, newSKUs: 0, removedSKUs: 0, riskIncreased: 0, riskDecreased: 0 },
    newSKUs: [], removedSKUs: [], changed: [], unchanged: []
  };

  latest.rows.forEach(function(latestRow) {
    var prev = prevMap[latestRow.asin];
    if (!prev) { results.newSKUs.push(latestRow); results.summary.newSKUs++; return; }
    var hasChanges = false;
    var fields = ['whInv','totalInv','totalDRR','companyDOC','whDOC'];
    fields.forEach(function(f) {
      var delta = (latestRow[f] || 0) - (prev[f] || 0);
      if (Math.abs(delta) > 0.01) hasChanges = true;
    });
    if (hasChanges) results.changed.push({ asin: latestRow.asin, sku: latestRow.sku, title: latestRow.title });
    else results.unchanged.push(latestRow.asin);
  });

  previous.rows.forEach(function(prevRow) {
    if (!latestMap[prevRow.asin]) { results.removedSKUs.push(prevRow); results.summary.removedSKUs++; }
  });

  return results;
}

module.exports = { computeRow: computeRow, parseExcelRow: parseExcelRow, compareSnapshots: compareSnapshots, getHealthStatus: getHealthStatus, getAlertLevel: getAlertLevel, getLegacyAction: getLegacyAction, getActionType: getActionType };
