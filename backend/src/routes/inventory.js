import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { inventoryApi, supplierPOApi } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { Empty, Loading, fmtN } from '../components/ui';
import { useSelection } from '../components/ui/useSelection';
import { exportToCSV } from '../components/ui/exportUtils';
import toast from 'react-hot-toast';

var fDoc = function(v) {
  return (v !== null && v !== undefined && isFinite(v)) ? (Math.round(v * 10) / 10) + 'd' : '-';
};
var fDRR = function(v) {
  return v ? parseFloat(v).toFixed(2).replace(/\.?0+$/, '') : '-';
};
var dCol = function(v) {
  if (!v && v !== 0) return 'var(--muted)';
  if (v < 7) return 'var(--red)';
  if (v < 15) return 'var(--orange)';
  if (v < 30) return 'var(--yellow)';
  return 'var(--green)';
};

var CFG = {
  CHINA: { label: 'China Supplier', icon: '🏭', color: '#7c3aed', heroClass: 'hero-china', docT: 120, whT: 60, targetDOC: 120 },
  MD:    { label: 'MD Supplier',    icon: '🏢', color: '#ea580c', heroClass: 'hero-md',    docT: 60,  whT: 30, targetDOC: 60  }
};

var TABS = [
  { key: 'all',      label: 'All SKUs',  color: '#3b6ff5' },
  { key: 'need_po',  label: 'Need PO',   color: '#dc2626' },
  { key: 'active',   label: 'Active PO', color: '#7c3aed' },
  { key: 'no_action',label: 'No Action', color: '#6b7280' }
];

export default function SupplierDashboard({ supplier }) {
  var cfg = CFG[supplier] || {
    label: supplier + ' Supplier', icon: '🏪', color: '#3b6ff5',
    heroClass: 'hero-china', docT: 60, whT: 30, targetDOC: 60
  };

  var auth = useAuth();
  var isAdmin = auth.isAdmin;
  var qc = useQueryClient();

  var [tab, setTab]         = useState('all');
  var [search, setSearch]   = useState('');
  // confirmType per PO id: 'full' or 'custom'
  var [confirmType, setConfirmType] = useState({});
  // customQty per PO id
  var [customQty, setCustomQty] = useState({});
  // shippedQty per PO id (what supplier types)
  var [shippedInput, setShippedInput] = useState({});

  var invQ = useQuery({
    queryKey: ['inv-' + supplier],
    queryFn: function() {
      return inventoryApi.getLatest({ supplier: supplier }).then(function(r) { return r.data; });
    }
  });

  var poQ = useQuery({
    queryKey: ['po-' + supplier],
    queryFn: function() {
      return supplierPOApi.list({ supplier: supplier }).then(function(r) { return r.data; });
    }
  });

  var confirmMut = useMutation({
    mutationFn: function(d) {
      return supplierPOApi.confirm(d.id, { poConfirmType: d.type, confirmedQty: d.qty });
    },
    onSuccess: function(data) {
      toast.success('PO Confirmed! ' + (data.data.message || 'Qty moved to Manufacturing.'));
      qc.invalidateQueries(['po-' + supplier]);
      qc.invalidateQueries(['inv-' + supplier]);
      qc.invalidateQueries(['inventory-all']);
    },
    onError: function(e) {
      toast.error(e.response && e.response.data ? e.response.data.error : 'Failed to confirm');
    }
  });

  var shipMut = useMutation({
    mutationFn: function(d) {
      return supplierPOApi.ship(d.id, { shippedQty: d.qty });
    },
    onSuccess: function(data) {
      toast.success('Shipped! ' + (data.data.message || 'Qty now in transit.'));
      qc.invalidateQueries(['po-' + supplier]);
      qc.invalidateQueries(['inv-' + supplier]);
    },
    onError: function() { toast.error('Failed to record shipment'); }
  });

  var deliverMut = useMutation({
    mutationFn: function(d) {
      return supplierPOApi.deliver(d.id, { deliveredQty: d.qty });
    },
    onSuccess: function(data) {
      toast.success('Delivered! ' + (data.data.message || 'Warehouse inventory updated.'));
      qc.invalidateQueries(['po-' + supplier]);
      qc.invalidateQueries(['inv-' + supplier]);
      qc.invalidateQueries(['inventory-all']);
      qc.invalidateQueries(['dashboard-latest']);
    },
    onError: function() { toast.error('Failed to mark delivery'); }
  });

  var allRows = invQ.data && invQ.data.rows ? invQ.data.rows : [];
  var poList  = poQ.data && poQ.data.purchaseOrders ? poQ.data.purchaseOrders : [];

  var poMap = useMemo(function() {
    var m = {};
    poList.forEach(function(po) { m[po.asin] = po; });
    return m;
  }, [poList]);

  // ── Tab counts ──────────────────────────────────────────────
  var counts = useMemo(function() {
    var activePOs = poList.filter(function(p) {
      return p.status === 'admin_approved' || p.status === 'supplier_confirmed' || p.status === 'shipped';
    });
    return {
      all:       allRows.length,
      need_po:   allRows.filter(function(r) { return r.actionType === 'supplier_po_required'; }).length,
      active:    activePOs.length,
      no_action: allRows.filter(function(r) { return r.actionType === 'no_action'; }).length
    };
  }, [allRows, poList]);

  // ── Filter rows by tab ──────────────────────────────────────
  var rows = useMemo(function() {
    var r = allRows;
    if (search) {
      var q = search.toLowerCase();
      r = r.filter(function(x) {
        return (x.sku   && x.sku.toLowerCase().indexOf(q)   >= 0) ||
               (x.asin  && x.asin.toLowerCase().indexOf(q)  >= 0) ||
               (x.title && x.title.toLowerCase().indexOf(q) >= 0);
      });
    }
    if (tab === 'need_po')  return r.filter(function(x) { return x.actionType === 'supplier_po_required'; });
    if (tab === 'active')   return r.filter(function(x) {
      var po = poMap[x.asin];
      return po && (po.status === 'admin_approved' || po.status === 'supplier_confirmed' || po.status === 'shipped');
    });
    if (tab === 'no_action') return r.filter(function(x) { return x.actionType === 'no_action'; });
    return r;
  }, [allRows, poMap, tab, search]);

  var sel = useSelection(rows);

  var doExport = function() {
    var expRows = sel.count > 0 ? sel.selectedRows : rows;
    exportToCSV(expRows, [
      { key: 'sku',          label: 'SKU' },
      { key: 'title',        label: 'Title' },
      { key: 'category',     label: 'Category' },
      { key: 'whInv',        label: 'WH Inv' },
      { key: 'companyDOC',   label: 'Co. DOC',      getValue: function(r) { return fDoc(r.companyDOC); } },
      { key: 'suggestQty',   label: 'Suggest Qty' },
      { key: 'finalQty',     label: 'Final Qty',    getValue: function(r) { var p = poMap[r.asin]; return p ? p.finalQty || '' : ''; } },
      { key: 'confirmedQty', label: 'Confirmed Qty',getValue: function(r) { var p = poMap[r.asin]; return p ? p.confirmedQty || '' : ''; } },
      { key: 'shippedQty',   label: 'Shipped Qty',  getValue: function(r) { var p = poMap[r.asin]; return p ? p.shippedQty || '' : ''; } },
      { key: 'deliveredQty', label: 'Delivered Qty',getValue: function(r) { var p = poMap[r.asin]; return p ? p.deliveredQty || '' : ''; } },
      { key: 'poStatus',     label: 'PO Status',    getValue: function(r) { var p = poMap[r.asin]; return p ? p.status : ''; } }
    ], supplier.toLowerCase() + '_supplier');
  };

  if (invQ.isLoading) return <Loading text={'Loading ' + cfg.label + '...'} />;

  return (
    <div>
      {/* Hero */}
      <div className={'hero ' + cfg.heroClass} style={{ marginBottom: 16 }}>
        <h2>{cfg.icon} {cfg.label} Dashboard</h2>
        <p>
          {allRows.length} SKUs &nbsp;·&nbsp;
          {counts.need_po} need PO &nbsp;·&nbsp;
          {counts.active} active PO
        </p>
      </div>

      {/* PO Flow Banner */}
      <div className="info-box" style={{ marginBottom: 14, fontSize: 11 }}>
        <strong>PO Flow:</strong>
        &nbsp;
        <span className="badge badge-po">1. Admin sets Final Qty</span>
        &nbsp;→&nbsp;
        <span className="badge badge-confirmed">2. Supplier Confirms (Full/Custom) → Mfg Qty</span>
        &nbsp;→&nbsp;
        <span className="badge badge-transit">3. Supplier enters Shipped Qty → In Transit</span>
        &nbsp;→&nbsp;
        <span className="badge badge-ok">4. Admin Delivers → WH Inv +Qty auto</span>
      </div>

      {/* Logic */}
      <div className="info-box" style={{ marginBottom: 14, fontSize: 11 }}>
        <strong>Logic:</strong> WH DOC &lt;{cfg.whT}d = flag &nbsp;|&nbsp;
        Co. DOC &lt;{cfg.docT}d = Need PO &nbsp;|&nbsp;
        Target DOC = {cfg.targetDOC}d
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', width: 'fit-content' }}>
        {TABS.map(function(t) {
          var active = tab === t.key;
          var cnt = counts[t.key] || 0;
          return (
            <button key={t.key} onClick={function() { setTab(t.key); }}
              style={{ padding: '8px 16px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                fontWeight: active ? 700 : 500, background: active ? t.color : 'var(--bg3)',
                color: active ? '#fff' : t.color, borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
              {t.label}
              {cnt > 0 && (
                <span style={{ marginLeft: 5, background: active ? 'rgba(255,255,255,.25)' : t.color + '20',
                  borderRadius: 10, padding: '1px 6px', fontSize: 10 }}>{cnt}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div className="sec" style={{ marginBottom: 0 }}>
          {TABS.find(function(t) { return t.key === tab; }).label} <small>({rows.length})</small>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {sel.count > 0 && <button className="btn btn-success btn-sm" onClick={doExport}>Export ({sel.count})</button>}
          <button className="btn btn-ghost" onClick={doExport}>Export All</button>
          <input className="filter-input" placeholder="Search SKU / ASIN..."
            value={search} onChange={function(e) { setSearch(e.target.value); }} style={{ width: 180 }} />
        </div>
      </div>

      {/* Selection bar */}
      {sel.count > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--blue-lt)', borderRadius: 8, padding: '8px 14px', marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 500 }}>{sel.count} selected</span>
          <button className="btn btn-ghost btn-sm" onClick={sel.clear}>Clear</button>
          <button className="btn btn-success btn-sm" onClick={doExport}>Export</button>
        </div>
      )}

      {rows.length === 0 ? (
        <Empty icon={cfg.icon}
          title={'No products in ' + TABS.find(function(t) { return t.key === tab; }).label}
          desc="Try a different tab." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={sel.isAllSelected}
                    ref={function(el) { if (el) el.indeterminate = sel.isSomeSelected; }}
                    onChange={function(e) { sel.toggleAll(e.target.checked); }} />
                </th>
                <th>SKU</th>
                <th style={{ minWidth: 160 }}>Title</th>
                <th>Category</th>
                <th>WH Inv</th>
                <th>WH DOC</th>
                <th>Co. DOC</th>
                <th>DRR</th>
                <th>Suggest Qty</th>
                {/* FINAL QTY — Admin sets, yellow */}
                <th style={{ background: '#fffde7', color: '#b45309', fontWeight: 700, minWidth: 100 }}>
                  Final Qty
                  <div style={{ fontSize: 9, fontWeight: 400, color: '#b45309' }}>set by Admin</div>
                </th>
                {/* CONFIRM — Supplier action, purple */}
                <th style={{ background: '#f5f3ff', color: '#7c3aed', fontWeight: 700, minWidth: 130 }}>
                  Confirm
                  <div style={{ fontSize: 9, fontWeight: 400, color: '#7c3aed' }}>Full / Custom</div>
                </th>
                {/* MFG QTY — auto filled, blue */}
                <th style={{ background: '#e0f2fe', color: '#0891b2', fontWeight: 700, minWidth: 90 }}>
                  Mfg Qty
                  <div style={{ fontSize: 9, fontWeight: 400, color: '#0891b2' }}>after confirm</div>
                </th>
                {/* SHIPPED — supplier enters, amber */}
                <th style={{ background: '#fef3c7', color: '#d97706', fontWeight: 700, minWidth: 100 }}>
                  Shipped Qty
                  <div style={{ fontSize: 9, fontWeight: 400, color: '#d97706' }}>enter dispatched</div>
                </th>
                {/* DELIVERED — admin marks, green */}
                {isAdmin && (
                  <th style={{ background: '#dcfce7', color: '#16a34a', fontWeight: 700, minWidth: 120 }}>
                    Deliver to WH
                    <div style={{ fontSize: 9, fontWeight: 400, color: '#16a34a' }}>admin only</div>
                  </th>
                )}
                <th>PO Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(function(r) {
                var po   = poMap[r.asin];
                var pid  = po ? po._id.toString() : r.asin;
                var cType = confirmType[pid] || 'full';
                var cQty  = customQty[pid]   !== undefined ? customQty[pid]  : (po ? po.finalQty || 0 : 0);
                var sQty  = shippedInput[pid] !== undefined ? shippedInput[pid] : '';
                var bg    = sel.selected.has(r.asin) ? 'var(--blue-lt)' : '';

                // Calculate remaining mfg qty (confirmed - shipped)
                var confirmedQty = po ? (po.confirmedQty || 0) : 0;
                var shippedQty   = po ? (po.shippedQty   || 0) : 0;
                var mfgRemaining = Math.max(0, confirmedQty - shippedQty);

                return (
                  <tr key={r.asin} style={{ background: bg }}>
                    <td>
                      <input type="checkbox" checked={sel.selected.has(r.asin)}
                        onChange={function() { sel.toggle(r.asin); }} />
                    </td>

                    {/* SKU */}
                    <td style={{ fontWeight: 500 }}>
                      {r.productLink
                        ? <a href={r.productLink} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)', textDecoration: 'none' }}>{r.sku || r.asin}</a>
                        : r.sku || r.asin}
                    </td>

                    {/* Title */}
                    <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11 }}>
                      {r.title || '-'}
                    </td>

                    {/* Category */}
                    <td style={{ fontSize: 11, color: 'var(--muted)' }}>{r.category || '-'}</td>

                    {/* WH Inv */}
                    <td style={{ fontWeight: 500, color: r.whInv === 0 ? 'var(--red)' : 'var(--text)' }}>
                      {fmtN(r.whInv)}
                      {r.whInv === 0 && <span style={{ fontSize: 9, marginLeft: 3, color: 'var(--red)' }}>EMPTY</span>}
                    </td>

                    {/* WH DOC */}
                    <td><span style={{ fontWeight: 600, color: dCol(r.whDOC) }}>{fDoc(r.whDOC)}</span></td>

                    {/* Co. DOC */}
                    <td><span style={{ fontWeight: 700, color: dCol(r.companyDOC) }}>{fDoc(r.companyDOC)}</span></td>

                    {/* DRR */}
                    <td>{fDRR(r.totalDRR)}</td>

                    {/* Suggest Qty */}
                    <td style={{ color: r.suggestQty > 0 ? 'var(--blue)' : 'var(--muted)', fontWeight: r.suggestQty > 0 ? 600 : 400 }}>
                      {r.suggestQty > 0 ? fmtN(r.suggestQty) : '-'}
                    </td>

                    {/* ── FINAL QTY (yellow) ── */}
                    {/* Shows number ONLY when admin_approved = waiting for supplier to confirm */}
                    {/* Once confirmed, shows badge — prevents repeat orders */}
                    <td style={{ background: '#fffde7', textAlign: 'center' }}>
                      {!po && (
                        <span style={{ color: 'var(--muted)', fontSize: 11 }}>-</span>
                      )}
                      {po && po.status === 'admin_approved' && (
                        <div>
                          <span style={{ fontWeight: 700, color: '#b45309', fontSize: 16 }}>
                            {fmtN(po.finalQty)}
                          </span>
                          <div style={{ fontSize: 9, color: '#b45309', marginTop: 2 }}>
                            confirm below
                          </div>
                        </div>
                      )}
                      {po && po.status === 'supplier_confirmed' && (
                        <div>
                          <span className="badge badge-confirmed">In Mfg</span>
                          <div style={{ fontSize: 9, color: '#0891b2', marginTop: 2 }}>
                            {fmtN(po.confirmedQty)} units
                          </div>
                        </div>
                      )}
                      {po && po.status === 'shipped' && (
                        <div>
                          <span className="badge badge-transit">Shipped</span>
                          <div style={{ fontSize: 9, color: '#d97706', marginTop: 2 }}>
                            {fmtN(po.shippedQty)} units
                          </div>
                        </div>
                      )}
                      {po && po.status === 'delivered' && (
                        <div>
                          <span className="badge badge-ok">Delivered</span>
                          <div style={{ fontSize: 9, color: '#16a34a', marginTop: 2 }}>
                            {fmtN(po.deliveredQty)} to WH
                          </div>
                        </div>
                      )}
                    </td>

                    {/* ── CONFIRM COLUMN (purple) ── */}
                    <td style={{ background: '#f5f3ff' }}>
                      {/* No PO yet */}
                      {!po && <span style={{ color: 'var(--muted)', fontSize: 11 }}>Waiting Admin</span>}

                      {/* Admin approved — supplier can confirm */}
                      {po && po.status === 'admin_approved' && !isAdmin && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <select
                            value={cType}
                            onChange={function(e) {
                              var n = {}; n[pid] = e.target.value;
                              setConfirmType(Object.assign({}, confirmType, n));
                              // Reset custom qty when switching
                              if (e.target.value === 'full') {
                                var n2 = {}; n2[pid] = po.finalQty;
                                setCustomQty(Object.assign({}, customQty, n2));
                              }
                            }}
                            style={{ padding: '4px 6px', borderRadius: 5, border: '1px solid #7c3aed', fontFamily: 'inherit', fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>
                            <option value="full">Full ({fmtN(po.finalQty)})</option>
                            <option value="custom">Custom Qty</option>
                          </select>

                          {cType === 'custom' && (
                            <input type="number" min="1" max={po.finalQty}
                              value={cQty}
                              onChange={function(e) {
                                var n = {}; n[pid] = e.target.value;
                                setCustomQty(Object.assign({}, customQty, n));
                              }}
                              placeholder={'Max: ' + po.finalQty}
                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #7c3aed', borderRadius: 5, fontFamily: 'inherit', fontSize: 12, textAlign: 'center' }} />
                          )}

                          <button className="btn btn-primary btn-xs"
                            style={{ background: '#7c3aed', borderColor: '#7c3aed' }}
                            disabled={confirmMut.isPending}
                            onClick={function() {
                              var qty = cType === 'full' ? po.finalQty : (parseInt(cQty) || 0);
                              if (qty <= 0) { toast.error('Enter a valid quantity'); return; }
                              confirmMut.mutate({ id: po._id, type: cType, qty: qty });
                            }}>
                            Confirm PO
                          </button>
                        </div>
                      )}

                      {/* Admin view when awaiting confirm */}
                      {po && po.status === 'admin_approved' && isAdmin && (
                        <span className="badge badge-po">Awaiting Supplier</span>
                      )}

                      {/* Already confirmed */}
                      {po && po.status !== 'admin_approved' && po.confirmedQty > 0 && (
                        <div>
                          <span className="badge badge-confirmed">{po.poConfirmType === 'full' ? 'Full' : 'Custom'}</span>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                            {fmtN(po.confirmedQty)} units
                          </div>
                        </div>
                      )}

                      {/* Rejected */}
                      {po && po.status === 'rejected' && (
                        <span className="badge badge-rejected">Rejected</span>
                      )}
                    </td>

                    {/* ── MFG QTY (blue) — auto shows remaining mfg ── */}
                    <td style={{ background: '#e0f2fe', textAlign: 'center' }}>
                      {po && po.status === 'supplier_confirmed' && (
                        <span style={{ fontWeight: 700, color: '#0891b2', fontSize: 14 }}>
                          {fmtN(po.confirmedQty)}
                        </span>
                      )}
                      {po && po.status === 'shipped' && mfgRemaining > 0 && (
                        <span style={{ fontWeight: 700, color: '#0891b2' }}>
                          {fmtN(mfgRemaining)}
                          <div style={{ fontSize: 9, color: '#0891b2' }}>remaining</div>
                        </span>
                      )}
                      {po && po.status === 'shipped' && mfgRemaining === 0 && (
                        <span style={{ color: 'var(--muted)', fontSize: 11 }}>All Shipped</span>
                      )}
                      {(!po || (po.status !== 'supplier_confirmed' && po.status !== 'shipped')) && (
                        <span style={{ color: 'var(--muted)', fontSize: 11 }}>-</span>
                      )}
                    </td>

                    {/* ── SHIPPED QTY (amber) — supplier enters ── */}
                    <td style={{ background: '#fef3c7' }}>
                      {/* Supplier can enter shipped qty after confirming */}
                      {po && po.status === 'supplier_confirmed' && !isAdmin && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <input type="number" min="1" max={po.confirmedQty}
                            value={sQty}
                            onChange={function(e) {
                              var n = {}; n[pid] = e.target.value;
                              setShippedInput(Object.assign({}, shippedInput, n));
                            }}
                            placeholder={'Max ' + fmtN(po.confirmedQty)}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d97706', borderRadius: 5, fontFamily: 'inherit', fontSize: 12, textAlign: 'center', background: '#fffbeb' }} />
                          <button className="btn btn-xs"
                            style={{ background: '#d97706', color: '#fff', border: 'none', borderRadius: 5, padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}
                            disabled={shipMut.isPending}
                            onClick={function() {
                              var qty = parseInt(sQty);
                              if (!qty || qty <= 0) { toast.error('Enter shipped qty'); return; }
                              if (qty > po.confirmedQty) { toast.error('Cannot ship more than confirmed qty (' + fmtN(po.confirmedQty) + ')'); return; }
                              shipMut.mutate({ id: po._id, qty: qty });
                            }}>
                            Mark Shipped
                          </button>
                        </div>
                      )}

                      {/* Show shipped qty if already shipped */}
                      {po && po.status === 'shipped' && (
                        <div style={{ textAlign: 'center' }}>
                          <span style={{ fontWeight: 700, color: '#d97706', fontSize: 14 }}>{fmtN(po.shippedQty)}</span>
                          <div style={{ fontSize: 9, color: '#d97706' }}>in transit</div>
                        </div>
                      )}

                      {/* Delivered */}
                      {po && po.status === 'delivered' && (
                        <div style={{ textAlign: 'center' }}>
                          <span style={{ fontWeight: 700, color: 'var(--green)' }}>{fmtN(po.shippedQty)}</span>
                          <div style={{ fontSize: 9, color: 'var(--green)' }}>delivered</div>
                        </div>
                      )}

                      {/* Admin view */}
                      {po && po.status === 'supplier_confirmed' && isAdmin && (
                        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Awaiting supplier</span>
                      )}

                      {(!po || po.status === 'admin_approved' || po.status === 'rejected') && (
                        <span style={{ color: 'var(--muted)', fontSize: 11 }}>-</span>
                      )}
                    </td>

                    {/* ── DELIVER TO WH (green) — admin only ── */}
                    {isAdmin && (
                      <td style={{ background: '#dcfce7' }}>
                        {po && po.status === 'shipped' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
                            <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>
                              {fmtN(po.shippedQty)} units ready
                            </div>
                            <button
                              style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 5, padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 600 }}
                              disabled={deliverMut.isPending}
                              onClick={function() {
                                deliverMut.mutate({ id: po._id, qty: po.shippedQty });
                              }}>
                              Deliver to WH
                            </button>
                          </div>
                        )}
                        {po && po.status === 'delivered' && (
                          <div style={{ textAlign: 'center' }}>
                            <span style={{ fontWeight: 700, color: '#16a34a', fontSize: 13 }}>+{fmtN(po.deliveredQty)}</span>
                            <div style={{ fontSize: 9, color: '#16a34a' }}>added to WH</div>
                          </div>
                        )}
                        {(!po || (po.status !== 'shipped' && po.status !== 'delivered')) && (
                          <span style={{ color: 'var(--muted)', fontSize: 11 }}>-</span>
                        )}
                      </td>
                    )}

                    {/* PO Status */}
                    <td>
                      {!po && <span className="badge badge-gray">No PO</span>}
                      {po && po.status === 'admin_approved'     && <span className="badge badge-po">Final Qty Set</span>}
                      {po && po.status === 'supplier_confirmed' && <span className="badge badge-confirmed">In Manufacturing</span>}
                      {po && po.status === 'shipped'            && <span className="badge badge-transit">In Transit</span>}
                      {po && po.status === 'delivered'          && <span className="badge badge-ok">Delivered</span>}
                      {po && po.status === 'rejected'           && <span className="badge badge-rejected">Rejected</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
