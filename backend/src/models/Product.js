const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  asin:     { type: String, required: true, unique: true, index: true },
  ean:      { type: String, index: true },
  sku:      { type: String },
  title:    { type: String },
  brand:    { type: String },
  category: { type: String, index: true },
  supplier: {
    type: String,
    enum: ['CHINA', 'MD'],
    required: true,
    index: true
  },
  vendorCode: { type: String },
  productLink: { type: String },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Product', productSchema);
