const mongoose = require('mongoose');

const purchaseOrderSchema = new mongoose.Schema({
  asin:       { type: String, required: true, index: true },
  ean:        String,
  sku:        String,
  title:      String,
  supplier:   { type: String, enum: ['CHINA', 'MD'], required: true, index: true },
  quantity:   { type: Number, required: true },
  suggestQty: { type: Number },

  status: {
    type: String,
    enum: ['system_suggested', 'supplier_confirmed', 'admin_approved', 'in_production', 'in_transit', 'delivered', 'rejected'],
    default: 'system_suggested',
    index: true
  },

  // Timestamps for each stage
  supplierConfirmedAt: Date,
  adminApprovedAt:     Date,
  productionStartAt:   Date,
  inTransitAt:         Date,
  deliveredAt:         Date,

  // Users at each stage
  confirmedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  deliveredBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // File storage
  packingListFile: {
    url:          String,
    publicId:     String,
    originalName: String,
    uploadedAt:   Date
  },

  // Notes
  discrepancyNotes: String,
  adminNotes:       String,
  supplierNotes:    String,

  // Context snapshot (DOC at time of PO creation)
  companyDocAtCreation: Number,
  whDocAtCreation:      Number,
  drrAtCreation:        Number,

  // Platform context
  platform: { type: String, enum: ['AMZ', 'FLK', 'ZPT', 'BLK', 'ALL'], default: 'ALL' }

}, { timestamps: true });

// Status history for timeline
purchaseOrderSchema.add({
  statusHistory: [{
    status:    String,
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note:      String
  }]
});

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
