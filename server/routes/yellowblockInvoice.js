import express from 'express';
import { generateYellowblockInvoice, InvoiceInputError } from '../services/yellowblockInvoice.js';

const router = express.Router();

router.post('/pdf', async (req, res) => {
  try {
    const { bytes, filename } = await generateYellowblockInvoice(req.body);
    res.set('Cache-Control', 'no-store').attachment(filename).send(Buffer.from(bytes));
  } catch (error) {
    if (error instanceof InvoiceInputError) return res.status(400).json({ success: false, message: error.message });
    console.error('[YellowBlock Invoice]', error.message);
    res.status(500).json({ success: false, message: 'Could not generate the invoice PDF.' });
  }
});

export default router;
