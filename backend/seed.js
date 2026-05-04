require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const xlsx = require('xlsx');
const path = require('path');
const User = require('./models/User');
const Product = require('./models/Product');
const Order = require('./models/Order');
const Rule = require('./models/Rule');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ai-ecommerce';

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

    // Parse Excel File
    const excelFilePath = path.join(__dirname, '..', 'Sales_Data_100_Rows.xlsx');
    const workbook = xlsx.readFile(excelFilePath);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    // Extract unique products
    const productMap = new Map();
    data.forEach(row => {
      if (!productMap.has(row.Product)) {
        productMap.set(row.Product, {
          name: row.Product,
          category: 'General', // Default category
          price: row['Price per Unit'],
          stock: Math.floor(Math.random() * 100) + 10, // Random stock between 10 and 110
          status: 'active'
        });
      }
    });

    const products = await Product.insertMany(Array.from(productMap.values()));
    console.log(`Seeded ${products.length} Unique Products`);

    // Create a map to quickly find product ObjectIds
    const productIds = {};
    products.forEach(p => {
      productIds[p.name] = p._id;
    });

    // Seed Orders
    const ordersData = data.map(row => {
      // Parse DD-MM-YYYY
      const [day, month, year] = row['Sale Date'].split('-');
      const orderDate = new Date(`${year}-${month}-${day}`);

      return {
        user: adminUser._id,
        items: [{
          product: productIds[row.Product],
          quantity: row.Quantity,
          price: row['Price per Unit']
        }],
        totalAmount: row['Sales Amount'],
        status: 'delivered', // Assume historical data is delivered
        region: row.Region,
        state: row.State,
        city: row.City,
        date: orderDate
      };
    });

    await Order.insertMany(ordersData);
    console.log(`Seeded ${ordersData.length} Orders from Excel`);

    // Seed Automation Rules
    const rulesData = [
      { name: 'Low Stock Alert', conditionType: 'stock', operator: '<', value: 20, action: 'notify' },
      { name: 'High Revenue Alert', conditionType: 'revenue', operator: '>', value: 5000, action: 'notify' }
    ];
    await Rule.insertMany(rulesData);
    console.log('Seeded Rules');

    console.log('Database seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  }
};

seedDatabase();
