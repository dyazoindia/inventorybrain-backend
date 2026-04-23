const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { protect, authorize } = require('../middleware/auth');
const InventorySnapshot = require('../models/InventorySnapshot');
const { parseExcelRow } = require('../utils/calculations');

// Multer — memory storage for Excel, disk/cloudinary for packing lists
const excelStorage = multer.memoryStorage();
const uploadExcel = multer({
  storage: excelStorage,
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel'
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Cloudinary for packing lists
let cloudinaryUpload = null;
if (process.env.CLOUDINARY_CLOUD_NAME) {
  const cloudinary = require('cloudinary').v2;
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  const packingStorage = new CloudinaryStorage({
    cloudinary,
    params: { folder: 'inventorybrain/packing_lists', resource_type: 'raw', allowed_formats: ['pdf','xlsx','csv','jpg','png'] }
  });
  cloudinaryUpload = multer({ storage: packingStorage, limits: { fileSize: 20 * 1024 * 1024 } });
}

// POST /api/upload/excel   (Admin only)
router.post('/excel', protect, authorize('admin'), uploadExcel.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws);

    if (!raw.length) return res.status(400).json({ error: 'Excel file is empty' });

    // Parse and compute each row
    const rows = raw.map(parseExcelRow).filter(Boolean);
    if (!rows.length) return res.status(400).json({ error: 'No valid rows found. Ensure "Asin" column exists.' });

    const snapshot = await InventorySnapshot.create({
      uploadedBy: req.user._id,
      fileName:   req.file.originalname,
      rowCount:   rows.length,
      rows
    });

    res.status(201).json({
      message:    `✅ Snapshot created with ${rows.length} SKUs`,
      snapshotId: snapshot._id,
      rowCount:   rows.length,
      createdAt:  snapshot.createdAt
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload/packing-list/:poId   (China supplier)
router.post('/packing-list/:poId', protect, authorize('admin', 'china_supplier'), async (req, res) => {
  if (!cloudinaryUpload) {
    return res.status(501).json({ error: 'File storage not configured. Set Cloudinary env vars.' });
  }

  cloudinaryUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const PurchaseOrder = require('../models/PurchaseOrder');
      const po = await PurchaseOrder.findById(req.params.poId);
      if (!po) return res.status(404).json({ error: 'PO not found' });

      po.packingListFile = {
        url:          req.file.path,
        publicId:     req.file.filename,
        originalName: req.file.originalname,
        uploadedAt:   new Date()
      };
      if (po.status === 'admin_approved' || po.status === 'in_production') {
        po.status = 'in_transit';
        po.inTransitAt = new Date();
        po.statusHistory.push({ status: 'in_transit', changedBy: req.user._id, note: 'Packing list uploaded' });
      }
      await po.save();

      res.json({ message: 'Packing list uploaded', fileUrl: req.file.path });
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  });
});

module.exports = router;
