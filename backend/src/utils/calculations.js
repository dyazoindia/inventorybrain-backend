// ── Constants ───────────────────────────────────────────────
const CHINA_WH_THRESHOLD   = 60;
const CHINA_COMP_THRESHOLD = 120;
const MD_WH_THRESHOLD      = 30;
const MD_COMP_THRESHOLD    = 60;
const CHINA_TARGET_DOC     = 120;
const MD_TARGET_DOC        = 60;

// ── Core Calculations ────────────────────────────────────────
function computeRow(raw) {
  const g = (v) => parseFloat(v) || 0;

  const wh       = g(raw.whInv    ?? raw['WH Inv']);
  const amzInv   = g(raw.amzInv   ?? raw['AMZ Inv']);
  const flkInv   = g(raw.flkInv   ?? raw['FLK Inv']);
  const zptInv   = g(raw.zptInv   ?? raw['ZPT Inv']);
  const blkInv   = g(raw.blkInv   ?? raw['BLK Inv']);
  const amzDRR   = g(raw.amzDRR   ?? raw['AMZ DRR']);
  const flkDRR   = g(raw.flkDRR   ?? raw['FLK DRR']);
  const zptDRR   = g(raw.zptDRR   ?? raw['ZPT DRR']);
  const blkDRR   = g(raw.blkDRR   ?? raw['BLK DRR']);
  const openPO   = g(raw.openPO   ?? raw['Open PO']);
  const mfgQty   = g(raw.mfgQty   ?? raw['Mfg Qty']);
  const inTransit = g(raw.inTransit ?? 0);

  const totalInv = wh + amzInv + flkInv + zptInv + blkInv + openPO + mfgQty + inTransit;
  const totalDRR = amzDRR + flkDRR + zptDRR + blkDRR;

  const companyDOC = totalDRR > 0 ? totalInv / totalDRR : null;
  const whDOC      = totalDRR > 0 ? (wh + openPO + mfgQty + inTransit) / totalDRR : null;
  const amzDOC     = amzDRR > 0 ? amzInv / amzDRR : null;
  const flkDOC     = flkDRR > 0 ? flkInv / flkDRR : null;
  const zptDOC     = zptDRR > 0 ? zptInv / zptDRR : null;
  const blkDOC     = blkDRR > 0 ? blkInv / blkDRR : null;

  const supplier = (raw.supplier ?? raw['Supplier'] ?? '').toString().toUpperCase();
  const targetDOC = supplier === 'CHINA' ? CHINA_TARGET_DOC : MD_TARGET_DOC;
  const suggestQty = (companyDOC !== null && totalDRR > 0 && companyDOC < targetDOC)
    ? Math.max(0, Math.ceil((targetDOC - companyDOC) * totalDRR))
    : 0;

  // ── NEW ACTION TYPE LOGIC ─────────────────────────────────
  const actionType    = getActionType(supplier, wh, whDOC, companyDOC, openPO, mfgQty, inTransit);
  const actionDetails = getActionDetails(actionType, supplier, wh, companyDOC, openPO);

  return {
    whInv: wh, amzInv, flkInv, zptInv, blkInv,
    amzDRR, flkDRR, zptDRR, blkDRR,
    openPO, mfgQty, inTransit,
    totalInv, totalDRR, companyDOC, whDOC,
    amzDOC, flkDOC, zptDOC, blkDOC,
    suggestQty,
    healthStatus:   getHealthStatus(companyDOC),
    alertLevel:     getAlertLevel(companyDOC),
    // Legacy field kept for backward compat
    actionRequired: getLegacyAction(supplier, whDOC, companyDOC),
    // New fields
    actionType,
    actionDetails
  };
}

// ── NEW: Action Type (Priority Logic) ─────────────────────────
function getActionType(supplier, whInv, whDOC, companyDOC, openPO, mfgQty, inTransit) {
  const hasIncoming = openPO > 0 || mfgQty > 0 || inTransit > 0;
  const threshold = supplier === 'CHINA' ? CHINA_COMP_THRESHOLD : MD_COMP_THRESHOLD;

  // Priority 1: Supplier PO already in progress
  if (hasIncoming) return 'supplier_po_inprogress';

  // Priority 2: Warehouse is empty
  if (whInv === 0 || whDOC === 0) return 'supplier_po_required';

  // Priority 3: Company DOC below threshold → need to order from supplier
  if (companyDOC !== null && companyDOC < threshold) return 'supplier_po_required';

  // Priority 4: Platform PO exists (open PO from marketplace) but stock is ok
  // Note: openPO is checked in priority 1 already, so if we're here openPO=0
  // This handles future case where platform demand is tracked separately
  // For now: if DOC is fine, no action needed
  return 'no_action';
}

// ── Action Details text ────────────────────────────────────────
function getActionDetails(actionType, supplier, whInv, companyDOC, openPO) {
  const supName = supplier === 'CHINA' ? 'China supplier' : 'MD supplier';
  switch (actionType) {
    case 'supplier_po_required':
      if (whInv === 0) return `Warehouse empty — order from ${supName} immediately`;
      return `Company DOC ${companyDOC ? companyDOC.toFixed(1) : '—'}d below threshold — order from ${supName}`;
    case 'supplier_po_inprogress':
      return `PO/Mfg/Transit already in progress — monitor stock arrival`;
    case 'platform_po_incoming':
      return `Incoming demand from marketplace — fulfil from warehouse`;
    case 'no_action':
      return `Stock sufficient — no supplier order needed`;
    default:
      return '—';
  }
}

// ── Health based on Company DOC ───────────────────────────────
function getHealthStatus(doc) {
  if (doc === null) return 'unknown';
  if (doc > 180)    return 'dead_inventory';
  if (doc > 150)    return 'very_unhealthy';
  if (doc > 120)    return 'unhealthy';
  if (doc <= 120)   return 'healthy';
  return 'unknown';
}

// ── Alert level (portal-agnostic, company DOC) ────────────────
function getAlertLevel(doc) {
  if (doc === null) return 'none';
  if (doc < 7)      return 'critical';
  if (doc < 15)     return 'urgent';
  if (doc < 30)     return 'po_required';
  return 'ok';
}

// ── Legacy action (kept for China/MD dashboards) ──────────────
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

// ── Parse Excel Row ──────────────────────────────────────────
function parseExcelRow(raw) {
  const normalize = (obj) => {
    const out = {};
    Object.keys(obj).forEach(k => {
      const clean = k.replace(/^['"\s]+|['"\s]+$/g, '').trim();
      out[clean] = obj[k];
    });
    return out;
  };

  const r = normalize(raw);
  const asin = (r['Asin'] || r['ASIN'] || '').toString().trim();
  if (!asin) return null;

  const computed = computeRow(r);

  return {
    asin,
    ean:         (r['EAN'] || '').toString().trim(),
    sku:         (r['SKU'] || '').toString().trim(),
    title:       (r['Title'] || '').toString().trim(),
    supplier:    (r['Supplier'] || '').toString().trim().toUpperCase(),
    brand:       (r['BRAND'] || r['Brand'] || '').toString().trim(),
    category:    (r['Category'] || '').toString().trim(),
    vendorCode:  (r['Vendor Code'] || '').toString().trim(),
    productLink: (r['Link'] || '').toString().trim(),
    ...computed
  };
}

// ── Comparison Engine ─────────────────────────────────────────
function compareSnapshots(previous, latest) {
  const prevMap = {};
  previous.rows.forEach(r => { prevMap[r.asin] = r; });
  const latestMap = {};
  latest.rows.forEach(r => { latestMap[r.asin] = r; });

  const results = {
    summary: { totalLatest: latest.rows.length, totalPrevious: previous.rows.length, newSKUs: 0, removedSKUs: 0, riskIncreased: 0, riskDecreased: 0 },
    newSKUs: [], removedSKUs: [], changed: [], unchanged: []
  };

  latest.rows.forEach(latestRow => {
    const prev = prevMap[latestRow.asin];
    if (!prev) { results.newSKUs.push(latestRow); results.summary.newSKUs++; return; }
    const diff = buildDiff(prev, latestRow);
    if (diff.hasChanges) {
      results.changed.push({ asin: latestRow.asin, sku: latestRow.sku, title: latestRow.title, supplier: latestRow.supplier, diff });
      if (diff.riskIncreased) results.summary.riskIncreased++;
      if (diff.riskDecreased) results.summary.riskDecreased++;
    } else { results.unchanged.push(latestRow.asin); }
  });

  previous.rows.forEach(prevRow => {
    if (!latestMap[prevRow.asin]) { results.removedSKUs.push(prevRow); results.summary.removedSKUs++; }
  });

  return results;
}

function buildDiff(prev, curr) {
  const fields = [
    { key: 'whInv',      label: 'WH Inventory',   type: 'inventory' },
    { key: 'totalInv',   label: 'Total Inventory', type: 'inventory' },
    { key: 'totalDRR',   label: 'Total DRR',       type: 'drr' },
    { key: 'companyDOC', label: 'Company DOC',     type: 'doc' },
    { key: 'whDOC',      label: 'WH DOC',          type: 'doc' },
    { key: 'amzDOC',     label: 'Amazon DOC',      type: 'doc' },
    { key: 'flkDOC',     label: 'Flipkart DOC',    type: 'doc' },
    { key: 'zptDOC',     label: 'Zepto DOC',       type: 'doc' },
    { key: 'blkDOC',     label: 'Blinkit DOC',     type: 'doc' }
  ];

  const changes = [];
  let hasChanges = false, riskIncreased = false, riskDecreased = false;

  fields.forEach(({ key, label, type }) => {
    const p = prev[key], c = curr[key];
    if (p === null && c === null) return;
    const delta = (c ?? 0) - (p ?? 0);
    if (Math.abs(delta) < 0.01) return;
    hasChanges = true;
    const pct = p && p !== 0 ? ((delta / Math.abs(p)) * 100).toFixed(1) : null;
    let risk = null;
    if (type === 'doc' || type === 'inventory') {
      if (delta < 0) { risk = 'increased'; riskIncreased = true; }
      else { risk = 'decreased'; riskDecreased = true; }
    }
    changes.push({ key, label, type, prev: p, curr: c, delta: Math.round(delta * 10) / 10, pct, risk });
  });

  if (prev.alertLevel !== curr.alertLevel) {
    hasChanges = true;
    const levels = ['none', 'ok', 'po_required', 'urgent', 'critical'];
    const pi = levels.indexOf(prev.alertLevel), ci = levels.indexOf(curr.alertLevel);
    if (ci > pi) riskIncreased = true;
    if (ci < pi) riskDecreased = true;
    changes.push({ key: 'alertLevel', label: 'Alert Level', type: 'status', prev: prev.alertLevel, curr: curr.alertLevel, delta: null, pct: null, risk: ci > pi ? 'increased' : 'decreased' });
  }

  return { hasChanges, riskIncreased, riskDecreased, changes };
}

module.exports = { computeRow, parseExcelRow, compareSnapshots, getHealthStatus, getAlertLevel, getLegacyAction, getActionType };
