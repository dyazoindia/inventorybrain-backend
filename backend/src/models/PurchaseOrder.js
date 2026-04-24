const mongoose = require('mongoose');

// PO Lifecycle: system_suggested → admin_set_qty → supplier_confirmed → shipped → delivered
const poSchema = new mongoose.Schema({
  asin:     { type: String, required: true, index: true },
  ean:      String,
  sku:      String,
  title:    String,
  supplier: { type: String, enum: ['CHINA', 'MD'], required: true, index: true },

  // Admin sets this after system suggestion
  finalQty: { type: Number, default: 0 },
  finalQtySetAt: Date,
  finalQtySetBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Supplier confirmation
  poConfirmType: { type: String, enum: ['full', 'custom', null], default: null },
  confirmedQty:  { type: Number, default: 0 },
  confirmedAt:   Date,
  confirmedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Shipment (supplier enters)
  shippedQty:  { type: Number, default: 0 },
  shippedAt:   Date,
  shippedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Delivery (admin marks)
  deliveredQty: { type: Number, default: 0 },
  deliveredAt:  Date,
  deliveredBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  discrepancyNotes: String,

  // Packing list file
  packingListFile: {
    url: String, publicId: String, originalName: String, uploadedAt: Date
  },

  // Overall status
  status: {
    type: String,
    enum: ['draft', 'admin_approved', 'supplier_confirmed', 'shipped', 'delivered', 'rejected'],
    default: 'draft',
    index: true
  },

  // Snapshot context
  companyDocAtCreation: Number,
  whDocAtCreation: Number,
  drrAtCreation: Number,
  suggestQty: Number,

  // Status history timeline
  statusHistory: [{
    status: String,
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: String,
    qty: Number
  }],

  adminNotes:    String,
  supplierNotes: String

}, { timestamps: true });

module.exports = mongoose.model('PurchaseOrder', poSchema);
