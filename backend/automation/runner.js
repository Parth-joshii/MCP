const cron = require('node-cron');
const Rule = require('../models/Rule');
const Product = require('../models/Product');
const Order = require('../models/Order');

const evaluateRules = async () => {
  console.log('--- Evaluating Automation Rules ---');
  try {
    const rules = await Rule.find({ status: 'active' });
    if (rules.length === 0) return;

    for (let rule of rules) {
      let conditionMet = false;
      let details = '';

      if (rule.conditionType === 'stock') {
        const lowStockProducts = await Product.find({ stock: { [getMongoOperator(rule.operator)]: rule.value } });
        if (lowStockProducts.length > 0) {
          conditionMet = true;
          details = `Found ${lowStockProducts.length} products meeting stock condition ${rule.operator} ${rule.value}.`;
        }
      } else if (rule.conditionType === 'revenue') {
        // Calculate total revenue
        const orders = await Order.find();
        const revenue = orders.reduce((acc, order) => acc + order.totalAmount, 0);
        
        if (evaluateCondition(revenue, rule.operator, rule.value)) {
          conditionMet = true;
          details = `Current revenue $${revenue} meets condition ${rule.operator} $${rule.value}.`;
        }
      }

      if (conditionMet) {
        console.log(`[ALERT] Rule Triggered: ${rule.name}`);
        console.log(`  -> Action: ${rule.action}`);
        console.log(`  -> Details: ${details}`);
        
        rule.lastTriggered = new Date();
        await rule.save();

        // In a real app, send email/sms here based on rule.action
      }
    }
  } catch (error) {
    console.error('Error evaluating rules:', error);
  }
};

const getMongoOperator = (operator) => {
  const map = {
    '<': '$lt',
    '<=': '$lte',
    '>': '$gt',
    '>=': '$gte',
    '==': '$eq'
  };
  return map[operator] || '$eq';
};

const evaluateCondition = (actual, operator, threshold) => {
  switch (operator) {
    case '<': return actual < threshold;
    case '<=': return actual <= threshold;
    case '>': return actual > threshold;
    case '>=': return actual >= threshold;
    case '==': return actual === threshold;
    default: return false;
  }
};

// Run every minute for demonstration purposes
const startAutomation = () => {
  cron.schedule('* * * * *', () => {
    evaluateRules();
  });
  console.log('Automation engine started.');
};

module.exports = { startAutomation };
