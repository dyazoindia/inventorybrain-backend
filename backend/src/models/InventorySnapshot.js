const mongoose = require('mongoose');

const snapshotRowSchema = new mongoose.Schema({
  asin:       { type: String, required: true, index: true },
  ean:        String,
  sku:        String,
  title:      String,
  supplier:   String,
  category:   String,
  brand:      String,
  productLink: String,

  // Warehouse
  whInv:      { type: Number, default: 0 },

  // Channel inventory
  amzInv:     { type: Number, default: 0 },
  flkInv:     { type: Number, default: 0 },
  zptInv:     { type: Number, default: 0 },
  blkInv:     { type: Number, default: 0 },

  // Daily Run Rate per channel
  amzDRR:     { type: Number, default: 0 },
  flkDRR:     { type: Number, default: 0 },
  zptDRR:     { type: Number, default: 0 },
  blkDRR:     { type: Number, default: 0 },

  // PO fields
  openPO:     { type: Number, default: 0 },
  mfgQty:     { type: Number, default: 0 },
  inTransit:  { type: Number, default: 0 },

  // Computed fields (calculated server-side on upload)
  totalInv:   { type: Number, default: 0 },
  totalDRR:   { type: Number, default: 0 },
  companyDOC: { type: Number, default: null },
  whDOC:      { type: Number, default: null },
  amzDOC:     { type: Number, default: null },
  flkDOC:     { type: Number, default: null },
  zptDOC:     { type: Number, default: null },
  blkDOC:     { type: Number, default: null },

  // Suggested order qty
  suggestQty: { type: Number, default: 0 },

  // Auto-classification
  healthStatus: {
    type: String,
    enum: ['healthy', 'slow_moving', 'overstock', 'dead_inventory', 'unknown'],
    default: 'unknown'
  },
  alertLevel: {
    type: String,
    enum: ['critical', 'urgent', 'po_required', 'ok', 'none'],
    default: 'none'
  },
  actionRequired: {
    type: String,
    enum: ['need_po', 'no_need', 'stock_ok', 'overstock_stop', 'liquidate', 'monitor', 'none'],
    default: 'none'
  }
}, { _id: false });

const inventorySnapshotSchema = new mongoose.Schema({
  uploadId:   { type: mongoose.Schema.Types.ObjectId, auto: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fileName:   { type: String },
  rowCount:   { type: Number, default: 0 },
  rows:       [snapshotRowSchema]
}, { timestamps: true });

// Index for efficient date-based queries
inventorySnapshotSchema.index({ createdAt: -1 });

module.exports = mongoose.model('InventorySnapshot', inventorySnapshotSchema);
