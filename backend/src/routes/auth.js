const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' });

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email, isActive: true });
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid email or password' });
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });
    const token = signToken(user._id);
    res.json({ token, user: user.toJSON() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/me
router.get('/me', protect, (req, res) => res.json({ user: req.user }));

// POST /api/auth/change-password
router.post('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    if (!(await user.comparePassword(currentPassword)))
      return res.status(400).json({ error: 'Current password is incorrect' });
    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password updated successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/seed-now — create initial users (safe: skips if exists)
router.get('/seed-now', async (req, res) => {
  try {
    const users = [
      { name: 'Admin User',       email: 'admin@yourcompany.com', password: 'Admin@123', role: 'admin' },
      { name: 'Operations Team',  email: 'ops@yourcompany.com',   password: 'Ops@123',   role: 'operations' },
      { name: 'China Supplier',   email: 'china@supplier.com',    password: 'China@123', role: 'china_supplier' },
      { name: 'MD Supplier',      email: 'md@supplier.com',       password: 'MD@123',    role: 'md_supplier' }
    ];
    const results = [];
    for (const u of users) {
      const exists = await User.findOne({ email: u.email });
      if (!exists) { await User.create(u); results.push('Created: ' + u.email); }
      else results.push('Exists: ' + u.email);
    }
    res.json({ message: 'Done!', results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
