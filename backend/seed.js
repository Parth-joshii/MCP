require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User');
const Product = require('./models/Product');
const Order = require('./models/Order');
const Rule = require('./models/Rule');
const { createRandom, money } = require('./seed-sales-demo');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ai-ecommerce';
const DEMO_SEED = process.env.DEMO_SEED || `${Date.now()}-${Math.random()}`;
const random = createRandom(`sample-app:${DEMO_SEED}`);
const BASE_DATE = process.env.DEMO_BASE_DATE
  ? new Date(`${process.env.DEMO_BASE_DATE}T00:00:00.000Z`)
  : new Date();

const choice = (items) => items[Math.floor(random() * items.length)];
const dateDaysAgo = (days) => {
  const date = new Date(BASE_DATE);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
};

const productCatalog = [
  ['Noise Cancelling Headphones', 'Electronics', 7999],
  ['Wireless Mouse', 'Electronics', 1299],
  ['Mechanical Keyboard', 'Electronics', 4599],
  ['USB-C Hub', 'Electronics', 2499],
  ['Running Shoes', 'Footwear', 3499],
  ['Formal Shoes', 'Footwear', 4299],
  ['Cotton T-Shirt', 'Apparel', 799],
  ['Denim Jacket', 'Apparel', 2999],
  ['Office Chair', 'Furniture', 8999],
  ['Laptop Stand', 'Accessories', 1799],
  ['Bluetooth Speaker', 'Electronics', 3299],
  ['Backpack', 'Accessories', 1899]
];

const locations = [
  { region: 'West', state: 'Maharashtra', city: 'Mumbai' },
  { region: 'West', state: 'Gujarat', city: 'Ahmedabad' },
  { region: 'North', state: 'Delhi', city: 'Delhi' },
  { region: 'North', state: 'Rajasthan', city: 'Jaipur' },
  { region: 'South', state: 'Karnataka', city: 'Bengaluru' },
  { region: 'South', state: 'Tamil Nadu', city: 'Chennai' },
  { region: 'South', state: 'Telangana', city: 'Hyderabad' },
  { region: 'East', state: 'West Bengal', city: 'Kolkata' },
  { region: 'West', state: 'Maharashtra', city: 'Pune' },
  { region: 'Central', state: 'Madhya Pradesh', city: 'Indore' }
];

const seedDatabase = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Clear existing data
    await User.deleteMany({});
    await Product.deleteMany({});
    await Order.deleteMany({});
    await Rule.deleteMany({});
    console.log('Cleared existing data');

    // Seed Admin User
    const hashedPassword = await bcrypt.hash('password123', 10);
    const adminUser = await User.create({
      name: 'Admin User',
      email: 'admin@example.com',
      password: hashedPassword,
      role: 'admin'
    });

    const products = await Product.insertMany(productCatalog.map(([name, category, price], index) => ({
      name,
      category,
      price,
      stock: Math.floor(15 + random() * 180),
      status: index % 11 === 0 ? 'inactive' : 'active'
    })));
    console.log(`Seeded ${products.length} Unique Products`);

    const orderCount = Number(process.env.SAMPLE_ORDER_COUNT || 160);
    const statuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    const ordersData = Array.from({ length: orderCount }, (_, index) => {
      const product = choice(products);
      const quantity = 1 + Math.floor(random() * 6);
      const location = locations[index % locations.length];
      return {
        user: adminUser._id,
        items: [{
          product: product._id,
          quantity,
          price: product.price
        }],
        totalAmount: money(product.price * quantity * (0.9 + random() * 0.25)),
        status: index % 19 === 0 ? 'cancelled' : choice(statuses),
        region: location.region,
        state: location.state,
        city: location.city,
        date: dateDaysAgo(Math.floor(random() * 420))
      };
    });

    await Order.insertMany(ordersData);
    console.log(`Seeded ${ordersData.length} dynamic Orders`);

    // Seed Automation Rules
    const rulesData = [
      { name: 'Low Stock Alert', conditionType: 'stock', operator: '<', value: 20, action: 'notify' },
      { name: 'High Revenue Alert', conditionType: 'revenue', operator: '>', value: 5000, action: 'notify' }
    ];
    await Rule.insertMany(rulesData);
    console.log('Seeded Rules');

    console.log(`Dynamic seed: ${DEMO_SEED}`);
    console.log('Database seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  }
};

seedDatabase();
