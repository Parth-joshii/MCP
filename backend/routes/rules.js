const express = require('express');
const router = express.Router();
const Rule = require('../models/Rule');
const auth = require('../middleware/auth');

// @route   GET /api/rules
// @desc    Get all rules
// @access  Private
router.get('/', async (req, res) => {
  try {
    const rules = await Rule.find().sort({ date: -1 });
    res.json(rules);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST /api/rules
// @desc    Add new rule
// @access  Private
router.post('/', async (req, res) => {
  try {
    const newRule = new Rule(req.body);
    const rule = await newRule.save();
    res.json(rule);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   DELETE /api/rules/:id
// @desc    Delete rule
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    const rule = await Rule.findById(req.params.id);
    if (!rule) return res.status(404).json({ msg: 'Rule not found' });

    await Rule.findByIdAndRemove(req.params.id);
    res.json({ msg: 'Rule removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
