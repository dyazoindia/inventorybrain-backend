const mongoose = require('mongoose');

const snapshotRowSchema = new mongoose.Schema({
  asin:       { type: String, required: true, index: true },
  ean:        String, sku: String, title: String,
  supplier:   String, category: String, brand: String, productLink: String,

  whInv:  { type: Number, default: 0 },
  amzInv: { type: Number, default: 0 }, flkInv: { type: Number, default: 0 },
  zptInv: { type: Number, default: 0 }, blkInv: { type: Number, default: 0 },
  amzDRR: { type: Number, default: 0 }, flkDRR: { type: Number, default: 0 },
  zptDRR: { type: Number, default: 0 }, blkDRR: { type: Number, default: 0 },
  openPO: { type: Number, default: 0 }, mfgQty: { type: Number, default: 0 },
  amzOpenPO: { type: Number, default: 0 }, flkOpenPO: { type: Number, default: 0 },
  zptOpenPO: { type: Number, default: 0 }, blkOpenPO: { type: Number, default: 0 },
  inTransit: { type: Number, default: 0 },

  totalInv: { type: Number, default: 0 }, totalDRR: { type: Number, default: 0 },
  companyDOC: { type: Number, default: null }, whDOC: { type: Number, default: null },
  amzDOC: { type: Number, default: null }, flkDOC: { type: Number, default: null },
  zptDOC: { type: Number, default: null }, blkDOC: { type: Number, default: null },

  suggestQty: { type: Number, default: 0 },

  healthStatus: {
    type: String,
    enum: ['healthy', 'unhealthy', 'very_unhealthy', 'dead_inventory', 'unknown'],
    default: 'unknown'
  },
  alertLevel: {
    type: String,
    enum: ['critical', 'urgent', 'po_required', 'ok', 'none'],
    default: 'none'
  },

  // Legacy
  actionRequired: {
    type: String,
    enum: ['need_po', 'no_need', 'stock_ok', 'overstock_stop', 'liquidate', 'monitor', 'none'],
    default: 'none'
  },

  // NEW: Clear action type
  actionType: {
    type: String,
    enum: ['supplier_po_required', 'supplier_po_inprogress', 'platform_po_incoming', 'no_action'],
    default: 'no_action'
  },
  actionDetails: { type: String, default: '' }

}, { _id: false });

const inventorySnapshotSchema = new mongoose.Schema({
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fileName:   String,
  rowCount:   { type: Number, default: 0 },
  rows:       [snapshotRowSchema]
}, { timestamps: true });

inventorySnapshotSchema.index({ createdAt: -1 });

module.exports = mongoose.model('InventorySnapshot', inventorySnapshotSchema);
