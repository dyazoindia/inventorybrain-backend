require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const users = [
    { name: 'Admin User',       email: 'admin@yourcompany.com',  password: 'Admin@123',  role: 'admin' },
    { name: 'China Supplier',   email: 'china@supplier.com',     password: 'China@123',  role: 'china_supplier' },
    { name: 'MD Supplier',      email: 'md@supplier.com',        password: 'MD@123',     role: 'md_supplier' }
  ];

  for (const u of users) {
    const exists = await User.findOne({ email: u.email });
    if (!exists) {
      await User.create(u);
      console.log(`✅ Created user: ${u.email} (${u.role})`);
    } else {
      console.log(`⏭  User already exists: ${u.email}`);
    }
  }

  console.log('\n🎉 Seed complete!');
  console.log('Login credentials:');
  users.forEach(u => console.log(`  ${u.role}: ${u.email} / ${u.password}`));
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
