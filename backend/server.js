require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ai-ecommerce';
const getMongoDatabaseName = (uri) => {
  try {
    const parsed = new URL(uri);
    return parsed.pathname.replace(/^\/+/, '') || '(default)';
  } catch (error) {
    return '(unknown)';
  }
};

mongoose.connect(MONGO_URI)
  .then(() => console.log(`MongoDB connected to ${getMongoDatabaseName(MONGO_URI)}`))
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/mcp', require('./routes/mcp'));
app.use('/api/database-connections', require('./routes/databaseConnections'));
app.use('/api/documents', require('./routes/documents'));
app.use('/mcp', require('./mcp/httpTransport').createMcpHttpRouter());
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/rules', require('./routes/rules'));

// Start automation engine
const { startAutomation } = require('./automation/runner');
startAutomation();

app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'Backend is running' }));

app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
