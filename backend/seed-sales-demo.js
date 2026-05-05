require('dotenv').config();
const mongoose = require('mongoose');

const SALES_DEMO_URI = process.env.SALES_DEMO_URI || 'mongodb://localhost:27017/sales_demo_mcp';
const DEMO_SEED = process.env.DEMO_SEED || `${Date.now()}-${Math.random()}`;
const SALES_DEMO_ORDER_COUNT = Number(process.env.SALES_DEMO_ORDER_COUNT || 240);
const SALES_DEMO_BASE_DATE = process.env.DEMO_BASE_DATE
  ? new Date(`${process.env.DEMO_BASE_DATE}T00:00:00.000Z`)
  : new Date();

const hashSeed = (value = '') => {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const createRandom = (seedValue) => {
  let seed = hashSeed(seedValue);
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};

const random = createRandom(`sales:${DEMO_SEED}`);

const choice = (items) => items[Math.floor(random() * items.length)];
const money = (value) => Math.round(value * 100) / 100;
const pad = (value, length = 4) => String(value).padStart(length, '0');
const dateDaysAgo = (days) => {
  const date = new Date(SALES_DEMO_BASE_DATE);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
};

const customerNames = [
  'Aarav Mehta', 'Riya Sharma', 'Sara Khan', 'Nikhil Jain', 'Anika Joshi',
  'Dev Nair', 'Priya Mehta', 'Rohan Nair', 'Kabir Iyer', 'Ishaan Patel',
  'Mira Kapoor', 'Vihaan Singh', 'Aanya Das', 'Arjun Verma', 'Karan Shah',
  'Sana Ali', 'Neha Rao', 'Yash Mehta', 'Viraj Sen', 'Parth Joshi',
  'Dhruv Verma', 'Meera Iyer', 'Aditya Patel', 'Isha Kapoor', 'Tanvi Shah',
  'Kavya Nair', 'Aditi Singh', 'Rahul Jain', 'Simran Kaur', 'Anaya Gupta',
  'Rudra Das', 'Kiara Sen', 'Aryan Rao', 'Diya Shah', 'Neil Mehta',
  'Tara Joshi', 'Mohan Iyer', 'Pooja Verma', 'Sahil Khan', 'Esha Patel'
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
  { region: 'North', state: 'Uttar Pradesh', city: 'Lucknow' }
];

const productCatalog = [
  ['PRD-0001', 'Noise Cancelling Headphones', 'Electronics', 'Auralux', 7999, 5200],
  ['PRD-0002', 'Wireless Mouse', 'Electronics', 'ClickPro', 1299, 620],
  ['PRD-0003', 'Mechanical Keyboard', 'Electronics', 'KeyForge', 4599, 2700],
  ['PRD-0004', 'USB-C Hub', 'Electronics', 'Portly', 2499, 1300],
  ['PRD-0005', 'Running Shoes', 'Footwear', 'StrideX', 3499, 1900],
  ['PRD-0006', 'Formal Shoes', 'Footwear', 'UrbanStep', 4299, 2400],
  ['PRD-0007', 'Cotton T-Shirt', 'Apparel', 'Everyday', 799, 320],
  ['PRD-0008', 'Denim Jacket', 'Apparel', 'BluePeak', 2999, 1550],
  ['PRD-0009', 'Office Chair', 'Furniture', 'WorkNest', 8999, 5700],
  ['PRD-0010', 'Study Desk', 'Furniture', 'CasaLine', 11999, 7600],
  ['PRD-0011', 'Water Bottle', 'Home', 'HydraGo', 599, 210],
  ['PRD-0012', 'Cookware Set', 'Home', 'ChefMate', 3999, 2300],
  ['PRD-0013', 'Backpack', 'Accessories', 'TrailPack', 1899, 900],
  ['PRD-0014', 'Smart Watch', 'Electronics', 'PulseIQ', 6999, 4100],
  ['PRD-0015', 'Yoga Mat', 'Fitness', 'FlexWell', 1199, 450],
  ['PRD-0016', 'Dumbbell Pair', 'Fitness', 'IronCore', 2499, 1350],
  ['PRD-0017', 'Desk Lamp', 'Home', 'Brightly', 1499, 700],
  ['PRD-0018', 'Travel Mug', 'Accessories', 'CafeGo', 899, 310],
  ['PRD-0019', 'Bluetooth Speaker', 'Electronics', 'BoomBox', 3299, 1800],
  ['PRD-0020', 'Laptop Stand', 'Accessories', 'ErgoRise', 1799, 850]
];

const buildCustomers = () => customerNames.map((name, index) => {
  const location = locations[index % locations.length];
  return {
    customer_id: `CUST-${pad(index + 1)}`,
    customer_name: name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
    phone: `+91-${9000000000 + index * 137}`,
    segment: choice(['Retail', 'Corporate', 'SMB', 'Enterprise']),
    loyalty_tier: choice(['Bronze', 'Silver', 'Gold', 'Platinum']),
    signup_date: dateDaysAgo(900 - index * 9),
    status: index % 17 === 0 ? 'inactive' : 'active',
    ...location
  };
});

const buildProducts = () => productCatalog.map(([id, name, category, brand, unitPrice, costPrice], index) => ({
  product_id: id,
  product_name: name,
  category,
  brand,
  unit_price: unitPrice,
  cost_price: costPrice,
  stock_quantity: 35 + Math.floor(random() * 180),
  reorder_level: 20 + Math.floor(random() * 25),
  supplier: choice(['NorthStar Supply', 'Metro Distributors', 'Prime Wholesale', 'RetailBridge']),
  status: index % 19 === 0 ? 'discontinued' : 'active'
}));

const buildSalesData = (customers, products) => {
  const orders = [];
  const orderItems = [];
  const payments = [];
  const shipments = [];
  const returns = [];
  const channels = ['online', 'retail_store', 'marketplace', 'partner'];
  const paymentMethods = ['upi', 'card', 'net_banking', 'wallet', 'cash'];
  const carriers = ['BlueDart', 'Delhivery', 'Ekart', 'Shiprocket'];
  const reasons = ['damaged', 'late_delivery', 'wrong_item', 'size_issue', 'changed_mind'];

  for (let index = 1; index <= SALES_DEMO_ORDER_COUNT; index += 1) {
    const customer = customers[Math.floor(random() * customers.length)];
    const itemCount = 1 + Math.floor(random() * 3);
    const orderDate = dateDaysAgo(Math.floor(random() * 520));
    const orderId = `ORD-${pad(index, 5)}`;
    let subtotal = 0;
    let costTotal = 0;

    for (let itemIndex = 1; itemIndex <= itemCount; itemIndex += 1) {
      const product = [1, 19, 29].includes(index) && itemIndex === 1
        ? products.find((item) => item.product_id === 'PRD-0020') || products[Math.floor(random() * products.length)]
        : products[Math.floor(random() * products.length)];
      const quantity = 1 + Math.floor(random() * 5);
      const discountRate = choice([0, 0.03, 0.05, 0.08, 0.1, 0.15]);
      const gross = product.unit_price * quantity;
      const discount = money(gross * discountRate);
      const salesAmount = money(gross - discount);
      const costAmount = money(product.cost_price * quantity);
      subtotal += salesAmount;
      costTotal += costAmount;

      orderItems.push({
        line_item_id: `ITEM-${pad(orderItems.length + 1, 6)}`,
        order_id: orderId,
        product_id: product.product_id,
        product_name: product.product_name,
        category: product.category,
        brand: product.brand,
        quantity,
        unit_price: product.unit_price,
        discount_amount: discount,
        sales_amount: salesAmount,
        cost_amount: costAmount,
        profit: money(salesAmount - costAmount)
      });
    }

    const taxAmount = money(subtotal * 0.18);
    const shippingFee = subtotal > 5000 ? 0 : choice([49, 79, 99, 149]);
    const discountAmount = money(orderItems
      .filter((item) => item.order_id === orderId)
      .reduce((total, item) => total + item.discount_amount, 0));
    const salesAmount = money(subtotal + taxAmount + shippingFee);
    const status = index % 23 === 0
      ? 'cancelled'
      : index % 19 === 0
        ? 'returned'
        : index % 11 === 0
          ? 'processing'
          : 'delivered';
    const paymentStatus = status === 'cancelled'
      ? 'refunded'
      : status === 'processing'
        ? 'pending'
        : 'paid';

    orders.push({
      order_id: orderId,
      customer_id: customer.customer_id,
      customer_name: customer.customer_name,
      order_date: orderDate,
      sales_channel: choice(channels),
      region: customer.region,
      state: customer.state,
      city: customer.city,
      order_status: status,
      payment_status: paymentStatus,
      payment_method: choice(paymentMethods),
      subtotal: money(subtotal),
      discount_amount: discountAmount,
      tax_amount: taxAmount,
      shipping_fee: shippingFee,
      sales_amount: salesAmount,
      profit: money(subtotal - costTotal),
      currency: 'INR'
    });

    payments.push({
      payment_id: `PAY-${pad(index, 5)}`,
      order_id: orderId,
      customer_id: customer.customer_id,
      customer_name: customer.customer_name,
      payment_date: orderDate,
      payment_method: orders[orders.length - 1].payment_method,
      amount: salesAmount,
      status: paymentStatus,
      transaction_reference: `TXN-SALES-${pad(index, 6)}`
    });

    if (status !== 'cancelled') {
      const shippedDate = new Date(orderDate);
      shippedDate.setUTCDate(shippedDate.getUTCDate() + 1 + Math.floor(random() * 3));
      const deliveredDate = new Date(shippedDate);
      deliveredDate.setUTCDate(deliveredDate.getUTCDate() + 1 + Math.floor(random() * 6));
      shipments.push({
        shipment_id: `SHP-${pad(shipments.length + 1, 5)}`,
        order_id: orderId,
        carrier: choice(carriers),
        shipped_date: shippedDate,
        delivered_date: status === 'processing' ? null : deliveredDate,
        delivery_status: status === 'processing' ? 'in_transit' : 'delivered',
        city: customer.city,
        state: customer.state,
        shipping_cost: money(70 + random() * 260)
      });
    }

    if (status === 'returned' || index % 29 === 0) {
      const returnedItem = orderItems.find((item) => item.order_id === orderId);
      const returnDate = new Date(orderDate);
      returnDate.setUTCDate(returnDate.getUTCDate() + 7 + Math.floor(random() * 20));
      returns.push({
        return_id: `RET-${pad(returns.length + 1, 5)}`,
        order_id: orderId,
        product_id: returnedItem.product_id,
        product_name: returnedItem.product_name,
        customer_id: customer.customer_id,
        customer_name: customer.customer_name,
        return_date: returnDate,
        reason: choice(reasons),
        refund_amount: money(returnedItem.sales_amount),
        status: choice(['approved', 'processed', 'rejected'])
      });
    }
  }

  return { orders, orderItems, payments, shipments, returns };
};

const seedSalesDemo = async () => {
  const connection = await mongoose.createConnection(SALES_DEMO_URI, {
    serverSelectionTimeoutMS: 5000
  }).asPromise();

  try {
    const db = connection.db;
    await db.dropDatabase();

    const customers = buildCustomers();
    const products = buildProducts();
    const sales = buildSalesData(customers, products);

    await db.collection('customers').insertMany(customers);
    await db.collection('products').insertMany(products);
    await db.collection('orders').insertMany(sales.orders);
    await db.collection('order_items').insertMany(sales.orderItems);
    await db.collection('payments').insertMany(sales.payments);
    await db.collection('shipments').insertMany(sales.shipments);
    await db.collection('returns').insertMany(sales.returns);

    await Promise.all([
      db.collection('customers').createIndex({ customer_id: 1 }, { unique: true }),
      db.collection('customers').createIndex({ customer_name: 1 }),
      db.collection('products').createIndex({ product_id: 1 }, { unique: true }),
      db.collection('products').createIndex({ category: 1 }),
      db.collection('orders').createIndex({ order_id: 1 }, { unique: true }),
      db.collection('orders').createIndex({ customer_name: 1 }),
      db.collection('orders').createIndex({ order_date: 1 }),
      db.collection('orders').createIndex({ city: 1, order_status: 1 }),
      db.collection('order_items').createIndex({ order_id: 1 }),
      db.collection('order_items').createIndex({ product_name: 1 }),
      db.collection('payments').createIndex({ order_id: 1 }),
      db.collection('shipments').createIndex({ order_id: 1 }),
      db.collection('returns').createIndex({ order_id: 1 })
    ]);

    const counts = {
      customers: customers.length,
      products: products.length,
      orders: sales.orders.length,
      order_items: sales.orderItems.length,
      payments: sales.payments.length,
      shipments: sales.shipments.length,
      returns: sales.returns.length
    };

    console.log(`Seeded ${connection.name} at ${SALES_DEMO_URI}`);
    console.log(`Dynamic seed: ${DEMO_SEED}`);
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    await connection.close();
  }
};

if (require.main === module) {
  seedSalesDemo().catch((error) => {
    console.error('Failed to seed sales demo database:', error);
    process.exit(1);
  });
}

module.exports = {
  seedSalesDemo,
  createRandom,
  hashSeed,
  money,
  pad
};
