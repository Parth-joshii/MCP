const mongoose = require('mongoose');

const ruleSchema = new mongoose.Schema({
  name: { type: String, required: true },
  conditionType: { type: String, enum: ['revenue', 'stock', 'orders'], required: true },
  operator: { type: String, enum: ['<', '>', '==', '<=', '>='], required: true },
  value: { type: Number, required: true },
  action: { type: String, enum: ['notify', 'reorder', 'discount'], required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  lastTriggered: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Rule', ruleSchema);
